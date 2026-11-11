// 在庫・仕入れ（設計書 8）。
// 在庫はロット単位で持ち、古いものから使う（先入れ先出し）。在庫以上は消費できない。

import { BALANCE } from '../data/balance';
import { EQUIPMENT } from '../data/equipment';
import { INGREDIENTS } from '../data/ingredients';
import { PREP_RECIPES } from '../data/prep';
import type { DayReport, DayStats, GameState, Lot, ManagerForecast, PurchaseRecord } from '../types';
import { clamp01, newId } from '../util';
import { cash, recordPL } from './economy';
import { activeStore } from './company';
import { calendarDemand } from './calendar';
import { hoursDemandWeight, isClosedDay, storeHours, todayHours } from './hours';
import { clearNotice, emit, notify, type SimCtx } from './notices';
import { purchaseMultOf } from './location';

export function stockOf(s: GameState, itemId: string): number {
  let q = 0;
  for (const l of s.inventory) if (l.itemId === itemId) q += l.qty;
  return q;
}

export function pendingOf(s: GameState, itemId: string): number {
  let q = 0;
  for (const d of s.deliveries) if (d.itemId === itemId) q += d.qty;
  return q;
}

function hasWorkingEquipmentRole(s: GameState, role: string): boolean {
  return s.equipment.some((e) => e.placed && EQUIPMENT[e.type]?.role === role && e.status !== 'broken' && e.status !== 'repairing');
}

/** 冷蔵庫の容量（kg）。故障中の冷蔵庫は数えない */
export function fridgeCapacity(s: GameState): number {
  let cap = 0;
  for (const e of s.equipment) {
    const def = EQUIPMENT[e.type];
    if (!e.placed || !def || def.role !== 'fridge') continue;
    if (e.status === 'broken' || e.status === 'repairing') continue;
    cap += def.capacity;
  }
  return cap;
}

export function freezerCapacity(s: GameState): number {
  let cap = 0;
  for (const e of s.equipment) {
    const def = EQUIPMENT[e.type];
    if (!e.placed || !def || def.role !== 'freezer') continue;
    if (e.status === 'broken' || e.status === 'repairing') continue;
    cap += def.capacity;
  }
  return cap;
}

/** 冷蔵保管している量（kg）。配送待ちを含めるか選べる */
export function fridgeUsage(s: GameState, includePending = false): number {
  let kg = 0;
  for (const l of s.inventory) {
    const def = INGREDIENTS[l.itemId];
    if (def && def.storage === 'fridge') kg += l.qty * def.kgPerUnit;
  }
  if (includePending) {
    for (const d of s.deliveries) {
      const def = INGREDIENTS[d.itemId];
      if (def && def.storage === 'fridge') kg += d.qty * def.kgPerUnit;
    }
  }
  return kg;
}

/** ロットの鮮度 0..1（作成日からの経過で低下） */
export function lotFreshness(s: GameState, l: Lot): number {
  const def = INGREDIENTS[l.itemId];
  const life = Math.max(1, (l.expiresDay - l.createdDay) || def?.shelfLifeDays || 1);
  const age = s.day - l.createdDay;
  return clamp01(1 - 0.4 * (age / life));
}

export function addLot(s: GameState, itemId: string, qty: number, unitCost: number, quality = 1, shelfOverride?: number): void {
  if (qty <= 0) return;
  const def = INGREDIENTS[itemId];
  if (!def) throw new Error(`unknown ingredient ${itemId}`);
  let life = shelfOverride ?? def.shelfLifeDays;
  if (shelfOverride === undefined && def.frozenShelfLifeDays && freezerCapacity(s) > 0) life = def.frozenShelfLifeDays;
  const expiresDay = s.day + life;
  const same = s.inventory.find(
    (l) => l.itemId === itemId && l.createdDay === s.day && l.expiresDay === expiresDay && Math.abs(l.quality - quality) < 0.05,
  );
  if (same) {
    const total = same.qty + qty;
    same.unitCost = (same.unitCost * same.qty + unitCost * qty) / total;
    same.quality = (same.quality * same.qty + quality * qty) / total;
    same.qty = total;
    return;
  }
  s.inventory.push({ id: newId(s, 'lot'), itemId, qty, unitCost, quality, createdDay: s.day, expiresDay });
}

