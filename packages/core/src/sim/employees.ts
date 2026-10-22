// 従業員（設計書 13）。
// AI の流れ: 仕事候補の取得 → 優先度計算 → 担当範囲の確認 → 予約 → 経路探索 → 移動 → 作業 → 結果確認 → 次の仕事
// 同じ仕事は予約（taskId）で一人だけが担当する。担当者が離脱した仕事は予約が外れ、他の人が引き継げる。

import { BALANCE } from '../data/balance';
import { EQUIPMENT } from '../data/equipment';
import { GIVEN_NAMES, SURNAMES } from '../data/names';
import { PREP_RECIPES } from '../data/prep';
import { equipmentCenter, stageOf } from '../geometry';
import { findPath, isNarrowAt } from '../nav';
import type {
  Candidate,
  Employee,
  EmployeeProfile,
  EmployeeRole,
  EmployeeSkills,
  GameState,
  TaskStep,
  Vec2,
} from '../types';
import { clamp01, dist, newId, pick, rand, randRange } from '../util';
import { cash, recordPL } from './economy';
import { defOf, isUsable } from './equipment';
import { stockOf } from './inventory';
import {
  bowlsOnAssembly,
  getActor,
  inReach,
  interact,
  resolveTarget,
  targetPoints,
  waitingOrders,
  noodlesStartedFor,
  bowlForOrder,
  dropHand,
  verbBlocked,
  assemblyFunctional,
  type Actor,
} from './interact';
import { isBowlComplete } from './cooking';
import { emit, notify, type SimCtx } from './notices';

export const ROLE_LABEL: Record<EmployeeRole, string> = {
  cook: '調理担当',
  server: '接客担当',
  cleaner: '清掃・洗い場担当',
};

/** 仕事の種類と基本優先度（設計書 13.4 の初期優先順位に対応） */
export const TASK_KINDS: Record<string, { label: string; base: number; roles: EmployeeRole[] }> = {
  spill: { label: 'こぼれの清掃（安全）', base: 100, roles: ['cleaner', 'server', 'cook'] },
  complaint: { label: 'クレーム対応', base: 96, roles: ['server', 'cook'] },
  noodlesUp: { label: '麺上げ', base: 92, roles: ['cook'] },
  discard: { label: 'ゆですぎ麺の処分', base: 90, roles: ['cook'] },
  serve: { label: '提供', base: 86, roles: ['server', 'cook'] },
  toppings: { label: 'トッピング', base: 82, roles: ['cook'] },
  askCall: { label: 'コール確認', base: 80, roles: ['server', 'cook'] },
  lostReturn: { label: '忘れ物の返却', base: 79, roles: ['server', 'cleaner', 'cook'] },
  noodlesIn: { label: '麺を入れる', base: 76, roles: ['cook'] },
  tare: { label: 'タレ', base: 72, roles: ['cook'] },
  soup: { label: 'スープ', base: 71, roles: ['cook'] },
  setBowls: { label: '丼を並べる', base: 68, roles: ['cook'] },
  prepUrgent: { label: '食材補充（急ぎ）', base: 66, roles: ['cook'] },
  collect: { label: '食器回収', base: 58, roles: ['cleaner', 'server'] },
  wipe: { label: 'テーブル清掃', base: 52, roles: ['cleaner', 'server'] },
  wash: { label: '洗浄', base: 50, roles: ['cleaner'] },
  prep: { label: '仕込み', base: 42, roles: ['cook'] },
  trash: { label: 'ゴミ処理', base: 36, roles: ['cleaner'] },
  lost: { label: '忘れ物の保管', base: 34, roles: ['cleaner', 'server'] },
  mop: { label: '床の清掃', base: 30, roles: ['cleaner'] },
  tidyHand: { label: '片付け', base: 20, roles: ['cook', 'server', 'cleaner'] },
};

