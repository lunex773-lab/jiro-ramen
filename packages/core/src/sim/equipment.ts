// 設備の状態・故障・修理・購入（設計書 10）。
// 故障率はランダムだけでなく、状態（使い込み）と設備の質に依存させる。

import { EQUIPMENT, type EquipmentDef, type EquipmentRole } from '../data/equipment';
import { BALANCE } from '../data/balance';
import { accessPoint, equipmentCenter } from '../geometry';
import type { Equipment, EquipmentStatus, GameState, Rot, Vec2 } from '../types';
import { clamp, dist, newId, rand } from '../util';
import { cash, recordPL, spend } from './economy';
import { emit, notify, type SimCtx } from './notices';

export function defOf(e: Equipment): EquipmentDef {
  const d = EQUIPMENT[e.type];
  if (!d) throw new Error(`unknown equipment ${e.type}`);
  return d;
}

export function makeEquipment(s: GameState, type: string, gx: number, gz: number, rot: Rot, placed: boolean): Equipment {
  const def = EQUIPMENT[type];
  if (!def) throw new Error(`unknown equipment ${type}`);
  return {
    id: newId(s, 'e'),
    type,
    placed: placed || def.w === 0,
    gx,
    gz,
    rot,
    offset: { x: 0, z: 0 },
    condition: 100,
    status: 'normal',
    repairUntil: null,
    uses: 0,
    maintenanceBooked: false,
    slots: def.role === 'boiler' ? Array.from({ length: def.capacity }, () => null) : [],
    process: null,
    soupL: 0,
    soupQuality: 0,
    soupCost: 0,
    bowlSlots: def.role === 'assembly' ? Array.from({ length: def.capacity }, () => null) : [],
    washing: [],
    washElapsed: 0,
    fill: 0,
  };
}

export function statusFromCondition(c: number): EquipmentStatus {
  if (c <= 0) return 'broken';
  if (c < 30) return 'faulty';
  if (c < 60) return 'worn';
  return 'normal';
}

export function isUsable(e: Equipment): boolean {
  return e.status !== 'broken' && e.status !== 'repairing';
}

/** 状態による作業速度倍率 */
export function statusSpeed(e: Equipment): number {
  switch (e.status) {
    case 'normal':
      return 1;
    case 'worn':
      return 0.9;
    case 'faulty':
      return 0.7;
    default:
      return 0;
  }
}

export function effectiveSpeed(e: Equipment): number {
  return defOf(e).speed * statusSpeed(e);
}

export const STATUS_LABEL: Record<EquipmentStatus, string> = {
  normal: '正常',
  worn: '劣化',
  faulty: '不調',
  broken: '故障',
  repairing: '修理中',
};

/**
 * 設備を使う。状態が下がり、故障判定を行う。
 * 故障率 = 基本故障率 × (1 + 4 × 劣化度)。劣化度 = 1 − 状態/100
 */
export function useEquipment(s: GameState, ctx: SimCtx, e: Equipment, times = 1): void {
  const def = defOf(e);
  e.uses += times;
  if (def.utilityPerUse > 0) recordPL(s, 'utilities', def.utilityPerUse * times);
  if (def.wearPerUse > 0) e.condition = clamp(e.condition - def.wearPerUse * times, 0, 100);
  if (e.status === 'repairing') return;
  let st = statusFromCondition(e.condition);
  if (st !== 'broken' && def.failureBase > 0) {
    const wear = 1 - e.condition / 100;
    const p = 1 - Math.pow(1 - def.failureBase * (1 + 4 * wear), times);
    if (rand(s) < p) st = 'broken';
  }
  if (st !== e.status) {
    const prev = e.status;
    e.status = st;
    if (st === 'broken') {
      s.today.breakdowns += 1;
      emit(ctx, { type: 'breakdown', targetId: e.id, text: `${def.name}が故障した` });
      notify(s, ctx, `broken:${e.id}`, 'danger', `${def.name}が故障しました。経営メニューの「設備」から修理を依頼してください`);
      onBroken(s, ctx, e);
    } else if (st === 'faulty' && prev !== 'faulty') {
      notify(s, ctx, `faulty:${e.id}`, 'warn', `${def.name}の調子が悪い（作業が遅くなっています）`);
    }
  }
}

