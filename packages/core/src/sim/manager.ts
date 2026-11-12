// 店長の営業（統合進化設計書 v2.1 Phase 2-4。オーナーの判断: プレイヤーがいない店は1日単位で計算）。
// プレイヤーがいる店だけが 0.1 秒刻みの細かいシミュレーション。ほかの店は、店長の能力・従業員・席・冷蔵庫・評判・価格・
// 立地から1日分を計算する。来客の見込みと客単価は細かいシミュレーションと同じ式（arrivalRate・メニューの人気）を使い、
// 処理能力の係数は細かいシミュレーションの結果に合わせる（BALANCE.company.model、test/manager-model.test.ts で差を確かめる）。
// 乱数を使わない（同じ状態なら同じ結果）。

import { BALANCE } from '../data/balance';
import { INGREDIENTS } from '../data/ingredients';
import { MENU } from '../data/menu';
import { STAGES } from '../data/stages';
import type { DayReport, Employee, GameState, StoreEntry, StoreHours } from '../types';
import { DEFAULT_HOURS, hoursDemandWeight, isClosedDay, openMinutesOf, utilitiesBaseOf } from './hours';
import { clamp } from '../util';
import { companyPolicyOf, withStore } from './company';
import { storeRentMult } from './location';
import { expectedDailyArrivals, expectedTicket } from './customers';
import { cash, emptyDayStats, finalProfit, netSales, operatingProfit } from './economy';
import { upkeepTotal } from './equipment';
import { addLot, consume, expireLots, fridgeCapacity, packPriceOf, stockOf } from './inventory';
import { makeCtx, type SimCtx } from './notices';
import { payAds, withPlannedAds } from './ads';
import { attendanceChances, checkQuits, endOfDayWellbeing, expectedPay, fatigueSpeed, isPartTime, shiftFor, weekdayOf } from './staff';
import { autoShifts } from './shift-plan';
import { tempHourly } from './employees';

const M = () => BALANCE.company.model;

/** 能力（0〜1）の効き方の倍率 */
function skillFactor(x: number): number {
  return M().skillBase + M().skillSlope * clamp(x, 0, 1);
}

function avgSkill(e: Employee): number {
  const k = e.profile.skills;
  return (k.speed + k.cooking + k.service + k.movement) / 4;
}

export interface ManagerDayOptions {
  /** 来客の倍率（オンライン市場で、同じ地域の競合の店に客を取られる分。1 = 競合なし） */
  demandMult?: number;
  /** 短期バイトの人数（人手が足りない日に方針で呼ぶ。runInStore が決める） */
  temps?: number;
}

/** 遅刻したときに働けない時間の割合の見込み（遅刻の分数の平均 ÷ 1日の営業の分数） */
const LATE_SHARE = () => (BALANCE.staff.attendance.lateMinFrom + BALANCE.staff.attendance.lateMinTo) / 2 / openMinutesOf(DEFAULT_HOURS);

/** その人が来て働く割合の見込み（当日欠勤・遅刻の確率から。細かいシミュレーションと同じ確率。乱数は使わない） */
export function expectedAttendance(e: Employee): number {
  const a = attendanceChances(e);
  return (1 - a.absent) * (1 - a.late * LATE_SHARE());
}

/** 短期バイト1人分の人手（能力は新人並みの平均） */
function tempLabor(): number {
  const m = M();
  const T = BALANCE.staff.temp;
  return (m.rolePoints.cook ?? 10) * (skillFactor((T.skillFrom + T.skillTo) / 2) / skillFactor(0.65));
}

