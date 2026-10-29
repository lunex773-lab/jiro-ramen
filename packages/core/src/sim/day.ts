// 営業日のサイクル（設計書 4.1）と精算・破産（設計書 14, 15）、評判（7.5）、キャリア（4.2）。
// prep（仕込み）→ open（営業）→ closing（ラストオーダー後、店内の客がはけるまで）→ 精算 → closed → 翌日 prep

import { BALANCE } from '../data/balance';
import { GOALS, UNLOCK_NAMES } from '../data/career';
import { EQUIPMENT } from '../data/equipment';
import { STAGES } from '../data/stages';
import type { DayReport, GameState } from '../types';
import { clamp, newId } from '../util';
import { closeLostItems } from './customers';
import { cash, emptyDayStats, operatingProfit, recordPL, totalDebt } from './economy';
import { finishRepair, resaleValue, runMaintenance, upkeepTotal, useEquipment } from './equipment';
import { dropHand } from './interact';
import { morningRollCall, refreshCandidates, wagesDue } from './employees';
import { expireLots, receiveDeliveries, runAutoOrder } from './inventory';
import { clearNotice, emit, notify, type SimCtx } from './notices';
import { drawAccident, takePrepSnapshot } from './accident';
import { onDayEndEvents, onDayStartEvents, onOpenShopEvents } from './visitors';

/** 開店 */
export function openShop(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  if (s.phase !== 'prep') return { ok: false, reason: '準備時間にだけ開店できます' };
  if (s.bankruptcy) return { ok: false, reason: '破産しています' };
  s.phase = 'open';
  s.openT = 0;
  s.arrivalAcc = 0.6;
  // その日のイベントの抽選（覆面調査員・爆発事故は開店のときに1日1回だけ）
  onOpenShopEvents(s);
  drawAccident(s);
  emit(ctx, { type: 'open' });
  notify(s, ctx, 'phase', 'info', `${s.day}日目の営業を開始しました`);
  return { ok: true };
}

/** 営業時間の終了（新規の来店を止める） */
export function startClosing(s: GameState, ctx: SimCtx): void {
  s.phase = 'closing';
  emit(ctx, { type: 'closing' });
  notify(s, ctx, 'phase', 'info', '営業時間が終わりました。店内のお客さんに提供を済ませましょう');
}

/** 店内の客がいなくなったか */
export function allCustomersGone(s: GameState): boolean {
  return s.customers.every((c) => c.state === 'left' || c.state === 'abandoned' || c.forLostItem !== null);
}

/** 当日の固定費（翌日の予測支出にも使う） */
export function fixedCosts(s: GameState): { rent: number; wages: number; upkeep: number; utilities: number; loans: number; total: number } {
  const st = STAGES[s.career.stage]!;
  const rent = st.rent;
  const wages = s.employees.reduce((a, e) => a + e.profile.wage, 0);
  const upkeep = upkeepTotal(s);
  const utilities = BALANCE.utilitiesBase;
  const loans = s.loans.reduce((a, l) => a + Math.min(l.remaining, l.dailyPayment) + Math.round(l.remaining * l.dailyRate), 0);
  return { rent, wages, upkeep, utilities, loans, total: rent + wages + upkeep + utilities + loans };
}

/**
 * 支払う。払えない分は未払金（期限 = 猶予日数後）にする。
 * key で同じ支払いの二重適用を防ぐ。
 */
function payOrAccrue(s: GameState, type: Parameters<typeof cash>[1], amount: number, memo: string, key: string): void {
  if (amount <= 0) return;
  const payNow = Math.min(amount, Math.max(0, s.money));
  if (payNow > 0) cash(s, type, -payNow, memo, key);
  const rest = amount - payNow;
  if (rest > 0) {
    s.arrears.push({ id: newId(s, 'ar'), amount: rest, reason: memo, sinceDay: s.day, dueDay: s.day + BALANCE.arrearsGraceDays });
  }
}

/** 未払金をできるだけ払う（古い順） */
export function payArrears(s: GameState, ctx: SimCtx): number {
  let paid = 0;
  s.arrears.sort((a, b) => a.dueDay - b.dueDay);
  for (const ar of s.arrears) {
    if (s.money <= 0) break;
    const p = Math.min(ar.amount, s.money);
    cash(s, 'arrearsPay', -p, `未払金の支払い（${ar.reason}）`);
    ar.amount -= p;
    paid += p;
  }
  s.arrears = s.arrears.filter((a) => a.amount > 0);
  if (paid > 0) emit(ctx, { type: 'arrearsPaid', value: paid });
  return paid;
}

