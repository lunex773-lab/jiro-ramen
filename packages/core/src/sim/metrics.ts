// ランキングの種別のうち、今までのゲームにはなかった数値（共通市場の仕様書 5.3。オーナーの判断 6「新しく作る」）。
// どれも 0〜1 の値か金額で、根拠のない重みを使わない（いくつかの値を合わせるときは同じ重みで平均する）。
//
//   従業員満足度 = 全店の従業員の満足度（moraleOf。希望外の日の勤務・疲れで下がる）の平均。従業員がいなければ値なし
//   店舗品質     = 店ごとに「評判 ÷ 5」「設備の状態の平均（0〜1）」「清潔さ（1 − 席と厨房の汚れの平均）」を同じ重みで平均し、全店で平均
//   企業価値     = 純資産 = 現金 − 借入の残り − 未払金 ＋ 設備の売却価値 ＋ 在庫の価値（借入で増えた現金は借入の残りと打ち消すので、借入で水増しできない）

import { STAGES } from '../data/stages';
import type { Employee, GameState, StoreEntry } from '../types';
import { clamp01 } from '../util';
import { resaleValue } from './equipment';
import { moraleOf } from './staff';

type StoreParts = Pick<GameState, 'employees' | 'equipment' | 'inventory' | 'deliveries' | 'reputation' | 'seats' | 'kitchenGrime'> & { stage: number };

function partsOf(s: GameState, entry: StoreEntry): StoreParts {
  if (entry.id === s.company.activeStoreId || !entry.snapshot) {
    return { employees: s.employees, equipment: s.equipment, inventory: s.inventory, deliveries: s.deliveries, reputation: s.reputation, seats: s.seats, kitchenGrime: s.kitchenGrime, stage: s.career.stage };
  }
  const p = entry.snapshot;
  return { employees: p.employees, equipment: p.equipment, inventory: p.inventory, deliveries: p.deliveries, reputation: p.reputation, seats: p.seats, kitchenGrime: p.kitchenGrime, stage: p.stage };
}

/** 従業員満足度（0〜1）。従業員がいなければ null */
export function employeeSatisfaction(s: GameState): number | null {
  const all: Employee[] = [];
  for (const entry of s.company.stores) all.push(...partsOf(s, entry).employees.filter((e) => !e.profile.temp));
  if (all.length === 0) return null;
  return all.reduce((a, e) => a + moraleOf(e), 0) / all.length;
}

/** その店の品質（0〜1）: 評判・設備の状態・清潔さを同じ重みで平均 */
export function storeQualityOf(p: StoreParts): number {
  const rep = clamp01(p.reputation / 5);
  const placed = p.equipment.filter((e) => e.placed);
  const cond = placed.length > 0 ? placed.reduce((a, e) => a + clamp01(e.condition / 100), 0) / placed.length : 1;
  const seats = p.seats.filter((x) => x.installed && x.index < (STAGES[p.stage]?.seats.length ?? 0));
  const seatDirt = seats.length > 0 ? seats.reduce((a, x) => a + clamp01(x.dirt), 0) / seats.length : 0;
  const clean = clamp01(1 - (seatDirt + clamp01(p.kitchenGrime)) / 2);
  return (rep + cond + clean) / 3;
}

/** 店舗品質（0〜1。全店の平均） */
export function storeQuality(s: GameState): number {
  const qs = s.company.stores.map((entry) => storeQualityOf(partsOf(s, entry)));
  return qs.reduce((a, b) => a + b, 0) / Math.max(1, qs.length);
}

/** 企業価値（純資産。円） */
export function enterpriseValue(s: GameState): number {
  let assets = s.money;
  for (const entry of s.company.stores) {
    const p = partsOf(s, entry);
    for (const e of p.equipment) assets += resaleValue(e);
    for (const l of p.inventory) assets += l.qty * l.unitCost;
    for (const d of p.deliveries) assets += d.qty * d.unitCost;
  }
  const debt = s.loans.reduce((a, l) => a + l.remaining, 0) + s.arrears.reduce((a, x) => a + x.amount, 0);
  return Math.round(assets - debt);
}
