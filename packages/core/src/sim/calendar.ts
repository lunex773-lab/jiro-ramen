// ゲームの暦と、曜日・季節の需要（共通市場の仕様書 4.2。オーナーの判断 11: 小さめの振れ幅・平均の客数は変えない）。
// ゲームの1日目 = 4月1日（月曜日）。1年 = 365日（閏年はない）でめぐる。曜日は weekdayOf（月=0 … 日=6）と同じ。
// 需要の倍率は、曜日は1週間の平均が1、季節は1年の平均が1になるようにしてある（ばらつきだけで、平均の客数は変わらない）。

import { BALANCE } from '../data/balance';
import { WEEKDAY_LABEL, weekdayOf } from './staff';

/** 4月から3月までの日数 */
const MONTH_DAYS = [30, 31, 30, 31, 31, 30, 31, 30, 31, 31, 28, 31] as const;
const MONTH_NUM = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3] as const;
export const YEAR_DAYS = 365;

export interface GameDate {
  /** 何年目か（1から） */
  year: number;
  /** 月（1〜12） */
  month: number;
  /** 日（1〜31） */
  date: number;
  /** 曜日（月=0 … 日=6） */
  weekday: number;
  /** 4月1日からの日数（0〜364） */
  doy: number;
}

/** ゲーム内の日（1日目 = 1年目の4月1日）の暦。0日目（練習の日）は前の年の3月31日として扱う */
export function gameDate(day: number): GameDate {
  const n = day - 1;
  const doy = ((n % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
  const year = Math.floor(n / YEAR_DAYS) + 1;
  let rest = doy;
  let i = 0;
  while (rest >= MONTH_DAYS[i]!) {
    rest -= MONTH_DAYS[i]!;
    i += 1;
  }
  return { year, month: MONTH_NUM[i]!, date: rest + 1, weekday: weekdayOf(day), doy };
}

/** 「4月1日（月）」 */
export function dateLabel(day: number): string {
  const g = gameDate(day);
  return `${g.month}月${g.date}日（${WEEKDAY_LABEL[g.weekday]}）`;
}

/** 季節（春・夏・秋・冬） */
export function seasonName(day: number): string {
  const m = gameDate(day).month;
  return m >= 3 && m <= 5 ? '春' : m >= 6 && m <= 8 ? '夏' : m >= 9 && m <= 11 ? '秋' : '冬';
}

/** 曜日の需要の倍率（1週間の平均が1） */
export function weekdayDemand(day: number): number {
  const w = BALANCE.calendar.weekdayDemand;
  const sum = w.reduce((a, b) => a + b, 0);
  return (w[weekdayOf(day)] ?? 1) * (w.length / sum);
}

/**
 * 季節の需要の倍率（1年の平均が1）。ラーメンは寒い時期によく売れ、暑い時期に落ちる:
 * 1 + 振れ幅 × cos(2π ×（4月1日からの日数 − いちばん売れる日）÷ 365)
 */
export function seasonDemand(day: number): number {
  const c = BALANCE.calendar;
  const doy = gameDate(day).doy;
  return 1 + c.seasonAmp * Math.cos((2 * Math.PI * (doy - c.seasonPeakDoy)) / YEAR_DAYS);
}

/** 暦による需要の倍率（曜日 × 季節）。0日目（練習の日）は1 */
export function calendarDemand(day: number): number {
  if (day <= 0) return 1;
  return weekdayDemand(day) * seasonDemand(day);
}