/** 閉店後の精算（設計書 14.1） */
export function settleDay(s: GameState, ctx: SimCtx): DayReport {
  const key = (k: string) => `settle:${s.day}:${k}`;
  // 手に持ったもの・作業中の仕事を安全に片付ける
  for (const p of s.players) dropHand(s, p, ctx);
  for (const e of s.employees) dropHand(s, e, ctx);
  // 盛り付け途中・釜に残った麺は廃棄
  for (const e of s.equipment) {
    e.slots = e.slots.map((sl) => {
      if (sl) {
        recordPL(s, 'waste', sl.unitCost);
        s.today.wasteItems.noodle = (s.today.wasteItems.noodle ?? 0) + sl.grams;
      }
      return null;
    });
    for (let i = 0; i < e.bowlSlots.length; i++) {
      const b = s.bowls.find((x) => x.id === e.bowlSlots[i]);
      if (!b) continue;
      if (b.contents && b.contents.cost > 0) recordPL(s, 'waste', b.contents.cost);
      b.contents = null;
      b.orderId = null;
      b.state = 'clean';
      b.loc = { at: 'rack' };
      e.bowlSlots[i] = null;
    }
  }
  // 閉店後の片付け（残った丼は洗ったことにする。手間は営業中の評価で反映済み）
  for (const b of s.bowls) {
    if (b.state === 'dirty' || b.state === 'washing' || b.state === 'served') {
      b.state = 'clean';
      b.contents = null;
      b.orderId = null;
      b.loc = { at: 'rack' };
    }
  }
  for (const seat of s.seats) {
    seat.bowlId = null;
    seat.customerId = null;
  }
  for (const e of s.equipment) {
    e.washing = [];
    e.washElapsed = 0;
  }
  // 冷蔵庫は毎日少し消耗
  for (const e of s.equipment) if (e.placed && EQUIPMENT[e.type]?.role === 'fridge') useEquipment(s, ctx, e);

  // 食材の期限切れ
  expireLots(s, ctx);
  closeLostItems(s, ctx);

  // 支払い（未払金 → 当日分）
  payArrears(s, ctx);
  const st = STAGES[s.career.stage]!;
  const wages = wagesDue(s);
  recordPL(s, 'rent', st.rent);
  payOrAccrue(s, 'rent', st.rent, `家賃（${s.day}日目）`, key('rent'));
  recordPL(s, 'wages', wages);
  payOrAccrue(s, 'wage', wages, `給与（${s.day}日目）`, key('wage'));
  const upkeep = upkeepTotal(s);
  recordPL(s, 'upkeep', upkeep);
  payOrAccrue(s, 'upkeep', upkeep, '設備維持費', key('upkeep'));
  recordPL(s, 'utilities', BALANCE.utilitiesBase);
  payOrAccrue(s, 'utilities', s.today.utilities, '光熱費', key('util'));
  for (const loan of s.loans) {
    const interest = Math.round(loan.remaining * loan.dailyRate);
    const principal = Math.min(loan.remaining, loan.dailyPayment);
    recordPL(s, 'interest', interest);
    payOrAccrue(s, 'interest', interest, '融資の利息', key(`int:${loan.id}`));
    payOrAccrue(s, 'loanRepay', principal, '融資の返済', key(`rep:${loan.id}`));
    loan.remaining -= principal;
  }
  s.loans = s.loans.filter((l) => l.remaining > 0);
  runMaintenance(s, ctx);

  // 評判の更新（その日の口コミを集計して反映）
  const reviews = s.todayReviews;
  if (reviews.length > 0) {
    const avg = reviews.reduce((a, r) => a + r.stars, 0) / reviews.length;
    const w = Math.min(BALANCE.reputation.maxWeight, BALANCE.reputation.weightPerReview * reviews.length);
    s.reputation = clamp(s.reputation * (1 - w) + avg * w, 1, 5);
  } else if (s.today.served === 0 && s.closedForConstruction === 0) {
    s.reputation = clamp(s.reputation - 0.03, 1, 5);
  }
  s.reviews = [...s.reviews, ...reviews].slice(-60);
  s.todayReviews = [];

  const op = operatingProfit(s.today);
  const report: DayReport = {
    ...s.today,
    wasteItems: { ...s.today.wasteItems },
    day: s.day,
    operatingProfit: op,
    cashStart: s.cashAtDayStart,
    cashEnd: s.money,
    reputation: Math.round(s.reputation * 100) / 100,
    reviews: reviews.length,
    avgSatisfaction: s.today.satisfactionCount > 0 ? s.today.satisfactionSum / s.today.satisfactionCount : 0,
    avgWait: s.today.served > 0 ? s.today.totalSeatWait / s.today.served : 0,
  };
  s.history.push(report);
  if (s.history.length > 60) s.history.splice(0, s.history.length - 60);
  s.career.daysPlayed += 1;
  s.career.bestDayServed = Math.max(s.career.bestDayServed, s.today.served);
  if (s.today.served > 0) s.career.bestDayProfit = Math.max(s.career.bestDayProfit, op);
  checkGoals(s, ctx);
  onDayEndEvents(s);
  s.phase = 'closed';
  s.customers = [];
  s.queue = [];
  s.insideQueue = [];
  s.orders = [];
  s.dirt = s.dirt.filter((d) => d.kind === 'grime');
  updateFinanceWarnings(s, ctx);
  // 翌朝便の自動発注
  runAutoOrder(s, ctx);
  emit(ctx, { type: 'dayEnd', value: op });
  return report;
}