/** その食材を仕込みで補充できる見込みがあるか（材料と設備がある、または工程中） */
function canReplenish(s: GameState, itemId: string): boolean {
  for (const r of Object.values(PREP_RECIPES)) {
    const produces = r.outputs.some((o) => o.itemId === itemId) || (itemId === 'buta' && r.outputs.some((o) => o.itemId === 'pork_block'));
    if (!produces) continue;
    if (s.equipment.some((e) => e.process?.recipeId === r.id)) return true;
    if (r.unlock && !s.career.unlocked.includes(r.unlock)) continue;
    const station = s.equipment.some((e) => e.placed && EQUIPMENT[e.type]?.role === r.station && isUsable(e));
    if (station && r.inputs.every((i) => stockOf(s, i.itemId) >= i.qty)) return true;
  }
  return itemId === 'buta' && stockOf(s, 'pork_block') > 0;
}

/** 1杯盛るのに最低限必要な量（これを下回ったら補充を最優先） */
const MIN_FOR_BOWL: Record<string, number> = { buta: 5, yasai: 540, garlic: 36, abura: 75 };

export interface Task {
  key: string;
  kind: string;
  steps: TaskStep[];
  priority: number;
  /** 優先度計算の基準位置（最初の対象） */
  at: Vec2;
}

// ───────────────────────── 採用 ─────────────────────────

function skill(s: GameState, mean: number): number {
  return clamp01(mean + randRange(s, -0.3, 0.3));
}

export function generateCandidate(s: GameState): Candidate {
  const role = pick(s, ['cook', 'cook', 'server', 'cleaner'] as EmployeeRole[]);
  const talent = randRange(s, 0.25, 0.8);
  const skills: EmployeeSkills = {
    speed: skill(s, talent),
    cooking: skill(s, role === 'cook' ? talent + 0.1 : talent - 0.15),
    service: skill(s, role === 'server' ? talent + 0.1 : talent - 0.1),
    hygiene: skill(s, role === 'cleaner' ? talent + 0.1 : talent - 0.05),
    movement: skill(s, talent),
    reliability: skill(s, 0.7),
  };
  const sc = (skills.speed + skills.movement + (role === 'cook' ? skills.cooking : role === 'server' ? skills.service : skills.hygiene)) / 3;
  const st = BALANCE.staff;
  // 能力と給与は相関するが、掘り出し物（安くて有能）や割高な人もいる
  const wage = Math.round((st.wageMin + (st.wageMax - st.wageMin) * clamp01(sc * 0.75 + randRange(s, -0.15, 0.3))) / 500) * 500;
  const hireFee = Math.round((st.hireFeeMin + (st.hireFeeMax - st.hireFeeMin) * clamp01(sc + randRange(s, -0.2, 0.2))) / 1000) * 1000;
  const profile: EmployeeProfile = {
    name: `${pick(s, SURNAMES)} ${pick(s, GIVEN_NAMES)}`,
    role,
    skills,
    wage,
    hireFee,
    experience: randRange(s, 0, 0.1),
  };
  return { id: newId(s, 'cand'), profile };
}

export function refreshCandidates(s: GameState): void {
  if (!s.career.unlocked.includes('hiring')) {
    s.candidates = [];
    return;
  }
  s.candidates = Array.from({ length: BALANCE.staff.candidatesPerDay }, () => generateCandidate(s));
}

export function makeEmployee(s: GameState, c: Candidate): Employee {
  const st = stageOf(s);
  return {
    id: newId(s, 'emp'),
    kind: 'employee',
    pos: { x: st.staffSpawn.x, z: st.staffSpawn.z },
    yaw: 0,
    hand: { kind: 'none' },
    work: null,
    profile: c.profile,
    hiredDay: s.day,
    priorities: {},
    ai: { state: 'idle', taskId: null, steps: [], path: [], stuckTime: 0, idleTime: 0, cooldown: 0, note: '' },
    presentToday: false,
    tasksDone: 0,
  };
}

