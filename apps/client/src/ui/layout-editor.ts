// レイアウト編集（設計書 11）: グリッド配置＋微調整のハイブリッド。
// 上から見た2D図で設備をドラッグ。ドラッグ中は配置可否をその場で検証してプレビューする（確定はサーバー/ローカルの検証を通す）。

import {
  accessPoint,
  CELL,
  EQUIPMENT,
  equipmentRect,
  FACING,
  FINE_ADJUST_MAX,
  footprint,
  stageOf,
  validateLayout,
  type Equipment,
  type GameState,
  type LayoutCheck,
  type Rot,
} from '@jiro/core';
import type { GameHost } from '../game/host';
import { h, replace, toast } from './dom';

interface Drag {
  id: string;
  /** 掴んだ位置と設備の左上の差（m） */
  grabDx: number;
  grabDz: number;
  gx: number;
  gz: number;
  offset: { x: number; z: number };
  moved: boolean;
}

interface UndoEntry {
  id: string;
  placed: boolean;
  gx: number;
  gz: number;
  rot: Rot;
  offset: { x: number; z: number };
}

export class LayoutEditor {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private side: HTMLElement;
  private selected: string | null = null;
  private drag: Drag | null = null;
  private fine = false;
  private undo: UndoEntry[] = [];
  private preview: LayoutCheck | null = null;
  private scale = 40;
  private ox = 20;
  private oz = 20;
  private raf = 0;
  private lockHeld = false;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private onClose: () => void,
    private requestLock?: (on: boolean) => void,
  ) {
    this.canvas = h('canvas', { class: 'layout-canvas' });
    this.side = h('div', { class: 'layout-side' });
    this.el = h(
      'div',
      { class: 'layout-editor' },
      h(
        'div',
        { class: 'manage-head' },
        h('div', { class: 'manage-title' }, 'レイアウト編集'),
        h('button', { class: 'btn primary', onclick: () => this.close() }, '完了'),
      ),
      h('div', { class: 'layout-main' }, h('div', { class: 'layout-canvas-wrap' }, this.canvas), this.side),
    );
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => void this.onUp(e));
    this.canvas.addEventListener('pointercancel', () => {
      this.drag = null;
      this.preview = null;
    });
  }

  open(): void {
    this.root.appendChild(this.el);
    this.requestLock?.(true);
    this.lockHeld = true;
    this.renderSide();
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    if (this.lockHeld) this.requestLock?.(false);
    this.lockHeld = false;
    this.el.remove();
    this.onClose();
  }

  private get s(): GameState {
    return this.host.state;
  }

  // ───────────── 座標変換 ─────────────
  private fit(): void {
    const wrap = this.canvas.parentElement!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = `${W}px`;
      this.canvas.style.height = `${H}px`;
    }
    const st = stageOf(this.s);
    const worldW = st.w * CELL;
    const worldD = st.d * CELL + 1.2; // 歩道の一部も表示
    // 奥（厨房）を上にしたいので z を反転して描く
    this.scale = Math.min((W - 24) / worldW, (H - 24) / worldD) * dpr;
    this.ox = (this.canvas.width - worldW * this.scale) / 2;
    this.oz = (this.canvas.height - worldD * this.scale) / 2;
  }

  /** 世界座標 → キャンバス */
  private toPx(x: number, z: number): [number, number] {
    const st = stageOf(this.s);
    return [this.ox + x * this.scale, this.oz + (st.d * CELL - z) * this.scale];
  }

  /** キャンバス → 世界座標 */
  private toWorld(px: number, py: number): { x: number; z: number } {
    const st = stageOf(this.s);
    return { x: (px - this.ox) / this.scale, z: st.d * CELL - (py - this.oz) / this.scale };
  }

  private eventPos(e: PointerEvent): { x: number; z: number } {
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / r.width;
    return this.toWorld((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  }

  private hit(p: { x: number; z: number }): Equipment | null {
    for (const e of [...this.s.equipment].reverse()) {
      if (!e.placed) continue;
      const def = EQUIPMENT[e.type];
      if (!def || def.w === 0) continue;
      const r = equipmentRect(e);
      if (p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1) return e;
    }
    return null;
  }

  // ───────────── 入力 ─────────────
  private onDown(e: PointerEvent): void {
    const p = this.eventPos(e);
    const hitE = this.hit(p);
    if (hitE) {
      this.selected = hitE.id;
      const r = equipmentRect(hitE);
      this.drag = { id: hitE.id, grabDx: p.x - r.x0, grabDz: p.z - r.z0, gx: hitE.gx, gz: hitE.gz, offset: { ...hitE.offset }, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    } else if (this.selected) {
      // 倉庫から選んだ設備をタップした位置に置く
      const sel = this.s.equipment.find((x) => x.id === this.selected);
      if (sel && !sel.placed) {
        const fp = footprint(sel.type, sel.rot);
        void this.commit(sel, Math.round(p.x / CELL - fp.w / 2), Math.round(p.z / CELL - fp.d / 2), sel.rot, { x: 0, z: 0 });
      } else this.selected = null;
    }
    this.renderSide();
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const p = this.eventPos(e);
    const eq = this.s.equipment.find((x) => x.id === this.drag!.id);
    if (!eq) return;
    const def = EQUIPMENT[eq.type]!;
    const x0 = p.x - this.drag.grabDx;
    const z0 = p.z - this.drag.grabDz;
    const gx = Math.round(x0 / CELL);
    const gz = Math.round(z0 / CELL);
    let offset = { x: 0, z: 0 };
    if (this.fine && def.fineAdjust) {
      offset = {
        x: Math.max(-FINE_ADJUST_MAX, Math.min(FINE_ADJUST_MAX, x0 - gx * CELL)),
        z: Math.max(-FINE_ADJUST_MAX, Math.min(FINE_ADJUST_MAX, z0 - gz * CELL)),
      };
    }
    if (gx !== this.drag.gx || gz !== this.drag.gz || Math.abs(offset.x - this.drag.offset.x) > 0.01 || Math.abs(offset.z - this.drag.offset.z) > 0.01) {
      this.drag.gx = gx;
      this.drag.gz = gz;
      this.drag.offset = offset;
      this.drag.moved = true;
      this.preview = this.check(eq, gx, gz, eq.rot, offset);
    }
  }

  private async onUp(_e: PointerEvent): Promise<void> {
    const d = this.drag;
    this.drag = null;
    if (!d || !d.moved) {
      this.preview = null;
      return;
    }
    const eq = this.s.equipment.find((x) => x.id === d.id);
    if (eq) await this.commit(eq, d.gx, d.gz, eq.rot, d.offset);
    this.preview = null;
  }

  /** 状態を変えずに配置を検証する（プレビュー用） */
  private check(eq: Equipment, gx: number, gz: number, rot: Rot, offset: { x: number; z: number }): LayoutCheck {
    const s = this.s;
    const trial = { ...s, equipment: s.equipment.map((x) => (x.id === eq.id ? { ...x, placed: true, gx, gz, rot, offset } : x)) } as GameState;
    return validateLayout(trial);
  }

  private async commit(eq: Equipment, gx: number, gz: number, rot: Rot, offset: { x: number; z: number }): Promise<boolean> {
    const before: UndoEntry = { id: eq.id, placed: eq.placed, gx: eq.gx, gz: eq.gz, rot: eq.rot, offset: { ...eq.offset } };
    const r = await this.host.act({ type: 'place', equipmentId: eq.id, gx, gz, rot, offset });
    if (!r.ok) {
      toast(this.root, r.reason ?? '置けません', 'warn', 2400);
      this.renderSide((r.data as LayoutCheck | undefined) ?? null);
      return false;
    }
    this.undo.push(before);
    this.renderSide((r.data as LayoutCheck | undefined) ?? null);
    return true;
  }

  private async rotate(): Promise<void> {
    const eq = this.s.equipment.find((x) => x.id === this.selected);
    if (!eq) return;
    // 回転すると大きさが変わるので、中心がなるべく同じ位置になるよう調整
    const fp0 = footprint(eq.type, eq.rot);
    const rot = ((eq.rot + 1) % 4) as Rot;
    const fp1 = footprint(eq.type, rot);
    const gx = eq.gx + Math.round((fp0.w - fp1.w) / 2);
    const gz = eq.gz + Math.round((fp0.d - fp1.d) / 2);
    if (!(await this.commit(eq, gx, gz, rot, eq.offset))) {
      // その場で回せなければ、同じ位置で試す
      await this.commit(eq, eq.gx, eq.gz, rot, eq.offset);
    }
  }

  private async store(): Promise<void> {
    const eq = this.s.equipment.find((x) => x.id === this.selected);
    if (!eq) return;
    const before: UndoEntry = { id: eq.id, placed: eq.placed, gx: eq.gx, gz: eq.gz, rot: eq.rot, offset: { ...eq.offset } };
    const r = await this.host.act({ type: 'store', equipmentId: eq.id });
    if (!r.ok) toast(this.root, r.reason ?? 'しまえません', 'warn');
    else this.undo.push(before);
    this.renderSide((r.data as LayoutCheck | undefined) ?? null);
  }

  private async undoLast(): Promise<void> {
    const u = this.undo.pop();
    if (!u) return;
    if (u.placed) await this.host.act({ type: 'place', equipmentId: u.id, gx: u.gx, gz: u.gz, rot: u.rot, offset: u.offset });
    else await this.host.act({ type: 'store', equipmentId: u.id });
    this.renderSide();
  }

  private renderSide(result: LayoutCheck | null = null): void {
    const s = this.s;
    const sel = s.equipment.find((x) => x.id === this.selected);
    const check = result ?? validateLayout(s);
    const stored = s.equipment.filter((e) => !e.placed && (EQUIPMENT[e.type]?.w ?? 0) > 0);
    const def = sel ? EQUIPMENT[sel.type] : undefined;
    replace(
      this.side,
      h('p', { class: 'note' }, '設備をドラッグして移動。緑の点は作業する位置（正面）です。椅子や装飾は「微調整」をONにすると細かく動かせます。'),
      sel && def
        ? h(
            'div',
            { class: 'card' },
            h('h4', null, def.name),
            h('p', { class: 'note' }, sel.placed ? `位置 (${sel.gx}, ${sel.gz}) 向き${['手前', '右', '奥', '左'][sel.rot]}` : '倉庫にあります。図の空いている場所をタップすると置きます'),
            h(
              'div',
              { class: 'row wrap' },
              h('button', { class: 'btn', onclick: () => void this.rotate() }, '⟳ 回転'),
              sel.placed ? h('button', { class: 'btn ghost', onclick: () => void this.store() }, '倉庫へ') : null,
              def.fineAdjust ? h('button', { class: `btn ${this.fine ? 'primary' : 'ghost'}`, onclick: () => { this.fine = !this.fine; this.renderSide(); } }, `微調整 ${this.fine ? 'ON' : 'OFF'}`) : null,
            ),
          )
        : h('p', { class: 'note' }, '設備をタップして選択'),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn ghost', disabled: this.undo.length === 0, onclick: () => void this.undoLast() }, '↶ 取り消し'),
      ),
      stored.length > 0
        ? h(
            'div',
            { class: 'card' },
            h('h4', null, '倉庫（未配置）'),
            stored.map((e) => h('button', { class: `mini ${this.selected === e.id ? 'on' : ''}`, onclick: () => { this.selected = e.id; this.renderSide(); } }, EQUIPMENT[e.type]?.name ?? e.type)),
          )
        : null,
      check.errors.length > 0 ? h('div', { class: 'card bad' }, h('h4', null, '配置できない理由'), check.errors.map((x) => h('div', null, `✕ ${x}`))) : null,
      check.warnings.length > 0 ? h('div', { class: 'card warn' }, h('h4', null, '注意'), check.warnings.map((x) => h('div', null, `△ ${x}`))) : null,
      check.errors.length === 0 && check.warnings.length === 0 ? h('div', { class: 'card good' }, '✓ 問題ありません') : null,
    );
  }

  // ───────────── 描画 ─────────────
  private draw(): void {
    this.fit();
    const c = this.canvas.getContext('2d');
    if (!c) return;
    const s = this.s;
    const st = stageOf(s);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.fillStyle = '#16120f';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    const rect = (x0: number, z0: number, x1: number, z1: number, fill: string, stroke?: string) => {
      const [ax, ay] = this.toPx(x0, z1);
      const [bx, by] = this.toPx(x1, z0);
      c.fillStyle = fill;
      c.fillRect(ax, ay, bx - ax, by - ay);
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = Math.max(1, this.scale * 0.03);
        c.strokeRect(ax, ay, bx - ax, by - ay);
      }
    };
    // 歩道・区画
    rect(-0.2, -1.2, st.w * CELL + 0.2, 0, '#3a3a3a');
    rect(st.dining.x0 * CELL, st.dining.z0 * CELL, st.dining.x1 * CELL, st.dining.z1 * CELL, '#4a3b2d');
    rect(st.kitchen.x0 * CELL, st.kitchen.z0 * CELL, st.kitchen.x1 * CELL, st.kitchen.z1 * CELL, '#59606a');
    rect(0, st.counter.z0 * CELL, st.counter.x0 * CELL, st.counter.z1 * CELL, '#59606a');
    // グリッド
    c.strokeStyle = 'rgba(255,255,255,0.07)';
    c.lineWidth = 1;
    for (let gx = 0; gx <= st.w; gx++) {
      const [x, y0] = this.toPx(gx * CELL, 0);
      const [, y1] = this.toPx(gx * CELL, st.d * CELL);
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x, y1);
      c.stroke();
    }
    for (let gz = 0; gz <= st.d; gz++) {
      const [x0, y] = this.toPx(0, gz * CELL);
      const [x1] = this.toPx(st.w * CELL, gz * CELL);
      c.beginPath();
      c.moveTo(x0, y);
      c.lineTo(x1, y);
      c.stroke();
    }
    // カウンター
    rect(st.counter.x0 * CELL, st.counter.z0 * CELL, st.counter.x1 * CELL, st.counter.z1 * CELL, '#a0723f', '#d9a35a');
    // 入口
    rect(st.door.x0, -0.1, st.door.x1, 0.1, '#f2c200');
    this.label('入口', (st.door.x0 + st.door.x1) / 2, -0.5, '#f2c200', 0.28);
    this.label('厨房', 0.6, st.d * CELL - 0.3, 'rgba(255,255,255,0.35)', 0.3);
    this.label('客席', st.w * CELL - 0.6, 0.35, 'rgba(255,255,255,0.35)', 0.3);
    // 席
    for (const seat of s.seats) {
      const p = st.seats[seat.index];
      if (!p) continue;
      const [x, y] = this.toPx(p.x + seat.offset.x, p.z + seat.offset.z);
      c.beginPath();
      c.arc(x, y, this.scale * 0.17, 0, Math.PI * 2);
      c.fillStyle = seat.installed ? '#c0392b' : 'rgba(255,255,255,0.15)';
      c.fill();
    }
    // 設備
    const errIds = new Set<string>();
    const pv = this.preview;
    for (const e of s.equipment) {
      if (!e.placed) continue;
      const def = EQUIPMENT[e.type];
      if (!def || def.w === 0) continue;
      let draw: Equipment = e;
      if (this.drag && this.drag.id === e.id) draw = { ...e, gx: this.drag.gx, gz: this.drag.gz, offset: this.drag.offset };
      const r = equipmentRect(draw);
      const isSel = e.id === this.selected;
      const invalid = this.drag?.id === e.id && pv && !pv.ok;
      rect(r.x0, r.z0, r.x1, r.z1, invalid ? 'rgba(231,76,60,0.75)' : def.color, isSel ? '#f2c200' : 'rgba(0,0,0,0.6)');
      // 正面の向き
      const ap = accessPoint(draw);
      const [ax, ay] = this.toPx(ap.x, ap.z);
      c.beginPath();
      c.arc(ax, ay, this.scale * 0.08, 0, Math.PI * 2);
      c.fillStyle = invalid ? '#e74c3c' : '#2ecc71';
      c.fill();
      const f = FACING[draw.rot];
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      this.label(shortName(def.name), cx - f.x * 0.05, cz - f.z * 0.05, '#111', Math.min(0.22, ((r.x1 - r.x0) / Math.max(2, shortName(def.name).length)) * 1.6));
      if (errIds.has(e.id)) void 0;
    }
    if (pv && this.drag) {
      const msg = pv.ok ? (pv.warnings[0] ?? '置けます') : (pv.errors[0] ?? '置けません');
      c.fillStyle = pv.ok ? 'rgba(46,204,113,0.9)' : 'rgba(231,76,60,0.9)';
      c.font = `${Math.round(this.scale * 0.32)}px sans-serif`;
      c.fillText(msg, 10, this.canvas.height - 12);
    }
  }

  private label(text: string, x: number, z: number, color: string, sizeM: number): void {
    const c = this.canvas.getContext('2d')!;
    const [px, py] = this.toPx(x, z);
    c.fillStyle = color;
    c.font = `bold ${Math.max(9, Math.round(this.scale * sizeM))}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, px, py);
    c.textAlign = 'start';
    c.textBaseline = 'alphabetic';
  }
}

function shortName(name: string): string {
  return name.replace(/（.*?）/g, '').replace('業務用', '').slice(0, 6);
}
