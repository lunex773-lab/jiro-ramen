// 爆発事故の画面の演出: 閃光・揺れ・暗転・「数時間後」・目覚め、焼け跡を歩く間の案内と「リセットする」ボタン。
// 進み具合はゲームの状態（事故の経過秒）から決まる。演出は状態を読むだけなので、ここが失敗してもゲームの状態は壊れない。

import { BALANCE, type AccidentState, type GameState } from '@jiro/core';
import type { GameHost } from '../game/host';
import { h, toast } from './dom';

export const EYE = 1.58;
/** 倒れているときの目の高さ */
const FLOOR_EYE = 0.32;

export interface AccidentView {
  /** 予兆（設備の異常） */
  warning: boolean;
  /** 焼け跡を表示する（爆発の直後から） */
  burned: boolean;
  /** 目覚めて歩ける（リセットできる） */
  awake: boolean;
  /** 白い閃光 0..1 */
  flash: number;
  /** 暗転 0..1 */
  black: number;
  /** 画面の揺れ（m） */
  shake: number;
  /** 目の高さ（m）と傾き（rad） */
  eyeY: number;
  roll: number;
  /** 画面の中央に出す文 */
  caption: string;
}

const NONE: AccidentView = { warning: false, burned: false, awake: true, flash: 0, black: 0, shake: 0, eyeY: EYE, roll: 0, caption: '' };

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const between = (t: number, a: number, b: number) => smooth((t - a) / Math.max(1e-6, b - a));

/**
 * 事故の経過から画面の演出を決める（爆発から目覚めるまでの秒数 faintSec に合わせて伸び縮みする）。
 *   0      閃光と揺れ、焼け落ちた店が一瞬見える（倒れていく）
 *   0.25   暗転 → 「……」 → 「数時間後」
 *   0.71   ゆっくり目が開き、起き上がる
 *   1.0    歩ける。「リセットする」を出す
 */
export function accidentView(acc: AccidentState | null | undefined, faintSec = BALANCE.events.explosion.faintSec): AccidentView {
  if (!acc) return NONE;
  if (acc.stage === 'warning') return { ...NONE, warning: true, shake: 0.004 + Math.min(1, acc.t / 5) * 0.01 };
  const k = faintSec / 9;
  const t = acc.t;
  const fall = between(t, 0.3 * k, 2.2 * k);
  const rise = between(t, 6.4 * k, 9 * k);
  const black = t < 2.2 * k ? 0 : t < 3.2 * k ? between(t, 2.2 * k, 3.2 * k) : t < 6.4 * k ? 1 : 1 - rise;
  let caption = '';
  if (t >= 3.4 * k && t < 4.9 * k) caption = '……';
  else if (t >= 4.9 * k && t < 6.4 * k) caption = '――数時間後';
  return {
    warning: false,
    burned: true,
    awake: t >= faintSec,
    flash: t < 0.6 * k ? 1 - t / (0.6 * k) : 0,
    black,
    shake: t < 1.8 * k ? 0.14 * (1 - t / (1.8 * k)) : 0,
    eyeY: EYE + (FLOOR_EYE - EYE) * (fall - rise * fall),
    roll: 0.5 * (fall - rise * fall),
    caption,
  };
}

/** 目覚めてから語りを出す秒数 */
const NARRATION_SEC = 9;

export class AccidentOverlay {
  readonly el: HTMLElement;
  private warn: HTMLElement;
  private flash: HTMLElement;
  private black: HTMLElement;
  private caption: HTMLElement;
  private panel: HTMLElement;
  /** 画面の下の中央（「リセットする」・ゲストへの案内） */
  private actions: HTMLElement;
  private narration: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private guestNote: HTMLElement;
  private pending = false;
  private last = { flash: -1, black: -1, warn: false, caption: '', panel: false, narration: '' };

  constructor(
    private root: HTMLElement,
    private host: GameHost,
  ) {
    this.warn = h('div', { class: 'acc-warn' });
    this.flash = h('div', { class: 'acc-flash' });
    this.black = h('div', { class: 'acc-black' });
    this.caption = h('div', { class: 'acc-caption' });
    this.narration = h('div', { class: 'acc-narration' });
    this.resetBtn = h('button', { class: 'btn primary acc-reset', onclick: () => void this.reset() }, 'リセットする') as HTMLButtonElement;
    this.guestNote = h('div', { class: 'acc-note' }, 'ホストが「リセットする」を押すと、今日の仕込みの開始時点に戻ります');
    this.panel = h('div', { class: 'acc-panel' }, this.narration);
    this.actions = h('div', { class: 'acc-actions' }, this.resetBtn, this.guestNote);
    this.el = h('div', { class: 'accident', 'aria-live': 'polite' }, this.warn, this.flash, this.black, this.caption, this.panel, this.actions);
    root.appendChild(this.el);
    this.apply(NONE, null);
  }

  /** 毎フレーム（状態から演出を決めて画面に反映する） */
  update(s: GameState, view: AccidentView): void {
    this.apply(view, s.events?.accident ?? null);
  }

  private apply(v: AccidentView, acc: AccidentState | null): void {
    const L = this.last;
    const flash = Math.round(v.flash * 50) / 50;
    if (flash !== L.flash) {
      L.flash = flash;
      this.flash.style.opacity = String(flash);
      this.flash.style.display = flash > 0 ? 'block' : 'none';
    }
    const black = Math.round(v.black * 50) / 50;
    if (black !== L.black) {
      L.black = black;
      this.black.style.opacity = String(black);
      this.black.style.display = black > 0 ? 'block' : 'none';
    }
    if (v.warning !== L.warn) {
      L.warn = v.warning;
      this.warn.style.display = v.warning ? 'block' : 'none';
    }
    if (v.caption !== L.caption) {
      L.caption = v.caption;
      this.caption.textContent = v.caption;
      this.caption.style.display = v.caption ? 'block' : 'none';
    }
    const showPanel = v.burned && v.awake && !!acc;
    if (showPanel !== L.panel) {
      L.panel = showPanel;
      this.panel.style.display = showPanel ? 'flex' : 'none';
      this.actions.style.display = showPanel ? 'flex' : 'none';
      this.pending = false;
      this.resetBtn.disabled = false;
    }
    if (showPanel && acc) {
      const since = acc.t - BALANCE.events.explosion.faintSec;
      const text =
        since < NARRATION_SEC
          ? '店は焼け落ちた。店員も、お客さんも、誰ひとり動かない。'
          : `焼け跡を歩くことができます。「リセットする」で、${acc.day}日目の仕込みの開始時点に戻ります`;
      if (text !== L.narration) {
        L.narration = text;
        this.narration.textContent = text;
        this.narration.classList.toggle('dim', since >= NARRATION_SEC);
      }
      const host = this.host.isHost;
      this.resetBtn.style.display = host ? '' : 'none';
      this.guestNote.style.display = host ? 'none' : '';
    }
  }

  private async reset(): Promise<void> {
    const acc = this.host.state.events?.accident;
    if (!acc || this.pending) return;
    this.pending = true;
    this.resetBtn.disabled = true;
    const r = await this.host.act({ type: 'accidentReset', accidentId: acc.id });
    if (!r.ok) {
      this.pending = false;
      this.resetBtn.disabled = false;
      if (r.reason) toast(this.root, r.reason, 'warn', 2500);
    }
  }

  dispose(): void {
    this.el.remove();
  }
}
