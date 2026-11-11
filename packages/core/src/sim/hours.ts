// 営業時間（じろ1 5.1。オーナーの指示: 店ごとに開店・閉店の時刻、1日に複数の営業、曜日の定休日、日をまたぐ営業）。
// 時間の進み方は今のまま（ゲームの1分 = 2.25秒。×1で1時間 = 実時間2分15秒）。営業の経過秒（openT）は、その日の営業の枠をつないだ通しの秒。
// 枠と枠の間（中休み）は仕込みの時間と同じく時間が止まり、「開店する」で次の枠を始める。
// 店の設定（StoreEntry.hours）を変えたら、次の営業から（その日の最初の開店の前なら今日から）使う（GameState.todayHours）。

import { BALANCE } from '../data/balance';
import type { GameState, StoreHours } from '../types';
import { activeStore } from './company';

/** ゲームの1分あたりの営業の秒数（営業 11〜15時 = 540秒 → 2.25秒） */
export const SEC_PER_MIN = BALANCE.openDuration / ((BALANCE.closeHour - BALANCE.openHour) * 60);

/** 今までの営業時間（11:00〜15:00・定休日なし）。前のセーブはこれ */
export const DEFAULT_HOURS: StoreHours = { sessions: [{ open: BALANCE.openHour * 60, close: BALANCE.closeHour * 60 }], closedDays: [] };

const H = () => BALANCE.hours;

/** 今日の営業時間（その日の朝に決まる） */
export function todayHours(s: GameState): StoreHours {
  return s.todayHours ?? DEFAULT_HOURS;
}

/** 店の営業時間の設定 */
export function storeHours(s: GameState): StoreHours {
  return (s.company ? activeStore(s).hours : undefined) ?? DEFAULT_HOURS;
}

/** 営業の分の合計 */
export function openMinutesOf(h: StoreHours): number {
  return h.sessions.reduce((a, x) => a + (x.close - x.open), 0);
}

/** 今日の営業の秒数（全部の枠の合計） */
export function openDurationOf(s: GameState): number {
  return openMinutesOf(todayHours(s)) * SEC_PER_MIN;
}

/** 枠ごとの、通しの営業の秒での始まりと終わり */
export function sessionSpans(h: StoreHours): { startT: number; endT: number; open: number; close: number }[] {
  let t = 0;
  return h.sessions.map((x) => {
    const d = (x.close - x.open) * SEC_PER_MIN;
    const span = { startT: t, endT: t + d, open: x.open, close: x.close };
    t += d;
    return span;
  });
}

/** 今の枠（0〜） */
export function sessionIndex(s: GameState): number {
  return Math.max(0, Math.min(todayHours(s).sessions.length - 1, s.sessionIdx ?? 0));
}

/** 今の枠が終わる通しの秒 */
export function sessionEndT(s: GameState): number {
  return sessionSpans(todayHours(s))[sessionIndex(s)]?.endT ?? openDurationOf(s);
}

/** 通しの営業の秒 → その日の時刻（分。24時を超えることがある = 日をまたぐ） */
export function clockMinuteAt(h: StoreHours, openT: number): number {
  const spans = sessionSpans(h);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    // 最後の枠の終わり（閉店の時刻ちょうど）とそのあとは、最後の枠の閉店の時刻
    if (openT < sp.endT || i === spans.length - 1) return sp.open + (Math.max(sp.startT, Math.min(sp.endT, openT)) - sp.startT) / SEC_PER_MIN;
  }
  return h.sessions[0]?.open ?? BALANCE.openHour * 60;
}

/**
 * 終わりの時刻としての、その日の時刻（分）。枠の終わりちょうどは、次の枠の開店ではなくその枠の閉店の時刻
 * （シフトの「〜14:00」・休憩の「〜まで」の表示に使う）
 */
export function clockMinuteAtEnd(h: StoreHours, openT: number): number {
  const spans = sessionSpans(h);
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i]!;
    if (openT <= sp.endT || i === spans.length - 1) return sp.open + (Math.max(sp.startT, Math.min(sp.endT, openT)) - sp.startT) / SEC_PER_MIN;
  }
  return h.sessions[0]?.open ?? BALANCE.openHour * 60;
}

/** その日の時刻（分）の文字（25:30 → 「翌1:30」） */
export function clockText(min: number): string {
  const m = Math.round(min);
  const day = Math.floor(m / 1440);
  const hm = ((m % 1440) + 1440) % 1440;
  return `${day > 0 ? '翌' : ''}${Math.floor(hm / 60)}:${String(hm % 60).padStart(2, '0')}`;
}

