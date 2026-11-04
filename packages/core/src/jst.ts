// 日本時間（JST, Asia/Tokyo）の日付と期間（共通市場・ランキング。MARKET_RANKING_PLAN.md）。
// サーバーは UTC のミリ秒で時刻を持ち、期間の境界はここだけで計算する（端末の時刻は使わない）。
// 日本は1951年から夏時間がないので、UTC+9 の固定で正しい（Intl のタイムゾーン表に頼らない）。

export const JST_OFFSET_MS = 9 * 3_600_000;
export const DAY_MS = 86_400_000;

/** 期間ID（JST の日付）。例: '2026-11-04' */
export type DateKey = string;

export interface JstParts {
  year: number;
  /** 1〜12 */
  month: number;
  /** 1〜31 */
  day: number;
  /** 0 = 日曜 … 6 = 土曜 */
  weekday: number;
  hour: number;
  minute: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function jstParts(ms: number): JstParts {
  const d = new Date(ms + JST_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** その時刻の JST の日付（期間ID） */
export function jstDateKey(ms: number): DateKey {
  const p = jstParts(ms);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(v: unknown): v is DateKey {
  if (typeof v !== 'string') return false;
  const m = KEY_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

function parseKey(key: DateKey): { y: number; m: number; d: number } {
  const r = KEY_RE.exec(key);
  if (!r) throw new Error(`bad date key: ${key}`);
  return { y: Number(r[1]), m: Number(r[2]), d: Number(r[3]) };
}

/** その日付の JST 0:00 の時刻（UTC のミリ秒） */
export function jstMidnight(key: DateKey): number {
  const { y, m, d } = parseKey(key);
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}

/** ms より後の、いちばん近い JST 0:00（ms がちょうど 0:00 なら次の日の 0:00） */
export function nextJstMidnight(ms: number): number {
  return jstMidnight(jstDateKey(ms)) + DAY_MS;
}

/** 日付を n 日ずらす */
export function addDays(key: DateKey, n: number): DateKey {
  return jstDateKey(jstMidnight(key) + n * DAY_MS);
}

/** a から b まで何日か（b が後なら正） */
export function daysBetween(a: DateKey, b: DateKey): number {
  return Math.round((jstMidnight(b) - jstMidnight(a)) / DAY_MS);
}

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, month: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** その日付の曜日（0 = 日曜） */
export function weekdayOfKey(key: DateKey): number {
  return jstParts(jstMidnight(key)).weekday;
}

// ───────────────────────── ランキングの期間 ─────────────────────────

export type RankScope = 'week' | 'month' | 'year' | 'total';
export const RANK_SCOPES: readonly RankScope[] = ['week', 'month', 'year', 'total'];

/** 週の初日（JST の月曜日） */
export function weekStart(key: DateKey): DateKey {
  const wd = weekdayOfKey(key);
  return addDays(key, -((wd + 6) % 7));
}

/**
 * その日付が入るランキングの期間のキー。
 * 週は月曜日の日付（'W2026-11-02'）、月は 'M2026-11'、年は 'Y2026'、累計は 'T'
 */
export function scopeKey(scope: RankScope, key: DateKey): string {
  if (scope === 'week') return `W${weekStart(key)}`;
  if (scope === 'month') return `M${key.slice(0, 7)}`;
  if (scope === 'year') return `Y${key.slice(0, 4)}`;
  return 'T';
}

export function scopeKeys(key: DateKey): Record<RankScope, string> {
  return { week: scopeKey('week', key), month: scopeKey('month', key), year: scopeKey('year', key), total: 'T' };
}

/** 期間のキーの最初と最後の日付（累計は null） */
export function scopeRange(periodKey: string): { from: DateKey; to: DateKey } | null {
  if (periodKey.startsWith('W')) {
    const from = periodKey.slice(1);
    return { from, to: addDays(from, 6) };
  }
  if (periodKey.startsWith('M')) {
    const [y, m] = periodKey.slice(1).split('-').map(Number) as [number, number];
    return { from: `${pad(y, 4)}-${pad(m)}-01`, to: `${pad(y, 4)}-${pad(m)}-${pad(daysInMonth(y, m))}` };
  }
  if (periodKey.startsWith('Y')) {
    const y = periodKey.slice(1);
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  return null;
}

/** ひとつ前の期間のキー（前の期間との順位の変動に使う。累計は null） */
export function previousScopeKey(periodKey: string): string | null {
  const r = scopeRange(periodKey);
  if (!r) return null;
  const before = addDays(r.from, -1);
  const scope: RankScope = periodKey.startsWith('W') ? 'week' : periodKey.startsWith('M') ? 'month' : 'year';
  return scopeKey(scope, before);
}
