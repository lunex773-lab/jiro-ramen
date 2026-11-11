// 従業員（設計書 13）。
// AI の流れ: 仕事候補の取得 → 優先度計算 → 担当範囲の確認 → 予約 → 経路探索 → 移動 → 作業 → 結果確認 → 次の仕事
// 同じ仕事は予約（taskId）で一人だけが担当する。担当者が離脱した仕事は予約が外れ、他の人が引き継げる。

import { openDurationOf } from './hours';
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
import { clamp01, dist, hashString, newId, pick, rand, randRange } from '../util';
import { cash, recordPL } from './economy';
import { defOf, isUsable } from './equipment';
import { stockOf } from './inventory';
import { activeStore } from './company';
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
import { complaintVerbFor } from './complaints';
import { evRand } from './events';
import { unpermittedFilming } from './media';
import { accidentPanic } from './accident';
import { moveAlong, staffRoute, walkSpeed } from './walk';
import { marketHourly, storeMinWage } from './wages';
import { updateCommute } from './commute';
import { attendHireDay, checkQuits, dailyWageOf, fullDayShift, initNewHire, isPartTime, isSlacking, rollCall, rollPostpone, wagesDueToday } from './staff';

export const ROLE_LABEL: Record<EmployeeRole, string> = {
  cook: '調理担当',
  server: '接客担当',
  cleaner: '清掃・洗い場担当',
  leader: 'シフトリーダー',
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
  manner: { label: '食べ方の注意', base: 74, roles: ['server', 'cook'] },
  linger: { label: '居座りへの声かけ', base: 64, roles: ['server', 'cook'] },
  smoke: { label: '店外の喫煙への声かけ', base: 46, roles: ['server', 'cleaner'] },
  film: { label: '許可のない撮影への声かけ', base: 70, roles: ['server', 'cook'] },
  noodlesIn: { label: '麺を入れる', base: 76, roles: ['cook'] },
  tare: { label: 'タレ', base: 72, roles: ['cook'] },
  soup: { label: 'スープ', base: 71, roles: ['cook'] },
  setBowls: { label: '丼を並べる', base: 68, roles: ['cook'] },
  // 仕込みは調理担当と接客担当の仕事（じろ1 5.8: 仕込み担当をなくし、接客の手が空いたときに仕込む）
  prepUrgent: { label: '食材補充（急ぎ）', base: 66, roles: ['cook', 'server'] },
  collect: { label: '食器回収', base: 58, roles: ['cleaner', 'server'] },
  wipe: { label: 'テーブル清掃', base: 52, roles: ['cleaner', 'server'] },
  wash: { label: '洗浄', base: 50, roles: ['cleaner'] },
  prep: { label: '仕込み', base: 42, roles: ['cook', 'server'] },
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

/** 豚のブロック1本を切った枚数 */
const BUTA_PER_BLOCK = PREP_RECIPES.slice_pork?.outputs[0]?.qty ?? 18;

/** 鍋・釜で工程中の、その物の出来上がりの量 */
function inProcessOutput(s: GameState, itemId: string): number {
  let n = 0;
  for (const e of s.equipment) {
    const pr = e.process ? PREP_RECIPES[e.process.recipeId] : undefined;
    if (!pr) continue;
    for (const o of pr.outputs) {
      if (o.itemId === itemId) n += o.qty;
      else if (itemId === 'buta' && o.itemId === 'pork_block') n += o.qty * BUTA_PER_BLOCK;
    }
  }
  return n;
}

/** その物の、営業1秒あたりの使用量の見込み（最近の日の使用量の最大と、今日のここまでの速さの大きいほう。品切れがあった日は多めに見る） */
export function prepUseRate(s: GameState, itemId: string): number {
  const D = openDurationOf(s);
  let best = 0;
  let n = 0;
  for (let i = s.history.length - 1; i >= 0 && n < BALANCE.prepPlan.days; i--) {
    const r = s.history[i]!;
    if (r.day === s.day || r.served === 0) continue;
    n += 1;
    const short = (r.stockoutItems?.[itemId] ?? 0) + (r.stockoutItems?.[`menu:${itemId}`] ?? 0) >= 2;
    best = Math.max(best, ((r.usedItems?.[itemId] ?? 0) / D) * (short ? BALANCE.prepPlan.stockoutBoost : 1));
  }
  if (s.phase === 'open' && s.openT > 60) best = Math.max(best, (s.today.usedItems?.[itemId] ?? 0) / s.openT);
  return best;
}

/**
 * 仕込みの目安: 決まった量（restockBelow）か、仕込みにかかる時間のあいだにピークの速さで使う見込みの量の多いほう。
 * 営業の残りの時間で使い切れない量は仕込まない（閉店前に作りすぎて廃棄しないように）
 */
export function restockTarget(s: GameState, r: { id: string; time: number; restockBelow?: { itemId: string; qty: number } }): number {
  if (!r.restockBelow) return 0;
  // プレイヤーが決めた仕込みの目安（じろ1 5.8）があればそれを使う
  const manual = s.prepTargets?.[r.restockBelow.itemId];
  if (manual !== undefined && manual >= 0) return manual;
  const P = BALANCE.prepPlan;
  const rate = prepUseRate(s, r.restockBelow.itemId);
  const lead = r.time + P.leadMarginSec + (r.id === 'braise_pork' ? (PREP_RECIPES.slice_pork?.time ?? 0) : 0);
  let want = rate * P.peakFactor * lead * P.safety;
  if (s.phase === 'open') want = Math.min(want, rate * Math.max(0, openDurationOf(s) - s.openT) * P.safety);
  return Math.max(r.restockBelow.qty, want);
}

/** 仕込みの目安を決められる品（仕込みで作る品）と、自動のときの最低の量 */
export function prepTargetItems(): { itemId: string; minQty: number }[] {
  const out = new Map<string, number>();
  for (const r of Object.values(PREP_RECIPES)) {
    if (!r.restockBelow) continue;
    out.set(r.restockBelow.itemId, Math.max(out.get(r.restockBelow.itemId) ?? 0, r.restockBelow.qty));
  }
  return [...out].map(([itemId, minQty]) => ({ itemId, minQty }));
}

/** 仕込みの目安を決める（qty: 作った品の量。null で自動に戻す）。0〜自動の最低の量の20倍まで */
export function setPrepTarget(s: GameState, itemId: string, qty: number | null): { ok: boolean; reason?: string } {
  const item = prepTargetItems().find((x) => x.itemId === itemId);
  if (!item) return { ok: false, reason: '仕込みで作る品ではありません' };
  if (qty === null) {
    if (s.prepTargets) delete s.prepTargets[itemId];
    return { ok: true };
  }
  if (!Number.isFinite(qty) || qty < 0 || qty > item.minQty * 20) return { ok: false, reason: `目安は0〜${(item.minQty * 20).toLocaleString('ja-JP')}の範囲で決めてください` };
  (s.prepTargets ??= {})[itemId] = Math.round(qty);
  return { ok: true };
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
  // 以前は一部の調理担当の候補を仕込み担当にしていた（じろ1 で仕込み担当はなくなった）。乱数の並びを変えないよう、抽選だけ残す
  if (role === 'cook') evRand(s);
  const finalRole: EmployeeRole = role;
  const talent = randRange(s, 0.25, 0.8);
  const skills: EmployeeSkills = {
    speed: skill(s, talent),
    cooking: skill(s, role === 'cook' ? talent + 0.1 : talent - 0.15),
    service: skill(s, role === 'server' ? talent + 0.1 : talent - 0.1),
    hygiene: skill(s, role === 'cleaner' ? talent + 0.1 : talent - 0.05),
    movement: skill(s, talent),
  };
  // 隠しパラメータ。勤怠は以前の「信頼性」と同じ乱数の引き方（既存の乱数の並びを変えない）、辛抱はイベント専用の乱数で引く
  const D = BALANCE.staff.diligence;
  const P = BALANCE.staff.patience;
  const diligence = clamp01(D.mean + randRange(s, -D.spread, D.spread));
  const sc = (skills.speed + skills.movement + (role === 'cook' ? skills.cooking : role === 'server' ? skills.service : skills.hygiene)) / 3;
  const st = BALANCE.staff;
  // 能力と給与は相関するが、掘り出し物（安くて有能）や割高な人もいる
  // 給料の高さのばらつき（以前の日給の抽選と同じ乱数の引き方。安くて有能な人・割高な人もいる）
  const wageU = clamp01((randRange(s, -0.15, 0.3) + 0.15) / 0.45);
  const hireFee = Math.round((st.hireFeeMin + (st.hireFeeMax - st.hireFeeMin) * clamp01(sc + randRange(s, -0.2, 0.2))) / 1000) * 1000;
  const profile: EmployeeProfile = {
    name: `${pick(s, SURNAMES)} ${pick(s, GIVEN_NAMES)}`,
    role: finalRole,
    skills,
    wage: 0,
    hireFee,
    experience: randRange(s, 0, 0.1),
    employment: BALANCE.staff.employment.hireAs,
    hourly: 0,
    diligence,
    patience: clamp01(P.mean + (2 * evRand(s) - 1) * P.spread),
  };
  // 時給は店の都道府県の最低賃金から（じろ1 5.7）。日給は仕込みから閉店まで働いた額
  profile.hourly = marketHourly(storeMinWage(s), finalRole, sc, profile.experience, wageU);
  profile.wage = Math.round((profile.hourly * BALANCE.staff.employment.fullShiftHours) / 10) * 10;
  const id = newId(s, 'cand');
  // 見た目の番号は乱数を使わずに決める（ゲームの乱数の並びを変えない）
  profile.look = hashString(`${s.seed}:${id}`) % 1_000_000;
  // 希望シフト（出られる曜日）も乱数を使わずに決める（オーナーの判断 13）
  profile.wishDays = wishDaysFor(`${s.seed}:${id}:wish`);
  return { id, profile };
}

/** 出られる曜日（wishDaysMin〜wishDaysMax 日。名前の種から決まる） */
export function wishDaysFor(key: string): boolean[] {
  const st = BALANCE.staff;
  let h = hashString(key);
  const n = st.wishDaysMin + (h % (st.wishDaysMax - st.wishDaysMin + 1));
  const order = [0, 1, 2, 3, 4, 5, 6];
  for (let i = order.length - 1; i > 0; i--) {
    h = hashString(`${key}:${i}:${h}`);
    const j = h % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const days = Array.from({ length: 7 }, () => false);
  for (const d of order.slice(0, n)) days[d] = true;
  return days;
}

/** 最初から解放されているもの（採用は1日目から。オーナーの判断 2026-11-05） */
export const STARTING_UNLOCKS: readonly string[] = ['hiring'];

/** 最初から解放されているものを足す（前のセーブ・共同経営・共通市場の会社）。足したら true */
/**
 * 前のセーブの担当を今の担当に直す（じろ1: 仕込み担当 → 接客担当）。プレイヤーがいる店と、ほかの店の中身の両方。何度呼んでもよい
 */
export function migrateStaffRoles(s: GameState): void {
  const fix = (list: { profile: { role: string } }[] | undefined) => {
    for (const x of list ?? []) if (x.profile.role === 'prep') x.profile.role = 'server';
  };
  fix(s.employees);
  fix(s.candidates);
  for (const st of s.company?.stores ?? []) {
    const snap = st.snapshot as { employees?: { profile: { role: string } }[]; candidates?: { profile: { role: string } }[] } | null | undefined;
    fix(snap?.employees);
    fix(snap?.candidates);
  }
}

export function ensureStartingUnlocks(s: GameState): boolean {
  // 前のセーブの担当を直す（読み込み・毎朝・共通市場の日の始めに通る）
  migrateStaffRoles(s);
  let added = false;
  for (const u of STARTING_UNLOCKS) {
    if (!s.career.unlocked.includes(u)) {
      s.career.unlocked.push(u);
      added = true;
    }
  }
  return added;
}

/**
 * ゲームの乱数・イベントの乱数・ID の連番を使わずに、採用の候補を出す（新しいゲームの1日目と、前のセーブを読み込んだとき）。
 * 1日目に雇わなければ、採用を最初から解放する前と同じ進み方になる
 */
export function candidatesWithoutRng(s: GameState, tag: string): void {
  const rng = s.rng;
  const nextId = s.nextId;
  const ev = s.events ? s.events.rng : null;
  s.rng = hashString(`${s.seed}:${tag}`) >>> 0;
  if (s.events) s.events.rng = hashString(`${s.seed}:${tag}:ev`) >>> 0;
  refreshCandidates(s);
  s.rng = rng;
  s.nextId = nextId;
  if (s.events && ev !== null) s.events.rng = ev;
  // ID は連番を使わない名前にする（見た目・希望シフトも ID から決め直す）
  s.candidates.forEach((c, i) => {
    c.id = `cand-${tag}-${i + 1}`;
    c.profile.look = hashString(`${s.seed}:${c.id}`) % 1_000_000;
    c.profile.wishDays = wishDaysFor(`${s.seed}:${c.id}:wish`);
  });
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
  // 採用したときの能力（伸びた分を色で分けて見せる）
  e.profile.initialSkills = { ...e.profile.skills };
  // アルバイトとして採用（初めのシフトは希望の曜日・仕込みから閉店まで。経営メニューで変えられる）
  initNewHire(e);
  // 通常の採用は、採用の2日後から出勤できる（すぐに人手が要るときは短期バイト。チュートリアルの練習はすぐ）
  if (!s.tutorial) e.availableFrom = s.day + BALANCE.staff.hireDelayDays;
  // 準備時間中に雇った場合は当日から勤務（当日分の給与が発生）
  attendHireDay(s, e);
  s.employees.push(e);
  s.candidates = s.candidates.filter((x) => x.id !== candidateId);
  emit(ctx, { type: 'hire', text: e.profile.name });
  notify(s, ctx, `hire:${e.id}`, 'good', `${e.profile.name}さん（${ROLE_LABEL[e.profile.role]}・アルバイト）を採用しました`);
  return { ok: true };
}

/** 今日雇った短期バイトの数 */
export function tempsToday(s: GameState): number {
  return s.employees.filter((e) => e.profile.temp).length;
}

/** 短期バイトの時給（候補の日給の平均の時給 × wageMult） */
export function tempHourly(): number {
  const st = BALANCE.staff;
  return Math.round((((st.wageMin + st.wageMax) / 2 / st.employment.fullShiftHours) * st.temp.wageMult) / 10) * 10;
}

/**
 * 短期バイトを呼ぶ（共通市場の仕様書 4.3「人員不足時の短期バイト」。オーナーの判断 14「控えめ」）。
 * 仕込みの間だけ。その日すぐ来て、閉店の精算のあと辞める。採用費なし・時給は通常の1.5倍・能力は新人並み。1日2人まで
 */
export function hireTemp(s: GameState, ctx: SimCtx, role: EmployeeRole): { ok: boolean; reason?: string } {
  const st = BALANCE.staff;
  if (!s.career.unlocked.includes('hiring')) return { ok: false, reason: '採用はまだ解放されていません' };
  if (s.phase !== 'prep') return { ok: false, reason: '短期バイトは開店前（仕込みの間）に呼べます' };
  if (!(role in ROLE_LABEL)) return { ok: false, reason: '担当が正しくありません' };
  if (tempsToday(s) >= st.temp.maxPerDay) return { ok: false, reason: `短期バイトは1日${st.temp.maxPerDay}人までです` };
  if (s.employees.length >= 12) return { ok: false, reason: 'これ以上雇えません' };
  const id = newId(s, 'temp');
  const h = (k: string) => (hashString(`${s.seed}:${id}:${k}`) % 1000) / 1000;
  const sk = (k: string) => st.temp.skillFrom + (st.temp.skillTo - st.temp.skillFrom) * h(k);
  const hourly = tempHourly();
  const profile: EmployeeProfile = {
    name: `${SURNAMES[hashString(`${id}:s`) % SURNAMES.length]} ${GIVEN_NAMES[hashString(`${id}:g`) % GIVEN_NAMES.length]}`,
    role,
    skills: { speed: sk('speed'), cooking: sk('cooking'), service: sk('service'), hygiene: sk('hygiene'), movement: sk('movement') },
    wage: Math.round(hourly * st.employment.fullShiftHours),
    hireFee: 0,
    experience: 0,
    employment: 'part',
    hourly,
    diligence: 0.8,
    patience: 0.6,
    temp: true,
    look: hashString(`${s.seed}:${id}:look`) % 1_000_000,
  };
  const e = makeEmployee(s, { id, profile });
  // 今日だけ・仕込みから閉店まで
  e.shifts = Array.from({ length: 7 }, () => null);
  e.dateShifts = { [String(s.day)]: fullDayShift() };
  attendHireDay(s, e);
  s.employees.push(e);
  emit(ctx, { type: 'hire', text: e.profile.name });
  notify(s, ctx, `temp:${e.id}`, 'good', `短期バイトの${e.profile.name}さん（${ROLE_LABEL[role]}）が今日だけ来ます（時給 ¥${hourly.toLocaleString('ja-JP')}）`);
  return { ok: true };
}

/** 閉店の精算のあと、短期バイトは辞める（その日の給与は払い済み） */
export function releaseTemps(s: GameState): void {
  if (!s.employees.some((e) => e.profile.temp)) return;
  s.employees = s.employees.filter((e) => !e.profile.temp);
}

/** 解雇（解雇手当 = 日給 × severanceDays） */
export function fire(s: GameState, ctx: SimCtx, employeeId: string): { ok: boolean; reason?: string } {
  if (s.phase === 'open' || s.phase === 'closing') return { ok: false, reason: '営業中は解雇できません' };
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  const fee = dailyWageOf(e) * BALANCE.severanceDays;
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
  if (!e || !Object.hasOwn(ROLE_LABEL, role)) return false;
  // シフトリーダーは昇格（promoteLeader）でなる。担当の変更ではなれない（シフトリーダーから別の担当には変えられる）
  if (role === 'leader') return false;
  e.profile.role = role;
  releaseTask(e);
  return true;
}

/** 担当設定: 仕事ごとの優先度補正（-100 で担当外） */
export function setPriority(s: GameState, employeeId: string, kind: string, value: number): boolean {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e || !Object.hasOwn(TASK_KINDS, kind) || !Number.isFinite(value)) return false;
  e.priorities[kind] = Math.max(-100, Math.min(50, Math.round(value)));
  return true;
}

/** 出勤確認（シフト・勤怠による遅刻と当日欠勤。staff.ts） */
export function morningRollCall(s: GameState, ctx: SimCtx): void {
  // 不満がたまった人は、朝に辞めることがある（オーナーの判断 13）
  checkQuits(s, ctx);
  rollCall(s, ctx);
}

/**
 * 従業員の道のり。店内は経路探索、店の外（歩道）へは入口を通る（店の前の喫煙客に声をかけるときなど）。
 * 店の外にいるときは入口から店内へ戻る
 */
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
      if (cust && cust.state === 'complaint') add('complaint', `complaint:${seat.id}`, [step(seat.id, complaintVerbFor(cust, s))]);
      // 許可のない撮影: ルールを説明 → やめるよう伝える → 退店を促す
      if (cust && unpermittedFilming(cust)) {
        const f = cust.special!.film!;
        const verb = f.warned === 0 ? 'film_rules' : f.tried[f.tried.length - 1] === 'rules' ? 'film_stop' : 'film_leave';
        add('film', `film:${cust.id}`, [step(seat.id, verb)]);
      }
      // 食べ方の汚い客: 何度か汚したら注意する（一度だけ）
      if (cust && cust.messy && cust.messy.count >= 2 && !cust.messy.calmed && cust.messy.warned === 0 && cust.state === 'eating') add('manner', `manner:${cust.id}`, [step(seat.id, 'manner_warn')]);
      // 居座り: 待っている客がいて、しばらく経ったら退店を促す（混雑の説明から）
      if (cust && cust.group?.leader) {
        const lg = cust.group.linger;
        if (lg && s.t < lg.until && s.t - lg.startT >= BALANCE.guests.group.lingerTroubleAfter && s.queue.length + s.insideQueue.length > 0) {
          const resp = (['explain', 'polite', 'request'] as const).find((r) => !lg.tried.includes(r));
          if (resp) add('linger', `linger:${cust.group.id}`, [step(seat.id, `linger_${resp}`)]);
        }
      }
    }
    // 店の前の喫煙: 声をかける（店の外へ出る）
    for (const c of s.customers) {
      if (c.state === 'smoking' && c.smoke && !c.smoke.warned && c.path.length === 0 && c.smoke.until > 0) add('smoke', `smoke:${c.id}`, [step(c.id, 'smoke_warn')]);
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
      const target = restockTarget(s, r);
      let have = stockOf(s, item);
      if (r.kind === 'process') {
        // 工程中の分も在庫とみなす（豚は、煮込み中・煮込み済みのブロックを切ったあとの枚数で数える）
        have += inProcessOutput(s, item);
        if (r.id === 'braise_pork') have += stockOf(s, 'pork_block') * BUTA_PER_BLOCK;
      }
      if (have >= target) continue;
      const st = stations.find((e) => !e.process || r.kind === 'hold');
      if (!st) continue;
      // 切れる寸前ほど優先度を上げる（盛り付けに必要な量を切ったら調理より先に補充）
      const ratio = have / target;
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
      // 汚れた席は、拭いてから丼を下げる（丼を下げると次の客が座って拭けなくなるため）
      const steps = seat.dirt >= BALANCE.cleaning.counterCleanBelow ? [step(seat.id, 'wipe'), step(seat.id, 'collect')] : [step(seat.id, 'collect')];
      if (drop) steps.push(step(drop.id, 'dishes_drop'));
      add('collect', `collect:${seat.id}`, steps, someoneWaiting ? 20 : 0);
    } else if (seat.dirt >= 0.3 && !seat.customerId) add('wipe', `wipe:${seat.id}`, [step(seat.id, 'wipe')], someoneWaiting ? 15 : 0);
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
  // 店長は担当に関係なく店の仕事を何でもする（店長の営業の計算と同じ前提。Phase 2）。シフトリーダーも全部の仕事をする（じろ1 5.8）
  if (s.company && activeStore(s).managerId === e.id) return true;
  if (e.profile.role === 'leader') return true;
  // 洗い物は、清掃担当が来ていない日は接客担当もする（丼が尽きて提供が止まらないように。じろ1 P5 の検証で、清掃担当のいない店が丼14個で止まっていた）
  if (t.kind === 'wash' && e.profile.role === 'server' && !s.employees.some((x) => x.presentToday && !x.commute && x.profile.role === 'cleaner')) return true;
  if (kind.roles.includes(e.profile.role)) {
    // 調理担当の接客系は、接客担当がいないときだけ
    if (e.profile.role === 'cook' && (t.kind === 'serve' || t.kind === 'askCall' || t.kind === 'complaint' || t.kind === 'manner' || t.kind === 'linger' || t.kind === 'film')) {
      const servers = s.employees.some((x) => x.presentToday && !x.commute && x.profile.role === 'server');
      if (servers && t.kind !== 'serve') return false;
    }
    return true;
  }
  // 担当設定で明示的に任せた仕事
  return override !== undefined && override > 0;
}

