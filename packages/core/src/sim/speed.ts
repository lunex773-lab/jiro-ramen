// ゲームの速度（倍速）の決まり（オーナーの判断 2026-11-13）。
// 店で珍しいことが起きている間は倍速を解除する（設定でオフにできる。初期はオン）。起きたら解除し、終わるまでその速さより上げられない。
// どのイベントで解除するか・解除したときの速さ（等倍 / 2倍）は設定で選べる（オーナーの指示 2026-11-13）。
// 解除したときの速さより遅く遊んでいるとき（×1 で 2倍を選んだ など）は、そのまま。
// 爆発事故の火事・武器の事件の間は、設定に関係なくいつも等倍（armory.ts の speedLocked。オーナーの指示 2026-11-11）。

import type { Customer, GameState, SpecialKind } from '../types';
import { speedLocked } from './armory';

/** 倍速を解除するイベントの種類（設定で選べる） */
export type SlowEventKey = 'chaos' | 'youtuber' | 'tv' | 'critic' | 'rare' | 'buzz' | 'complaint' | 'request';

/** 設定の画面に出す順 */
export const SLOW_EVENTS: readonly { key: SlowEventKey; label: string }[] = [
  { key: 'chaos', label: '珍客イベント' },
  { key: 'youtuber', label: 'YouTuber' },
  { key: 'tv', label: 'テレビ取材' },
  { key: 'critic', label: '覆面調査員' },
  { key: 'rare', label: '珍しいお客さん' },
  { key: 'buzz', label: 'SNS のバズ' },
  { key: 'complaint', label: 'クレーム' },
  { key: 'request', label: '確認待ち（撮影・取材の許可）' },
];

/** 倍速の解除の設定。events で false にした種類は解除しない（ない種類は解除する）。speed = 解除したときの速さ（1 か 2） */
export interface EventSlowConfig {
  on: boolean;
  events?: Partial<Record<SlowEventKey, boolean>>;
  speed?: number;
}

/** 倍速の上限（今の速さがこれより上なら、これに下げる） */
export interface SpeedLimit {
  cap: number;
  /** 何が起きているか（知らせに使う） */
  label: string;
  /** 画面に出す理由 */
  reason: string;
  /** 爆発事故・武器の事件（設定に関係なく等倍。速さのボタンは押せない） */
  hard: boolean;
}

const SPECIAL_KEY: Record<SpecialKind, SlowEventKey> = {
  critic: 'critic',
  couple_her: 'rare',
  couple_him: 'rare',
  ramen_lover: 'rare',
  youtuber: 'youtuber',
  tv_performer: 'tv',
  tv_camera: 'tv',
  tv_staff: 'tv',
  alien: 'chaos',
  golden: 'chaos',
  dancer: 'chaos',
  nosepicker: 'chaos',
  bear: 'chaos',
  quarreler: 'chaos',
};

const LABEL: Record<SlowEventKey, string> = {
  chaos: '珍客イベント',
  youtuber: 'YouTuber',
  tv: 'テレビ取材',
  critic: '覆面調査員',
  rare: '珍しいお客さん',
  buzz: 'SNS のバズ',
  complaint: 'クレーム',
  request: '確認を待っています',
};

const gone = (c: Customer) => c.state === 'left' || c.state === 'abandoned' || c.state === 'dead';

/** 店で今起きている珍しいことの種類（起きた順ではなく、確認の順） */
export function activeSlowEvents(s: GameState): SlowEventKey[] {
  if (s.phase !== 'prep' && s.phase !== 'open' && s.phase !== 'closing') return [];
  const out: SlowEventKey[] = [];
  const add = (k: SlowEventKey) => {
    if (!out.includes(k)) out.push(k);
  };
  const ev = s.events;
  if (ev?.requests && ev.requests.length > 0) add('request');
  if (ev?.chaos?.active && ev.chaos.active.length > 0) add('chaos');
  if (ev?.buzz && s.phase === 'open' && s.openT >= ev.buzz.startT && s.openT < ev.buzz.endT) add('buzz');
  for (const c of s.customers) {
    if (gone(c)) continue;
    if (c.state === 'complaint') add('complaint');
    if (c.special) add(SPECIAL_KEY[c.special.kind] ?? 'rare');
  }
  return out;
}

/**
 * 店で起きている珍しいこと（設定で選んだ種類だけ。なければ null）: 撮影・取材の許可の確認・珍客イベント・SNS のバズ・
 * クレーム・YouTuber・テレビ取材・覆面調査員・珍しいお客さん（店にいる間）
 */
export function eventSpeedLock(s: GameState, events?: EventSlowConfig['events']): string | null {
  const k = activeSlowEvents(s).find((x) => events?.[x] !== false);
  return k ? LABEL[k] : null;
}

/** 解除したときの速さ（1 か 2） */
export function slowSpeedOf(cfg: EventSlowConfig): number {
  return cfg.speed === 2 ? 2 : 1;
}

/** 今の倍速の上限（上限がなければ null） */
export function speedLimit(s: GameState, cfg: EventSlowConfig | boolean): SpeedLimit | null {
  if (speedLocked(s)) {
    const label = s.events?.accident ? '事故' : '事件';
    return { cap: 1, label, reason: `${label}の間は倍速にできません`, hard: true };
  }
  const c: EventSlowConfig = typeof cfg === 'boolean' ? { on: cfg } : cfg;
  if (!c.on) return null;
  const label = eventSpeedLock(s, c.events);
  if (!label) return null;
  const cap = slowSpeedOf(c);
  return { cap, label, reason: cap <= 1 ? `${label}の間は倍速にできません（設定で変えられます）` : `${label}の間は×${cap}までです（設定で変えられます）`, hard: false };
}

/**
 * 倍速にできない理由（できるなら null）。爆発事故・武器の事件はいつも。events が true（または設定）なら、珍しいことが起きている間も。
 * 解除したときの速さを2倍にしている設定では、×2 までは理由を返さない
 */
export function speedLockReason(s: GameState, events: EventSlowConfig | boolean): string | null {
  const l = speedLimit(s, events);
  return l && l.cap <= 1 ? l.reason : null;
}