export interface Consumed {
  ok: boolean;
  cost: number;
  quality: number;
  freshness: number;
}

/**
 * 在庫を消費する。足りなければ何も変えずに ok=false。
 * 戻り値の cost は消費した分の原価（呼び出し側で丼などに引き継ぐ）。
 */
export function consume(s: GameState, itemId: string, qty: number): Consumed {
  if (qty <= 0) return { ok: true, cost: 0, quality: 1, freshness: 1 };
  if (stockOf(s, itemId) + 1e-9 < qty) return { ok: false, cost: 0, quality: 0, freshness: 0 };
  const lots = s.inventory
    .filter((l) => l.itemId === itemId)
    .sort((a, b) => a.expiresDay - b.expiresDay || a.createdDay - b.createdDay);
  let left = qty;
  let cost = 0;
  let qualSum = 0;
  let minFresh = 1;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(l.qty, left);
    l.qty -= take;
    left -= take;
    cost += take * l.unitCost;
    qualSum += take * l.quality;
    minFresh = Math.min(minFresh, lotFreshness(s, l));
  }
  s.inventory = s.inventory.filter((l) => l.qty > 1e-6);
  // 使用量を数える（仕入れる食材は「売れ行きに合わせる」自動発注、仕込みで作る物は従業員の仕込みの目安に使う）
  if (INGREDIENTS[itemId]) {
    const u = (s.today.usedItems ??= {});
    u[itemId] = (u[itemId] ?? 0) + qty;
  }
  return { ok: true, cost, quality: qualSum / qty, freshness: minFresh };
}

/**
 * 自動発注の目安の量。「売れ行きに合わせる」なら、今日と最近の日報の使用量の平均 × 余裕（品切れした食材はさらに多め）。
 * 手動なら設定した目安のまま
 */
export function autoOrderTarget(s: GameState, itemId: string): number {
  const manual = s.autoOrder[itemId] ?? 0;
  if (s.autoOrderMode !== 'sales' || manual <= 0) return manual;
  const A = BALANCE.autoOrderSales;
  const days: number[] = s.today.served > 0 ? [s.today.usedItems?.[itemId] ?? 0] : [];
  for (let i = s.history.length - 1; i >= 0 && days.length < A.days; i--) {
    const r = s.history[i]!;
    // 営業しなかった日（拡張の工事・1杯も出せなかった日）は売れ行きの目安にしない
    if (r.day === s.day || r.served === 0) continue;
    if (r.usedItems) days.push(r.usedItems[itemId] ?? 0);
  }
  const avg = days.length > 0 ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  let short = false;
  for (const [k, n] of Object.entries(s.today.stockoutItems ?? {})) if (n >= 2 && STOCKOUT_SOURCE[k]?.raw.includes(itemId)) short = true;
  const want = avg * A.safety * (short ? A.stockoutBoost : 1);
  // 仕込み1回に使う量の batchFloor 回分は必ず持つ（以前は背脂が1回分の1,000gに届かず炊けないまま、使用量も増えない悪循環になった）
  const batch = (PREP_BATCH[itemId] ?? 0) * A.batchFloor;
  return Math.round(Math.max(manual * A.floorOfManual, batch, want));
}

/**
 * 店長に発注を任せているか（じろ1 5.8「店長は自動で仕入れも行う」）。店長がいて、方針で「自分で発注する」にしていない店
 */
export function managerOrders(s: GameState): boolean {
  if (!s.company) return false;
  const st = activeStore(s);
  if (!st.managerId || st.policy.orderBy === 'self') return false;
  return s.employees.some((e) => e.id === st.managerId);
}

/** 予測に使う、最近の営業した日（1杯以上出した日。新しい順に最大 recentDays 日） */
function recentOpenDays(s: GameState): DayReport[] {
  const out: DayReport[] = [];
  for (let i = s.history.length - 1; i >= 0 && out.length < BALANCE.storeManager.recentDays; i--) {
    const r = s.history[i]!;
    if (r.served > 0) out.push(r);
  }
  return out;
}