function taskScore(e: Employee, t: Task, isManager = false): number {
  const override = e.priorities[t.kind] ?? 0;
  // 店長は、仕込み品が切れそうなとき（急ぎの仕込み）にほかの仕事より先に仕込む（オーナーの指示 2026-11-11）
  const mgr = isManager && t.kind === 'prepUrgent' ? BALANCE.storeManager.urgentPrepBonus : 0;
  return t.priority + override + mgr - dist(e.pos, t.at) * 2;
}

// ───────────────────────── 実行 ─────────────────────────


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
 * 失敗した仕事の再試行を遅らせる（仕事キー → その日の sim時刻）。従業員ごとに状態に持つ。
 * 以前はモジュールの表（ゲームの状態の外）に持っていたため、
 *   - s.t は毎朝 0 に戻るのに前日の時刻が残り、前日の終わりに失敗した仕事を翌日のほとんどの時間選ばなかった
 *   - タイトルに戻って始めたゲームや、同じサーバーの別のルームにも前のゲームの記録が残った
 * という不具合があった（統合進化設計書 v2.1 の経済の測定で発見）。毎朝の出勤確認で消す
 */
function failedUntil(e: Employee, key: string): number | undefined {
  return e.ai.failed?.[key];
}

function markFailed(s: GameState, e: Employee, key: string): void {
  const f = (e.ai.failed ??= {});
  // 期限の切れたものは捨てる（表が大きくならない）
  for (const k of Object.keys(f)) if (f[k]! <= s.t) delete f[k];
  f[key] = s.t + 3;
}