/** 採用（閉店後・準備時間のみ。採用費は即時、給与は翌営業日から日割りで精算） */
export function hire(s: GameState, ctx: SimCtx, candidateId: string): { ok: boolean; reason?: string } {
  if (!s.career.unlocked.includes('hiring')) return { ok: false, reason: '採用はまだ解放されていません' };
  if (s.phase === 'open' || s.phase === 'closing') return { ok: false, reason: '営業中は採用できません' };
  const c = s.candidates.find((x) => x.id === candidateId);
  if (!c) return { ok: false, reason: '候補者が見つかりません' };
  if (s.employees.length >= 12) return { ok: false, reason: 'これ以上雇えません' };
  if (!cash(s, 'hire', -c.profile.hireFee, `${c.profile.name}さんを採用`, `hire:${c.id}`)) return { ok: false, reason: '採用費が足りません' };
  recordPL(s, 'hiring', c.profile.hireFee);
  const e = makeEmployee(s, c);
  // 準備時間中に雇った場合は当日から勤務（当日分の給与が発生）
  e.presentToday = s.phase === 'prep';
  s.employees.push(e);
  s.candidates = s.candidates.filter((x) => x.id !== candidateId);
  emit(ctx, { type: 'hire', text: e.profile.name });
  notify(s, ctx, `hire:${e.id}`, 'good', `${e.profile.name}さん（${ROLE_LABEL[e.profile.role]}）を採用しました`);
  return { ok: true };
}

/** 解雇（解雇手当 = 日給 × severanceDays） */
export function fire(s: GameState, ctx: SimCtx, employeeId: string): { ok: boolean; reason?: string } {
  if (s.phase === 'open' || s.phase === 'closing') return { ok: false, reason: '営業中は解雇できません' };
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  const fee = e.profile.wage * BALANCE.severanceDays;
  // 解雇手当は払えなくても未払金として計上する（支払義務は消えない）
  if (!cash(s, 'severance', -fee, `${e.profile.name}さんの解雇手当`, `sev:${e.id}`)) {
    s.arrears.push({ id: newId(s, 'ar'), amount: fee, reason: `${e.profile.name}さんの解雇手当`, sinceDay: s.day, dueDay: s.day + BALANCE.arrearsGraceDays });
  }
  recordPL(s, 'hiring', fee);
  dropHand(s, e, ctx);
  // 準備時間中の解雇は当日の給与を日割りしない（勤務していないため）
  s.employees = s.employees.filter((x) => x.id !== employeeId);
  emit(ctx, { type: 'fire', text: e.profile.name });
  notify(s, ctx, `fire:${e.id}`, 'info', `${e.profile.name}さんを解雇しました（解雇手当 ¥${fee.toLocaleString('ja-JP')}）`);
  return { ok: true };
}

export function setRole(s: GameState, employeeId: string, role: EmployeeRole): boolean {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e || !(role in ROLE_LABEL)) return false;
  e.profile.role = role;
  releaseTask(e);
  return true;
}

/** 担当設定: 仕事ごとの優先度補正（-100 で担当外） */
export function setPriority(s: GameState, employeeId: string, kind: string, value: number): boolean {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e || !(kind in TASK_KINDS) || !Number.isFinite(value)) return false;
  e.priorities[kind] = Math.max(-100, Math.min(50, Math.round(value)));
  return true;
}

/** 出勤判定（勤務安定性が低いと欠勤がある） */
export function morningRollCall(s: GameState, ctx: SimCtx): void {
  const st = stageOf(s);
  for (const e of s.employees) {
    e.presentToday = rand(s) > (1 - e.profile.skills.reliability) * 0.12;
    e.pos = { x: st.staffSpawn.x + randRange(s, 0, 0.4), z: st.staffSpawn.z + randRange(s, 0, 0.4) };
    e.hand = { kind: 'none' };
    e.work = null;
    releaseTask(e);
    e.ai.state = e.presentToday ? 'idle' : 'absent';
    if (!e.presentToday) notify(s, ctx, `absent:${e.id}`, 'warn', `${e.profile.name}さんが今日は欠勤です`);
  }
}

function releaseTask(e: Employee): void {
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
  e.ai.stuckTime = 0;
}

// ───────────────────────── 仕事の候補 ─────────────────────────

function placedRole(s: GameState, role: string) {
  return s.equipment.filter((e) => e.placed && EQUIPMENT[e.type]?.role === role);
}

