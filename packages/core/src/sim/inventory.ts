// 在庫・仕入れ（設計書 8）。
// 在庫はロット単位で持ち、古いものから使う（先入れ先出し）。在庫以上は消費できない。

import { BALANCE } from '../data/balance';
import { EQUIPMENT } from '../data/equipment';
import { INGREDIENTS } from '../data/ingredients';
import type { GameState, Lot } from '../types';
import { clamp01, newId } from '../util';
import { cash, recordPL } from './economy';
import { clearNotice, emit, notify, type SimCtx } from './notices';

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
  const days: number[] = [s.today.usedItems?.[itemId] ?? 0];
  for (let i = s.history.length - 1; i >= 0 && days.length < A.days; i--) {
    const r = s.history[i]!;
    if (r.day === s.day) continue;
    if (r.usedItems) days.push(r.usedItems[itemId] ?? 0);
  }
  const avg = days.reduce((a, b) => a + b, 0) / days.length;
  let short = false;
  for (const [k, n] of Object.entries(s.today.stockoutItems ?? {})) if (n >= 2 && STOCKOUT_SOURCE[k]?.raw.includes(itemId)) short = true;
  const want = avg * A.safety * (short ? A.stockoutBoost : 1);
  return Math.round(Math.max(manual * A.floorOfManual, want));
}

/** 品切れのもとの食材（仕込みで作る物 → 仕入れる食材）。閉店後の原因の説明と「売れ行きに合わせる」自動発注で使う */
export const STOCKOUT_SOURCE: Record<string, { raw: string[]; label: string }> = {
  // 豚の煮込み・背脂を炊くのには醤油も使う（醤油が足りないと豚肉があっても煮込めない）
  buta: { raw: ['pork_raw', 'soy'], label: '豚' },
  'menu:buta': { raw: ['pork_raw', 'soy'], label: '豚（売り切れ）' },
  yasai: { raw: ['moyashi', 'cabbage'], label: 'ヤサイ' },
  abura: { raw: ['backfat_raw', 'soy'], label: 'アブラ' },
  garlic: { raw: ['garlic_raw'], label: 'ニンニク' },
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

export function purchaseUnitCost(itemId: string, express: boolean): number {
  const def = INGREDIENTS[itemId];
  if (!def || def.packQty <= 0) return 0;
  return (def.packPrice / def.packQty) * (express ? 1.3 : 1);
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
export function placeOrder(s: GameState, ctx: SimCtx, itemId: string, packs: number, express: boolean): OrderResult {
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
  const unit = purchaseUnitCost(itemId, express);
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
  return { ok: true, cost };
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

/**
 * 自動発注（閉店後の翌朝便）。目標在庫に足りない分をパック単位で発注する。
 * 冷蔵の食材が冷蔵庫に入りきらないときは、足りない分を比例して減らし、残りが少ない食材から先に入れる
 * （以前は表の順に発注していたため、麺・豚・ガラで冷蔵庫が埋まり、もやしが入らずヤサイが作れなくなって店が止まった。
 * 統合進化設計書 v2.1 の経済の測定で発見）
 */
export function runAutoOrder(s: GameState, ctx: SimCtx): void {
  type Need = { itemId: string; packs: number; full: number; kgPerPack: number; coverage: number; fridge: boolean };
  const needs: Need[] = [];
  for (const itemId of Object.keys(s.autoOrder)) {
    const target = autoOrderTarget(s, itemId);
    const def = INGREDIENTS[itemId];
    if (!def || !def.purchasable || target <= 0) continue;
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
    // 比例して減らす
    for (const n of fridgeNeeds) {
      const p = Math.floor(n.packs * k);
      if (p < n.packs) reduced.push(n.itemId);
      n.packs = p;
      left -= p * n.kgPerPack;
    }
    // 余った容量は、残りが少ない食材から1パックずつ
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
  for (const n of needs) {
    if (n.packs <= 0) continue;
    const def = INGREDIENTS[n.itemId]!;
    const r = placeOrder(s, ctx, n.itemId, Math.min(50, n.packs), false);
    if (!r.ok) notify(s, ctx, `autoorder:${n.itemId}`, 'warn', `自動発注できません: ${def.name}（${r.reason}）`);
    else clearNotice(s, `autoorder:${n.itemId}`);
  }
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
