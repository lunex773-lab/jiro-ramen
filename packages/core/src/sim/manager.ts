// 店長の営業（統合進化設計書 v2.1 Phase 2-4。オーナーの判断: プレイヤーがいない店は1日単位で計算）。
// プレイヤーがいる店だけが 0.1 秒刻みの細かいシミュレーション。ほかの店は、店長の能力・従業員・席・冷蔵庫・評判・価格・
// 立地から1日分を計算する。来客の見込みと客単価は細かいシミュレーションと同じ式（arrivalRate・メニューの人気）を使い、
// 処理能力の係数は細かいシミュレーションの結果に合わせる（BALANCE.company.model、test/manager-model.test.ts で差を確かめる）。
// 乱数を使わない（同じ状態なら同じ結果）。

import { BALANCE } from '../data/balance';
import { INGREDIENTS } from '../data/ingredients';
import { MENU } from '../data/menu';
import { STAGES } from '../data/stages';
import type { DayReport, Employee, GameState, StoreEntry } from '../types';
import { clamp } from '../util';
import { storeProperty, withStore } from './company';
import { expectedDailyArrivals, expectedTicket } from './customers';
import { cash, emptyDayStats, finalProfit, netSales, operatingProfit } from './economy';
import { upkeepTotal } from './equipment';
import { addLot, consume, expireLots, fridgeCapacity, stockOf } from './inventory';
import { makeCtx, type SimCtx } from './notices';
import { expectedPay } from './staff';

const M = () => BALANCE.company.model;

/** 能力（0〜1）の効き方の倍率 */
function skillFactor(x: number): number {
  return M().skillBase + M().skillSlope * clamp(x, 0, 1);
}

function avgSkill(e: Employee): number {
  const k = e.profile.skills;
  return (k.speed + k.cooking + k.service + k.movement) / 4;
}

export interface ManagerDayPlan {
  open: boolean;
  /** 休む理由（休むとき） */
  closedReason: string | null;
  arrivals: number;
  /** 席・人手・冷蔵庫から決まる1日の提供の上限 */
  capacity: { seats: number; labor: number; fridge: number; total: number };
  served: number;
  ticket: number;
}

/** 1日の処理能力（杯）。席の数・店長と従業員の担当と能力・冷蔵庫の容量の小さいほう */
export function storeCapacity(s: GameState, managerId: string | null): ManagerDayPlan['capacity'] {
  const m = M();
  const seats = s.seats.filter((x) => x.installed && x.index < STAGES[s.career.stage]!.seats.length).length * m.seatTurns;
  const mgr = s.employees.find((e) => e.id === managerId);
  let labor = 0;
  if (mgr) {
    labor = (m.leadPoints * skillFactor(avgSkill(mgr))) / skillFactor(0.65);
    const others = s.employees.filter((e) => e.id !== managerId);
    let extra = 0;
    for (const e of others) extra += (m.rolePoints[e.profile.role] ?? 10) * (skillFactor(avgSkill(e)) / skillFactor(0.65));
    labor += extra / (1 + m.extraDiminish * Math.max(0, others.length - 1));
  }
  const fridge = fridgeCapacity(s) * m.bowlsPerFridgeKg;
  return { seats, labor, fridge, total: Math.max(0, Math.min(seats, labor, fridge)) };
}

/** 方針の価格の倍率を、メニューの値段に反映する */
function applyPolicyPrices(s: GameState, entry: StoreEntry): void {
  for (const m of Object.values(MENU)) s.prices[m.id] = Math.round((m.defaultPrice * entry.policy.priceMult) / 10) * 10;
}

/** その日の計画（読むだけ。店の中身が GameState に入っているときに呼ぶ） */
export function planManagerDay(s: GameState, entry: StoreEntry): ManagerDayPlan {
  const mgr = entry.managerId ? s.employees.find((e) => e.id === entry.managerId) : undefined;
  const closedReason = s.closedForConstruction > 0 ? '工事・準備のため休業' : !mgr ? '店長がいないため休業' : null;
  const capacity = storeCapacity(s, mgr?.id ?? null);
  const ticket = expectedTicket(s);
  if (closedReason) return { open: false, closedReason, arrivals: 0, capacity, served: 0, ticket };
  const arrivals = expectedDailyArrivals(s, { events: false });
  const served = Math.floor(Math.min(capacity.total, arrivals * M().joinShare));
  return { open: true, closedReason: null, arrivals, capacity, served, ticket };
}