/** 盤面から仕事の候補を作る */
export function buildTasks(s: GameState): Task[] {
  const tasks: Task[] = [];
  const add = (kind: string, key: string, steps: TaskStep[], bonus = 0) => {
    const first = steps[0];
    if (!first) return;
    const t = resolveTarget(s, first.targetId);
    if (!t) return;
    const at = targetPoints(s, t)[0] ?? { x: 0, z: 0 };
    tasks.push({ key, kind, steps, priority: (TASK_KINDS[kind]?.base ?? 0) + bonus, at });
  };
  const step = (targetId: string, verb: string, args: TaskStep['args'] = null): TaskStep => ({ targetId, verb, args });
  const cooking = s.phase === 'open' || s.phase === 'closing' || s.phase === 'prep';
  const orders = waitingOrders(s);
  const racks = placedRole(s, 'rack');
  const sinks = placedRole(s, 'sink').filter(isUsable);
  const dws = placedRole(s, 'dishwasher').filter((e) => isUsable(e) && e.washElapsed === 0);
  const lockers = placedRole(s, 'locker');
  const desks = placedRole(s, 'desk');
  const someoneWaiting = s.insideQueue.length > 0;

  if (cooking) {
    // ── 調理 ──
    const ordersWithoutBowl = orders.filter((o) => !bowlForOrder(s, o.id));
    for (const asm of placedRole(s, 'assembly')) {
      const on = bowlsOnAssembly(s, asm);
      const free = asm.bowlSlots.filter((x) => x === null).length;
      const cleanAtRack = s.bowls.filter((b) => b.state === 'clean' && b.loc.at === 'rack').length;
      // スープやトッピングに届かない盛り付け台には丼を並べない（完成できず詰まるため）
      if (free > 0 && ordersWithoutBowl.length > 0 && cleanAtRack > 0 && racks[0] && assemblyFunctional(s, asm)) {
        const n = Math.min(free, ordersWithoutBowl.length, 6);
        add('setBowls', `setBowls:${asm.id}`, [step(racks[0].id, 'bowls_take', { count: n }), step(asm.id, 'bowls_place')]);
      }
      if (on.some((x) => x.bowl.contents && x.bowl.contents.tare === 0) && stockOf(s, 'tare') > 30) add('tare', `tare:${asm.id}`, [step(asm.id, 'tare')]);
      if (on.some((x) => x.bowl.contents && x.bowl.contents.tare > 0 && x.bowl.contents.soupL === 0)) add('soup', `soup:${asm.id}`, [step(asm.id, 'soup')]);
      const needTop = on.filter((x) => x.bowl.contents && x.bowl.contents.noodleG > 0 && !x.bowl.contents.steps.includes('toppings'));
      // 豚やヤサイが切れているときは、補充できる見込みがある限り待ってから盛る（足りないまま出すとミスになる）
      const stocked = Object.entries(MIN_FOR_BOWL).every(([id, q]) => stockOf(s, id) >= q || !canReplenish(s, id));
      if (needTop.length > 0 && stocked) {
        const allAsked = needTop.every((x) => s.orders.find((o) => o.id === x.bowl.orderId)?.callRevealed ?? true);
        // コール未確認のまま盛ると間違えるので、確認してから盛る（丼が冷めすぎる前に）
        const oldest = Math.max(...needTop.map((x) => s.t - (x.bowl.contents?.startedAt ?? s.t)));
        if (allAsked || oldest > 40) add('toppings', `toppings:${asm.id}`, [step(asm.id, 'toppings')]);
      }
      for (const { slot, bowl } of on) {
        if (!isBowlComplete(bowl.contents) || !bowl.orderId) continue;
        const o = s.orders.find((x) => x.id === bowl.orderId);
        if (!o || o.status !== 'waiting') continue;
        const cust = s.customers.find((c) => c.id === o.customerId);
        if (!cust || cust.state !== 'seated') continue;
        add('serve', `serve:${bowl.id}`, [step(asm.id, 'bowl_take', { slot }), step(o.seatId, 'serve')], (s.t - o.createdAt) * 0.1);
      }
    }
    for (const b of placedRole(s, 'boiler')) {
      const free = b.slots.filter((x) => x === null).length;
      const need = orders.filter((o) => !noodlesStartedFor(s, o.id)).length;
      // 故障した釜でも、入っている麺は上げられる（新しく入れるのは不可）
      if (isUsable(b) && free > 0 && need > 0) add('noodlesIn', `noodlesIn:${b.id}`, [step(b.id, 'noodles_in')], Math.min(10, need));
      // スープまで入った丼が待っているときだけ麺を上げる（麺だけ先に入れると品質が下がる）
      const readyBowls = placedRole(s, 'assembly').some((a) => bowlsOnAssembly(s, a).some((x) => x.bowl.contents && x.bowl.contents.soupL > 0 && x.bowl.contents.noodleG === 0));
      if (readyBowls && b.slots.some((x) => x && x.elapsed >= x.ideal - 1.5)) add('noodlesUp', `noodlesUp:${b.id}`, [step(b.id, 'noodles_up')]);
      if (b.slots.some((x) => x && x.elapsed > x.ideal + BALANCE.cooking.noodleBadWindow)) add('discard', `discard:${b.id}`, [step(b.id, 'noodles_discard')]);
    }
    // ── 接客 ──
    for (const o of orders) {
      if (o.callRevealed) continue;
      const cust = s.customers.find((c) => c.id === o.customerId);
      if (!cust || cust.state !== 'seated') continue;
      // 麺をゆで始めたらコールを聞く（次郎系の作法）
      if (noodlesStartedFor(s, o.id) || s.t - o.createdAt > 25) add('askCall', `askCall:${o.id}`, [step(o.seatId, 'ask_call')]);
    }
    for (const seat of s.seats) {
      const cust = s.customers.find((c) => c.id === seat.customerId);
      if (cust && cust.state === 'complaint') add('complaint', `complaint:${seat.id}`, [step(seat.id, 'complaint_remake')]);
    }
    // ── 仕込み ──
    for (const r of Object.values(PREP_RECIPES)) {
      if (r.unlock && !s.career.unlocked.includes(r.unlock)) continue;
      const stations = s.equipment.filter((e) => e.placed && EQUIPMENT[e.type]?.role === r.station && isUsable(e));
      if (stations.length === 0) continue;
      if (!r.inputs.every((i) => stockOf(s, i.itemId) >= i.qty)) continue;
      if (r.soupL) {
        for (const pot of stations) {
          if (pot.process) continue;
          if (pot.soupL + r.soupL > defOf(pot).capacity) continue;
          if (pot.soupL < 8) add(pot.soupL < 3 ? 'prepUrgent' : 'prep', `prep:${r.id}:${pot.id}`, [step(pot.id, `prep:${r.id}`)]);
        }
        continue;
      }
      if (!r.restockBelow) continue;
      const item = r.restockBelow.itemId;
      // 工程中の分も在庫とみなす
      const inProcess = s.equipment
        .filter((e) => e.process && PREP_RECIPES[e.process.recipeId]?.outputs.some((o) => o.itemId === item || (item === 'buta' && o.itemId === 'pork_block')))
        .length;
      let have = stockOf(s, item);
      if (r.id === 'braise_pork') have += stockOf(s, 'pork_block') * 18 + inProcess * 72;
      else if (inProcess > 0) continue;
      if (have >= r.restockBelow.qty) continue;
      const st = stations.find((e) => !e.process || r.kind === 'hold');
      if (!st) continue;
      // 切れる寸前ほど優先度を上げる（盛り付けに必要な量を切ったら調理より先に補充）
      const ratio = have / r.restockBelow.qty;
      const minNeed = MIN_FOR_BOWL[item] ?? 0;
      if (stockOf(s, item) < minNeed && r.id !== 'braise_pork') add('prepUrgent', `prep:${r.id}`, [step(st.id, `prep:${r.id}`)], 30);
      else if (ratio < 0.4) add('prepUrgent', `prep:${r.id}`, [step(st.id, `prep:${r.id}`)], Math.round((0.4 - ratio) * 40));
      else add('prep', `prep:${r.id}`, [step(st.id, `prep:${r.id}`)], Math.round((1 - ratio) * 20));
    }
  }

  // ── 清掃・洗い場 ──
  for (const seat of s.seats) {
    const b = s.bowls.find((x) => x.id === seat.bowlId);
    if (b && b.state === 'dirty') {
      const drop = dws[0] ?? sinks[0];
      const steps = [step(seat.id, 'collect')];
      if (drop) steps.push(step(drop.id, 'dishes_drop'));
      add('collect', `collect:${seat.id}`, steps, someoneWaiting ? 20 : 0);
    }
    if (seat.dirt >= 0.3 && !seat.customerId) add('wipe', `wipe:${seat.id}`, [step(seat.id, 'wipe')], someoneWaiting ? 15 : 0);
    if (seat.lostItemId && desks[0]) {
      const item = s.lostItems.find((l) => l.id === seat.lostItemId);
      if (item && item.state === 'lying') add('lost', `lost:${item.id}`, [step(seat.id, 'lost_pick'), step(desks[0].id, 'lost_store')]);
    }
  }
  for (const sink of sinks) {
    const n = s.bowls.filter((b) => b.loc.at === 'sink' && b.loc.stationId === sink.id && b.state === 'dirty').length;
    const cleanLeft = s.bowls.filter((b) => b.state === 'clean' && b.loc.at === 'rack').length;
    if (n > 0) add('wash', `wash:${sink.id}`, [step(sink.id, 'wash')], cleanLeft < 4 ? 25 : 0);
  }
  for (const bin of placedRole(s, 'trash')) {
    if (bin.fill >= defOf(bin).capacity * 0.7) add('trash', `trash:${bin.id}`, [step(bin.id, 'trash_empty')]);
  }
  if (lockers[0]) {
    for (const d of s.dirt) {
      add(d.kind === 'spill' ? 'spill' : 'mop', `mop:${d.id}`, [step(lockers[0].id, 'mop_take'), step(d.id, 'mop'), step(lockers[0].id, 'mop_return')]);
    }
  }
  if (desks[0]) {
    const owner = s.customers.find((c) => c.forLostItem && c.state === 'waitingSeat' && s.lostItems.find((l) => l.id === c.forLostItem)?.state === 'stored');
    if (owner) add('lostReturn', `lostReturn:${owner.id}`, [step(desks[0].id, 'lost_return')]);
  }
  return tasks;
}

