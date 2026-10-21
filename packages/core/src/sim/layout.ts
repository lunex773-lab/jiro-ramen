// 店舗レイアウト（設計書 11）: グリッド配置＋一部の微調整のハイブリッド方式。
// 配置変更は閉店後・準備時間のみ。検証済みの変更だけを確定する。

import { EQUIPMENT } from '../data/equipment';
import { CELL, STAGES } from '../data/stages';
import { accessPoint, equipmentCenter, equipmentRect, seatKitchenPoint, seatPos, stageOf, type Rect } from '../geometry';
import { buildNavGrid, cellBlocked, cellVisited, floodFill, isNarrowAt } from '../nav';
import type { Equipment, GameState, Rot, Vec2 } from '../types';
import { dist } from '../util';
import { cash, recordPL } from './economy';
import { MAX_DEPENDENCY_DIST } from './equipment';
import { emit, notify, type SimCtx } from './notices';

export const FINE_ADJUST_MAX = 0.24;

export interface LayoutCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  const eps = 1e-6;
  return a.x0 < b.x1 - eps && a.x1 > b.x0 + eps && a.z0 < b.z1 - eps && a.z1 > b.z0 + eps;
}

export function layoutEditable(s: GameState): boolean {
  return s.phase === 'closed' || s.phase === 'prep';
}

/** 1台の配置が置ける場所か（重なり・範囲・区画） */
function checkPlacement(s: GameState, e: Equipment, errors: string[]): void {
  const def = EQUIPMENT[e.type];
  if (!def || def.w === 0) return;
  const st = stageOf(s);
  const r = equipmentRect(e);
  const zoneRect = def.zone === 'kitchen' ? st.kitchen : st.dining;
  const zr = { x0: zoneRect.x0 * CELL, z0: zoneRect.z0 * CELL, x1: zoneRect.x1 * CELL, z1: zoneRect.z1 * CELL };
  const eps = 1e-6;
  if (r.x0 < zr.x0 - eps || r.z0 < zr.z0 - eps || r.x1 > zr.x1 + eps || r.z1 > zr.z1 + eps) {
    errors.push(`${def.name}: ${def.zone === 'kitchen' ? '厨房' : '客席'}の範囲外です`);
  }
  if (!def.fineAdjust && (Math.abs(e.offset.x) > eps || Math.abs(e.offset.z) > eps)) {
    errors.push(`${def.name}: 微調整できない設備です`);
  }
  if (Math.abs(e.offset.x) > FINE_ADJUST_MAX + eps || Math.abs(e.offset.z) > FINE_ADJUST_MAX + eps) {
    errors.push(`${def.name}: 微調整の範囲を超えています`);
  }
  // 入口の前は空けておく
  if (def.zone === 'dining') {
    const doorZone = { x0: st.door.x0 - 0.3, z0: 0, x1: st.door.x1 + 0.3, z1: 1.0 };
    if (rectsOverlap(r, doorZone)) errors.push(`${def.name}: 入口をふさいでいます`);
  }
  for (const o of s.equipment) {
    if (o.id === e.id || !o.placed) continue;
    const od = EQUIPMENT[o.type];
    if (!od || od.w === 0) continue;
    if (rectsOverlap(r, equipmentRect(o))) errors.push(`${def.name}: ${od.name}と重なっています`);
  }
}

/**
 * レイアウト全体を検証する（設計書 11.2）。
 * - 重複・壁・区画
 * - 厨房の全設備の操作位置に従業員出入口から到達できるか
 * - 全席・券売機・待ち位置に入口から到達できるか
 * - 配膳位置（カウンター裏）に到達できるか
 * - 通路幅（0.5m の狭い通路は警告）
 */