/** 故障したときの影響（麺釜の麺は伸びる、など） */
function onBroken(s: GameState, ctx: SimCtx, e: Equipment): void {
  const def = defOf(e);
  if (def.role === 'dishwasher' && e.washing.length > 0) {
    // 洗浄途中の丼は汚れたまま取り出す（洗い場へ）
    const sink = s.equipment.find((x) => x.placed && EQUIPMENT[x.type]?.role === 'sink');
    for (const id of e.washing) {
      const b = s.bowls.find((x) => x.id === id);
      if (!b) continue;
      b.state = 'dirty';
      b.loc = sink ? { at: 'sink', stationId: sink.id } : { at: 'rack' };
      if (!sink) b.state = 'clean';
    }
    e.washing = [];
    e.washElapsed = 0;
    emit(ctx, { type: 'info', text: '食洗機の中の丼を洗い場に移した' });
  }
}

/** 修理を依頼する（修理費を払い、修理時間後に復旧） */
export function requestRepair(s: GameState, ctx: SimCtx, e: Equipment): { ok: boolean; reason?: string } {
  const def = defOf(e);
  if (e.status === 'repairing') return { ok: false, reason: 'すでに修理中です' };
  if (e.status === 'normal' && e.condition >= 95) return { ok: false, reason: '修理の必要はありません' };
  // 劣化・不調段階での修理は割安
  const cost = e.status === 'broken' ? def.repairCost : Math.round(def.repairCost * 0.5);
  if (!spend(s, 'repair', 'repairs', cost, `${def.name}の修理`)) return { ok: false, reason: '資金が足りません' };
  e.status = 'repairing';
  // 営業していない時間帯は翌営業開始までに直る
  e.repairUntil = s.phase === 'closed' ? 0 : s.t + def.repairTime;
  emit(ctx, { type: 'repair', targetId: e.id, text: `${def.name}の修理を依頼した`, value: cost });
  return { ok: true };
}

export function updateRepairs(s: GameState, ctx: SimCtx): void {
  for (const e of s.equipment) {
    if (e.status !== 'repairing' || e.repairUntil === null) continue;
    if (s.t >= e.repairUntil || s.phase === 'closed') finishRepair(s, ctx, e);
  }
}

export function finishRepair(s: GameState, ctx: SimCtx, e: Equipment): void {
  e.condition = Math.max(e.condition, 85);
  e.status = statusFromCondition(e.condition);
  e.repairUntil = null;
  notify(s, ctx, `broken:${e.id}`, 'good', `${defOf(e).name}の修理が完了しました`);
}

export function maintenanceCost(e: Equipment): number {
  return Math.max(2_000, Math.round(defOf(e).repairCost * 0.2));
}

/** 閉店後の定期メンテ（予約済みの設備の状態を回復） */
export function runMaintenance(s: GameState, ctx: SimCtx): void {
  for (const e of s.equipment) {
    if (!e.maintenanceBooked) continue;
    const cost = maintenanceCost(e);
    if (spend(s, 'maintenance', 'repairs', cost, `${defOf(e).name}の定期メンテ`, `mt:${e.id}:${s.day}`)) {
      e.condition = clamp(e.condition + 40, 0, 100);
      if (e.status !== 'repairing') e.status = statusFromCondition(e.condition);
    } else {
      notify(s, ctx, `mtfail:${e.id}`, 'warn', `${defOf(e).name}の定期メンテ代が払えませんでした`);
    }
  }
}

export function countOwned(s: GameState, type: string): number {
  return s.equipment.filter((e) => e.type === type).length;
}

export function isUnlocked(s: GameState, unlock: string | undefined): boolean {
  return !unlock || s.career.unlocked.includes(unlock);
}