/** その従業員がこの仕事を担当できるか */
function canTake(s: GameState, e: Employee, t: Task): boolean {
  const kind = TASK_KINDS[t.kind];
  if (!kind) return false;
  const override = e.priorities[t.kind];
  if (override !== undefined && override <= -100) return false;
  if (kind.roles.includes(e.profile.role)) {
    // 調理担当の接客系は、接客担当がいないときだけ
    if (e.profile.role === 'cook' && (t.kind === 'serve' || t.kind === 'askCall' || t.kind === 'complaint')) {
      const servers = s.employees.some((x) => x.presentToday && x.profile.role === 'server');
      if (servers && t.kind !== 'serve') return false;
    }
    return true;
  }
  // 担当設定で明示的に任せた仕事
  return override !== undefined && override > 0;
}

function taskScore(e: Employee, t: Task): number {
  const override = e.priorities[t.kind] ?? 0;
  return t.priority + override - dist(e.pos, t.at) * 2;
}

// ───────────────────────── 実行 ─────────────────────────

function walkSpeed(s: GameState, e: Employee): number {
  let v = BALANCE.staff.baseWalkSpeed * (0.7 + 0.6 * e.profile.skills.movement);
  if (isNarrowAt(s, e.pos)) v *= 0.75;
  if (s.dirt.some((d) => d.kind === 'spill' && dist(d.pos, e.pos) < 0.6)) v *= 0.6;
  return v;
}

