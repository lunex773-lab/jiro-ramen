// 会社と店舗（統合進化設計書 v2.1 Phase 2）。
// GameState はそのまま「プレイヤーがいる店」の状態として使い、その上に会社（店舗の一覧・会社の日報）を足す。
// お金・借入・未払金・キャリア（目標と解放）は会社のもので、GameState の money などをそのまま使う。
// プレイヤーがいない店の中身は stores[].snapshot にしまい、店を切り替えるときに GameState の店の部分と入れ替える。

import { PROPERTIES } from '../data/properties';
import type { CompanyDayReport, CompanyState, DayReport, GameState, StoreEntry, StoreKey, StorePolicy } from '../types';
import { netSales } from './economy';

/** 店ごとの項目の一覧（types.ts の StoreKey とそろえる。抜けがあると型エラーになる） */
const STORE_KEY_SET: Record<StoreKey, true> = {
  inventory: true,
  deliveries: true,
  autoOrder: true,
  autoOrderMode: true,
  equipment: true,
  seats: true,
  bowls: true,
  dirt: true,
  kitchenGrime: true,
  lostItems: true,
  employees: true,
  candidates: true,
  customers: true,
  orders: true,
  queue: true,
  insideQueue: true,
  arrivalAcc: true,
  regularsVisitedToday: true,
  reputation: true,
  reviews: true,
  todayReviews: true,
  regulars: true,
  prices: true,
  pausedMenu: true,
  history: true,
  closedForConstruction: true,
};
export const STORE_KEYS = Object.keys(STORE_KEY_SET) as StoreKey[];

/** 1店舗目の店の id */
export const FIRST_STORE_ID = 'store1';

export const DEFAULT_POLICY: StorePolicy = { priceMult: 1, orderMode: 'sales', repairCap: 30_000, maintenance: true };

/** 新しいキャリア（または古いセーブ）の会社: 今の店が1店舗目で、プレイヤーはそこにいる */
export function newCompany(s: Pick<GameState, 'shopName' | 'day'>): CompanyState {
  return {
    activeStoreId: FIRST_STORE_ID,
    stores: [
      {
        id: FIRST_STORE_ID,
        name: s.shopName,
        propertyId: 'home',
        openedDay: s.day,
        managerId: null,
        policy: { ...DEFAULT_POLICY },
        snapshot: null,
      },
    ],
    history: [],
  };
}

/** 会社がないとき（作り直しの途中など）に補う */
export function ensureCompany(s: GameState): CompanyState {
  if (!s.company || !Array.isArray(s.company.stores) || s.company.stores.length === 0) s.company = newCompany(s);
  return s.company;
}

/** プレイヤーがいる店 */
export function activeStore(s: GameState): StoreEntry {
  const c = ensureCompany(s);
  return c.stores.find((x) => x.id === c.activeStoreId) ?? c.stores[0]!;
}

/** その店の物件 */
export function storeProperty(entry: StoreEntry) {
  return PROPERTIES[entry.propertyId] ?? PROPERTIES.home!;
}

/** 店を2つ以上持っているか（会社の画面を出すか） */
export function isMultiStore(s: GameState): boolean {
  return (s.company?.stores.length ?? 1) > 1;
}

/** その店のその日の日報（プレイヤーがいる店は GameState の日報、いない店はしまった日報） */
export function storeReport(s: GameState, entry: StoreEntry, day: number): DayReport | null {
  const hist = entry.id === s.company.activeStoreId ? s.history : (entry.snapshot?.history ?? []);
  for (let i = hist.length - 1; i >= 0; i--) {
    const r = hist[i]!;
    if (r.day === day) return r;
    if (r.day < day) break;
  }
  return null;
}

/**
 * 会社の日報を作る（その日のすべての店の日報がそろったあと、次の日へ進むときに呼ぶ）。
 * 店舗の合計 = 会社。利息は会社のもの（プレイヤーがいる店の精算で払っている）
 */
export function recordCompanyDay(s: GameState, day: number): CompanyDayReport {
  const c = ensureCompany(s);
  const lines = c.stores.map((entry) => {
    const r = storeReport(s, entry, day);
    return {
      storeId: entry.id,
      name: entry.name,
      played: entry.id === c.activeStoreId,
      netSales: r ? (r.netSales ?? netSales(r)) : 0,
      operatingProfit: r?.operatingProfit ?? 0,
      served: r?.served ?? 0,
      customers: r?.customers ?? 0,
      reputation: r?.reputation ?? (entry.snapshot?.reputation ?? s.reputation),
    };
  });
  let interest = 0;
  for (const entry of c.stores) interest += storeReport(s, entry, day)?.interest ?? 0;
  const report: CompanyDayReport = {
    day,
    stores: lines,
    netSales: lines.reduce((a, x) => a + x.netSales, 0),
    operatingProfit: lines.reduce((a, x) => a + x.operatingProfit, 0),
    interest,
    finalProfit: lines.reduce((a, x) => a + x.operatingProfit, 0) - interest,
    served: lines.reduce((a, x) => a + x.served, 0),
    cashEnd: s.money,
  };
  const prev = c.history.findIndex((x) => x.day === day);
  if (prev >= 0) c.history.splice(prev, 1);
  c.history.push(report);
  if (c.history.length > 60) c.history.splice(0, c.history.length - 60);
  return report;
}
