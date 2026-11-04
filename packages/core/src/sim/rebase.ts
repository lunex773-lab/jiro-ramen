// 会社のゲーム内の暦をずらす（育てた会社で別の市場に入るとき。オーナーの判断 15「入る市場の日付に合わせる」）。
// お金・店・従業員・在庫・評判・日報はそのままで、日付を表す値（キーが day または …Day のもの）を同じ日数だけずらす。
// 0以下の値（「まだない」を表す印・練習の日）はずらさない。日にちごとのシフト（dateShifts）はキーの日付をずらす。
// 日付ではない …Day の値（1日の最高の杯数・利益、その日の始めの現金）はずらさない。

import type { GameState } from '../types';

/** 名前は …Day だが日付ではない値 */
const NOT_DATES = new Set(['bestDayServed', 'bestDayProfit', 'cashAtDayStart']);

const isDayKey = (k: string) => (k === 'day' || /[a-z]Day$/.test(k)) && !NOT_DATES.has(k);

function walk(v: unknown, delta: number): void {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, delta);
    return;
  }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const x = o[k];
    if (typeof x === 'number') {
      if (isDayKey(k) && Number.isFinite(x) && x >= 1) o[k] = x + delta;
      continue;
    }
    if (k === 'dateShifts' && x && typeof x === 'object' && !Array.isArray(x)) {
      const map = x as Record<string, unknown>;
      const next: Record<string, unknown> = {};
      for (const [day, sh] of Object.entries(map)) next[String(Number(day) + delta)] = sh;
      o[k] = next;
      continue;
    }
    walk(x, delta);
  }
}

/** 会社の暦を delta 日ずらす（state を書き換える） */
export function shiftGameDays(s: GameState, delta: number): void {
  if (!Number.isInteger(delta) || delta === 0) return;
  walk(s, delta);
}
