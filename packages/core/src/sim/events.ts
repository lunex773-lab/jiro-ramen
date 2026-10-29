// 営業中のイベントの共通部分（docs/SALES_IMPROVEMENT_IMPLEMENTATION_PLAN.md）。
// - 状態は GameState.events（古いセーブにはないので ensureEvents で補う）
// - 抽選はイベント専用の乱数（events.rng）で行い、イベントが起きない限り既存の乱数（s.rng）の並びを変えない
// - ここと visitors.ts / complaints.ts / accident.ts は状態とゲームへの影響だけを扱う。
//   演出（音・光・吹き出しの見た目）は client が状態と emit のイベントを読んで出すので、演出が失敗しても状態は壊れない
//
// 注意: client の共同経営の複製（サーバーから配られた状態）では ensureEvents を呼ばないこと（状態がずれる）。読むだけなら s.events?.… を使う。

import type { EventKind, EventStat, GameState, ShopEvents } from '../types';
import { hashString, rand } from '../util';
import { BALANCE } from '../data/balance';

/** イベントの種類（設定値・記録・強制発生のキー） */
export const EVENT_KINDS: readonly EventKind[] = ['sns_buzz', 'critic', 'rare_couple', 'rare_lover', 'complaint_unreasonable', 'explosion'];

export function newEvents(seed: number): ShopEvents {
  return {
    rng: (hashString(`events:${seed}`) ^ 0x9e3779b9) >>> 0,
    stats: {},
    daily: { day: -1, counts: {} },
    buzz: null,
    nextBuzzCheck: BALANCE.events.buzz.checkEvery,
    criticPlan: null,
    critics: [],
    effects: [],
    unreasonableAt: -1e9,
    forced: [],
    accidentDrawDay: -1,
    accidentPlan: null,
    accident: null,
    resets: 0,
  };
}

/** イベントの状態。なければ作る（シミュレーションの中でだけ呼ぶ） */
export function ensureEvents(s: GameState): ShopEvents {
  if (!s.events) s.events = newEvents(s.seed);
  return s.events;
}

/** イベント専用の乱数 0..1 */
export function evRand(s: GameState): number {
  return rand(ensureEvents(s));
}

/** その日にイベントを起こしてよいか（チュートリアル中は起こさない） */
export function eventsAllowed(s: GameState, minDay: number): boolean {
  return !s.tutorial && s.day >= minDay && s.phase !== 'bankrupt';
}

function stat(ev: ShopEvents, kind: EventKind): EventStat {
  const st = (ev.stats[kind] ??= { draws: 0, fired: 0, forced: 0, lastDay: -1 });
  st.forced ??= 0;
  return st;
}

/** 抽選した回数を数える */
export function noteDraw(s: GameState, kind: EventKind): void {
  stat(ensureEvents(s), kind).draws += 1;
}

/** 発生を記録する（forced = テスト用の強制発生） */
export function noteFire(s: GameState, kind: EventKind, forced = false): void {
  const st = stat(ensureEvents(s), kind);
  st.fired += 1;
  if (forced) st.forced += 1;
  st.lastDay = s.day;
}

/** 最後に起きた日から days 日より後か（一度も起きていなければ true） */
export function cooledDown(s: GameState, kind: EventKind, days: number): boolean {
  const st = s.events?.stats[kind];
  return !st || st.lastDay < 0 || s.day - st.lastDay > days;
}

/** その日に起きた回数（日が変わると 0） */
export function dailyCount(s: GameState, key: string): number {
  const ev = ensureEvents(s);
  if (ev.daily.day !== s.day) ev.daily = { day: s.day, counts: {} };
  return ev.daily.counts[key] ?? 0;
}

export function addDaily(s: GameState, key: string): void {
  const n = dailyCount(s, key);
  s.events!.daily.counts[key] = n + 1;
}

/** テスト用に予約した強制発生を取り出す（あれば true） */
export function takeForced(s: GameState, kind: EventKind): boolean {
  const ev = ensureEvents(s);
  const i = ev.forced.indexOf(kind);
  if (i < 0) return false;
  ev.forced.splice(i, 1);
  return true;
}

/** イベントによる来客の倍率（SNS バズ・覆面調査員の記事の反響）。読むだけ */
export function eventDemandFactor(s: GameState): number {
  const ev = s.events;
  if (!ev) return 1;
  let f = 1;
  if (ev.buzz && s.phase === 'open' && s.openT >= ev.buzz.startT && s.openT < ev.buzz.endT) f *= ev.buzz.mult;
  for (const e of ev.effects) if (e.untilDay >= s.day) f *= e.mult;
  return f;
}

/** 爆発事故で店が壊滅している（営業処理を止める）。読むだけ */
export function accidentHalted(s: GameState): boolean {
  return s.events?.accident?.stage === 'destroyed';
}