/** 赤字が3日続いているか（会社の日報） */
export function inDeficit(s: GameState): boolean {
  const h = s.company?.history ?? [];
  if (h.length < 3) return false;
  return h.slice(-3).every((r) => r.operatingProfit < 0);
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

/**
 * 1日の処理能力（杯）。席の数・店長と従業員の担当と能力・冷蔵庫の容量の小さいほう。
 * lead は店を回す人（店長の社員、または店主）。null なら人手は0（休業）
 */
export function storeCapacity(s: GameState, lead: { id: string | null; skill: number } | null, temps = 0, hours: StoreHours = DEFAULT_HOURS): ManagerDayPlan['capacity'] {
  const m = M();
  // 係数は11〜15時（4時間）の1日の杯数。営業時間が長い・短い店は時間に比例させる（じろ1 5.1）
  const hf = openMinutesOf(hours) / openMinutesOf(DEFAULT_HOURS);
  const seats = s.seats.filter((x) => x.installed && x.index < STAGES[s.career.stage]!.seats.length).length * m.seatTurns * hf;
  let labor = 0;
  if (lead) {
    const leadEmp = lead.id ? s.employees.find((e) => e.id === lead.id) : undefined;
    labor = ((m.leadPoints * skillFactor(lead.skill)) / skillFactor(0.65)) * (leadEmp ? fatigueSpeed(leadEmp) * expectedAttendance(leadEmp) : 1);
    // その日に勤務の予定がある人だけ（休みの曜日・シフトのない日は来ない）。疲れていると遅い（細かいシミュレーションと同じ倍率）
    const others = s.employees.filter((e) => e.id !== lead.id && shiftFor(e, s.day) !== null);
    let extra = 0;
    // 当日欠勤・遅刻は見込み（確率）で減らす。短期バイトは新人並みの人手
    for (const e of others) extra += (m.rolePoints[e.profile.role] ?? 10) * (skillFactor(avgSkill(e)) / skillFactor(0.65)) * fatigueSpeed(e) * expectedAttendance(e);
    for (let i = 0; i < temps; i++) extra += tempLabor();
    const n = others.length + temps;
    labor += extra / (1 + m.extraDiminish * Math.max(0, n - 1));
    labor *= hf;
  }
  const fridge = fridgeCapacity(s) * m.bowlsPerFridgeKg;
  return { seats, labor, fridge, total: Math.max(0, Math.min(seats, labor, fridge)) };
}

/**
 * その店を回す人: 店長（社員）。店長がいなくても、店主が自分で回す店（オンライン市場の本店など、company.ownerStoreId）は店主
 */
export function storeLead(s: GameState, entry: StoreEntry): { id: string | null; skill: number; owner: boolean } | null {
  const mgr = entry.managerId ? s.employees.find((e) => e.id === entry.managerId) : undefined;
  if (mgr && shiftFor(mgr, s.day) !== null) return { id: mgr.id, skill: avgSkill(mgr), owner: false };
  // 店長がいない・休みの日は、その日に勤務のあるシフトリーダーが店長代理として回す（オーナーの判断 2026-11-12「店長代理」）。
  // いなければ休業（店主が自分で回す店は店主）
  const deputy = s.employees.filter((e) => e.id !== mgr?.id && e.profile.role === 'leader' && shiftFor(e, s.day) !== null).sort((a, b) => avgSkill(b) - avgSkill(a))[0];
  if (deputy) return { id: deputy.id, skill: avgSkill(deputy), owner: false };
  if (s.company?.ownerStoreId === entry.id) return { id: null, skill: M().ownerSkill, owner: true };
  return null;
}

/** 方針の価格の倍率を、メニューの値段に反映する */
function applyPolicyPrices(s: GameState, entry: StoreEntry): void {
  for (const m of Object.values(MENU)) s.prices[m.id] = Math.round((m.defaultPrice * entry.policy.priceMult) / 10) * 10;
}

/** その日の計画（読むだけ。店の中身が GameState に入っているときに呼ぶ） */
export function planManagerDay(s: GameState, entry: StoreEntry, opts: ManagerDayOptions = {}): ManagerDayPlan {
  const lead = storeLead(s, entry);
  const hours = entry.hours ?? DEFAULT_HOURS;
  const closedReason = s.closedForConstruction > 0 ? '工事・準備のため休業' : isClosedDay(hours, s.day) ? '定休日' : !lead ? '店長（店長代理のシフトリーダー）がいないため休業' : null;
  const capacity = storeCapacity(s, lead, opts.temps ?? 0, hours);
  const ticket = expectedTicket(s) * M().ticketFactor;
  if (closedReason) return { open: false, closedReason, arrivals: 0, capacity, served: 0, ticket };
  // 来客の見込みは、その店の営業時間で数える（読むだけなので、今日の営業時間は元に戻す）
  const keepHours = s.todayHours;
  s.todayHours = hours;
  const arrivals = expectedDailyArrivals(s, { events: false }) * (opts.demandMult ?? 1);
  s.todayHours = keepHours;
  const served = Math.floor(Math.min(capacity.total, arrivals * M().joinShare));
  return { open: true, closedReason: null, arrivals, capacity, served, ticket };
}

/** 朝の仕入れ: 見込みの杯数の分の在庫をそろえる（払えた分だけ。安全基準は店の方針）。払った額を返す */
function restock(s: GameState, bowls: number, key: (k: string) => string, safety = 1): number {
  const use = M().usePerBowl;
  let paid = 0;
  for (const [itemId, per] of Object.entries(use)) {
    const def = INGREDIENTS[itemId];
    if (!def || !def.purchasable || def.packQty <= 0) continue;
    if (def.unlock && !s.career.unlocked.includes(def.unlock)) continue;
    const want = per * bowls * (1 + M().wasteShare) * M().stockSafety * safety;
    const have = stockOf(s, itemId);
    if (have >= want) continue;
    const packs = Math.ceil((want - have) / def.packQty);
    // 店の場所の物価で仕入れ値が変わる（じろ1 5.5）
    const cost = packs * packPriceOf(s, itemId);
    if (cost <= 0 || !cash(s, 'purchase', -cost, `${def.name}の仕入れ`, key(`buy:${itemId}`))) continue;
    addLot(s, itemId, packs * def.packQty, cost / (packs * def.packQty));
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
function runInStore(s: GameState, entry: StoreEntry, day: number, ctx: SimCtx, opts: ManagerDayOptions): DayReport {
  const m = M();
  const st = STAGES[s.career.stage]!;
  const t = s.today;
  const cashStart = s.money;
  const name = entry.name;
  const key = (k: string) => `mgr:${entry.id}:${day}:${k}`;
  const hours = entry.hours ?? DEFAULT_HOURS;
  s.autoOrderMode = entry.policy.orderMode;
  applyPolicyPrices(s, entry);
  // 届いた分を受け取り、期限切れを捨てる（廃棄は損益に入る）
  for (const d of s.deliveries) addLot(s, d.itemId, d.qty, d.unitCost);
  s.deliveries = [];
  expireLots(s, ctx);
  // 赤字が続いているとき（方針「赤字のときは経費を減らす」）は、広告と短期バイトを止める
  const austerity = companyPolicyOf(s).deficit === 'cutCosts' && inDeficit(s);
  // その日の広告費（営業する日だけ。払えなければ出さない）。来客の見込みに入る
  if (!austerity && s.closedForConstruction <= 0 && storeLead(s, entry)) payAds(s, entry, day);
  let plan = planManagerDay(s, entry, opts);
  // 人手が足りない日（方針で許可していれば）は短期バイトを1人呼ぶ（時給は通常の1.5倍・その日だけ）
  let temps = 0;
  if (plan.open && !austerity && entry.policy.tempWhenShort && s.career.unlocked.includes('hiring')) {
    const want = plan.arrivals * M().joinShare;
    const c = plan.capacity;
    if (c.labor < Math.min(c.seats, c.fridge, want)) {
      temps = 1;
      plan = planManagerDay(s, entry, { ...opts, temps });
    }
  }
  let served = 0;
  if (plan.open) {
    s.closedForConstruction = 0;
    restock(s, plan.served, key, entry.policy.safetyStock ?? 1);
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
    t.utilities = Math.round(utilitiesBaseOf(hours, true) + m.utilitiesPerBowl * served);
    t.wages = s.employees.reduce((a, e) => a + expectedPay(e, day, hours), 0) + temps * Math.round(tempHourly() * (openMinutesOf(hours) / 60 + BALANCE.staff.employment.prepPaidHours));
  } else {
    const construction = s.closedForConstruction > 0;
    if (construction) s.closedForConstruction -= 1;
    t.utilities = utilitiesBaseOf(hours, false);
    // 工事（拡張）・出店の準備の休業日は給与なし（オーナーの指示 2026-11-12）。
    // ほかの休み（店長がいない日など）は社員の日給はかかる（アルバイトは来ない。社員の休みの曜日・定休日はかからない）
    t.wages = construction ? 0 : s.employees.reduce((a, e) => a + (e.profile.employment === 'full' ? expectedPay(e, day, hours) : 0), 0);
  }
  t.rent = Math.round(st.rent * storeRentMult(entry));
  t.upkeep = upkeepTotal(s);
  if (t.sales > 0) cash(s, 'sale', t.sales, `${name}の売上（${day}日目）`, key('sale'));
  payOrAccrue(s, 'rent', t.rent, `${name}の家賃（${day}日目）`, key('rent'));
  payOrAccrue(s, 'wage', t.wages, `${name}の給与（${day}日目）`, key('wage'));
  payOrAccrue(s, 'upkeep', t.upkeep, `${name}の設備維持費`, key('upkeep'));
  payOrAccrue(s, 'utilities', t.utilities, `${name}の光熱費`, key('util'));
  payOrAccrue(s, 'repair', t.repairs, `${name}の修理・メンテ`, key('repair'));
  // 評判: 店長の能力・値段で決まる目標に少しずつ近づく。休んだ日は下がる
  const lead = storeLead(s, entry);
  if (plan.open && lead) {
    const pm = entry.policy.priceMult;
    const target = clamp(
      m.repBase + m.repManagerSlope * (lead.skill - 0.65) - m.repHighPricePenalty * Math.max(0, pm - 1.1) + m.repLowPriceBonus * Math.max(0, 1 - pm),
      1,
      5,
    );
    s.reputation = clamp(s.reputation + (target - s.reputation) * m.repApproach, 1, 5);
  } else if (plan.closedReason !== '定休日') {
    // 決まった定休日は評判が下がらない（急な休業・店長がいない日は下がる）
    s.reputation = clamp(s.reputation - m.repClosedDecay, 1, 5);
  }
  // 従業員の疲れと満足度（細かいシミュレーションの精算と同じ規則。休業の日は社員だけ出勤）
  for (const e of s.employees) {
    const scheduled = shiftFor(e, day) !== null;
    const worked = scheduled && (plan.open || e.profile.employment === 'full');
    endOfDayWellbeing(s, e, worked, worked ? 1 : 0);
  }
  // 常連: 店が開いている日は、店長の店にも通い続ける（来た日として数え、離れない）。休んだ日だけ少しずつ離れる。
  // 以前は営業した日も来なかったことになり、自動営業が5日を超えると常連が離れていなくなっていた（オーナーの報告。来客の常連の倍率も下がった）。
  // 店長の店では新しい常連の計算はしない
  if (plan.open && served > 0) {
    for (const r of s.regulars) r.lastVisitDay = day;
  } else {
    for (const r of s.regulars) if (day - r.lastVisitDay > 5) r.loyalty = Math.max(0, r.loyalty - 0.03);
    s.regulars = s.regulars.filter((r) => r.loyalty > 0.02);
  }
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
    demandWeight: Math.round(hoursDemandWeight(hours) * 1000) / 1000,
  };
  s.history.push(report);
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  // 店長の毎週のシフト: 日曜の夜に、翌週のアルバイトのシフトを来客の見込みに合わせて組み直す（方針で「自分で組む」の店は組まない。
  // オーナーの指示 2026-11-11）。店主はこの店にいないので数えない
  if (weekdayOf(day) === 6 && entry.policy.shiftBy !== 'self' && entry.managerId && s.employees.some((e) => e.id === entry.managerId) && s.employees.some(isPartTime)) {
    autoShifts(s, ctx, 'manager', { owner: false, hours, silent: true, day });
  }
  // キャリア（会社のもの）: 累計の杯数・1日の最高（目標の解放に使う）
  s.career.totalServed += served;
  s.career.bestDayServed = Math.max(s.career.bestDayServed, served);
  if (served > 0) s.career.bestDayProfit = Math.max(s.career.bestDayProfit, report.operatingProfit);
  return report;
}

/**
 * プレイヤーがいない店のその日を、店長の営業で計算する（日報を店の日報に足し、お金は会社で動かす）。
 * 休んだ店（工事・店長なし）も家賃・維持費・社員の日給を払う
 */
export function runManagerDay(s: GameState, entry: StoreEntry, day: number, _ctx: SimCtx, opts: ManagerDayOptions = {}): DayReport {
  const quiet = makeCtx();
  const absent = entry.id !== s.company.activeStoreId;
  return withStore(s, entry, () => {
    s.today = emptyDayStats();
    // プレイヤーがいない店の朝: 不満がたまった人は辞めることがある（プレイヤーがいる店は朝の出勤確認で）
    if (absent) {
      checkQuits(s, null);
      if (entry.managerId && !s.employees.some((e) => e.id === entry.managerId)) entry.managerId = null;
    }
    return runInStore(s, entry, day, quiet, opts);
  });
}

/** その店が競合なしで迎える来客の見込み（人/日。方針の価格で。休業なら0）。オンライン市場の客の取り合いの計算に使う */
export function standaloneArrivals(s: GameState, entry: StoreEntry): number {
  return withStore(s, entry, () => {
    applyPolicyPrices(s, entry);
    if (s.closedForConstruction > 0 || !storeLead(s, entry)) return 0;
    // 方針の広告費を払ったとみなす（客の取り合いにも効く）
    return withPlannedAds(s, entry, () => expectedDailyArrivals(s, { events: false }));
  });
}