/** 設備を購入する。配置が必要な設備は倉庫（未配置）に入る */
export function buyEquipment(s: GameState, ctx: SimCtx, type: string): { ok: boolean; reason?: string; id?: string } {
  const def = EQUIPMENT[type];
  if (!def) return { ok: false, reason: '不明な設備です' };
  if (!isUnlocked(s, def.unlock)) return { ok: false, reason: 'まだ解放されていません' };
  if (countOwned(s, type) >= def.maxCount) return { ok: false, reason: 'これ以上は購入できません' };
  if (!cash(s, 'equipment', -def.price, `${def.name}を購入`)) return { ok: false, reason: '資金が足りません' };
  recordPL(s, 'capex', def.price);
  const e = makeEquipment(s, type, 0, 0, 0, false);
  if (def.role === 'soup') {
    e.soupL = 0;
  }
  s.equipment.push(e);
  s.layoutVersion += 1;
  emit(ctx, { type: 'buy', targetId: e.id, text: `${def.name}を購入した`, value: def.price });
  return { ok: true, id: e.id };
}

/** 設備を売却する（買取率 BALANCE.resaleRate） */
export function sellEquipment(s: GameState, ctx: SimCtx, e: Equipment): { ok: boolean; reason?: string } {
  const def = defOf(e);
  if (s.phase === 'open' || s.phase === 'closing') return { ok: false, reason: '営業中は売却できません' };
  if (e.slots.some((x) => x !== null) || e.bowlSlots.some((x) => x !== null) || e.washing.length > 0 || e.process) {
    return { ok: false, reason: '使用中の設備は売却できません' };
  }
  const value = resaleValue(e);
  cash(s, 'equipmentSale', value, `${def.name}を売却`, `sell:${e.id}`);
  s.equipment = s.equipment.filter((x) => x.id !== e.id);
  s.layoutVersion += 1;
  emit(ctx, { type: 'sell', text: `${def.name}を売却した`, value });
  return { ok: true };
}

export function resaleValue(e: Equipment): number {
  const def = defOf(e);
  return Math.round(def.price * BALANCE.resaleRate * (0.5 + 0.5 * (e.condition / 100)));
}

export function equipmentByRole(s: GameState, role: EquipmentRole): Equipment[] {
  return s.equipment.filter((e) => e.placed && EQUIPMENT[e.type]?.role === role);
}

/** 指定位置から最も近い、条件を満たす設備 */
export function nearestByRole(s: GameState, role: EquipmentRole, from: Vec2, usableOnly = true): { e: Equipment; d: number } | null {
  let best: { e: Equipment; d: number } | null = null;
  for (const e of equipmentByRole(s, role)) {
    if (usableOnly && !isUsable(e)) continue;
    const d = dist(from, equipmentCenter(e));
    if (!best || d < best.d) best = { e, d };
  }
  return best;
}

/**
 * 依存する設備までの距離による作業時間の倍率（設計書 11.5 動線）。
 * 1.5m 以内なら等倍、それ以上は往復の分だけ遅くなる。
 */
export function distanceFactor(d: number): number {
  return 1 + Math.max(0, d - 1.5) * 0.35;
}

/** 依存設備の最大距離。これを超えると作業できない */
export const MAX_DEPENDENCY_DIST = 6;

export function upkeepTotal(s: GameState): number {
  return s.equipment.reduce((a, e) => a + (EQUIPMENT[e.type]?.upkeep ?? 0), 0);
}

export function effectSum(s: GameState, key: 'comfort' | 'demand' | 'grimeReduction' | 'lostItemReduction' | 'service'): number {
  let v = 0;
  for (const e of s.equipment) {
    if (!e.placed) continue;
    v += EQUIPMENT[e.type]?.effects?.[key] ?? 0;
  }
  return v;
}

export function equipmentAccess(e: Equipment): Vec2 {
  return accessPoint(e);
}
