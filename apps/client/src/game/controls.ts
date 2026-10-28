// 入力（設計書 5.1）。
// スマホ: 左側=移動スティック、右側=ドラッグで視点（タッチイベント）。操作ボタンは HUD 側。
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
  /** 移動スティックと視点に使っている指（Touch.identifier） */
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
    // 別のアプリに切り替えたときなどは、押している指・キーをすべて離したことにする
    this.listen(window, 'blur', () => this.releaseAll());
    const onHidden = () => {
      if (document.visibilityState === 'hidden') this.releaseAll();
    };
    document.addEventListener('visibilitychange', onHidden);
    this.disposers.push(() => document.removeEventListener('visibilitychange', onHidden));

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

    // タッチ（スマホ）。iOS の元のタッチイベントで扱い、合図のたびに「画面に残っている指」（e.touches）と照合する。
    // Safari がタッチを途中で取ると、指を離した合図が届かないことがあり、そのままだと歩き続けたり、次のタッチで視点が飛ぶため。
    // UI ボタンの上で始まったタッチはキャンバスには来ない。座標は表示の座標に直す（縦向きの画面では表示を 90° 回している。game/orientation.ts）
    const active = { passive: false };
    this.listen(
      this.canvas,
      'touchstart',
      (e) => {
        // Safari のスクロール・拡大・バーの出し入れを起こさない
        e.preventDefault();
        if (!this.enabled) return;
        for (const t of Array.from(e.changedTouches)) this.touchStart(t);
      },
      active,
    );
    this.listen(
      this.canvas,
      'touchmove',
      (e) => {
        e.preventDefault();
        for (const t of Array.from(e.changedTouches)) this.touchMove(t);
      },
      active,
    );
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) this.touchEnd(t.identifier);
      this.reconcile(e.touches);
    };
    this.listen(this.canvas, 'touchend', end);
    this.listen(this.canvas, 'touchcancel', end);
    // ボタンなど、ほかの場所のタッチの合図でも照合する（キャンバスで始めた指の合図が来なくなっていても気づける）
    for (const type of ['touchstart', 'touchend', 'touchcancel'] as const) {
      this.listen(window, type, (e) => this.reconcile(e.touches), { capture: true, passive: true });
    }
  }

  private touchStart(t: Touch): void {
    const p = toView(t.clientX, t.clientY);
    if (p.x < viewSize().width * 0.45) {
      // 左側の2本目の指は使わない
      if (this.joyId !== null) return;
      this.joyId = t.identifier;
      this.joyOrigin = p;
      this.joyVec = { x: 0, y: 0 };
      this.joyEl.style.display = 'block';
      this.joyEl.style.left = `${p.x - 60}px`;
      this.joyEl.style.top = `${p.y - 60}px`;
      this.knobEl.style.transform = 'translate(0px, 0px)';
    } else if (this.lookId === null) {
      this.lookId = t.identifier;
      this.lookLast = p;
    }
  }

  private touchMove(t: Touch): void {
    const p = toView(t.clientX, t.clientY);
    if (t.identifier === this.joyId) {
      const dx = p.x - this.joyOrigin.x;
      const dy = p.y - this.joyOrigin.y;
      const len = Math.hypot(dx, dy);
      const max = 55;
      const k = len > max ? max / len : 1;
      this.joyVec = { x: (dx * k) / max, y: (dy * k) / max };
      this.knobEl.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    } else if (t.identifier === this.lookId) {
      const dx = p.x - this.lookLast.x;
      const dy = p.y - this.lookLast.y;
      this.lookLast = p;
      // 1回の合図で大きく動いたものは、合図の取りこぼしによる飛びとみなして使わない
      if (Math.abs(dx) > 120 || Math.abs(dy) > 120) return;
      if (this.enabled) this.look(dx, dy, 0.0062);
    }
  }

  private touchEnd(id: number): void {
    if (id === this.joyId) this.releaseJoy();
    if (id === this.lookId) this.lookId = null;
  }

  /** 画面に残っていない指を離したことにする */
  private reconcile(list: TouchList): void {
    if (this.joyId === null && this.lookId === null) return;
    const ids = new Set(Array.from(list, (t) => t.identifier));
    if (this.joyId !== null && !ids.has(this.joyId)) this.releaseJoy();
    if (this.lookId !== null && !ids.has(this.lookId)) this.lookId = null;
  }

  private releaseJoy(): void {
    this.joyId = null;
    this.joyVec = { x: 0, y: 0 };
    this.joyEl.style.display = 'none';
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
      // メニューや画面が出たら、押している指は離したことにする（閉じた後に歩き続けない）
      if (this.joyId !== null) this.releaseJoy();
      this.lookId = null;
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
    this.releaseJoy();
    this.lookId = null;
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
