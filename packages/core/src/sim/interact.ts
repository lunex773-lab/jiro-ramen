// インタラクション（設計書 5.2）。
// プレイヤーと従業員は同じ「動詞（verb）」で設備・席・汚れ・忘れ物を操作する。
// 各動詞は 開始条件 / 所要時間 / 効果 をデータとして持ち、サーバーでも同じ判定を行う。

import { BALANCE } from '../data/balance';
import type { EquipmentRole } from '../data/equipment';
import { CALLS, DEFAULT_CALL, MENU, callToSpoken } from '../data/menu';
import { NOODLE_SOURCES, INGREDIENTS } from '../data/ingredients';
import { PREP_RECIPES, type PrepRecipe } from '../data/prep';
import { accessPoint, equipmentCenter, seatKitchenPoint, seatPos } from '../geometry';
import type {
  Bowl,
  DayPhase,
  DirtSpot,
  Employee,
  Equipment,
  GameState,
  Hand,
  Id,
  LostItem,
  Order,
  Player,
  Seat,
  ToppingKey,
  Vec2,
} from '../types';
import { clamp01, dist, newId } from '../util';
import { emptyContents, evaluateBowl, isBowlComplete, menuOf, noodleQualityFor, soupPerBowl, toppingAmount } from './cooking';
import { cash, recordPL } from './economy';
import {
  defOf,
  distanceFactor,
  effectiveSpeed,
  isUsable,
  MAX_DEPENDENCY_DIST,
  nearestByRole,
  useEquipment,
} from './equipment';
import { addLot, addTrash, consume, discardWaste, stockOf } from './inventory';
import { emit, notify, type SimCtx } from './notices';
import { leaveFromInsideQueue, leaveWithoutEating, onServed } from './customers';

export type Actor = Player | Employee;

export type Target =
  | { kind: 'equipment'; id: Id; e: Equipment }
  | { kind: 'seat'; id: Id; seat: Seat }
  | { kind: 'dirt'; id: Id; dirt: DirtSpot }
  | { kind: 'lost'; id: Id; lost: LostItem };

export type Args = Record<string, string | number | boolean> | null;

export function getActor(s: GameState, id: Id): Actor | null {
  return s.players.find((p) => p.id === id) ?? s.employees.find((e) => e.id === id) ?? null;
}

export function resolveTarget(s: GameState, id: Id): Target | null {
  const e = s.equipment.find((x) => x.id === id);
  if (e) return { kind: 'equipment', id, e };
  const seat = s.seats.find((x) => x.id === id);
  if (seat) return { kind: 'seat', id, seat };
  const dirt = s.dirt.find((x) => x.id === id);
  if (dirt) return { kind: 'dirt', id, dirt };
  const lost = s.lostItems.find((x) => x.id === id);
  if (lost) return { kind: 'lost', id, lost };
  return null;
}

/** 対象を操作できる位置（複数ある場合はいずれか） */
export function targetPoints(s: GameState, t: Target): Vec2[] {
  switch (t.kind) {
    case 'equipment':
      return [accessPoint(t.e)];
    case 'seat':
      return [seatPos(s, t.seat), seatKitchenPoint(s, t.seat)];
    case 'dirt':
      return [t.dirt.pos];
    case 'lost': {
      const seat = s.seats.find((x) => x.id === t.lost.seatId);
      return seat ? [seatPos(s, seat), seatKitchenPoint(s, seat)] : [];
    }
  }
}

export function inReach(s: GameState, actor: Actor, t: Target, extra = 0): boolean {
  const reach = BALANCE.player.reach + extra + (actor.kind === 'employee' ? 0.25 : 0);
  return targetPoints(s, t).some((p) => dist(actor.pos, p) <= reach);
}

// ───────────────────────── 補助関数 ─────────────────────────

export function roleOf(e: Equipment): EquipmentRole {
  return defOf(e).role;
}

export function bowlById(s: GameState, id: Id | null | undefined): Bowl | undefined {
  if (!id) return undefined;
  return s.bowls.find((b) => b.id === id);
}

export function orderById(s: GameState, id: Id | null | undefined): Order | undefined {
  if (!id) return undefined;
  return s.orders.find((o) => o.id === id);
}