/** 朝の仕入れ: 見込みの杯数の分の在庫をそろえる（払えた分だけ）。払った額を返す */
function restock(s: GameState, bowls: number, key: (k: string) => string): number {
  const use = M().usePerBowl;
  let paid = 0;
  for (const [itemId, per] of Object.entries(use)) {
    const def = INGREDIENTS[itemId];
    if (!def || !def.purchasable || def.packQty <= 0) continue;
    if (def.unlock && !s.career.unlocked.includes(def.unlock)) continue;
    const want = per * bowls * (1 + M().wasteShare) * M().stockSafety;
    const have = stockOf(s, itemId);
    if (have >= want) continue;
    const packs = Math.ceil((want - have) / def.packQty);
    const cost = packs * def.packPrice;
    if (cost <= 0 || !cash(s, 'purchase', -cost, `${def.name}の仕入れ`, key(`buy:${itemId}`))) continue;
    addLot(s, itemId, packs * def.packQty, def.packPrice / def.packQty);
    s.today.purchases += cost;
    paid += cost;
  }
  return paid;
}

/** 在庫で出せる杯数（仕入れの食材のうち一番少ないもの） */
function stockLimit(s: GameState): number {
  let lim = Number.POSITIVE_INFINITY;
  for (const [itemId, per] of Object.entries(M().usePerBowl)) {
    const def = INGREDIENTS[itemId];
    if (!def || per <= 0 || (def.unlock && !s.career.unlocked.includes(def.unlock))) continue;
    lim = Math.min(lim, stockOf(s, itemId) / (per * (1 + M().wasteShare)));
  }
  return Number.isFinite(lim) ? Math.floor(lim) : 0;
}

/** 払う（足りなければ未払金） */
function payOrAccrue(s: GameState, type: Parameters<typeof cash>[1], amount: number, memo: string, key: string): void {
  if (amount <= 0) return;
  const payNow = Math.min(amount, Math.max(0, s.money));
  if (payNow > 0) cash(s, type, -payNow, memo, key);
  const rest = amount - payNow;
  if (rest > 0) s.arrears.push({ id: `${key}:ar`, amount: rest, reason: memo, sinceDay: s.day, dueDay: s.day + BALANCE.arrearsGraceDays });
}

