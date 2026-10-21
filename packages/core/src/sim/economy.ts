// 経済（設計書 14）。
// 現金の動き（キャッシュフロー）と損益（P/L）を分けて記録する。
//  - 食材の購入: 現金だけ減る（在庫という資産に変わる）
//  - 食材の使用: 提供時に売上原価、廃棄時に廃棄損として P/L に計上
//  - 設備購入: 現金だけ減る（投資）
// 同じ key の現金取引は一度しか適用しない（二重計上・二重支払いの防止）。

import type { DayStats, GameState, TxnType } from '../types';
import { newId, yen } from '../util';

export function emptyDayStats(): DayStats {
  return {
    sales: 0, refunds: 0, cogs: 0, waste: 0, wages: 0, rent: 0, upkeep: 0, utilities: 0, repairs: 0,
    hiring: 0, interest: 0, purchases: 0, capex: 0,
    served: 0, customers: 0, lost: 0, balked: 0, totalSeatWait: 0, totalQueueWait: 0,
    satisfactionSum: 0, satisfactionCount: 0, mistakes: 0, stockouts: 0, complaints: 0, breakdowns: 0, remakes: 0,
    wasteItems: {},
  };
}

/** 営業利益 = 売上 − 返金 − 原価 − 廃棄 − 人件費 − 家賃 − 維持費 − 光熱費 − 修理費 − 採用費 − 利息 */
export function operatingProfit(d: DayStats): number {
  return d.sales - d.refunds - d.cogs - d.waste - d.wages - d.rent - d.upkeep - d.utilities - d.repairs - d.hiring - d.interest;
}

const TXN_KEEP_DAYS = 2;

export function hasTxn(s: GameState, key: string): boolean {
  return s.transactions.some((t) => t.key === key);
}

/**
 * 現金を動かす。amount は増加なら正、支出なら負。
 * 残高不足の支出は allowNegative=false なら失敗（false を返し何も変えない）。
 */
export function cash(
  s: GameState,
  type: TxnType,
  amount: number,
  memo: string,
  key: string | null = null,
  allowNegative = false,
): boolean {
  const amt = yen(amount);
  const k = key ?? newId(s, 'tx');
  if (key !== null && hasTxn(s, key)) return false;
  if (amt < 0 && !allowNegative && s.money + amt < 0) return false;
  s.money += amt;
  s.transactions.push({ id: newId(s, 'T'), day: s.day, t: Math.round(s.t * 10) / 10, type, amount: amt, memo, key: k });
  // 古い取引は日次レポートに集計済みなので捨てる
  const minDay = s.day - TXN_KEEP_DAYS;
  if (s.transactions.length > 400 || (s.transactions[0] && s.transactions[0].day < minDay)) {
    s.transactions = s.transactions.filter((t) => t.day >= minDay).slice(-400);
  }
  return true;
}

export type PLField = 'sales' | 'refunds' | 'cogs' | 'waste' | 'wages' | 'rent' | 'upkeep' | 'utilities' | 'repairs' | 'hiring' | 'interest' | 'purchases' | 'capex';

/** 損益に計上する（現金は動かさない） */
export function recordPL(s: GameState, field: PLField, amount: number): void {
  s.today[field] = yen(s.today[field] + amount);
}

/** 支払い（現金・P/L 両方）。資金不足なら false */
export function spend(s: GameState, type: TxnType, field: PLField, amount: number, memo: string, key: string | null = null): boolean {
  if (amount <= 0) return true;
  if (!cash(s, type, -amount, memo, key)) return false;
  recordPL(s, field, amount);
  return true;
}

export function totalDebt(s: GameState): number {
  return s.arrears.reduce((a, b) => a + b.amount, 0) + s.loans.reduce((a, b) => a + b.remaining, 0);
}
