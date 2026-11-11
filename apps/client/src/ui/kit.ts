// 経営・市場の画面の部品（じろ1 P6。オーナーが承認した見た目の案: 数字のカード・お金の流れの帯・2週間の利益の棒・
// 気をつけること。長い説明は「？」を押したときだけ出す）。
import { h } from './dom';

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'accent' | '';

/** 円の文字（+/− 付き）。¥1,234 / −¥1,234 / +¥1,234 */
export function yenSigned(v: number, plus = false): string {
  const n = Math.round(v);
  const abs = `¥${Math.abs(n).toLocaleString('ja-JP')}`;
  return n < 0 ? `−${abs}` : plus && n > 0 ? `+${abs}` : abs;
}

/** 数字のカード（ラベル・大きな数字・小さな補足。tone で色） */
export function kpi(label: string, value: string, sub?: string | null, tone: Tone = '', subTone: Tone = '', attrs: Record<string, string> = {}): HTMLElement {
  return h(
    'div',
    { class: `kpi${tone ? ` tone-${tone}` : ''}`, ...attrs },
    h('span', { class: 'kpi-label' }, label),
    h('b', { class: 'kpi-value' }, value),
    sub ? h('small', { class: `kpi-sub${subTone ? ` tone-${subTone}` : ''}` }, sub) : null,
  );
}

/** 数字のカードの並び（横に4枚まで。狭い画面では折り返す） */
export function kpiRow(items: (HTMLElement | null)[], cls = ''): HTMLElement {
  return h('div', { class: `kpi-row ${cls}` }, items);
}

/** 前の値との差の文字と色（▲ / ▼） */
export function delta(now: number, before: number | null, fmt: (v: number) => string, unit = ''): { text: string; tone: Tone } | null {
  if (before === null || !Number.isFinite(before)) return null;
  const d = now - before;
  if (Math.abs(d) < 1e-9) return { text: `± 0${unit}`, tone: '' };
  return { text: `${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}${unit}`, tone: d > 0 ? 'good' : 'bad' };
}

/**
 * 「？」を押したときだけ出る説明（details/summary。キーボードでも開ける）
 */
export function help(body: string | HTMLElement, label = '説明'): HTMLElement {
  return h('details', { class: 'help', 'data-guest-ok': '1' }, h('summary', { 'aria-label': label, title: label }, '？'), h('div', { class: 'help-body' }, body));
}

/** カードの見出し（右に「？」の説明） */
export function cardHead(title: string, helpText?: string | HTMLElement | null): HTMLElement {
  return h('div', { class: 'card-head' }, h('h4', null, title), helpText ? help(helpText, `${title}の説明`) : null);
}

export interface FlowPart {
  label: string;
  value: number;
  color: string;
}

/** お金の流れの帯: 純売上を 100% として、費用の内訳と利益（赤字なら赤字の分を右に）を並べる */
export function flowBar(parts: FlowPart[], profit: number): HTMLElement {
  const costs = parts.filter((p) => p.value > 0);
  const total = Math.max(1, costs.reduce((a, p) => a + p.value, 0) + Math.max(0, profit));
  const seg = (label: string, value: number, color: string, cls = '') =>
    h('div', { class: `flow-seg ${cls}`, style: { width: `${(value / total) * 100}%`, background: color }, title: `${label} ${yenSigned(value)}` }, value / total >= 0.12 ? label : '');
  return h(
    'div',
    { class: 'flow-bar', role: 'img', 'aria-label': `お金の流れ: ${costs.map((p) => `${p.label} ${yenSigned(p.value)}`).join('、')}、利益 ${yenSigned(profit, true)}` },
    costs.map((p) => seg(p.label, p.value, p.color)),
    profit > 0 ? seg('利益', profit, 'var(--good)', 'profit') : null,
  );
}

/** 2週間の利益の棒（0 の線から上が黒字・下が赤字） */
export function profitBars(rows: { day: number; value: number }[]): HTMLElement {
  if (rows.length === 0) return h('p', { class: 'note' }, '営業日の利益の推移がここに出ます');
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const reds = rows.filter((r) => r.value < 0).length;
  return h(
    'div',
    { class: 'pbars-wrap' },
    h(
      'div',
      { class: 'pbars', role: 'img', 'aria-label': `直近${rows.length}日の営業利益（赤字${reds}日）` },
      rows.map((r) =>
        h(
          'div',
          { class: 'pbar-col', title: `${r.day}日目 ${yenSigned(r.value, true)}` },
          h('div', { class: 'pbar-half up' }, r.value > 0 ? h('div', { class: 'pbar good', style: { height: `${(r.value / max) * 100}%` } }) : null),
          h('div', { class: 'pbar-half down' }, r.value < 0 ? h('div', { class: 'pbar bad', style: { height: `${(-r.value / max) * 100}%` } }) : null),
        ),
      ),
    ),
    h('div', { class: 'pbars-axis' }, h('span', null, `${rows[0]!.day}日目`), h('span', null, `黒字 ${rows.length - reds}日・赤字 ${reds}日`), h('span', null, `${rows[rows.length - 1]!.day}日目`)),
  );
}

/** 気をつけること（色付きの短い文。ボタンを付けられる） */
export function alertBox(level: 'bad' | 'warn' | 'info' | 'good', text: string, action?: HTMLElement | null): HTMLElement {
  return h('div', { class: `alert ${level}` }, h('span', null, text), action ?? null);
}

/** 割合の横棒（0〜1）。シェア・冷蔵庫の使用率など */
export function meterBar(ratio: number, tone: Tone = 'accent', label?: string): HTMLElement {
  const r = Math.max(0, Math.min(1, ratio));
  return h('div', { class: `mbar tone-${tone}`, role: 'img', 'aria-label': label ?? `${Math.round(r * 100)}%` }, h('div', { class: 'mbar-fill', style: { width: `${r * 100}%` } }));
}