export function validateLayout(s: GameState): LayoutCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const st = stageOf(s);
  const placed = s.equipment.filter((e) => e.placed && (EQUIPMENT[e.type]?.w ?? 0) > 0);
  if (placed.length > st.maxEquipment) errors.push(`設置できる設備は${st.maxEquipment}台までです`);
  for (const e of placed) checkPlacement(s, e, errors);
  if (errors.length > 0) return { ok: false, errors: dedupe(errors), warnings };

  const grid = buildNavGrid(s);
  const staff = floodFill(s, st.staffSpawn, 'staff');
  const doorInside = { x: (st.door.x0 + st.door.x1) / 2, z: 0.3 };
  const guest = floodFill(s, doorInside, 'customer');

  for (const e of placed) {
    const def = EQUIPMENT[e.type]!;
    const ap = accessPoint(e);
    const flood = def.zone === 'kitchen' ? staff : guest;
    if (cellBlocked(grid, ap)) errors.push(`${def.name}: 正面（操作する位置）がふさがっています`);
    else if (!cellVisited(flood, ap)) errors.push(`${def.name}: 操作する位置まで行けません`);
    else if (isNarrowAt(s, ap)) warnings.push(`${def.name}の前の通路が狭く（0.5m）、移動が遅くなります`);
  }
  for (const seat of s.seats) {
    if (!seat.installed || seat.index >= st.seats.length) continue;
    if (!cellVisited(guest, seatPos(s, seat))) errors.push(`${seat.index + 1}番席にお客さんが行けません`);
    if (!cellVisited(staff, seatKitchenPoint(s, seat))) errors.push(`${seat.index + 1}番席にカウンター越しに配膳できません（カウンター裏の通路をふさいでいます）`);
  }
  for (const w of st.waitSpots.slice(0, 3)) {
    if (!cellVisited(guest, w)) {
      errors.push('店内の待ち位置に行けません');
      break;
    }
  }
  // 必須設備
  const has = (role: string) => placed.some((e) => EQUIPMENT[e.type]?.role === role);
  const required: [string, string][] = [
    ['boiler', '麺釜'], ['assembly', '盛り付け台'], ['soup', 'スープ寸胴'], ['topping', 'トッピング台'], ['rack', '丼棚'], ['sink', '洗い場'],
  ];
  for (const [role, name] of required) if (!has(role)) warnings.push(`${name}が置かれていません（営業に必要です）`);
  if (!has('ticket')) warnings.push('券売機がないと食券の手売りになり、来客が減ります');
  // 動線: 盛り付け台から依存設備までの距離
  for (const asm of placed.filter((e) => EQUIPMENT[e.type]?.role === 'assembly')) {
    for (const [role, name] of [['soup', 'スープ寸胴'], ['topping', 'トッピング台'], ['boiler', '麺釜']] as const) {
      const deps = placed.filter((e) => EQUIPMENT[e.type]?.role === role);
      if (deps.length === 0) continue;
      const d = Math.min(...deps.map((x) => dist(equipmentCenter(x), equipmentCenter(asm))));
      if (d > MAX_DEPENDENCY_DIST) warnings.push(`盛り付け台から${name}が遠すぎて使えません（${d.toFixed(1)}m）`);
      else if (d > 2.5) warnings.push(`盛り付け台から${name}まで${d.toFixed(1)}m。近いほど作業が速くなります`);
    }
  }
  return { ok: errors.length === 0, errors: dedupe(errors), warnings: dedupe(warnings) };
}

function dedupe(a: string[]): string[] {
  return [...new Set(a)];
}

export interface PlaceRequest {
  equipmentId: string;
  gx: number;
  gz: number;
  rot: Rot;
  offset?: Vec2;
}

/** 配置を試す（検証に通らなければ元に戻す） */
export function placeEquipment(s: GameState, ctx: SimCtx, req: PlaceRequest): LayoutCheck {
  if (!layoutEditable(s)) return { ok: false, errors: ['配置変更は閉店後か準備時間にだけできます'], warnings: [] };
  const e = s.equipment.find((x) => x.id === req.equipmentId);
  if (!e) return { ok: false, errors: ['設備が見つかりません'], warnings: [] };
  const def = EQUIPMENT[e.type];
  if (!def || def.w === 0) return { ok: false, errors: ['配置する必要のない設備です'], warnings: [] };
  if (![0, 1, 2, 3].includes(req.rot) || !Number.isInteger(req.gx) || !Number.isInteger(req.gz)) {
    return { ok: false, errors: ['配置の指定が不正です'], warnings: [] };
  }
  if (busy(e)) return { ok: false, errors: ['使用中の設備は動かせません（中身を片付けてから）'], warnings: [] };
  const before = { placed: e.placed, gx: e.gx, gz: e.gz, rot: e.rot, offset: { ...e.offset } };
  const off = def.fineAdjust && req.offset ? { x: req.offset.x, z: req.offset.z } : { x: 0, z: 0 };
  e.placed = true;
  e.gx = req.gx;
  e.gz = req.gz;
  e.rot = req.rot;
  e.offset = off;
  const check = validateLayout(s);
  if (!check.ok) {
    Object.assign(e, before);
    return check;
  }
  s.layoutVersion += 1;
  emit(ctx, { type: 'layout', targetId: e.id });
  return check;
}