/** その日が定休日か（曜日: 1日目 = 月曜 = 0） */
export function isClosedDay(h: StoreHours, day: number): boolean {
  const wd = (((day - 1) % 7) + 7) % 7;
  return h.closedDays.includes(wd);
}

/** 営業時間の設定を確かめる（正しければ null） */
export function hoursProblem(h: StoreHours): string | null {
  const L = H();
  if (!h || !Array.isArray(h.sessions) || !Array.isArray(h.closedDays)) return '営業時間の形が正しくありません';
  if (h.sessions.length < 1 || h.sessions.length > L.maxSessions) return `営業の枠は1〜${L.maxSessions}つです`;
  let prevClose = -Infinity;
  for (const x of h.sessions) {
    const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v % L.stepMin === 0;
    if (!ok(x.open) || !ok(x.close)) return `時刻は${L.stepMin}分刻みです`;
    if (x.open < 0 || x.open >= 1440) return '開店の時刻は0:00〜23:30です';
    if (x.close - x.open < L.minSessionMin) return `1つの枠は${L.minSessionMin / 60}時間以上にしてください`;
    if (x.open < prevClose + L.minBreakMin) return `枠と枠の間は${L.minBreakMin}分以上あけてください（時刻の早い順に）`;
    prevClose = x.close;
  }
  const first = h.sessions[0]!.open;
  if (prevClose - first > 24 * 60) return '最初の開店から最後の閉店までは24時間以内です';
  if (openMinutesOf(h) > L.maxOpenMin) return `営業は1日${L.maxOpenMin / 60}時間までです`;
  const days = new Set(h.closedDays);
  if (days.size !== h.closedDays.length || h.closedDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return '定休日の曜日が正しくありません';
  if (days.size >= 7) return '毎日を定休日にはできません';
  return null;
}

/** 深夜（22:00〜翌5:00）にかかる営業の分（深夜の割り増しの給料に使う） */
export function lateNightMinutes(h: StoreHours): number {
  let n = 0;
  for (const x of h.sessions) {
    for (let m = x.open; m < x.close; m += 30) {
      const hm = ((m % 1440) + 1440) % 1440;
      if (hm >= 22 * 60 || hm < 5 * 60) n += Math.min(30, x.close - m);
    }
  }
  return n;
}

/** 光熱費の基本（1日の固定分 + 営業1時間あたり。定休日は固定分だけ） */
export function utilitiesBaseOf(h: StoreHours, open: boolean): number {
  const L = H();
  return Math.round(L.utilitiesFixed + (open ? (L.utilitiesPerHour * openMinutesOf(h)) / 60 : 0));
}

/**
 * 時刻（その日の分。24時を超えてもよい）ごとの来客の倍率。昼の山（12:41ごろ）は今までの11〜15時の山と同じ形
 * （0.55 + 0.9 × 山）。夜の山（19:30ごろ）を足し、早朝・深夜は低くする。11〜15時の合計は今までと同じ（難易度を変えない）
 */
export function hourDemand(min: number): number {
  const m = ((min % 1440) + 1440) % 1440;
  let base: number;
  if (m >= 630 && m < 1290) base = 0.55; // 10:30〜21:30
  else if (m >= 1290) base = 0.55 - (0.25 * (m - 1290)) / 150; // 21:30〜24:00 → 0.3
  else if (m < 180) base = 0.3 - (0.2 * m) / 180; // 0:00〜3:00 → 0.1
  else if (m < 360) base = 0.1; // 3:00〜6:00
  else base = 0.1 + (0.45 * (m - 360)) / 270; // 6:00〜10:30 → 0.55
  const lunch = 0.9 * Math.exp(-(((m - 760.8) / 57.6) ** 2));
  const dinner = 0.75 * Math.exp(-(((m - 1170) / 80) ** 2));
  return base + lunch + dinner;
}

/**
 * 給料を払う時間（割り増しを足した時間）。hours = 働いた時間、lateHours = そのうち深夜（22:00〜翌5:00）の時間。
 * 6時間を超えると休憩45分・8時間を超えると60分（給与なし）、休憩を引いて8時間を超えた分は25%増し、深夜は25%増し（労働基準法の考え方）
 */
export function paidHoursWithPremium(hours: number, lateHours = 0): number {
  const L = H();
  const brk = hours > 8 ? L.breakOver8h : hours > 6 ? L.breakOver6h : 0;
  const work = Math.max(0, hours - brk);
  return work + L.overtimeRate * Math.max(0, work - L.overtimeAfterH) + L.lateNightRate * Math.min(work, Math.max(0, lateHours));
}

/** 今日の営業のうち深夜の割合（0〜1） */
export function lateNightShare(h: StoreHours): number {
  const m = openMinutesOf(h);
  return m > 0 ? lateNightMinutes(h) / m : 0;
}