/** 従業員AIの更新 */
export function updateEmployees(s: GameState, dt: number, ctx: SimCtx): void {
  if (s.employees.length === 0) return;
  let tasks: Task[] | null = null;
  const busyTargets = playerBusyTargets(s);
  for (const e of s.employees) {
    // 出勤前・休憩中・退勤後・欠勤（状態は staff.ts の出勤の処理が決める）
    if (!e.presentToday) continue;
    // 火事に気づいたら仕事の手を止めて火の方を見る（店からは出ない）
    if (accidentPanic(s) && !e.work && e.pos.z >= 0.05) {
      const acc = s.events!.accident!;
      releaseTask(e);
      e.ai.state = 'idle';
      e.ai.note = '火事に驚いている';
      e.yaw = Math.atan2(acc.pos.x - e.pos.x, acc.pos.z - e.pos.z);
      continue;
    }
    // 出退勤の途中（歩いて入る・あいさつ・手洗い／あいさつ・歩いて出る）は仕事をしない
    if (e.commute) {
      updateCommute(s, e, dt, ctx);
      continue;
    }
    // サボっている間は仕事を選ばない（作業の途中では始まらない）
    if (isSlacking(e, s)) {
      e.ai.state = 'slacking';
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
            const r = staffRoute(s, e.pos, p);
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
        if (e.ai.taskId) markFailed(s, e, e.ai.taskId);
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
    // 店の外（喫煙客への声かけのあと）にいるときは、まず店内へ戻る
    if (e.pos.z < 0) {
      if (e.ai.path.length === 0) {
        const st = stageOf(s);
        e.ai.path = staffRoute(s, e.pos, { x: st.staffSpawn.x, z: st.staffSpawn.z })?.points ?? [];
      }
      e.ai.state = 'moving';
      e.ai.note = '店内へ戻る';
      moveAlong(e, dt, walkSpeed(s, e));
      continue;
    }
    // 新しい仕事を選ぶ
    e.ai.cooldown -= dt;
    if (e.ai.cooldown > 0) continue;
    tasks = tasks ?? buildTasks(s);
    const isManager = !!s.company && activeStore(s).managerId === e.id;
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
      const until = failedUntil(e, t.key);
      if (until !== undefined && until > s.t) continue;
      const sc = taskScore(e, t, isManager);
      if (sc <= bestScore) continue;
      // 実際に実行できるか（行為と同じ判定）を確認してから選ぶ
      if (verbBlocked(s, e.id, t.steps[0]!.targetId, firstVerb, t.steps[0]!.args) !== null) continue;
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
    }
    if (!best && e.hand.kind !== 'none') best = tidyHandTask(s, e);
    // 勤怠が低いと、仕事を後回しにすることがある（手に物を持っていないときだけ）
    if (best && e.hand.kind === 'none' && rollPostpone(s, e)) continue;
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

/** 閉店後の精算の給与（アルバイトは時給 × 働いた時間、社員は日給） */
export function wagesDue(s: GameState): number {
  return wagesDueToday(s);
}

export function employeeById(s: GameState, id: string): Employee | undefined {
  return s.employees.find((e) => e.id === id);
}

export { getActor };