export function checkGoals(s: GameState, ctx: SimCtx): void {
  for (const g of GOALS) {
    if (s.career.goalsDone.includes(g.id)) continue;
    if (!g.check(s)) continue;
    s.career.goalsDone.push(g.id);
    for (const u of g.unlocks) if (!s.career.unlocked.includes(u)) s.career.unlocked.push(u);
    const names = g.unlocks.map((u) => UNLOCK_NAMES[u] ?? u).join('・');
    notify(s, ctx, `goal:${g.id}`, 'good', `目標達成「${g.name}」${names ? `：${names}が解放されました` : ''}`);
    emit(ctx, { type: 'goal', text: g.name });
    if (g.unlocks.includes('hiring') && s.candidates.length === 0) refreshCandidates(s);
  }
}

/** 資金の警告（設計書 15.2）: 段階的に、金額と原因を示す */
export function updateFinanceWarnings(s: GameState, ctx: SimCtx): void {
  const fc = fixedCosts(s);
  const arrearsTotal = s.arrears.reduce((a, b) => a + b.amount, 0);
  const overdue = s.arrears.filter((a) => a.dueDay < s.day + 1);
  for (const c of ['fin:caution', 'fin:next', 'fin:short', 'fin:arrears', 'fin:overdue']) clearNotice(s, c);
  const fmt = (v: number) => `¥${Math.round(v).toLocaleString('ja-JP')}`;
  if (overdue.length > 0) {
    notify(s, ctx, 'fin:overdue', 'danger',
      `支払期限超過: ${fmt(overdue.reduce((a, b) => a + b.amount, 0))}。設備の売却・融資・解雇で支払わないと破産します`);
  } else if (arrearsTotal > 0) {
    notify(s, ctx, 'fin:arrears', 'danger', `未払金 ${fmt(arrearsTotal)}（${s.arrears.map((a) => a.reason).join('・')}）。期限は${Math.min(...s.arrears.map((a) => a.dueDay))}日目`);
  } else if (s.money < fc.total) {
    notify(s, ctx, 'fin:short', 'danger', `支払い不足の予測: 明日の支出 ${fmt(fc.total)}（家賃${fmt(fc.rent)}・給与${fmt(fc.wages)}・維持費${fmt(fc.upkeep)}）に対し資金 ${fmt(s.money)}`);
  } else if (s.money < fc.total * 1.5) {
    notify(s, ctx, 'fin:next', 'warn', `次回の支払額 ${fmt(fc.total)} に対して資金に余裕がありません`);
  } else if (s.money < fc.total * BALANCE.cautionDaysOfFixedCost) {
    notify(s, ctx, 'fin:caution', 'warn', `資金注意: 固定費の${BALANCE.cautionDaysOfFixedCost}日分（${fmt(fc.total * BALANCE.cautionDaysOfFixedCost)}）を下回っています`);
  }
}

/** 救済手段で用意できる最大額（設備売却＋融資） */
export function rescueCapacity(s: GameState): number {
  const sell = s.equipment.reduce((a, e) => a + resaleValue(e), 0);
  const loan = loanAvailable(s) ? BALANCE.loan.amount : 0;
  return sell + loan;
}

export function loanAvailable(s: GameState): boolean {
  return s.loans.length === 0 && s.reputation >= BALANCE.loan.minReputation && !s.bankruptcy;
}