function moveAlong(e: Employee, dt: number, speed: number): boolean {
  let left = speed * dt;
  while (left > 0 && e.ai.path.length > 0) {
    const tgt = e.ai.path[0]!;
    const d = dist(e.pos, tgt);
    if (d > 1e-6) e.yaw = Math.atan2(tgt.x - e.pos.x, tgt.z - e.pos.z);
    if (d <= left) {
      e.pos = { x: tgt.x, z: tgt.z };
      e.ai.path.shift();
      left -= d;
    } else {
      e.pos = { x: e.pos.x + ((tgt.x - e.pos.x) / d) * left, z: e.pos.z + ((tgt.z - e.pos.z) / d) * left };
      left = 0;
    }
  }
  return e.ai.path.length === 0;
}

function reservedBy(s: GameState, key: string, except: string): boolean {
  return s.employees.some((x) => x.id !== except && x.ai.taskId === key);
}

/** プレイヤーが操作中の対象 */
function playerBusyTargets(s: GameState): Set<string> {
  const set = new Set<string>();
  for (const p of s.players) if (p.work) set.add(p.work.targetId);
  return set;
}

function startTask(e: Employee, t: Task): void {
  e.ai.taskId = t.key;
  e.ai.steps = t.steps.map((x) => ({ ...x, args: x.args ? { ...x.args } : null }));
  e.ai.path = [];
  e.ai.stuckTime = 0;
  e.ai.state = 'moving';
  e.ai.note = TASK_KINDS[t.kind]?.label ?? t.kind;
}

