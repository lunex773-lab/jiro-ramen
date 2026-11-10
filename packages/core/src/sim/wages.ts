// 給料（じろ1 5.7。オーナーの指示「最低賃金を参考に見直す。最低賃金を下回らない」）。
// 時給 = 店の都道府県の地域別最低賃金（令和8年度。data/regional.ts）× 担当 ×（1 + 能力 + 経験）× 人ごとの少しのばらつき。
// 場所のない店（前のセーブの1店目など）は全国加重平均。

import { BALANCE } from '../data/balance';
import { NATIONAL_ECONOMY, PREFECTURE_ECONOMY } from '../data/regional';
import type { EmployeeRole, GameState } from '../types';
import { activeStore } from './company';

/** 市区町村のコード（5桁）の都道府県の最低賃金（円/時）。場所がなければ全国加重平均 */
export function minWageOf(location: string | null | undefined): number {
  const pref = typeof location === 'string' && location.length >= 2 ? location.slice(0, 2) : null;
  return (pref ? PREFECTURE_ECONOMY[pref]?.minWage : undefined) ?? NATIONAL_ECONOMY.minWage;
}

/** 今いる店の最低賃金（円/時） */
export function storeMinWage(s: GameState): number {
  return minWageOf(s.company ? activeStore(s).location : null);
}

/**
 * 時給の相場。ability = 担当の仕事に効く能力の平均（0〜1）、experience = 経験（0〜）、u = 人ごとのばらつき（0〜1）。
 * 10円単位に切り上げ、最低賃金を下回らない
 */
export function marketHourly(minWage: number, role: EmployeeRole, ability: number, experience: number, u: number): number {
  const W = BALANCE.staff.pay;
  const v =
    minWage *
    (W.roleFactor[role] ?? 1) *
    (1 + W.abilitySlope * Math.max(0, Math.min(1, ability)) + W.experienceSlope * Math.max(0, experience)) *
    (1 + W.spread * (2 * Math.max(0, Math.min(1, u)) - 1));
  return Math.max(minWage, Math.ceil(v / 10) * 10);
}

/**
 * 今いる従業員の給料が、店の都道府県の最低賃金を下回っていたら上げる（下げることはしない。じろ1 7章 Q6）。
 * アルバイトは時給、社員・シフトリーダーは日給（仕込みから閉店まで働いた時間 × 最低賃金）を下回らないようにする。上げた人の数を返す
 */
export function applyWageFloor(s: GameState): number {
  const min = storeMinWage(s);
  const hours = BALANCE.staff.employment.fullShiftHours;
  let n = 0;
  for (const e of s.employees) {
    const p = e.profile;
    // 給与0の人は店主の代わり（測定・テストのボット）なので払わない
    if (p.wage <= 0 && (p.hourly ?? 0) <= 0) continue;
    if ((p.hourly ?? 0) > 0 && p.hourly! < min) {
      p.hourly = min;
      n += 1;
    }
    if (p.employment === 'full' && p.wage < min * hours) {
      p.wage = Math.ceil((min * hours) / 10) * 10;
      n += 1;
    }
  }
  return n;
}