/**
 * 店長の翌日の予測（オーナーの指示 2026-11-11: その日の営業の数字や曜日などを考えて、翌日の来客を予測する）。
 * 最近の営業日の来客・杯数を、その日の曜日・季節（calendarDemand）と営業時間の「来客の多さ」（hoursDemandWeight）で割って
 * ならし、翌日の曜日・季節と翌日の営業時間を掛ける。今日の数字は2倍の重みで見る（直近の評判・値段・天気の変化を早く入れる）。
 * 翌日が定休日なら closed（発注しない。定休日の夜に、次の営業日の分を発注する）。営業した日がまだなければ null
 */
export function forecastNextDay(s: GameState): ManagerForecast | null {
  const day = s.day + 1;
  const hours = storeHours(s);
  if (isClosedDay(hours, day)) return { day, closed: true, customers: 0, bowls: 0, basis: 0 };
  const rows = recentOpenDays(s);
  if (rows.length === 0) return null;
  const fallbackW = hoursDemandWeight(todayHours(s));
  let w = 0;
  let cust = 0;
  let bowls = 0;
  for (const r of rows) {
    const weight = r.day === s.day ? BALANCE.storeManager.todayWeight : 1;
    const norm = Math.max(0.05, calendarDemand(r.day) * (r.demandWeight ?? fallbackW));
    cust += (weight * (r.customers + r.balked)) / norm;
    bowls += (weight * r.served) / norm;
    w += weight;
  }
  const k = calendarDemand(day) * hoursDemandWeight(hours);
  return { day, closed: false, customers: Math.round((cust / w) * k), bowls: Math.round((bowls / w) * k), basis: rows.length };
}

/**
 * 店長の発注の目安: 翌日の予測の杯数 × 1杯あたりの使用量（最近の営業日の使用量 ÷ 杯数）× 余裕（品切れした食材はさらに多め）。
 * 仕込み1回に使う量の batchFloor 回分は持つ。翌日が定休日なら 0（発注しない）。予測ができない（営業した日がない）ときは、
 * 売れ行きに合わせる自動発注の目安。発注をしない設定（目安0）の食材は発注しない
 */
export function managerOrderTarget(s: GameState, itemId: string, forecast: ManagerForecast | null = forecastNextDay(s)): number {
  const manual = s.autoOrder[itemId] ?? 0;
  if (manual <= 0) return 0;
  if (forecast?.closed) return 0;
  if (!forecast || s.tutorial) {
    const keep = s.autoOrderMode;
    s.autoOrderMode = 'sales';
    const base = autoOrderTarget(s, itemId);
    s.autoOrderMode = keep;
    return base;
  }
  const A = BALANCE.autoOrderSales;
  const rows = recentOpenDays(s);
  const used = rows.reduce((a, r) => a + (r.usedItems?.[itemId] ?? 0), 0);
  const served = rows.reduce((a, r) => a + r.served, 0);
  const perBowl = served > 0 ? used / served : 0;
  let short = false;
  for (const [k, n] of Object.entries(rows[0]?.stockoutItems ?? {})) if (n >= 2 && STOCKOUT_SOURCE[k]?.raw.includes(itemId)) short = true;
  const want = perBowl * forecast.bowls * A.safety * (short ? A.stockoutBoost : 1);
  const batch = (PREP_BATCH[itemId] ?? 0) * A.batchFloor;
  return Math.round(Math.max(batch, want));
}

/** 店長が発注に使ってよい額: 手元の資金から、翌日の固定費（家賃・維持費・光熱費の基本）の2日分を残した額 */
export function managerOrderBudget(s: GameState): number {
  const fixed = (s.history.at(-1)?.rent ?? 8_000) + (s.history.at(-1)?.upkeep ?? 0) + BALANCE.utilitiesBase;
  return Math.max(0, s.money - fixed * 2);
}

/** 仕込みのレシピ1回に使う、その食材の量（レシピの中の最大） */
const PREP_BATCH: Record<string, number> = {};
for (const r of Object.values(PREP_RECIPES)) for (const i of r.inputs) PREP_BATCH[i.itemId] = Math.max(PREP_BATCH[i.itemId] ?? 0, i.qty);

