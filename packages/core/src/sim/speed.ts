// ゲームの速度（倍速）の決まり（オーナーの判断 2026-11-13）。
// 店で珍しいことが起きている間は等倍にする（設定でオフにできる。初期はオン）。起きたら倍速を解除し、終わるまで倍速にできない。
// 爆発事故の火事・武器の事件の間は、設定に関係なくいつも等倍（armory.ts の speedLocked。オーナーの指示 2026-11-11）。

import type { Customer, GameState, SpecialKind } from '../types';
import { speedLocked } from './armory';

const SPECIAL_LABEL: Record<SpecialKind, string> = {
  critic: '覆面調査員',
  couple_her: '珍しいお客さん',
  couple_him: '珍しいお客さん',
  ramen_lover: '珍しいお客さん',
  youtuber: 'YouTuber',
  tv_performer: 'テレビ取材',
  tv_camera: 'テレビ取材',
  tv_staff: 'テレビ取材',
  alien: '珍客イベント',
  golden: '珍客イベント',
  dancer: '珍客イベント',
  nosepicker: '珍客イベント',
  bear: '珍客イベント',
  quarreler: '珍客イベント',
};

const gone = (c: Customer) => c.state === 'left' || c.state === 'abandoned' || c.state === 'dead';

/**
 * 店で起きている珍しいこと（起きている間は等倍。なければ null）: 撮影・取材の許可の確認・珍客イベント・SNS のバズ・
 * クレーム・YouTuber・テレビ取材・覆面調査員・珍しいお客さん（店にいる間）
 */
export function eventSpeedLock(s: GameState): string | null {
  if (s.phase !== 'prep' && s.phase !== 'open' && s.phase !== 'closing') return null;
  const ev = s.events;
  if (ev?.requests && ev.requests.length > 0) return '確認を待っています';
  if (ev?.chaos?.active && ev.chaos.active.length > 0) return '珍客イベント';
  if (ev?.buzz && s.phase === 'open' && s.openT >= ev.buzz.startT && s.openT < ev.buzz.endT) return 'SNS のバズ';
  for (const c of s.customers) {
    if (gone(c)) continue;
    if (c.state === 'complaint') return 'クレーム';
    if (c.special) return SPECIAL_LABEL[c.special.kind] ?? '珍しいお客さん';
  }
  return null;
}

/**
 * 倍速にできない理由（できるなら null）。爆発事故・武器の事件はいつも。events が true なら、珍しいことが起きている間も
 */
export function speedLockReason(s: GameState, events: boolean): string | null {
  if (speedLocked(s)) return s.events?.accident ? '事故の間は倍速にできません' : '事件の間は倍速にできません';
  if (!events) return null;
  const e = eventSpeedLock(s);
  return e ? `${e}の間は倍速にできません（設定で変えられます）` : null;
}
