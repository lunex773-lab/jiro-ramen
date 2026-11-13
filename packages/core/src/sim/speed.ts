// ゲームの速度（倍速）の決まり（オーナーの判断 2026-11-13）。
// 店で決まったイベントが起きている間は倍速を解除する（設定でオフにできる。初期はオン）。起きたら解除し、終わるまでその速さより上げられない。
// 解除するイベントはオーナーが選んだもの（UFO・金色覚醒・横バウンス・クマ・YouTuber・テレビ取材・撮影や取材の許可の確認待ち）。
// 設定の画面にはイベントの名前を出さない（ネタバレになる。オーナーの指示 2026-11-13）。
// 解除したときの速さは設定で等倍か2倍。それより遅く遊んでいるとき（×1 で 2倍を選んだ など）は、そのまま。
// 爆発事故の火事・武器の事件の間は、設定に関係なくいつも等倍（armory.ts の speedLocked。オーナーの指示 2026-11-11）。

import type { ChaosKind, Customer, GameState, SpecialKind } from '../types';
import { speedLocked } from './armory';

/** 倍速を解除するイベントの種類 */
export type SlowEventKey = 'ufo' | 'golden' | 'bounce' | 'bear' | 'youtuber' | 'tv' | 'request';

/** 解除するイベント（オーナーが選んだもの。2026-11-13） */
export const SLOW_EVENT_KEYS: readonly SlowEventKey[] = ['ufo', 'golden', 'bounce', 'bear', 'youtuber', 'tv', 'request'];

/** 倍速の解除の設定。speed = 解除したときの速さ（1 か 2） */
export interface EventSlowConfig {
  on: boolean;
  speed?: number;
}

/** 倍速の上限（今の速さがこれより上なら、これに下げる） */
export interface SpeedLimit {
  cap: number;
  /** 何が起きているか（知らせに使う。起きているときだけ出る） */
  label: string;
  /** 画面に出す理由 */
  reason: string;
  /** 爆発事故・武器の事件（設定に関係なく等倍。速さのボタンは押せない） */
  hard: boolean;
}

/** 珍客イベントのうち、解除するもの（鼻ほじり・口論は解除しない） */
const CHAOS_KEY: Partial<Record<ChaosKind, SlowEventKey>> = { ufo: 'ufo', golden: 'golden', bounce: 'bounce', bear: 'bear' };

/** 店にいる珍しい客のうち、解除するもの（覆面調査員・珍しいお客さん・鼻ほじり・口論は解除しない） */
const SPECIAL_KEY: Partial<Record<SpecialKind, SlowEventKey>> = {
  youtuber: 'youtuber',
  tv_performer: 'tv',
  tv_camera: 'tv',
  tv_staff: 'tv',
  alien: 'ufo',
  golden: 'golden',
  dancer: 'bounce',
  bear: 'bear',
};

const LABEL: Record<SlowEventKey, string> = {
  ufo: '珍客イベント',
  golden: '珍客イベント',
  bounce: '珍客イベント',
  bear: '珍客イベント',
  youtuber: 'YouTuber',
  tv: 'テレビ取材',
  request: '確認を待っています',
};

const gone = (c: Customer) => c.state === 'left' || c.state === 'abandoned' || c.state === 'dead';

/** 店で今起きている、倍速を解除するイベント（確認の順） */
export function activeSlowEvents(s: GameState): SlowEventKey[] {
  if (s.phase !== 'prep' && s.phase !== 'open' && s.phase !== 'closing') return [];
  const out: SlowEventKey[] = [];
  const add = (k: SlowEventKey | undefined) => {
    if (k && !out.includes(k)) out.push(k);
  };
  const ev = s.events;
  if (ev?.requests && ev.requests.length > 0) add('request');
  for (const run of ev?.chaos?.active ?? []) add(CHAOS_KEY[run.kind]);
  for (const c of s.customers) {
    if (gone(c) || !c.special) continue;
    add(SPECIAL_KEY[c.special.kind]);
  }
  return out;
}

/** 店で起きている、倍速を解除するイベント（なければ null） */
export function eventSpeedLock(s: GameState): string | null {
  const k = activeSlowEvents(s)[0];
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
  const label = eventSpeedLock(s);
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