/** 品切れのもとの食材（仕込みで作る物 → 仕入れる食材）。閉店後の原因の説明と「売れ行きに合わせる」自動発注で使う */
export const STOCKOUT_SOURCE: Record<string, { raw: string[]; label: string }> = {
  // 豚の煮込み・背脂を炊くのには醤油も使う（醤油が足りないと豚肉があっても煮込めない）
  buta: { raw: ['pork_raw', 'soy'], label: '豚' },
  'menu:buta': { raw: ['pork_raw', 'soy'], label: '豚（売り切れ）' },
  yasai: { raw: ['moyashi', 'cabbage'], label: 'ヤサイ' },
  abura: { raw: ['backfat_raw', 'soy'], label: 'アブラ' },
  garlic: { raw: ['garlic_raw'], label: 'ニンニク' },
  // スープは豚骨（ゲンコツ・背ガラ）と背脂で炊く（スープが切れると1杯も出せない）
  soup: { raw: ['bones', 'backfat_raw'], label: 'スープ' },
  ichimi: { raw: ['ichimi'], label: '一味' },
  'menu:noodle': { raw: ['noodle'], label: '麺（売り切れ）' },
};

/** 廃棄（P/L の廃棄損に計上） */
export function discardWaste(s: GameState, ctx: SimCtx, itemId: string, qty: number, cost: number, reason: string): void {
  if (qty <= 0) return;
  recordPL(s, 'waste', cost);
  s.today.wasteItems[itemId] = (s.today.wasteItems[itemId] ?? 0) + qty;
  addTrash(s, BALANCE.cleaning.trashPerWaste);
  emit(ctx, { type: 'waste', text: `${INGREDIENTS[itemId]?.name ?? itemId}を廃棄（${reason}）`, value: cost });
}

export function addTrash(s: GameState, amount: number): void {
  const bins = s.equipment.filter((e) => e.placed && EQUIPMENT[e.type]?.role === 'trash');
  if (bins.length === 0) {
    s.kitchenGrime = clamp01(s.kitchenGrime + amount * 0.01);
    return;
  }
  // 空いているゴミ箱に入れる
  bins.sort((a, b) => a.fill - b.fill);
  const bin = bins[0]!;
  const cap = EQUIPMENT[bin.type]!.capacity;
  bin.fill = Math.min(cap, bin.fill + amount);
  if (bin.fill >= cap) s.kitchenGrime = clamp01(s.kitchenGrime + amount * 0.01);
}

/** 期限切れのロットを廃棄する（日の終わりに呼ぶ） */
export function expireLots(s: GameState, ctx: SimCtx): void {
  const keep: Lot[] = [];
  for (const l of s.inventory) {
    // expiresDay の営業日の終わりまで使える（保存期間0の仕込み品はその日の閉店で廃棄）
    if (l.expiresDay <= s.day) {
      discardWaste(s, ctx, l.itemId, l.qty, l.qty * l.unitCost, '期限切れ');
    } else {
      keep.push(l);
    }
  }
  s.inventory = keep;
}

/**
 * 仕入れの単価（1単位）。s を渡すと、店の場所の食料の物価（都道府県の消費者物価地域差指数）を掛ける（じろ1 5.5。場所のない店は ×1）
 */
export function purchaseUnitCost(itemId: string, express: boolean, s?: GameState): number {
  const def = INGREDIENTS[itemId];
  if (!def || def.packQty <= 0) return 0;
  return (def.packPrice / def.packQty) * (express ? 1.3 : 1) * (s ? purchaseMultOf(s) : (BALANCE.purchaseCostMult ?? 1));
}

/** 1パックの仕入れ値（店の場所の物価を入れる。円） */
export function packPriceOf(s: GameState, itemId: string): number {
  const def = INGREDIENTS[itemId];
  if (!def) return 0;
  return Math.round(def.packPrice * purchaseMultOf(s));
}

export interface OrderResult {
  ok: boolean;
  reason?: string;
  cost?: number;
}

/**
 * 食材を発注する（パック単位）。代金は発注時に支払う。
 * express=true は当日便（60秒後に到着, 3割高）。false は翌朝便。
 */