/** 手に何か持ったまま暇になったときの片付け */
function tidyHandTask(s: GameState, e: Employee): Task | null {
  const step = (targetId: string, verb: string): TaskStep => ({ targetId, verb, args: null });
  const first = (role: string) => s.equipment.find((x) => x.placed && EQUIPMENT[x.type]?.role === role && isUsable(x));
  switch (e.hand.kind) {
    case 'dirty': {
      const sink = first('sink');
      return sink ? { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(sink.id, 'dishes_drop')], priority: 20, at: equipmentCenter(sink) } : null;
    }
    case 'clean': {
      const asm = s.equipment.find((x) => x.placed && EQUIPMENT[x.type]?.role === 'assembly' && x.bowlSlots.some((y) => y === null));
      if (asm) return { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(asm.id, 'bowls_place')], priority: 20, at: equipmentCenter(asm) };
      const rack = first('rack');
      return rack ? { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(rack.id, 'bowls_return')], priority: 20, at: equipmentCenter(rack) } : null;
    }
    case 'mop': {
      const locker = first('locker');
      return locker ? { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(locker.id, 'mop_return')], priority: 20, at: equipmentCenter(locker) } : null;
    }
    case 'lostItem': {
      const desk = first('desk');
      return desk ? { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(desk.id, 'lost_store')], priority: 20, at: equipmentCenter(desk) } : null;
    }
    case 'bowl': {
      const asm = s.equipment.find((x) => x.placed && EQUIPMENT[x.type]?.role === 'assembly' && x.bowlSlots.some((y) => y === null));
      return asm ? { key: `tidy:${e.id}`, kind: 'tidyHand', steps: [step(asm.id, 'bowls_place')], priority: 20, at: equipmentCenter(asm) } : null;
    }
    default:
      return null;
  }
}

/**
 * 失敗した仕事の再試行を遅らせる表（従業員ID|仕事キー → sim時刻）。
 * 一時的な判断材料なので状態（セーブ）には含めない。含めなくても結果の決定性は
 * 「同じ操作列なら同じ結果」の範囲で保たれる（サーバーとクライアントで AI を二重に動かさないため）。
 */
const failCooldown = new Map<string, number>();