export function waitingOrders(s: GameState): Order[] {
  return s.orders.filter((o) => o.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
}

export function orderForSeat(s: GameState, seat: Seat): Order | undefined {
  if (!seat.customerId) return undefined;
  return s.orders.find((o) => o.seatId === seat.id && o.customerId === seat.customerId && o.status === 'waiting');
}

/** 注文に割り当て済みの、まだ提供していない丼 */
export function bowlForOrder(s: GameState, orderId: Id): Bowl | undefined {
  return s.bowls.find((b) => b.orderId === orderId && (b.state === 'assembling' || b.state === 'clean'));
}

export function noodlesStartedFor(s: GameState, orderId: Id): boolean {
  for (const e of s.equipment) for (const sl of e.slots) if (sl && sl.orderId === orderId) return true;
  const b = bowlForOrder(s, orderId);
  return !!b?.contents && b.contents.noodleG > 0;
}

export function bowlsOnAssembly(s: GameState, e: Equipment): { slot: number; bowl: Bowl }[] {
  const out: { slot: number; bowl: Bowl }[] = [];
  e.bowlSlots.forEach((id, slot) => {
    const b = bowlById(s, id);
    if (b) out.push({ slot, bowl: b });
  });
  return out;
}

/** 割り当てのない丼に、丼のない注文を古い順に割り当てる */
export function assignBowls(s: GameState): void {
  const unassignedBowls = s.bowls.filter(
    (b) => b.orderId === null && (b.state === 'assembling' || (b.state === 'clean' && b.loc.at === 'station')),
  );
  if (unassignedBowls.length === 0) return;
  for (const o of waitingOrders(s)) {
    if (bowlForOrder(s, o.id)) continue;
    const b = unassignedBowls.shift();
    if (!b) break;
    b.orderId = o.id;
  }
}

function handIsEmpty(h: Hand): boolean {
  return h.kind === 'none';
}

function handLabel(h: Hand): string {
  switch (h.kind) {
    case 'none':
      return '手ぶら';
    case 'bowl':
      return '丼';
    case 'clean':
      return `きれいな丼×${h.bowlIds.length}`;
    case 'dirty':
      return `下げた丼×${h.bowlIds.length}`;
    case 'mop':
      return 'モップ';
    case 'lostItem':
      return '忘れ物';
    case 'trash':
      return 'ゴミ';
  }
}

export { handLabel };

const COOKING_PHASES: DayPhase[] = ['prep', 'open', 'closing'];

/** 依存設備（盛り付け台から見たスープ寸胴など）を探す */
function dependency(s: GameState, from: Equipment, role: EquipmentRole, needUsable = true): { e: Equipment; d: number } | null {
  const near = nearestByRole(s, role, equipmentCenter(from), needUsable);
  if (!near || near.d > MAX_DEPENDENCY_DIST) return null;
  return near;
}

function actorSpeed(actor: Actor, kind: 'cook' | 'clean' | 'service' | 'general'): number {
  if (actor.kind === 'player') return 1;
  const sk = actor.profile.skills;
  const exp = Math.min(0.2, actor.profile.experience);
  const skill = kind === 'cook' ? sk.cooking : kind === 'clean' ? sk.hygiene : kind === 'service' ? sk.service : sk.speed;
  return (0.55 + 0.45 * sk.speed + 0.35 * skill) * (1 + exp);
}

// ───────────────────────── 動詞の定義 ─────────────────────────

export interface Plan {
  /** null なら実行可能 */
  reason: string | null;
  label: string;
  /** 1単位の秒数（0 なら即時） */
  unitTime: number;
  units: number;
}

interface VerbDef {
  id: string;
  /** 適用できる対象 */
  match: (t: Target) => boolean;
  phases: DayPhase[];
  /** 作業の種類（従業員の能力の反映先） */
  skill: 'cook' | 'clean' | 'service' | 'general';
  plan: (s: GameState, a: Actor, t: Target, args: Args) => Plan;
  /** 1単位ごとの効果。即時の動詞は index=0 で1回呼ばれる */
  applyUnit: (s: GameState, a: Actor, t: Target, args: Args, ctx: SimCtx, index: number) => void;
  /** 全単位の完了後 */
  finish?: (s: GameState, a: Actor, t: Target, args: Args, ctx: SimCtx) => void;
}

const isRole = (role: EquipmentRole) => (t: Target) => t.kind === 'equipment' && roleOf(t.e) === role;
const eq = (t: Target) => (t as { e: Equipment }).e;
const seatOf = (t: Target) => (t as { seat: Seat }).seat;

const ok = (label: string, unitTime = 0, units = 1): Plan => ({ reason: null, label, unitTime, units });
const no = (label: string, reason: string): Plan => ({ reason, label, unitTime: 0, units: 0 });

function needUsable(e: Equipment, label: string): Plan | null {
  if (!isUsable(e)) return no(label, `${defOf(e).name}は${e.status === 'repairing' ? '修理中' : '故障中'}です`);
  return null;
}

function noodleSource(s: GameState, grams: number): string | null {
  for (const src of NOODLE_SOURCES) if (stockOf(s, src) >= grams) return src;
  return null;
}

/** 麺を入れる対象の注文（麺がまだ・古い順） */
function ordersNeedingNoodles(s: GameState): Order[] {
  return waitingOrders(s).filter((o) => !noodlesStartedFor(s, o.id));
}

const VERBS: VerbDef[] = [
  // ── 麺釜 ──
  {
    id: 'noodles_in',
    match: isRole('boiler'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, a, t) => {
      const e = eq(t);
      const label = '麺を入れる';
      const bad = needUsable(e, label);
      if (bad) return bad;
      if (a.hand.kind === 'dirty' || a.hand.kind === 'trash' || a.hand.kind === 'mop') return no(label, '手を洗ってから（汚れ物を持っています）');
      const free = e.slots.filter((x) => x === null).length;
      if (free === 0) return no(label, '空いているテボがありません');
      const want = ordersNeedingNoodles(s).length;
      const n = Math.max(1, Math.min(free, want));
      if (!noodleSource(s, 300)) return no(label, '麺の在庫がありません');
      const sp = effectiveSpeed(e);
      return ok(want > 0 ? `麺を入れる（${n}玉）` : '麺を入れる（見込み1玉）', 0.6 / sp, n);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const slotIdx = e.slots.findIndex((x) => x === null);
      if (slotIdx < 0) return;
      const order = ordersNeedingNoodles(s)[0];
      const grams = order ? menuOf(order.menuId).noodleG : 300;
      const src = noodleSource(s, grams);
      if (!src) {
        notify(s, ctx, 'stock:noodle', 'danger', '麺が足りません！発注するか製麺してください');
        return;
      }
      const c = consume(s, src, grams);
      const homemadeBonus = src === 'homemade_noodle' ? 1.08 : 1;
      e.slots[slotIdx] = {
        orderId: order?.id ?? null,
        grams,
        elapsed: 0,
        ideal: BALANCE.cooking.noodleIdeal,
        quality: Math.min(1.08, c.quality * homemadeBonus),
        freshness: c.freshness,
        unitCost: c.cost,
      };
      useEquipment(s, ctx, e);
      emit(ctx, { type: 'noodlesIn', actorId: a.id, targetId: e.id });
    },
  },
  {
    id: 'noodles_up',
    match: isRole('boiler'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, a, t) => {
      const e = eq(t);
      const label = '麺上げ（湯切りして丼へ）';
      const ready = e.slots.filter((x) => x && x.elapsed >= x.ideal * 0.6);
      if (ready.length === 0) return no(label, 'ゆで上がった麺がありません');
      const targets = drainTargets(s, a, e);
      if (targets.length === 0) return no(label, '麺を受ける丼がありません（盛り付け台に丼を並べるか、丼を持ってください）');
      // スープ入りの丼があるときは、その数だけ上げる（スープのない丼に麺だけ入れない）
      const soupReady = targets.filter((b) => b.contents && b.contents.soupL > 0).length;
      const n = Math.min(ready.length, soupReady > 0 ? soupReady : targets.length);
      const asm = dependency(s, e, 'assembly', false);
      const f = a.hand.kind === 'bowl' ? 1 : distanceFactor(asm?.d ?? 0);
      return ok(`麺上げ（${n}玉）`, (0.9 * f) / Math.max(0.3, effectiveSpeed(e) || 1), n);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const targets = drainTargets(s, a, e);
      // ゆで上がりの早い順に
      const order = e.slots
        .map((sl, i) => ({ sl, i }))
        .filter((x) => x.sl && x.sl.elapsed >= x.sl.ideal * 0.6)
        .sort((x, y) => y.sl!.elapsed - x.sl!.elapsed);
      const first = order[0];
      if (!first || !first.sl) return;
      const sl = first.sl;
      // 注文が一致する丼 → 同じ量の注文の丼 → 麺のない丼
      const pickBowl =
        targets.find((b) => sl.orderId && b.orderId === sl.orderId) ??
        targets.find((b) => {
          const o = orderById(s, b.orderId);
          return o ? menuOf(o.menuId).noodleG === sl.grams : true;
        }) ??
        targets[0];
      if (!pickBowl) return;
      if (!pickBowl.contents) pickBowl.contents = emptyContents(s.t);
      const c = pickBowl.contents;
      c.noodleG = sl.grams;
      c.noodleQuality = noodleQualityFor(sl.elapsed, sl.ideal) * Math.min(1.08, sl.quality);
      c.noodleBoilDelta = sl.elapsed - sl.ideal;
      c.freshness = Math.min(c.freshness, sl.freshness);
      c.cost += sl.unitCost;
      c.steps.push('noodles');
      c.heat = Math.max(c.heat, c.soupL > 0 ? Math.min(95, c.heat + 4) : 80);
      pickBowl.state = 'assembling';
      if (!pickBowl.orderId && sl.orderId && !bowlForOrder(s, sl.orderId)) pickBowl.orderId = sl.orderId;
      e.slots[first.i] = null;
      emit(ctx, { type: 'noodlesUp', actorId: a.id, targetId: e.id, value: c.noodleQuality });
    },
  },
  {
    id: 'noodles_discard',
    match: isRole('boiler'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (_s, _a, t) => {
      const e = eq(t);
      const over = e.slots.filter((x) => x && x.elapsed > x.ideal + BALANCE.cooking.noodleBadWindow).length;
      if (over === 0) return no('ゆですぎの麺を捨てる', 'ゆですぎの麺はありません');
      return ok(`ゆですぎの麺を捨てる（${over}玉）`, 0.4, 1);
    },
    applyUnit: (s, _a, t, _args, ctx) => {
      const e = eq(t);
      e.slots = e.slots.map((sl) => {
        if (sl && sl.elapsed > sl.ideal + BALANCE.cooking.noodleBadWindow) {
          discardWaste(s, ctx, 'noodle', sl.grams, sl.unitCost, 'ゆですぎ');
          return null;
        }
        return sl;
      });
    },
  },

  // ── 丼棚 ──
  {
    id: 'bowls_take',
    match: isRole('rack'),
    phases: ['prep', 'open', 'closing'],
    skill: 'general',
    plan: (s, a) => {
      const label = 'きれいな丼を取る';
      if (!(handIsEmpty(a.hand) || a.hand.kind === 'clean')) return no(label, `手がふさがっています（${handLabel(a.hand)}）`);
      const have = a.hand.kind === 'clean' ? a.hand.bowlIds.length : 0;
      const avail = s.bowls.filter((b) => b.state === 'clean' && b.loc.at === 'rack').length;
      if (avail === 0) return no(label, 'きれいな丼がありません（洗い場で洗ってください）');
      if (have >= 6) return no(label, 'これ以上持てません');
      return ok(label, 0, 1);
    },
    applyUnit: (s, a, _t, args) => {
      const have = a.hand.kind === 'clean' ? a.hand.bowlIds : [];
      const want = typeof args?.count === 'number' ? Math.max(1, Math.min(6, args.count)) : 4;
      const add = s.bowls.filter((b) => b.state === 'clean' && b.loc.at === 'rack').slice(0, Math.max(0, Math.min(want, 6 - have.length)));
      for (const b of add) b.loc = { at: 'hand', actorId: a.id };
      a.hand = { kind: 'clean', bowlIds: [...have, ...add.map((b) => b.id)] };
    },
  },
  {
    id: 'bowls_return',
    match: isRole('rack'),
    phases: ['prep', 'open', 'closing'],
    skill: 'general',
    plan: (_s, a) => (a.hand.kind === 'clean' ? ok('丼を棚に戻す') : no('丼を棚に戻す', 'きれいな丼を持っていません')),
    applyUnit: (s, a) => {
      if (a.hand.kind !== 'clean') return;
      for (const id of a.hand.bowlIds) {
        const b = bowlById(s, id);
        if (b) b.loc = { at: 'rack' };
      }
      a.hand = { kind: 'none' };
    },
  },

  // ── 盛り付け台 ──
  {
    id: 'bowls_place',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (_s, a, t) => {
      const e = eq(t);
      const label = '丼を並べる';
      if (a.hand.kind !== 'clean' && a.hand.kind !== 'bowl') return no(label, '丼を持っていません（丼棚から取ってください）');
      const free = e.bowlSlots.filter((x) => x === null).length;
      if (free === 0) return no(label, '盛り付け台がいっぱいです');
      return ok(a.hand.kind === 'bowl' ? '丼を置く' : label, 0, 1);
    },
    applyUnit: (s, a, t) => {
      const e = eq(t);
      const ids = a.hand.kind === 'clean' ? [...a.hand.bowlIds] : a.hand.kind === 'bowl' ? [a.hand.bowlId] : [];
      const left: Id[] = [];
      for (const id of ids) {
        const slot = e.bowlSlots.findIndex((x) => x === null);
        const b = bowlById(s, id);
        if (!b) continue;
        if (slot < 0) {
          left.push(id);
          continue;
        }
        e.bowlSlots[slot] = id;
        b.loc = { at: 'station', stationId: e.id, slot };
        if (b.state === 'clean') {
          b.state = 'assembling';
          b.contents = emptyContents(s.t);
        }
      }
      if (a.hand.kind === 'clean') a.hand = left.length > 0 ? { kind: 'clean', bowlIds: left } : { kind: 'none' };
      else a.hand = left.length > 0 ? { kind: 'bowl', bowlId: left[0]! } : { kind: 'none' };
      assignBowls(s);
    },
  },
  {
    id: 'tare',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, _a, t) => {
      const e = eq(t);
      const label = 'タレを入れる';
      const targets = bowlsOnAssembly(s, e).filter((x) => x.bowl.contents && x.bowl.contents.tare === 0);
      if (targets.length === 0) return no(label, 'タレを入れる丼がありません');
      if (stockOf(s, 'tare') < BALANCE.cooking.tarePerLevel) return no(label, 'タレがありません（豚を煮込むとタレができます）');
      return ok(`タレを入れる（${targets.length}杯）`, 0.45, targets.length);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const target = bowlsOnAssembly(s, e).find((x) => x.bowl.contents && x.bowl.contents.tare === 0);
      if (!target || !target.bowl.contents) return;
      const c = consume(s, 'tare', BALANCE.cooking.tarePerLevel);
      if (!c.ok) {
        notify(s, ctx, 'stock:tare', 'danger', 'タレが切れました！豚を煮込んでタレを作ってください');
        return;
      }
      const bc = target.bowl.contents;
      bc.tare = 1;
      bc.tareQuality = 0.85 + 0.15 * c.freshness;
      bc.cost += c.cost;
      bc.steps.push('tare');
      emit(ctx, { type: 'tare', actorId: a.id, targetId: e.id });
    },
  },
  {
    id: 'soup',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, _a, t) => {
      const e = eq(t);
      const label = 'スープを注ぐ';
      const targets = bowlsOnAssembly(s, e).filter((x) => x.bowl.contents && x.bowl.contents.soupL === 0);
      if (targets.length === 0) return no(label, 'スープを注ぐ丼がありません');
      const pot = soupPotFor(s, e);
      if (!pot) return no(label, '近くに使えるスープ寸胴がありません');
      if (pot.e.soupL < BALANCE.cooking.soupPerBowlSmall) return no(label, 'スープが残っていません（寸胴でスープを炊いてください）');
      return ok(`スープを注ぐ（${targets.length}杯）`, (0.6 * distanceFactor(pot.d)) / Math.max(0.3, effectiveSpeed(pot.e)), targets.length);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const target = bowlsOnAssembly(s, e).find((x) => x.bowl.contents && x.bowl.contents.soupL === 0);
      const pot = soupPotFor(s, e);
      if (!target || !target.bowl.contents || !pot) return;
      const order = orderById(s, target.bowl.orderId);
      const need = soupPerBowl(order?.menuId ?? null);
      if (pot.e.soupL < need) {
        notify(s, ctx, 'stock:soup', 'danger', 'スープが足りません！寸胴でスープを炊いてください');
        return;
      }
      const costPart = pot.e.soupL > 0 ? (pot.e.soupCost * need) / pot.e.soupL : 0;
      pot.e.soupL -= need;
      pot.e.soupCost = Math.max(0, pot.e.soupCost - costPart);
      const bc = target.bowl.contents;
      bc.soupL = need;
      bc.soupQuality = pot.e.soupQuality;
      bc.soupTemp = soupTemperature(pot.e);
      bc.heat = Math.max(bc.heat, bc.soupTemp);
      bc.cost += costPart;
      bc.steps.push('soup');
      useEquipment(s, ctx, pot.e);
      emit(ctx, { type: 'soup', actorId: a.id, targetId: e.id });
    },
  },
  {
    id: 'toppings',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, _a, t) => {
      const e = eq(t);
      const label = 'コールどおりに盛る';
      const targets = bowlsOnAssembly(s, e).filter(
        (x) => x.bowl.contents && x.bowl.contents.noodleG > 0 && !x.bowl.contents.steps.includes('toppings'),
      );
      if (targets.length === 0) return no(label, '麺の入った丼がありません');
      const top = dependency(s, e, 'topping');
      if (!top) return no(label, '近くに使えるトッピング台がありません');
      const unasked = targets.filter((x) => {
        const o = orderById(s, x.bowl.orderId);
        return !o || !o.callRevealed;
      }).length;
      const extra = unasked > 0 ? `（コール未確認${unasked}杯）` : '';
      return ok(`豚・トッピングを盛る（${targets.length}杯）${extra}`, (1.0 * distanceFactor(top.d)) / Math.max(0.3, effectiveSpeed(top.e)), targets.length);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const target = bowlsOnAssembly(s, e).find(
        (x) => x.bowl.contents && x.bowl.contents.noodleG > 0 && !x.bowl.contents.steps.includes('toppings'),
      );
      const top = dependency(s, e, 'topping');
      if (!target || !target.bowl.contents || !top) return;
      applyToppings(s, ctx, target.bowl, a);
      useEquipment(s, ctx, top.e);
    },
  },
  {
    id: 'bowl_take',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'service',
    plan: (s, a, t, args) => {
      const e = eq(t);
      const label = '丼を持つ';
      if (!handIsEmpty(a.hand)) return no(label, `手がふさがっています（${handLabel(a.hand)}）`);
      const list = bowlsOnAssembly(s, e);
      const slot = typeof args?.slot === 'number' ? args.slot : -1;
      const pick = slot >= 0 ? list.find((x) => x.slot === slot) : list.find((x) => isBowlComplete(x.bowl.contents)) ?? list[0];
      if (!pick) return no(label, '盛り付け台に丼がありません');
      const o = orderById(s, pick.bowl.orderId);
      const seatNo = o ? s.seats.find((x) => x.id === o.seatId)?.index : undefined;
      const what = o ? `${seatNo !== undefined ? `${seatNo + 1}番席 ` : ''}${MENU[o.menuId]?.short ?? ''}` : '';
      return ok(`丼を持つ${what ? `（${what}）` : ''}`, 0, 1);
    },
    applyUnit: (s, a, t, args) => {
      const e = eq(t);
      const list = bowlsOnAssembly(s, e);
      const slot = typeof args?.slot === 'number' ? args.slot : -1;
      const pick = slot >= 0 ? list.find((x) => x.slot === slot) : list.find((x) => isBowlComplete(x.bowl.contents)) ?? list[0];
      if (!pick) return;
      e.bowlSlots[pick.slot] = null;
      pick.bowl.loc = { at: 'hand', actorId: a.id };
      a.hand = { kind: 'bowl', bowlId: pick.bowl.id };
    },
  },
  {
    id: 'bowl_discard',
    match: isRole('assembly'),
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, a, t, args) => {
      const e = eq(t);
      const label = '丼の中身を捨てる（作り直し）';
      if (!(handIsEmpty(a.hand) || a.hand.kind === 'dirty')) return no(label, '手がふさがっています');
      const slot = typeof args?.slot === 'number' ? args.slot : -1;
      const list = bowlsOnAssembly(s, e).filter((x) => x.bowl.contents && x.bowl.contents.steps.length > 0);
      const pick = slot >= 0 ? list.find((x) => x.slot === slot) : list[0];
      if (!pick) return no(label, '捨てる丼がありません');
      return ok(label, 0.8, 1);
    },
    applyUnit: (s, a, t, args, ctx) => {
      const e = eq(t);
      const slot = typeof args?.slot === 'number' ? args.slot : -1;
      const list = bowlsOnAssembly(s, e).filter((x) => x.bowl.contents && x.bowl.contents.steps.length > 0);
      const pick = slot >= 0 ? list.find((x) => x.slot === slot) : list[0];
      if (!pick) return;
      discardBowl(s, ctx, pick.bowl, a, '作り直し');
      e.bowlSlots[pick.slot] = null;
    },
  },

  // ── 仕込み（鍋・仕込み台・ゆで釜・製麺機・寸胴） ──
  ...Object.values(PREP_RECIPES).map((r): VerbDef => prepVerb(r)),

  // ── 洗い場・食洗機 ──
  {
    id: 'dishes_drop',
    match: (t) => isRole('sink')(t) || isRole('dishwasher')(t),
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (s, a, t) => {
      const e = eq(t);
      const isDw = roleOf(e) === 'dishwasher';
      const label = isDw ? '食洗機に入れて回す' : '下げた丼を洗い場に置く';
      if (a.hand.kind !== 'dirty') return no(label, '下げた丼を持っていません');
      const bad = isDw ? needUsable(e, label) : null;
      if (bad) return bad;
      if (isDw) {
        if (e.washElapsed > 0) return no(label, '洗浄中です');
        if (e.washing.length >= defOf(e).capacity) return no(label, '食洗機がいっぱいです');
      } else {
        const at = s.bowls.filter((b) => b.loc.at === 'sink' && b.loc.stationId === e.id).length;
        if (at >= defOf(e).capacity) return no(label, '洗い場がいっぱいです。先に洗ってください');
      }
      return ok(label, 0, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      if (a.hand.kind !== 'dirty') return;
      const isDw = roleOf(e) === 'dishwasher';
      const cap = defOf(e).capacity;
      const left: Id[] = [];
      for (const id of a.hand.bowlIds) {
        const b = bowlById(s, id);
        if (!b) continue;
        if (isDw) {
          if (e.washing.length < cap) {
            e.washing.push(id);
            b.state = 'washing';
            b.loc = { at: 'sink', stationId: e.id };
          } else left.push(id);
        } else {
          const at = s.bowls.filter((x) => x.loc.at === 'sink' && x.loc.stationId === e.id).length;
          if (at < cap) b.loc = { at: 'sink', stationId: e.id };
          else left.push(id);
        }
      }
      a.hand = left.length > 0 ? { kind: 'dirty', bowlIds: left } : { kind: 'none' };
      if (isDw && e.washing.length > 0) {
        e.washElapsed = 0.001;
        useEquipment(s, ctx, e);
        emit(ctx, { type: 'dishwasher', targetId: e.id });
      }
    },
  },
  {
    id: 'wash',
    match: isRole('sink'),
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (s, a, t) => {
      const e = eq(t);
      const label = '丼を洗う';
      if (!handIsEmpty(a.hand)) return no(label, '手をあけてください');
      const bad = needUsable(e, label);
      if (bad) return bad;
      const n = s.bowls.filter((b) => b.loc.at === 'sink' && b.loc.stationId === e.id && b.state === 'dirty').length;
      if (n === 0) return no(label, '洗う丼がありません');
      const units = Math.min(n, 6);
      return ok(`丼を洗う（${units}枚）`, BALANCE.cleaning.washTime / Math.max(0.3, effectiveSpeed(e)), units);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      const b = s.bowls.find((x) => x.loc.at === 'sink' && x.loc.stationId === e.id && x.state === 'dirty');
      if (!b) return;
      b.state = 'clean';
      b.contents = null;
      b.orderId = null;
      b.loc = { at: 'rack' };
      useEquipment(s, ctx, e);
      emit(ctx, { type: 'wash', actorId: a.id, targetId: e.id });
    },
  },

  // ── ゴミ箱・用具入れ・事務机 ──
  {
    id: 'trash_empty',
    match: isRole('trash'),
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (_s, a, t) => {
      const e = eq(t);
      if (!handIsEmpty(a.hand)) return no('ゴミを捨てに行く', '手をあけてください');
      if (e.fill < 1) return no('ゴミを捨てに行く', 'ゴミはほとんどありません');
      return ok(`ゴミを捨てに行く（${Math.round((e.fill / defOf(e).capacity) * 100)}%）`, 3, 1);
    },
    applyUnit: (_s, _a, t, _args, ctx) => {
      eq(t).fill = 0;
      emit(ctx, { type: 'trash', targetId: eq(t).id });
    },
  },
  {
    id: 'mop_take',
    match: isRole('locker'),
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (_s, a) => (handIsEmpty(a.hand) ? ok('モップを持つ') : no('モップを持つ', '手をあけてください')),
    applyUnit: (_s, a) => {
      a.hand = { kind: 'mop' };
    },
  },
  {
    id: 'mop_return',
    match: isRole('locker'),
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (_s, a) => (a.hand.kind === 'mop' ? ok('モップを片付ける') : no('モップを片付ける', 'モップを持っていません')),
    applyUnit: (_s, a) => {
      a.hand = { kind: 'none' };
    },
  },
  {
    id: 'lost_store',
    match: isRole('desk'),
    phases: ['prep', 'open', 'closing'],
    skill: 'service',
    plan: (_s, a) => (a.hand.kind === 'lostItem' ? ok('忘れ物を保管する') : no('忘れ物を保管する', '忘れ物を持っていません')),
    applyUnit: (s, a, _t, _args, ctx) => {
      if (a.hand.kind !== 'lostItem') return;
      const item = s.lostItems.find((x) => x.id === (a.hand as { lostItemId: Id }).lostItemId);
      if (item) {
        item.state = 'stored';
        emit(ctx, { type: 'lostStored', text: `忘れ物（${item.kind}）を保管した` });
      }
      a.hand = { kind: 'none' };
    },
  },
  {
    id: 'lost_return',
    match: isRole('desk'),
    phases: ['prep', 'open', 'closing'],
    skill: 'service',
    plan: (s, a) => {
      const label = '忘れ物を持ち主に返す';
      if (!handIsEmpty(a.hand)) return no(label, '手をあけてください');
      const owner = s.customers.find((c) => c.forLostItem && c.state === 'waitingSeat' && s.lostItems.find((l) => l.id === c.forLostItem)?.state === 'stored');
      if (!owner) return no(label, '取りに来ている人はいません');
      return ok(label, 1.2, 1);
    },
    applyUnit: (s, _a, _t, _args, ctx) => {
      const owner = s.customers.find((c) => c.forLostItem && c.state === 'waitingSeat' && s.lostItems.find((l) => l.id === c.forLostItem)?.state === 'stored');
      if (!owner) return;
      const item = s.lostItems.find((l) => l.id === owner.forLostItem);
      if (!item) return;
      item.state = 'returned';
      owner.sat.service = 1;
      owner.say = 'ありがとうございます！助かりました';
      owner.sayUntil = s.t + 3;
      leaveFromInsideQueue(s, owner, ctx);
      emit(ctx, { type: 'lostReturned', text: `忘れ物（${item.kind}）を返した` });
      notify(s, ctx, `lost:${item.id}`, 'good', `忘れ物（${item.kind}）を持ち主に返しました。評判が上がりました`);
      s.todayReviews.push({
        id: newId(s, 'rv'), day: s.day, stars: 5, text: `忘れた${item.kind}を大切に保管してくれていた。神対応`,
        parts: { taste: 1, speed: 1, service: 1, cleanliness: 1, accuracy: 1, stock: 1, value: 1, comfort: 1 }, regular: !!item.ownerRegularId,
      });
    },
  },

  // ── 席（カウンター） ──
  {
    id: 'ask_call',
    match: (t) => t.kind === 'seat',
    phases: ['open', 'closing'],
    skill: 'service',
    plan: (s, _a, t) => {
      const seat = seatOf(t);
      const label = '「ニンニク入れますか？」';
      const o = orderForSeat(s, seat);
      if (!o) return no(label, 'この席に注文はありません');
      if (o.callRevealed) return no(label, 'コールは確認済みです');
      return ok(label, 0.5, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const seat = seatOf(t);
      const o = orderForSeat(s, seat);
      if (!o) return;
      o.callRevealed = true;
      o.callAskedAt = s.t;
      const cust = s.customers.find((c) => c.id === o.customerId);
      if (cust) {
        cust.say = callToSpoken(o.call);
        cust.sayUntil = s.t + 4;
        // 接客の質（従業員の接客能力）を記録
        const svc = a.kind === 'employee' ? 0.6 + 0.4 * a.profile.skills.service : 0.9;
        cust.sat.service = Math.max(cust.sat.service, svc);
      }
      emit(ctx, { type: 'call', actorId: a.id, targetId: seat.id, text: callToSpoken(o.call) });
    },
  },
  {
    id: 'serve',
    match: (t) => t.kind === 'seat',
    phases: ['open', 'closing'],
    skill: 'service',
    plan: (s, a, t) => {
      const seat = seatOf(t);
      const label = '提供する';
      if (a.hand.kind !== 'bowl') return no(label, '丼を持っていません');
      const o = orderForSeat(s, seat);
      if (!o) return no(label, 'この席に提供待ちの注文はありません');
      const b = bowlById(s, a.hand.bowlId);
      if (!b || !b.contents || b.contents.noodleG === 0) return no(label, '丼が空です');
      const warn = b.orderId && b.orderId !== o.id ? '（別の席の丼です！）' : '';
      return ok(`${seat.index + 1}番席に提供する${warn}`, 0, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const seat = seatOf(t);
      if (a.hand.kind !== 'bowl') return;
      const o = orderForSeat(s, seat);
      const b = bowlById(s, a.hand.bowlId);
      if (!o || !b || !b.contents) return;
      // 別の注文に割り当てていた丼なら、その注文は丼なしに戻る
      b.orderId = o.id;
      const q = evaluateBowl(b.contents, o);
      o.status = 'served';
      o.servedAt = s.t;
      o.quality = q.quality;
      o.mistakes = q.mistakes;
      b.state = 'served';
      b.loc = { at: 'seat', seatId: seat.id };
      seat.bowlId = b.id;
      a.hand = { kind: 'none' };
      // 売上は提供完了時に計上（設計書 14.3）。原価は丼に積み上げた食材原価
      cash(s, 'sale', o.price, `${MENU[o.menuId]?.name ?? o.menuId}（${seat.index + 1}番席）`, `sale:${o.id}:${o.remakes}`);
      recordPL(s, 'sales', o.price);
      recordPL(s, 'cogs', b.contents.cost);
      recordPL(s, 'utilities', BALANCE.utilitiesPerBowl);
      s.today.served += 1;
      s.career.totalServed += 1;
      if (q.mistakes.length > 0) s.today.mistakes += 1;
      addTrash(s, BALANCE.cleaning.trashPerBowl);
      onServed(s, ctx, o, q);
      emit(ctx, { type: 'served', actorId: a.id, targetId: seat.id, value: q.quality, text: q.mistakes.join('、') });
    },
  },
  {
    id: 'collect',
    match: (t) => t.kind === 'seat',
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (s, a, t) => {
      const seat = seatOf(t);
      const label = '丼を下げる';
      const b = bowlById(s, seat.bowlId);
      if (!b || b.state !== 'dirty') return no(label, '下げる丼がありません');
      // 丼がある間は次の客が座らないので、その間にカウンターを拭いてもらう
      if (seat.dirt >= BALANCE.cleaning.counterCleanBelow) return no(label, '先にカウンターを拭いてください');
      if (!(handIsEmpty(a.hand) || a.hand.kind === 'dirty')) return no(label, `手がふさがっています（${handLabel(a.hand)}）`);
      if (a.hand.kind === 'dirty' && a.hand.bowlIds.length >= 5) return no(label, 'これ以上持てません（洗い場へ）');
      return ok(label, 0.4, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const seat = seatOf(t);
      const b = bowlById(s, seat.bowlId);
      if (!b) return;
      seat.bowlId = null;
      b.loc = { at: 'hand', actorId: a.id };
      const ids = a.hand.kind === 'dirty' ? a.hand.bowlIds : [];
      a.hand = { kind: 'dirty', bowlIds: [...ids, b.id] };
      emit(ctx, { type: 'collect', actorId: a.id, targetId: seat.id });
    },
  },
  {
    id: 'wipe',
    match: (t) => t.kind === 'seat',
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (_s, a, t) => {
      const seat = seatOf(t);
      const label = 'カウンターを拭く';
      if (seat.dirt < BALANCE.cleaning.counterCleanBelow) return no(label, 'きれいです');
      if (seat.customerId) return no(label, 'お客さんが座っています');
      if (!(handIsEmpty(a.hand) || a.hand.kind === 'dirty')) return no(label, '手がふさがっています');
      return ok(`カウンターを拭く（汚れ${Math.round(seat.dirt * 100)}%）`, BALANCE.cleaning.wipeTime, 1);
    },
    applyUnit: (_s, a, t, _args, ctx) => {
      seatOf(t).dirt = 0;
      emit(ctx, { type: 'wipe', actorId: a.id, targetId: seatOf(t).id });
    },
  },
  {
    id: 'lost_pick',
    match: (t) => t.kind === 'seat' || t.kind === 'lost',
    phases: ['prep', 'open', 'closing'],
    skill: 'service',
    plan: (s, a, t) => {
      const label = '忘れ物を拾う';
      const item = t.kind === 'lost' ? t.lost : s.lostItems.find((l) => l.id === seatOf(t).lostItemId);
      if (!item || item.state !== 'lying') return no(label, '忘れ物はありません');
      if (!handIsEmpty(a.hand)) return no(label, '手をあけてください');
      return ok(`忘れ物（${item.kind}）を拾う`, 0, 1);
    },
    applyUnit: (s, a, t) => {
      const item = t.kind === 'lost' ? t.lost : s.lostItems.find((l) => l.id === seatOf(t).lostItemId);
      if (!item) return;
      item.state = 'carried';
      const seat = s.seats.find((x) => x.lostItemId === item.id);
      if (seat) seat.lostItemId = null;
      a.hand = { kind: 'lostItem', lostItemId: item.id };
    },
  },
  {
    id: 'complaint_remake',
    match: (t) => t.kind === 'seat',
    phases: ['open', 'closing'],
    skill: 'service',
    plan: (s, a, t) => {
      const seat = seatOf(t);
      const cust = s.customers.find((c) => c.id === seat.customerId);
      if (!cust || cust.state !== 'complaint') return no('お詫びして作り直す', 'クレームはありません');
      if (!(a.hand.kind === 'none' || (a.hand.kind === 'dirty' && a.hand.bowlIds.length < 5))) return no('お詫びして作り直す', '手をあけてください（丼を下げます）');
      return ok('お詫びして作り直す', 1, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => handleComplaint(s, ctx, seatOf(t), a, 'remake'),
  },
  {
    id: 'complaint_refund',
    match: (t) => t.kind === 'seat',
    phases: ['open', 'closing'],
    skill: 'service',
    plan: (s, _a, t) => {
      const seat = seatOf(t);
      const cust = s.customers.find((c) => c.id === seat.customerId);
      if (!cust || cust.state !== 'complaint') return no('お詫びして返金する', 'クレームはありません');
      return ok('お詫びして返金する', 1, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => handleComplaint(s, ctx, seatOf(t), a, 'refund'),
  },

  // ── 床の汚れ ──
  {
    id: 'mop',
    match: (t) => t.kind === 'dirt',
    phases: ['prep', 'open', 'closing'],
    skill: 'clean',
    plan: (_s, a, t) => {
      const d = (t as { dirt: DirtSpot }).dirt;
      const label = d.kind === 'spill' ? 'こぼれたスープを拭く' : '床の汚れを掃除する';
      if (a.hand.kind !== 'mop') return no(label, 'モップが必要です（掃除用具入れ）');
      return ok(label, BALANCE.cleaning.mopTime * (0.5 + d.amount * 0.5), 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const d = (t as { dirt: DirtSpot }).dirt;
      s.dirt = s.dirt.filter((x) => x.id !== d.id);
      emit(ctx, { type: 'mop', actorId: a.id, pos: d.pos });
    },
  },
];

const VERB_MAP = new Map(VERBS.map((v) => [v.id, v]));
export const VERB_IDS = VERBS.map((v) => v.id);

/** 仕込みレシピから動詞を作る */
function prepVerb(r: PrepRecipe): VerbDef {
  return {
    id: `prep:${r.id}`,
    match: (t) => t.kind === 'equipment' && roleOf(t.e) === r.station,
    phases: COOKING_PHASES,
    skill: 'cook',
    plan: (s, a, t) => {
      const e = eq(t);
      const label = r.name;
      if (r.unlock && !s.career.unlocked.includes(r.unlock)) return no(label, 'まだ解放されていません');
      const bad = needUsable(e, label);
      if (bad) return bad;
      if (r.kind === 'process' && e.process) {
        const left = Math.ceil(e.process.duration - e.process.elapsed);
        return no(label, `${PREP_RECIPES[e.process.recipeId]?.name ?? '工程'}の途中です（残り${left}秒）`);
      }
      if (r.kind === 'hold' && !handIsEmpty(a.hand)) return no(label, '手をあけてください');
      for (const inp of r.inputs) {
        if (stockOf(s, inp.itemId) < inp.qty) return no(label, `${INGREDIENTS[inp.itemId]?.name ?? inp.itemId}が足りません`);
      }
      if (r.soupL && e.soupL + r.soupL > defOf(e).capacity + 1e-6) return no(label, '寸胴に入りきりません（スープを使ってから）');
      const time = r.kind === 'hold' ? r.time / Math.max(0.3, effectiveSpeed(e)) : 1.2;
      return ok(r.kind === 'process' ? `${label}（${r.time}秒）` : label, time, 1);
    },
    applyUnit: (s, a, t, _args, ctx) => {
      const e = eq(t);
      let cost = 0;
      let quality = 0;
      let freshness = 1;
      for (const inp of r.inputs) {
        const c = consume(s, inp.itemId, inp.qty);
        if (!c.ok) {
          notify(s, ctx, `stock:${inp.itemId}`, 'danger', `${INGREDIENTS[inp.itemId]?.name ?? inp.itemId}が足りません`);
          return;
        }
        cost += c.cost;
        quality += c.quality / r.inputs.length;
        freshness = Math.min(freshness, c.freshness);
      }
      useEquipment(s, ctx, e);
      if (r.kind === 'process') {
        e.process = { recipeId: r.id, elapsed: 0, duration: r.time, cost, quality, freshness, startedBy: a.id };
        emit(ctx, { type: 'processStart', actorId: a.id, targetId: e.id, text: r.name });
      } else {
        produceOutputs(s, ctx, r, cost, quality * (0.85 + 0.15 * freshness));
        emit(ctx, { type: 'prepDone', actorId: a.id, targetId: e.id, text: r.name });
      }
    },
  };
}

/** 仕込みの完成品を在庫に入れる */
export function produceOutputs(s: GameState, ctx: SimCtx, r: PrepRecipe, cost: number, quality: number): void {
  for (const out of r.outputs) {
    addLot(s, out.itemId, out.qty, (cost * out.costShare) / out.qty, clamp01(quality));
  }
  emit(ctx, { type: 'produced', text: `${r.name}：完成` });
}

/** 工程の完了（鍋・ゆで釜・寸胴・製麺機） */
export function completeProcess(s: GameState, ctx: SimCtx, e: Equipment): void {
  const p = e.process;
  if (!p) return;
  const r = PREP_RECIPES[p.recipeId];
  e.process = null;
  if (!r) return;
  const q = clamp01(p.quality * (0.85 + 0.15 * p.freshness) * (e.status === 'faulty' ? 0.9 : 1));
  if (r.soupL) {
    const total = e.soupL + r.soupL;
    // スープは継ぎ足し。品質は量で加重平均（炊きたては乳化が進んで高品質）
    const fresh = Math.min(1, 0.78 + 0.22 * q);
    e.soupQuality = total > 0 ? (e.soupQuality * e.soupL + fresh * r.soupL) / total : fresh;
    e.soupL = Math.min(defOf(e).capacity, total);
    e.soupCost += p.cost;
  }
  produceOutputs(s, ctx, r, p.cost, q);
  notify(s, ctx, `process:${e.id}`, 'good', `${r.name}が完了しました`);
}

/** 丼にトッピングを盛る（コール確認済みならコールどおり、未確認なら「そのまま」で盛る） */
export function applyToppings(s: GameState, ctx: SimCtx, bowl: Bowl, actor: Actor): void {
  const c = bowl.contents;
  if (!c) return;
  const o = orderById(s, bowl.orderId);
  const call = o && o.callRevealed ? o.call : DEFAULT_CALL;
  const menu = o ? menuOf(o.menuId) : menuOf('small');
  const short: string[] = [];
  for (const k of ['yasai', 'ninniku', 'abura', 'ichimi'] as ToppingKey[]) {
    const lv = call[k];
    if (lv <= 0) continue;
    const need = toppingAmount(k, lv);
    const r = consume(s, need.itemId, need.qty);
    if (!r.ok) {
      // 足りない分は盛れない（在庫以上は消費しない: 設計書 8.3）
      short.push(CALLS[k].name);
      s.today.stockouts += 1;
      continue;
    }
    c.toppings[k] = lv;
    c.cost += r.cost;
    c.freshness = Math.min(c.freshness, r.freshness);
  }
  if (call.karame > 0) {
    const r = consume(s, 'tare', BALANCE.cooking.tarePerLevel * call.karame);
    if (r.ok) {
      c.tare += call.karame;
      c.cost += r.cost;
    } else short.push('カラメ');
  }
  const buta = consume(s, 'buta', menu.buta);
  if (buta.ok) {
    c.buta = menu.buta;
    c.butaQuality = buta.quality * (0.8 + 0.2 * buta.freshness);
    c.cost += buta.cost;
  } else {
    const have = Math.floor(stockOf(s, 'buta'));
    if (have > 0) {
      const part = consume(s, 'buta', have);
      c.buta = have;
      c.butaQuality = part.quality;
      c.cost += part.cost;
    }
    short.push('豚');
    s.today.stockouts += 1;
  }
  if (menu.extras?.egg) {
    const r = consume(s, 'egg', menu.extras.egg);
    if (r.ok) {
      c.extras.egg = menu.extras.egg;
      c.cost += r.cost;
    } else short.push('生卵');
  }
  c.steps.push('toppings');
  if (short.length > 0) notify(s, ctx, 'stock:topping', 'danger', `${short.join('・')}が足りません！仕込みをしてください`);
  emit(ctx, { type: 'toppings', actorId: actor.id, targetId: bowl.id });
}

function discardBowl(s: GameState, ctx: SimCtx, b: Bowl, a: Actor, reason: string): void {
  if (b.contents && b.contents.cost > 0) {
    recordPL(s, 'waste', b.contents.cost);
    s.today.wasteItems.bowl = (s.today.wasteItems.bowl ?? 0) + 1;
    emit(ctx, { type: 'waste', text: `ラーメン1杯を廃棄（${reason}）`, value: b.contents.cost });
  }
  addTrash(s, BALANCE.cleaning.trashPerWaste);
  b.contents = null;
  b.orderId = null;
  b.state = 'dirty';
  b.loc = { at: 'hand', actorId: a.id };
  const ids = a.hand.kind === 'dirty' ? a.hand.bowlIds : [];
  a.hand = { kind: 'dirty', bowlIds: [...ids, b.id] };
}

function handleComplaint(s: GameState, ctx: SimCtx, seat: Seat, a: Actor, mode: 'remake' | 'refund'): void {
  const cust = s.customers.find((c) => c.id === seat.customerId);
  if (!cust || cust.state !== 'complaint') return;
  const o = s.orders.find((x) => x.id === cust.orderId);
  const svc = a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
  if (mode === 'remake' && o) {
    // 提供済みの丼を下げて、同じ注文を作り直す
    const b = bowlById(s, seat.bowlId);
    if (b) {
      seat.bowlId = null;
      b.state = 'dirty';
      b.contents = null;
      b.orderId = null;
      b.loc = { at: 'hand', actorId: a.id };
      const ids = a.hand.kind === 'dirty' ? a.hand.bowlIds : [];
      a.hand = { kind: 'dirty', bowlIds: [...ids, b.id] };
    }
    // 先に計上した売上は返金扱いにして、作り直しを提供したときに改めて計上する
    cash(s, 'refund', -o.price, `作り直しのため売上取消（${seat.index + 1}番席）`, `refund:${o.id}:${o.remakes}`, true);
    recordPL(s, 'refunds', o.price);
    o.status = 'waiting';
    o.servedAt = null;
    o.quality = null;
    o.mistakes = [];
    // 売上キーは作り直し回数で区別する（sale:<注文ID>:<回数>）
    o.remakes += 1;
    s.today.remakes += 1;
    cust.state = 'seated';
    cust.stateTime = 0;
    cust.patience = Math.max(cust.patience, 60);
    cust.sat.service = Math.max(cust.sat.service * 0.8, svc * 0.85);
    cust.say = 'じゃあ作り直しでお願いします';
    cust.sayUntil = s.t + 3;
    emit(ctx, { type: 'complaintRemake', targetId: seat.id });
  } else if (o) {
    cash(s, 'refund', -o.price, `返金（${seat.index + 1}番席）`, `refund:${o.id}:${o.remakes}`, true);
    recordPL(s, 'refunds', o.price);
    o.status = 'refunded';
    cust.sat.service = Math.max(cust.sat.service * 0.7, svc * 0.7);
    cust.sat.value = Math.max(cust.sat.value, 0.8);
    cust.say = 'まあ、返金してくれるなら…';
    cust.sayUntil = s.t + 3;
    leaveWithoutEating(s, cust, ctx);
    emit(ctx, { type: 'complaintRefund', targetId: seat.id, value: o.price });
  }
}

function soupPotFor(s: GameState, assembly: Equipment): { e: Equipment; d: number } | null {
  const pots = s.equipment
    .filter((x) => x.placed && roleOf(x) === 'soup' && isUsable(x))
    .map((x) => ({ e: x, d: dist(equipmentCenter(x), equipmentCenter(assembly)) }))
    .filter((x) => x.d <= MAX_DEPENDENCY_DIST)
    .sort((a, b) => (b.e.soupL > 0.3 ? 1 : 0) - (a.e.soupL > 0.3 ? 1 : 0) || a.d - b.d);
  return pots[0] ?? null;
}

export function soupTemperature(e: Equipment): number {
  switch (e.status) {
    case 'normal':
      return 94;
    case 'worn':
      return 90;
    case 'faulty':
      return 80;
    default:
      return 60;
  }
}

/** 麺上げで麺を受けられる丼（手に持った丼 or 近くの盛り付け台の、スープ以降の工程が済んだ麺なしの丼） */
function drainTargets(s: GameState, a: Actor, boiler: Equipment): Bowl[] {
  if (a.hand.kind === 'bowl') {
    const b = bowlById(s, a.hand.bowlId);
    if (b && b.contents && b.contents.noodleG === 0) return [b];
    if (b && !b.contents) {
      b.contents = emptyContents(s.t);
      b.state = 'assembling';
      return [b];
    }
    return [];
  }
  const asms = s.equipment
    .filter((x) => x.placed && roleOf(x) === 'assembly')
    .map((x) => ({ e: x, d: dist(equipmentCenter(x), equipmentCenter(boiler)) }))
    .filter((x) => x.d <= MAX_DEPENDENCY_DIST)
    .sort((x, y) => x.d - y.d);
  const out: Bowl[] = [];
  for (const { e } of asms) {
    for (const { bowl } of bowlsOnAssembly(s, e)) {
      if (bowl.contents && bowl.contents.noodleG === 0) out.push(bowl);
    }
  }
  // スープまで入った丼を優先（タレ→スープ→麺の順が正しい）
  const rank = (b: Bowl) => (b.contents!.soupL > 0 ? 2 : 0) + (b.contents!.tare > 0 ? 1 : 0);
  return out.sort((x, y) => rank(y) - rank(x));
}

// ───────────────────────── 公開API ─────────────────────────

export interface VerbInfo {
  verb: string;
  label: string;
  hold: boolean;
  duration: number;
  enabled: boolean;
  reason: string | null;
}

function scaledPlan(s: GameState, a: Actor, t: Target, v: VerbDef, args: Args): Plan {
  const p = v.plan(s, a, t, args);
  if (p.reason === null && p.unitTime > 0) {
    p.unitTime = p.unitTime / actorSpeed(a, v.skill);
  }
  return p;
}

/** 対象に対して可能な動詞の一覧（UI の操作候補） */
export function listVerbs(s: GameState, actorId: Id, targetId: Id): VerbInfo[] {
  const a = getActor(s, actorId);
  const t = resolveTarget(s, targetId);
  if (!a || !t) return [];
  const out: VerbInfo[] = [];
  for (const v of VERBS) {
    if (!v.match(t)) continue;
    if (!v.phases.includes(s.phase)) continue;
    const p = scaledPlan(s, a, t, v, null);
    out.push({
      verb: v.id,
      label: p.label,
      hold: p.unitTime > 0,
      duration: p.unitTime * p.units,
      enabled: p.reason === null,
      reason: p.reason,
    });
  }
  return out;
}

export interface InteractResult {
  ok: boolean;
  reason?: string;
  /** 長押し作業を開始した */
  started?: boolean;
}

/**
 * 動詞が今の状態で実行できるか（距離は問わない）。従業員AIが仕事を選ぶ前の確認に使う。
 * 実行できなければ理由を返す。
 */
export function verbBlocked(s: GameState, actorId: Id, targetId: Id, verb: string, args: Args): string | null {
  const a = getActor(s, actorId);
  const t = resolveTarget(s, targetId);
  const v = VERB_MAP.get(verb);
  if (!a || !t || !v || !v.match(t)) return 'その操作はできません';
  if (!v.phases.includes(s.phase)) return 'この時間帯にはできません';
  return v.plan(s, a, t, args).reason;
}

/** 動詞を実行する（即時なら即適用、時間がかかるなら作業を開始） */
export function interact(s: GameState, actorId: Id, targetId: Id, verb: string, args: Args, ctx: SimCtx): InteractResult {
  const a = getActor(s, actorId);
  if (!a) return { ok: false, reason: '操作者が見つかりません' };
  if (s.phase === 'bankrupt') return { ok: false, reason: '破産しています' };
  const t = resolveTarget(s, targetId);
  if (!t) return { ok: false, reason: '対象が見つかりません' };
  const v = VERB_MAP.get(verb);
  if (!v || !v.match(t)) return { ok: false, reason: 'その操作はできません' };
  if (!v.phases.includes(s.phase)) return { ok: false, reason: 'この時間帯にはできません' };
  if (a.work) return { ok: false, reason: '作業中です' };
  if (!inReach(s, a, t)) return { ok: false, reason: '遠すぎます' };
  const p = scaledPlan(s, a, t, v, args);
  if (p.reason !== null) return { ok: false, reason: p.reason };
  if (p.unitTime <= 0) {
    for (let i = 0; i < p.units; i++) v.applyUnit(s, a, t, args, ctx, i);
    v.finish?.(s, a, t, args, ctx);
    return { ok: true };
  }
  a.work = { verb, targetId, progress: 0, duration: p.unitTime * p.units, unitTime: p.unitTime, units: p.units, done: 0, args };
  emit(ctx, { type: 'workStart', actorId: a.id, targetId, text: p.label, value: a.work.duration });
  return { ok: true, started: true };
}

/** 長押し作業を進める（step から呼ぶ）。完了したら true */
export function progressWork(s: GameState, a: Actor, dt: number, ctx: SimCtx): boolean {
  const w = a.work;
  if (!w) return false;
  const t = resolveTarget(s, w.targetId);
  const v = VERB_MAP.get(w.verb);
  if (!t || !v || !v.phases.includes(s.phase) || !inReach(s, a, t, 0.4)) {
    cancelWork(s, a, ctx, '作業を中断した');
    return false;
  }
  w.progress += dt;
  while (w.done < w.units && w.progress >= w.unitTime * (w.done + 1) - 1e-9) {
    // 単位ごとに条件を再確認（他の人が先に処理した場合など）
    const p = v.plan(s, a, t, w.args);
    if (p.reason !== null && w.done === 0) {
      cancelWork(s, a, ctx, p.reason);
      return false;
    }
    if (p.reason !== null) {
      w.units = w.done;
      break;
    }
    v.applyUnit(s, a, t, w.args, ctx, w.done);
    w.done += 1;
  }
  if (w.done >= w.units) {
    v.finish?.(s, a, t, w.args, ctx);
    a.work = null;
    emit(ctx, { type: 'workDone', actorId: a.id, targetId: t.id, text: w.verb });
    return true;
  }
  return false;
}

export function cancelWork(s: GameState, a: Actor, ctx: SimCtx, reason: string): void {
  if (!a.work) return;
  emit(ctx, { type: 'workCancel', actorId: a.id, text: reason });
  a.work = null;
  void s;
}

/** 手に持っているものを置く・落とす（切断時など） */
export function dropHand(s: GameState, a: Actor, ctx: SimCtx): void {
  const h = a.hand;
  switch (h.kind) {
    case 'bowl': {
      const b = bowlById(s, h.bowlId);
      if (b) {
        // 近くの盛り付け台の空きに戻す。無理なら廃棄扱いで洗い場へ
        const asm = s.equipment.find((e) => e.placed && roleOf(e) === 'assembly' && e.bowlSlots.some((x) => x === null));
        if (asm) {
          const slot = asm.bowlSlots.findIndex((x) => x === null);
          asm.bowlSlots[slot] = b.id;
          b.loc = { at: 'station', stationId: asm.id, slot };
        } else {
          if (b.contents) recordPL(s, 'waste', b.contents.cost);
          b.contents = null;
          b.orderId = null;
          b.state = 'dirty';
          const sink = s.equipment.find((e) => e.placed && roleOf(e) === 'sink');
          b.loc = sink ? { at: 'sink', stationId: sink.id } : { at: 'rack' };
          if (!sink) b.state = 'clean';
        }
      }
      break;
    }
    case 'clean':
      for (const id of h.bowlIds) {
        const b = bowlById(s, id);
        if (b) b.loc = { at: 'rack' };
      }
      break;
    case 'dirty': {
      const sink = s.equipment.find((e) => e.placed && roleOf(e) === 'sink');
      for (const id of h.bowlIds) {
        const b = bowlById(s, id);
        if (!b) continue;
        b.loc = sink ? { at: 'sink', stationId: sink.id } : { at: 'rack' };
        if (!sink) b.state = 'clean';
      }
      break;
    }
    case 'lostItem': {
      const item = s.lostItems.find((l) => l.id === h.lostItemId);
      if (item) item.state = 'stored';
      break;
    }
    default:
      break;
  }
  a.hand = { kind: 'none' };
  a.work = null;
  emit(ctx, { type: 'drop', actorId: a.id });
}


/** 盛り付け台が使える状態か（スープ寸胴とトッピング台が作業できる距離にある） */
export function assemblyFunctional(s: GameState, asm: Equipment): boolean {
  return soupPotFor(s, asm) !== null && dependency(s, asm, 'topping') !== null && isUsable(asm);
}