export function placeOrder(s: GameState, ctx: SimCtx, itemId: string, packs: number, express: boolean, by: PurchaseRecord['by'] = 'manual'): OrderResult {
  const def = INGREDIENTS[itemId];
  if (!def || !def.purchasable) return { ok: false, reason: 'この食材は仕入れできません' };
  if (def.unlock && !s.career.unlocked.includes(def.unlock)) return { ok: false, reason: 'まだ解放されていません' };
  if (!Number.isInteger(packs) || packs <= 0 || packs > 50) return { ok: false, reason: '数量が不正です' };
  if (s.phase === 'bankrupt') return { ok: false, reason: '破産しています' };
  const qty = def.packQty * packs;
  if (def.storage === 'fridge') {
    const cap = fridgeCapacity(s) + (def.frozenShelfLifeDays ? freezerCapacity(s) : 0);
    if (fridgeUsage(s, true) + qty * def.kgPerUnit > cap + 1e-6) {
      return { ok: false, reason: `冷蔵庫の容量が足りません（${cap}kg）` };
    }
  }
  const unit = purchaseUnitCost(itemId, express, s);
  const cost = Math.round(unit * qty);
  if (!cash(s, 'purchase', -cost, `${def.name} ×${packs}${express ? '（当日便）' : ''}`)) {
    return { ok: false, reason: '資金が足りません' };
  }
  recordPL(s, 'purchases', cost);
  const arriveNow = express && (s.phase === 'open' || s.phase === 'prep' || s.phase === 'closing');
  s.deliveries.push({
    id: newId(s, 'dl'),
    itemId,
    qty,
    unitCost: unit,
    arriveDay: arriveNow ? s.day : s.day + 1,
    arriveAt: arriveNow ? s.t + 60 : null,
  });
  emit(ctx, { type: 'order', text: `${def.name}を${packs}パック発注`, value: cost });
  // 仕入れの記録（じろ2）
  const log = (s.purchaseLog ??= []);
  log.push({ day: s.day, itemId, packs, cost, express, by });
  if (log.length > PURCHASE_LOG_KEEP) log.splice(0, log.length - PURCHASE_LOG_KEEP);
  return { ok: true, cost };
}

/** 保存期間の上限の余裕 */
const SHELF_MARGIN = 1.2;

/** 残す仕入れの記録の数 */
const PURCHASE_LOG_KEEP = 60;

/** 自動の仕入れ（自動発注・店長の発注・当日便）をする食材か（じろ2: 食材ごとの有効/無効） */
export function autoOrderEnabled(s: GameState, itemId: string): boolean {
  return !(s.autoOrderOff ?? []).includes(itemId);
}

/** 食材ごとに自動の仕入れを止める・戻す（目安の量はそのまま） */
export function setAutoOrderItem(s: GameState, itemId: string, enabled: boolean): { ok: boolean; reason?: string } {
  const def = INGREDIENTS[itemId];
  if (!def || !def.purchasable) return { ok: false, reason: '仕入れできる食材ではありません' };
  const off = new Set(s.autoOrderOff ?? []);
  if (enabled) off.delete(itemId);
  else off.add(itemId);
  if (off.size === 0) delete s.autoOrderOff;
  else s.autoOrderOff = [...off];
  return { ok: true };
}

/**
 * 保存期間のうちに使い切れる量（じろ2: 改修設計書02「保存期間を過ぎる買いすぎを防ぐ」）。
 * 最近の営業日の1日の使用量 × 保存期間の日数（仕込み1回分は持てる）。使用量がわからなければ上限なし
 */
export function shelfLifeCap(s: GameState, itemId: string): number {
  const def = INGREDIENTS[itemId];
  if (!def) return Number.POSITIVE_INFINITY;
  const rows = recentOpenDays(s);
  const used = rows.reduce((a, r) => a + (r.usedItems?.[itemId] ?? 0), 0);
  if (rows.length === 0 || used <= 0) return Number.POSITIVE_INFINITY;
  const daily = used / rows.length;
  const life = Math.max(def.shelfLifeDays, def.frozenShelfLifeDays && freezerCapacity(s) > 0 ? def.frozenShelfLifeDays : 0);
  // 少し余裕を持たせる（使用量は品切れの日に少なく出るため）
  return Math.max((PREP_BATCH[itemId] ?? 0) + def.packQty, daily * life * SHELF_MARGIN);
}

