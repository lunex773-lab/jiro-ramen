// 入力（設計書 5.1）。
// スマホ: 左側=移動スティック、右側=ドラッグで視点。操作ボタンは HUD 側。
// PC: WASD/矢印で移動、マウスで視点（クリックでポインターロック）、E/クリック=操作、Q=中断、Tab=経営メニュー。

import { h } from '../ui/dom';
import { toView, viewSize } from './orientation';

export interface ControlSettings {
  lookSensitivity: number;
  invertY: boolean;
}

export class Controls {
  yaw = Math.PI;
  pitch = -0.12;
  /** 前後・左右の入力（-1..1） */
  forward = 0;
  strafe = 0;
  readonly isTouch: boolean;
  enabled = true;
  settings: ControlSettings = { lookSensitivity: 1, invertY: false };

  private keys = new Set<string>();
  private joyId: number | null = null;
  private joyOrigin = { x: 0, y: 0 };
  private joyVec = { x: 0, y: 0 };
  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };
  private joyEl: HTMLElement;
  private knobEl: HTMLElement;
  private disposers: (() => void)[] = [];

  /** キー操作のコールバック */
  onPrimary: ((down: boolean) => void) | null = null;
  onVerbKey: ((index: number, down: boolean) => void) | null = null;
  onCancel: (() => void) | null = null;
  onMenu: (() => void) | null = null;
  onPause: (() => void) | null = null;

  constructor(
    private root: HTMLElement,
    private canvas: HTMLCanvasElement,
  ) {
    this.isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.joyEl = h('div', { class: 'joy' });
    this.knobEl = h('div', { class: 'joy-knob' });
    this.joyEl.appendChild(this.knobEl);
    root.appendChild(this.joyEl);
    this.bind();
  }

  private listen<K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions): void {
    target.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private bind(): void {
    this.listen(window, 'keydown', (e) => {
      if (!this.enabled || isTyping(e)) return;
      const k = e.key.toLowerCase();
      if (this.keys.has(k)) return;
      this.keys.add(k);
      if (k === 'e' || k === ' ') this.onPrimary?.(true);
      else if (k >= '1' && k <= '6') this.onVerbKey?.(Number(k) - 1, true);
      else if (k === 'q') this.onCancel?.();
      else if (k === 'tab' || k === 'm') {
        e.preventDefault();
        this.onMenu?.();
      } else if (k === 'escape') this.onPause?.();
    });
    this.listen(window, 'keyup', (e) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k);
      if (!this.enabled) return;
      if (k === 'e' || k === ' ') this.onPrimary?.(false);
      else if (k >= '1' && k <= '6') this.onVerbKey?.(Number(k) - 1, false);
    });
    this.listen(window, 'blur', () => this.keys.clear());

    // マウス（PC）
    this.listen(this.canvas, 'mousedown', (e) => {
      if (!this.enabled || this.isTouch) return;
      if (document.pointerLockElement !== this.canvas) {
        this.canvas.requestPointerLock?.();
        return;
      }
      if (e.button === 0) this.onPrimary?.(true);
    });
    this.listen(window, 'mouseup', (e) => {
      if (!this.enabled || this.isTouch) return;
      if (e.button === 0 && document.pointerLockElement === this.canvas) this.onPrimary?.(false);
    });
    this.listen(window, 'mousemove', (e) => {
      if (!this.enabled || document.pointerLockElement !== this.canvas) return;
      this.look(e.movementX, e.movementY, 0.0024);
    });

    // タッチ（スマホ）。UI ボタン上のタッチはここに来ない（HUD 側で stopPropagation）。
    // 座標は表示の座標に直して使う（縦向きの画面では表示を 90° 回しているため。game/orientation.ts）
    this.listen(this.canvas, 'pointerdown', (e) => {
      if (!this.enabled || e.pointerType === 'mouse') return;
      const p = toView(e.clientX, e.clientY);
      if (p.x < viewSize().width * 0.45 && this.joyId === null) {
        this.joyId = e.pointerId;
        this.joyOrigin = p;
        this.joyVec = { x: 0, y: 0 };
        this.joyEl.style.display = 'block';
        this.joyEl.style.left = `${p.x - 60}px`;
        this.joyEl.style.top = `${p.y - 60}px`;
        this.knobEl.style.transform = 'translate(0px, 0px)';
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this.lookLast = p;
      }
      this.canvas.setPointerCapture?.(e.pointerId);
    });
    this.listen(this.canvas, 'pointermove', (e) => {
      const p = toView(e.clientX, e.clientY);
      if (e.pointerId === this.joyId) {
        const dx = p.x - this.joyOrigin.x;
        const dy = p.y - this.joyOrigin.y;
        const len = Math.hypot(dx, dy);
        const max = 55;
        const k = len > max ? max / len : 1;
        this.joyVec = { x: (dx * k) / max, y: (dy * k) / max };
        this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
      } else if (e.pointerId === this.lookId) {
        const dx = p.x - this.lookLast.x;
        const dy = p.y - this.lookLast.y;
        this.lookLast = p;
        this.look(dx, dy, 0.0062);
      }
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId === this.joyId) {
        this.joyId = null;
        this.joyVec = { x: 0, y: 0 };
        this.joyEl.style.display = 'none';
      }
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    this.listen(this.canvas, 'pointerup', end);
    this.listen(this.canvas, 'pointercancel', end);
  }

  private look(dx: number, dy: number, base: number): void {
    const s = base * this.settings.lookSensitivity;
    this.yaw -= dx * s;
    this.pitch -= dy * s * (this.settings.invertY ? -1 : 1);
    this.pitch = Math.max(-1.35, Math.min(1.2, this.pitch));
  }

  /** 毎フレーム呼ぶ。移動入力を更新 */
  update(): void {
    if (!this.enabled) {
      this.forward = 0;
      this.strafe = 0;
      return;
    }
    let f = 0;
    let r = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) f += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) f -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) r += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) r -= 1;
    if (this.joyId !== null) {
      // 小さな入力は無視（デッドゾーン）
      const jx = Math.abs(this.joyVec.x) < 0.12 ? 0 : this.joyVec.x;
      const jy = Math.abs(this.joyVec.y) < 0.12 ? 0 : this.joyVec.y;
      f += -jy;
      r += jx;
    }
    const len = Math.hypot(f, r);
    if (len > 1) {
      f /= len;
      r /= len;
    }
    this.forward = f;
    this.strafe = r;
  }

  releaseAll(): void {
    this.keys.clear();
    this.joyId = null;
    this.lookId = null;
    this.joyVec = { x: 0, y: 0 };
    this.joyEl.style.display = 'none';
    if (document.pointerLockElement === this.canvas) document.exitPointerLock?.();
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.joyEl.remove();
  }
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
