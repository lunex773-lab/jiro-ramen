// 昼夜・星空の時刻と、地域の光害（じろ7 1）。3D の空と明かりは、ここで決めた値だけを使う（同じ計算を端末の別の場所に書かない）。
// - ゲーム内の時刻（0〜1440分）は、ゲームの場面から決める（現実の時刻とは関係ない）:
//     仕込み = 開店の前の朝（開店の90分前から、仕込みの時間が進むにつれて開店の直前まで）
//     中休み = 前の枠の閉店と次の枠の開店の間
//     営業中 = 時計の時刻（営業時間の枠・日またぎ）
//     閉店作業 = 閉店の時刻のすぐあと
//     閉店後（事務作業。時間は止まっている）= その日の夜（21時。閉店がもっと遅い店は閉店の30分後。オーナーの判断 Q5）
// - 月の満ち欠けはゲーム内の日付（29.5日で一巡り）
// - 光害（0〜1）は、店の周りの種類（都会・駅前・街・住宅街・郊外・田舎）と市区町村の人口密度から、同じ式で決める（地域ごとの個別の設定は作らない）

import type { GameState } from '../types';
import { activeStore } from './company';
import { clockMinuteAt, clockMinuteAtEnd, SEC_PER_MIN, sessionEndT, sessionIndex, todayHours } from './hours';
import { locationInfo, surroundingsOf, type Surroundings } from './location';

export const MINUTES_PER_DAY = 1440;
/** 仕込みの時間を、開店の何分前からとみなすか */
const PREP_LEAD_MIN = 90;
/** 閉店後（事務作業）の夜の時刻 */
const EVENING_MIN = 21 * 60;
/** 朔望月（日） */
export const LUNAR_DAYS = 29.53;

/** 0〜1440 に丸める */
function wrap(min: number): number {
  return ((min % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** 今のゲーム内の時刻（0〜1440分。0 = 0時）。空の色・太陽と月の位置・明かりはこの時刻で決める */
export function gameClockMinute(s: GameState): number {
  const h = todayHours(s);
  const sessions = h.sessions;
  const first = sessions[0];
  if (!first) return 12 * 60;
  const lastClose = sessions[sessions.length - 1]!.close;
  switch (s.phase) {
    case 'open':
      return wrap(clockMinuteAt(h, s.openT));
    case 'prep': {
      const idx = sessionIndex(s);
      if (idx > 0 && sessions[idx]) {
        // 中休み: 前の枠の閉店と次の枠の開店の間
        const prev = sessions[idx - 1]!;
        return wrap((prev.close + sessions[idx]!.open) / 2);
      }
      const elapsed = s.t / SEC_PER_MIN;
      return wrap(first.open - PREP_LEAD_MIN + Math.min(elapsed, PREP_LEAD_MIN - 5));
    }
    case 'closing':
      return wrap(clockMinuteAtEnd(h, sessionEndT(s)) + 10);
    case 'closed':
    case 'bankrupt':
    default:
      return wrap(Math.max(EVENING_MIN, lastClose + 30));
  }
}

/** 月齢（0 = 新月、0.5 = 満月、1 の手前で次の新月）。ゲーム内の日付から */
export function moonPhase(day: number): number {
  // 1日目を上弦の少し前（月齢およそ6日）にする
  return (((day + 6) % LUNAR_DAYS) + LUNAR_DAYS) % LUNAR_DAYS / LUNAR_DAYS;
}

/** 月の明るさ（0 = 新月 〜 1 = 満月） */
export function moonIllumination(phase: number): number {
  return (1 - Math.cos(phase * Math.PI * 2)) / 2;
}

/** 店の周りの種類ごとの光害のもと（街灯・窓・看板・道路の明るさ） */
const SURROUNDINGS_GLOW: Record<Surroundings, number> = {
  metro: 0.95,
  station: 0.8,
  town: 0.6,
  residential: 0.42,
  suburb: 0.3,
  rural: 0.06,
};

/**
 * 光害（0 = 真っ暗な田舎 〜 1 = 大都会の中心）。店の周りの種類（6割）と人口密度（4割）から。
 * 都会でも1にはせず（星は少し見える）、田舎でも0にはしない（遠くの明かり）
 */
export function lightPollution(s: GameState): number {
  const entry = s.company ? activeStore(s) : null;
  const kind = surroundingsOf(entry);
  const d = locationInfo(entry?.location)?.densityIndex ?? 0;
  const v = 0.6 * (SURROUNDINGS_GLOW[kind] ?? 0.6) + 0.4 * ((d + 1) / 2);
  return Math.min(0.97, Math.max(0.03, v));
}

/** 太陽の高さ（−1 〜 1。0 が地平線。日の出 5:30・日の入り 18:30 の簡単な形） */
export function sunHeight(minute: number): number {
  const rise = 5.5 * 60;
  const set = 18.5 * 60;
  const m = wrap(minute);
  if (m >= rise && m <= set) return Math.sin((Math.PI * (m - rise)) / (set - rise));
  // 夜は地平線の下（真夜中がいちばん低い）
  const night = MINUTES_PER_DAY - (set - rise);
  const t = m > set ? m - set : m + MINUTES_PER_DAY - set;
  return -Math.sin((Math.PI * t) / night);
}

/** 夜の度合い（0 = 昼 〜 1 = 夜。日の出・日の入りの前後で滑らかに変わる） */
export function nightness(minute: number): number {
  const h = sunHeight(minute);
  // 太陽が地平線の少し上（薄明）から少し下までで 0 → 1
  const x = (0.12 - h) / 0.32;
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** 空の時間帯の名前（画面に出す・テスト用） */
export function skyPeriod(minute: number): '深夜' | '夜明け前' | '朝焼け' | '朝' | '昼' | '夕方' | '夕焼け' | '日没' | '夜' {
  const m = wrap(minute);
  if (m < 4 * 60) return '深夜';
  if (m < 5 * 60) return '夜明け前';
  if (m < 6.5 * 60) return '朝焼け';
  if (m < 10 * 60) return '朝';
  if (m < 16 * 60) return '昼';
  if (m < 17.75 * 60) return '夕方';
  if (m < 18.5 * 60) return '夕焼け';
  if (m < 19.25 * 60) return '日没';
  if (m < 23 * 60) return '夜';
  return '深夜';
}

/** 空の状態（3D の描画に渡す） */
export interface SkyState {
  /** ゲーム内の時刻（分） */
  minute: number;
  period: ReturnType<typeof skyPeriod>;
  sunHeight: number;
  night: number;
  moonPhase: number;
  moonLight: number;
  lightPollution: number;
}

export function skyState(s: GameState): SkyState {
  const minute = gameClockMinute(s);
  const phase = moonPhase(s.day);
  return { minute, period: skyPeriod(minute), sunHeight: sunHeight(minute), night: nightness(minute), moonPhase: phase, moonLight: moonIllumination(phase), lightPollution: lightPollution(s) };
}