/** 到着した配送を在庫に入れる */
export function receiveDeliveries(s: GameState, ctx: SimCtx, morning: boolean): void {
  const remaining = [];
  for (const d of s.deliveries) {
    const due = morning ? d.arriveDay <= s.day && d.arriveAt === null : d.arriveAt !== null && d.arriveDay === s.day && s.t >= d.arriveAt;
    const overdue = d.arriveDay < s.day;
    if (due || overdue) {
      addLot(s, d.itemId, d.qty, d.unitCost, 1);
      emit(ctx, { type: 'delivery', text: `${INGREDIENTS[d.itemId]?.name ?? d.itemId}が届いた` });
      notify(s, ctx, `delivery:${d.itemId}`, 'info', `${INGREDIENTS[d.itemId]?.name ?? d.itemId}が納品されました`);
    } else {
      remaining.push(d);
    }
  }
  s.deliveries = remaining;
}

/** 冷蔵庫に入りきらないときに先に確保する食材（ないと1杯も出せない: 麺・スープを炊く豚骨） */
const ESSENTIAL_ITEMS = ['noodle', 'bones'];

/**
 * 自動発注（閉店後の翌朝便）。目標在庫に足りない分をパック単位で発注する。
 * 冷蔵の食材が冷蔵庫に入りきらないときは、足りない分を比例して減らし（麺・豚骨は最低1パック）、余った容量は残りが少ない食材から入れる
 * （以前は表の順に発注していたため、麺・豚・ガラで冷蔵庫が埋まり、もやしが入らずヤサイが作れなくなって店が止まった。
 * 統合進化設計書 v2.1 の経済の測定で発見）
 */
