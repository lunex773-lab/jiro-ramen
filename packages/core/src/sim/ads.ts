// 広告（共通市場の仕様書 4.3「広告予算」。オーナーの判断 14「控えめ」）。
// 店ごとの方針の1日の広告費を、開店のとき（1日単位の計算では営業の前）に払い、その日の来客が増える。払えなければその日は出さない。

import { BALANCE } from '../data/balance';
import type { GameState, StoreEntry } from '../types';
import { cash, emptyDayStats, recordPL } from './economy';

/** その日の広告費（円）による来客の倍率 */
export function adFactor(paid: number): number {
  const A = BALANCE.ads;
  if (!(paid > 0)) return 1;
  return 1 + A.max * (1 - Math.exp(-paid / A.k));
}

/** 店の方針の1日の広告費 */
export function adBudgetOf(entry: StoreEntry): number {
  const b = entry.policy.adBudget ?? 0;
  return Number.isFinite(b) && b > 0 ? Math.round(b) : 0;
}

/** その日の広告費を払う（店の中身が GameState にある状態で。二度は払わない）。払った額を返す */
export function payAds(s: GameState, entry: StoreEntry, day: number): number {
  const budget = adBudgetOf(entry);
  if (budget <= 0 || (s.today.ads ?? 0) > 0) return s.today.ads ?? 0;
  if (s.money < budget) return 0;
  if (!cash(s, 'advertising', -budget, `${entry.name}の広告費（${day}日目）`, `ad:${entry.id}:${day}`)) return 0;
  recordPL(s, 'ads', budget);
  return budget;
}

/** 広告費を払ったとみなして計算する（店の見込み・客の取り合いの計算用。お金は動かさない） */
export function withPlannedAds<T>(s: GameState, entry: StoreEntry, fn: () => T): T {
  const keep = s.today;
  s.today = { ...emptyDayStats(), ads: s.money >= adBudgetOf(entry) ? adBudgetOf(entry) : 0 };
  try {
    return fn();
  } finally {
    s.today = keep;
  }
}