/** 設備を倉庫にしまう（未配置にする） */
export function storeEquipment(s: GameState, ctx: SimCtx, id: string): LayoutCheck {
  if (!layoutEditable(s)) return { ok: false, errors: ['配置変更は閉店後か準備時間にだけできます'], warnings: [] };
  const e = s.equipment.find((x) => x.id === id);
  if (!e) return { ok: false, errors: ['設備が見つかりません'], warnings: [] };
  if (busy(e)) return { ok: false, errors: ['使用中の設備はしまえません'], warnings: [] };
  e.placed = false;
  s.layoutVersion += 1;
  emit(ctx, { type: 'layout', targetId: e.id });
  return validateLayout(s);
}

function busy(e: Equipment): boolean {
  return e.slots.some((x) => x !== null) || e.bowlSlots.some((x) => x !== null) || e.washing.length > 0 || e.process !== null;
}

/** 空いている場所を探して自動配置する（購入直後の仮置き用） */
export function autoPlace(s: GameState, ctx: SimCtx, id: string): boolean {
  const e = s.equipment.find((x) => x.id === id);
  if (!e) return false;
  const def = EQUIPMENT[e.type];
  if (!def || def.w === 0) return true;
  const st = stageOf(s);
  const zone = def.zone === 'kitchen' ? st.kitchen : st.dining;
  for (const rot of [0, 2, 1, 3] as Rot[]) {
    for (let gz = zone.z1 - 1; gz >= zone.z0; gz--) {
      for (let gx = zone.x0; gx < zone.x1; gx++) {
        const r = placeEquipment(s, ctx, { equipmentId: id, gx, gz, rot });
        if (r.ok) return true;
      }
    }
  }
  return false;
}

// ───────────────────────── 店舗拡張（設計書 12） ─────────────────────────

export interface ExpansionInfo {
  next: (typeof STAGES)[number] | null;
  cost: number;
  relocation: number;
  canExpand: boolean;
  reason: string | null;
}

export function expansionInfo(s: GameState): ExpansionInfo {
  const next = STAGES[s.career.stage + 1] ?? null;
  if (!next) return { next: null, cost: 0, relocation: 0, canExpand: false, reason: 'これ以上は拡張できません' };
  const relocation = s.equipment.filter((e) => e.placed && (EQUIPMENT[e.type]?.w ?? 0) > 0).length * next.relocationPerItem;
  const cost = next.constructionCost + relocation;
  let reason: string | null = null;
  if (next.unlock && !s.career.unlocked.includes(next.unlock)) reason = 'キャリア目標を達成すると解放されます';
  else if (s.phase !== 'closed') reason = '閉店後にだけ工事を依頼できます';
  else if (s.arrears.length > 0) reason = '未払いがあると工事できません';
  else if (s.money < cost + next.minFundsAfter) reason = `資金が足りません（工事費＋運転資金 ¥${(cost + next.minFundsAfter).toLocaleString('ja-JP')} が必要）`;
  return { next, cost, relocation, canExpand: reason === null, reason };
}

export function expand(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  const info = expansionInfo(s);
  if (!info.canExpand || !info.next) return { ok: false, reason: info.reason ?? '拡張できません' };
  if (!cash(s, 'expansion', -info.next.constructionCost, `店舗拡張工事（${info.next.name}）`, `expand:${info.next.id}`)) {
    return { ok: false, reason: '資金が足りません' };
  }
  recordPL(s, 'capex', info.next.constructionCost);
  if (info.relocation > 0) {
    cash(s, 'relocation', -info.relocation, '設備移設費', `reloc:${info.next.id}`);
    recordPL(s, 'capex', info.relocation);
  }
  s.career.stage = info.next.id;
  // 席の枠を増やす（設置は購入が必要）
  const st = info.next;
  for (let i = s.seats.length; i < st.seats.length; i++) {
    s.seats.push({ id: `seat${i}`, index: i, installed: false, offset: { x: 0, z: 0 }, dirt: 0, customerId: null, bowlId: null, lostItemId: null });
  }
  s.closedForConstruction = st.closureDays;
  s.layoutVersion += 1;
  notify(s, ctx, 'expand', 'good', `${st.name}への拡張工事を発注しました。工事のため${st.closureDays}日休業します`);
  emit(ctx, { type: 'expand', value: st.id });
  return { ok: true };
}