export function runAutoOrder(s: GameState, ctx: SimCtx): void {
  type Need = { itemId: string; packs: number; full: number; kgPerPack: number; coverage: number; fridge: boolean };
  const needs: Need[] = [];
  const mgr = managerOrders(s);
  const forecast = mgr ? forecastNextDay(s) : null;
  const shelfCut: string[] = [];
  for (const itemId of Object.keys(s.autoOrder)) {
    if (!autoOrderEnabled(s, itemId)) continue;
    let target = mgr ? managerOrderTarget(s, itemId, forecast) : autoOrderTarget(s, itemId);
    const def = INGREDIENTS[itemId];
    if (!def || !def.purchasable || target <= 0) continue;
    // 保存期間のうちに使い切れない分は頼まない（じろ2）
    const cap = shelfLifeCap(s, itemId);
    if (target > cap) {
      target = Math.round(cap);
      if (stockOf(s, itemId) + pendingOf(s, itemId) < target + def.packQty) shelfCut.push(itemId);
    }
    if (def.unlock && !s.career.unlocked.includes(def.unlock)) continue;
    const have = stockOf(s, itemId) + pendingOf(s, itemId);
    if (have >= target) continue;
    const packs = Math.ceil((target - have) / def.packQty);
    needs.push({
      itemId,
      packs,
      full: packs,
      kgPerPack: def.packQty * def.kgPerUnit,
      coverage: have / target,
      fridge: def.storage === 'fridge' && def.kgPerUnit > 0,
    });
  }
  // 冷蔵庫に入る量に合わせる（冷凍できる食材は冷凍庫の分も使えるが、まずは冷蔵庫に入る量で配分する）
  const fridgeNeeds = needs.filter((n) => n.fridge);
  const wantKg = fridgeNeeds.reduce((a, n) => a + n.packs * n.kgPerPack, 0);
  const avail = Math.max(0, fridgeCapacity(s) - fridgeUsage(s, true));
  const reduced: string[] = [];
  if (wantKg > avail + 1e-6 && fridgeNeeds.length > 0) {
    const k = avail / wantKg;
    let left = avail;
    // 比例して減らす。ないと1杯も出せない食材（麺・スープの豚骨）は、かさばっても最低1パックは入れる
    for (const n of fridgeNeeds) {
      const essential = ESSENTIAL_ITEMS.includes(n.itemId);
      let p = Math.floor(n.packs * k);
      if (essential && p === 0 && n.packs > 0 && n.kgPerPack <= left + 1e-6) p = 1;
      if (p < n.packs) reduced.push(n.itemId);
      n.packs = p;
      left -= p * n.kgPerPack;
    }
    // 余った容量は、残りが少ない食材から1パックずつ（麺・豚骨を先にすると、少量の背脂・ニンニクが毎晩入らなくなった）
    const order = [...fridgeNeeds].sort((a, b) => a.coverage - b.coverage || a.kgPerPack - b.kgPerPack);
    let added = true;
    while (added) {
      added = false;
      for (const n of order) {
        if (n.kgPerPack <= left + 1e-6 && n.packs < n.full) {
          n.packs += 1;
          left -= n.kgPerPack;
          added = true;
        }
      }
    }
  }
  // 残りが少ない食材から先に発注する（資金が足りないときも必要な物を先に）
  needs.sort((a, b) => a.coverage - b.coverage);
  // 店長の発注は、手元の資金から翌日の固定費の分を残した額まで（資金が足りないときに無制限に仕入れない。じろ1 5.8）
  let budget = mgr ? managerOrderBudget(s) : Number.POSITIVE_INFINITY;
  const summary: NonNullable<DayStats['managerOrder']> = { spent: 0, packs: 0, skipped: 0, ...(forecast ? { forecast } : {}) };
  for (const n of needs) {
    if (n.packs <= 0) continue;
    const def = INGREDIENTS[n.itemId]!;
    if (mgr) {
      const afford = Math.floor(budget / packPriceOf(s, n.itemId));
      if (afford < n.packs) summary.skipped += n.packs - Math.max(0, afford);
      n.packs = Math.max(0, Math.min(n.packs, afford));
      if (n.packs <= 0) continue;
    }
    const r = placeOrder(s, ctx, n.itemId, Math.min(50, n.packs), false, mgr ? 'manager' : 'auto');
    if (r.ok && mgr) {
      const cost = Math.round(Math.min(50, n.packs) * def.packQty * purchaseUnitCost(n.itemId, false, s));
      budget -= cost;
      summary.spent += cost;
      summary.packs += Math.min(50, n.packs);
    }
    if (!r.ok) notify(s, ctx, `autoorder:${n.itemId}`, 'warn', `自動発注できません: ${def.name}（${r.reason}）`);
    else clearNotice(s, `autoorder:${n.itemId}`);
  }
  if (mgr) {
    // 店長の発注の実績（日報に入れる。閉店後の精算で日報はもう作られているので、最後の日報にも書く）
    s.today.managerOrder = summary;
    const last = s.history.at(-1);
    if (last && last.day === s.day) last.managerOrder = { ...summary, ...(forecast ? { forecast: { ...forecast } } : {}) };
    if (forecast?.closed) notify(s, ctx, 'mgrForecast', 'info', `店長: あす（${forecast.day}日目）は定休日なので、翌朝便は頼みません（定休日の夜に次の営業日の分を頼みます）`);
    else clearNotice(s, 'mgrForecast');
    if (summary.skipped > 0) notify(s, ctx, 'autoorder:budget', 'warn', `店長: 資金が少ないため、翌朝便を${summary.skipped}パック減らしました（手元に翌日の固定費の2日分を残す）`);
    else clearNotice(s, 'autoorder:budget');
  }
  if (shelfCut.length > 0) notify(s, ctx, 'autoorder:shelf', 'info', `保存期間のうちに使い切れない分は頼みませんでした（${shelfCut.map((id) => INGREDIENTS[id]?.name ?? id).join('・')}）`);
  else clearNotice(s, 'autoorder:shelf');
  if (reduced.length > 0) {
    notify(
      s,
      ctx,
      'autoorder:fridge',
      'warn',
      `冷蔵庫に入りきらないため、自動発注を減らしました（${reduced.map((id) => INGREDIENTS[id]?.name ?? id).join('・')}）。冷蔵庫を増やすか、自動発注の量を見直してください`,
    );
  } else clearNotice(s, 'autoorder:fridge');
}

export function hasWorkingFridge(s: GameState): boolean {
  return hasWorkingEquipmentRole(s, 'fridge');
}