export function takeLoan(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  if (!loanAvailable(s)) return { ok: false, reason: s.loans.length > 0 ? '返済中の融資があります' : '評判が低く融資を受けられません' };
  const L = BALANCE.loan;
  const loan = { id: newId(s, 'loan'), principal: L.amount, remaining: L.amount, dailyRate: L.dailyRate, dailyPayment: Math.ceil(L.amount / L.days), takenDay: s.day };
  s.loans.push(loan);
  cash(s, 'loan', L.amount, `緊急融資（日利${(L.dailyRate * 100).toFixed(1)}%・${L.days}日返済）`, `loan:${loan.id}`);
  notify(s, ctx, 'loan', 'warn', `¥${L.amount.toLocaleString('ja-JP')}の融資を受けました。毎日¥${loan.dailyPayment.toLocaleString('ja-JP')}＋利息を返済します`);
  updateFinanceWarnings(s, ctx);
  return { ok: true };
}

/**
 * 破産判定（設計書 15.1）。
 * 期限を過ぎた未払金があり、手元資金と救済手段（設備売却・融資）を合わせても払えない場合に破産。
 */
export function bankruptcyCheck(s: GameState): { bankrupt: boolean; overdue: number } {
  const overdue = s.arrears.filter((a) => a.dueDay < s.day).reduce((a, b) => a + b.amount, 0);
  if (overdue <= 0) return { bankrupt: false, overdue: 0 };
  return { bankrupt: s.money + rescueCapacity(s) < overdue, overdue };
}

export function declareBankruptcy(s: GameState, ctx: SimCtx, reason: string): void {
  s.phase = 'bankrupt';
  s.bankruptcy = { day: s.day, cash: s.money, debt: totalDebt(s), reason };
  for (const p of s.players) dropHand(s, p, ctx);
  for (const e of s.employees) {
    dropHand(s, e, ctx);
    e.ai.steps = [];
    e.ai.taskId = null;
  }
  notify(s, ctx, 'bankrupt', 'danger', `破産しました: ${reason}`);
  emit(ctx, { type: 'bankrupt', text: reason });
}

/** 翌営業日へ（設計書 4.1 の 13） */
export function nextDay(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  if (s.phase !== 'closed') return { ok: false, reason: '閉店後にだけ次の日へ進めます' };
  // 期限切れの未払金があるまま次の日へは進めない
  const bc = bankruptcyCheck(s);
  if (bc.overdue > 0) {
    payArrears(s, ctx);
    const again = bankruptcyCheck(s);
    if (again.bankrupt) {
      declareBankruptcy(s, ctx, `期限を過ぎた未払金 ¥${again.overdue.toLocaleString('ja-JP')} を支払えない`);
      return { ok: false, reason: '破産しました' };
    }
    if (again.overdue > 0) {
      return { ok: false, reason: `期限を過ぎた未払金 ¥${again.overdue.toLocaleString('ja-JP')} があります。設備の売却・融資・解雇で支払ってください` };
    }
  }
  s.day += 1;
  s.t = 0;
  s.openT = 0;
  s.today = emptyDayStats();
  s.cashAtDayStart = s.money;
  s.regularsVisitedToday = [];
  for (const e of s.equipment) {
    if (e.status === 'repairing') finishRepair(s, ctx, e);
    e.process = null;
  }
  receiveDeliveries(s, ctx, true);
  refreshCandidates(s);
  morningRollCall(s, ctx);
  for (const p of s.players) {
    const st = STAGES[s.career.stage]!;
    p.pos = { x: st.playerSpawn.x, z: st.playerSpawn.z };
    p.hand = { kind: 'none' };
    p.work = null;
  }
  // 常連は時間が経つと少しずつ離れる
  for (const r of s.regulars) if (s.day - r.lastVisitDay > 5) r.loyalty = Math.max(0, r.loyalty - 0.03);
  s.regulars = s.regulars.filter((r) => r.loyalty > 0.02);
  // 覆面調査員の記事の公開など（仕込み開始時点の控えより前に済ませ、控えに含める）
  onDayStartEvents(s, ctx);
  if (s.closedForConstruction > 0) {
    // 工事で休業: 営業せずに精算だけ行う
    s.closedForConstruction -= 1;
    notify(s, ctx, 'construction', 'info', `工事のため休業日です（残り${s.closedForConstruction}日）`);
    s.phase = 'closing';
    settleDay(s, ctx);
    return { ok: true };
  }
  s.phase = 'prep';
  // 爆発事故のリセットに使う「仕込み開始時点」の控え（ここと新しいキャリアの1日目だけで作る）
  takePrepSnapshot(s);
  emit(ctx, { type: 'dayStart', value: s.day });
  return { ok: true };
}