/** 従業員AIの更新 */
export function updateEmployees(s: GameState, dt: number, ctx: SimCtx): void {
  if (failCooldown.size > 500) failCooldown.clear();
  if (s.employees.length === 0) return;
  let tasks: Task[] | null = null;
  const busyTargets = playerBusyTargets(s);
  for (const e of s.employees) {
    if (!e.presentToday) {
      e.ai.state = 'absent';
      continue;
    }
    if (e.work) {
      e.ai.state = 'working';
      continue;
    }
    // 次の手順
    const cur = e.ai.steps[0];
    if (cur) {
      const t = resolveTarget(s, cur.targetId);
      if (!t) {
        releaseTask(e);
        continue;
      }
      if (!inReach(s, e, t)) {
        if (e.ai.path.length === 0) {
          const pts = targetPoints(s, t);
          let best: Vec2[] | null = null;
          let bestCost = Infinity;
          for (const p of pts) {
            const r = findPath(s, e.pos, p, 'staff');
            if (r && r.cost < bestCost) {
              bestCost = r.cost;
              best = r.points;
            }
          }
          if (!best) {
            e.ai.stuckTime += dt;
            e.ai.state = 'stuck';
            if (e.ai.stuckTime > 3) {
              notify(s, ctx, `stuck:${e.id}`, 'warn', `${e.profile.name}さんが通れず作業できません（レイアウトを確認してください）`);
              releaseTask(e);
              e.ai.cooldown = 2;
            }
            continue;
          }
          e.ai.path = best;
        }
        e.ai.state = 'moving';
        const before = { ...e.pos };
        moveAlong(e, dt, walkSpeed(s, e));
        if (dist(before, e.pos) < 1e-4 && e.ai.path.length > 0) {
          e.ai.stuckTime += dt;
          if (e.ai.stuckTime > 3) {
            e.ai.state = 'stuck';
            releaseTask(e);
          }
        } else e.ai.stuckTime = 0;
        // 到着したが届かない場合は経路を引き直す
        if (e.ai.path.length === 0 && !inReach(s, e, t)) {
          e.ai.stuckTime += 0.5;
          if (e.ai.stuckTime > 3) releaseTask(e);
        }
        continue;
      }
      // 対象の方を向く
      const tp = targetPoints(s, t)[0];
      if (tp && t.kind === 'equipment') {
        const c = equipmentCenter(t.e);
        e.yaw = Math.atan2(c.x - e.pos.x, c.z - e.pos.z);
      }
      const r = interact(s, e.id, cur.targetId, cur.verb, cur.args, ctx);
      if (!r.ok) {
        // 状況が変わった（誰かが先に処理した等）。仕事を手放し、同じ仕事はしばらく避ける
        e.ai.note = r.reason ?? '';
        if (e.ai.taskId) failCooldown.set(`${e.id}|${e.ai.taskId}`, s.t + 3);
        releaseTask(e);
        e.ai.cooldown = 0.3;
        continue;
      }
      e.ai.steps.shift();
      e.ai.path = [];
      if (e.ai.steps.length === 0) {
        if (!r.started) finishTask(e);
      }
      e.ai.state = r.started ? 'working' : 'moving';
      continue;
    }
    if (e.ai.taskId && e.ai.steps.length === 0) finishTask(e);
    // 新しい仕事を選ぶ
    e.ai.cooldown -= dt;
    if (e.ai.cooldown > 0) continue;
    tasks = tasks ?? buildTasks(s);
    let best: Task | null = null;
    let bestScore = -Infinity;
    for (const t of tasks) {
      if (!canTake(s, e, t)) continue;
      if (reservedBy(s, t.key, e.id)) continue;
      if (t.steps.some((x) => busyTargets.has(x.targetId))) continue;
      // 手がふさがっていると始められない仕事
      const firstVerb = t.steps[0]!.verb;
      if (e.hand.kind !== 'none' && !['dishes_drop', 'bowls_place', 'serve', 'mop', 'mop_return', 'lost_store', 'collect', 'noodles_up'].includes(firstVerb)) continue;
      // 最近失敗した仕事はしばらく選ばない
      const failedUntil = failCooldown.get(`${e.id}|${t.key}`);
      if (failedUntil !== undefined && failedUntil > s.t) continue;
      const sc = taskScore(e, t);
      if (sc <= bestScore) continue;
      // 実際に実行できるか（行為と同じ判定）を確認してから選ぶ
      if (verbBlocked(s, e.id, t.steps[0]!.targetId, firstVerb, t.steps[0]!.args) !== null) continue;
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
    }
    if (!best && e.hand.kind !== 'none') best = tidyHandTask(s, e);
    if (best) {
      startTask(e, best);
      e.ai.idleTime = 0;
    } else {
      e.ai.state = 'idle';
      e.ai.idleTime += dt;
      e.ai.cooldown = 0.4;
      e.ai.note = '待機中';
    }
  }
}

function finishTask(e: Employee): void {
  e.tasksDone += 1;
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
}

/** 長押し作業が終わった従業員の後処理（step から呼ぶ） */
export function onEmployeeWorkDone(e: Actor): void {
  if (e.kind !== 'employee') return;
  if (e.ai.steps.length === 0) finishTask(e);
}

export function wagesDue(s: GameState): number {
  return s.employees.filter((e) => e.presentToday).reduce((a, e) => a + e.profile.wage, 0);
}

export function employeeById(s: GameState, id: string): Employee | undefined {
  return s.employees.find((e) => e.id === id);
}

export { getActor };