/** 店の中身が GameState に入っている状態で、その日の店長の営業を計算して日報を作る */
function runInStore(s: GameState, entry: StoreEntry, day: number, ctx: SimCtx): DayReport {
  const m = M();
  const prop = storeProperty(entry);
  const st = STAGES[s.career.stage]!;
  const t = s.today;
  const cashStart = s.money;
  const name = entry.name;
  const key = (k: string) => `mgr:${entry.id}:${day}:${k}`;
  s.autoOrderMode = entry.policy.orderMode;
  applyPolicyPrices(s, entry);
  // 届いた分を受け取り、期限切れを捨てる（廃棄は損益に入る）
  for (const d of s.deliveries) addLot(s, d.itemId, d.qty, d.unitCost);
  s.deliveries = [];
  expireLots(s, ctx);
  const plan = planManagerDay(s, entry);
  let served = 0;
  if (plan.open) {
    s.closedForConstruction = 0;
    restock(s, plan.served, key);
    served = Math.min(plan.served, stockLimit(s));
    // 食材を使う（原価）。使う量の一部は廃棄（ゆですぎ・こぼし）
    for (const [itemId, per] of Object.entries(m.usePerBowl)) {
      const def = INGREDIENTS[itemId];
      if (!def || (def.unlock && !s.career.unlocked.includes(def.unlock))) continue;
      const q = per * served;
      if (q <= 0) continue;
      const used = consume(s, itemId, Math.min(q, stockOf(s, itemId)));
      if (used.ok) t.cogs += Math.round(used.cost);
      const w = Math.min(q * m.wasteShare, stockOf(s, itemId));
      if (w > 0) {
        const wasted = consume(s, itemId, w);
        if (wasted.ok) t.waste += Math.round(wasted.cost);
      }
      const u = (t.usedItems ??= {});
      u[itemId] = (u[itemId] ?? 0) + q;
    }
    const arrivals = Math.round(plan.arrivals);
    t.served = served;
    t.customers = Math.min(arrivals, Math.round(served / m.joinShare));
    t.balked = Math.max(0, arrivals - t.customers);
    t.lost = Math.max(0, t.customers - served);
    t.sales = Math.round(served * plan.ticket);
    const repairs = served * m.repairPerBowl * (entry.policy.maintenance ? 1 : m.repairNoMaintenanceMult);
    t.repairs = Math.round(Math.min(entry.policy.repairCap, repairs));
    t.utilities = Math.round(BALANCE.utilitiesBase + m.utilitiesPerBowl * served);
    t.wages = s.employees.reduce((a, e) => a + expectedPay(e, day), 0);
  } else {
    if (s.closedForConstruction > 0) s.closedForConstruction -= 1;
    t.utilities = BALANCE.utilitiesBase;
    // 休みでも社員の日給はかかる（アルバイトは来ない）
    t.wages = s.employees.reduce((a, e) => a + (e.profile.employment === 'full' ? e.profile.wage : 0), 0);
  }
  t.rent = Math.round(st.rent * prop.rentMult);
  t.upkeep = upkeepTotal(s);
  if (t.sales > 0) cash(s, 'sale', t.sales, `${name}の売上（${day}日目）`, key('sale'));
  payOrAccrue(s, 'rent', t.rent, `${name}の家賃（${day}日目）`, key('rent'));
  payOrAccrue(s, 'wage', t.wages, `${name}の給与（${day}日目）`, key('wage'));
  payOrAccrue(s, 'upkeep', t.upkeep, `${name}の設備維持費`, key('upkeep'));
  payOrAccrue(s, 'utilities', t.utilities, `${name}の光熱費`, key('util'));
  payOrAccrue(s, 'repair', t.repairs, `${name}の修理・メンテ`, key('repair'));
  // 評判: 店長の能力・値段で決まる目標に少しずつ近づく。休んだ日は下がる
  const mgr = entry.managerId ? s.employees.find((e) => e.id === entry.managerId) : undefined;
  if (plan.open && mgr) {
    const pm = entry.policy.priceMult;
    const target = clamp(
      m.repBase + m.repManagerSlope * (avgSkill(mgr) - 0.65) - m.repHighPricePenalty * Math.max(0, pm - 1.1) + m.repLowPriceBonus * Math.max(0, 1 - pm),
      1,
      5,
    );
    s.reputation = clamp(s.reputation + (target - s.reputation) * m.repApproach, 1, 5);
  } else {
    s.reputation = clamp(s.reputation - m.repClosedDecay, 1, 5);
  }
  // 常連は少しずつ離れる（店長の店では新しい常連の計算はしない）
  for (const r of s.regulars) if (day - r.lastVisitDay > 5) r.loyalty = Math.max(0, r.loyalty - 0.03);
  s.regulars = s.regulars.filter((r) => r.loyalty > 0.02);
  const report: DayReport = {
    ...t,
    wasteItems: { ...t.wasteItems },
    stockoutItems: { ...(t.stockoutItems ?? {}) },
    usedItems: { ...(t.usedItems ?? {}) },
    day,
    operatingProfit: operatingProfit(t),
    netSales: netSales(t),
    finalProfit: finalProfit(t),
    cashStart,
    cashEnd: s.money,
    reputation: Math.round(s.reputation * 100) / 100,
    reviews: 0,
    avgSatisfaction: 0,
    avgWait: 0,
    managed: plan.open ? 'manager' : 'closed',
  };
  s.history.push(report);
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  return report;
}

/**
 * プレイヤーがいない店のその日を、店長の営業で計算する（日報を店の日報に足し、お金は会社で動かす）。
 * 休んだ店（工事・店長なし）も家賃・維持費・社員の日給を払う
 */
export function runManagerDay(s: GameState, entry: StoreEntry, day: number, _ctx: SimCtx): DayReport {
  const quiet = makeCtx();
  return withStore(s, entry, () => {
    s.today = emptyDayStats();
    return runInStore(s, entry, day, quiet);
  });
}
