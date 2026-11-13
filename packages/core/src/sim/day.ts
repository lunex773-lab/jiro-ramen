// 営業日のサイクル（設計書 4.1）と精算・破産（設計書 14, 15）、評判（7.5）、キャリア（4.2）。
// prep（仕込み）→ open（営業）→ closing（ラストオーダー後、店内の客がはけるまで）→ 精算 → closed → 翌日 prep

import { BALANCE } from '../data/balance';
import { GOALS, UNLOCK_NAMES } from '../data/career';
import { EQUIPMENT } from '../data/equipment';
import { INGREDIENTS } from '../data/ingredients';
import { STAGES } from '../data/stages';
import type { StoreHours, DayReport, GameState } from '../types';
import { clamp, newId } from '../util';
import { closeLostItems } from './customers';
import { activeStore, recordCompanyDay } from './company';
import { storeRentMult } from './location';
import { payAds } from './ads';
import { runAbsentStores } from './stores';
import { cash, emptyDayStats, finalProfit, foldIntoLastReport, netSales, operatingProfit, recordPL, STAT_MONEY, totalDebt } from './economy';
import { finishRepair, resaleValue, runMaintenance, upkeepTotal, useEquipment } from './equipment';
import { dropHand } from './interact';
import { ensureStartingUnlocks, morningRollCall, refreshCandidates, releaseTemps, wagesDue } from './employees';
import { closeStaffDay, expectedWages } from './staff';
import { expireLots, receiveDeliveries, runAutoOrder, STOCKOUT_SOURCE } from './inventory';
import { managerWeeklyShifts } from './shift-plan';
import { clearNotice, emit, notify, type SimCtx } from './notices';
import { drawAccident, takePrepSnapshot } from './accident';
import { applyWageFloor } from './wages';
import { clockMinuteAt, clockText, hoursDemandWeight, isClosedDay, SEC_PER_MIN, sessionIndex, sessionSpans, storeHours, todayHours, utilitiesBaseOf } from './hours';
import { onDayEndEvents, onDayStartEvents, onOpenShopEvents } from './visitors';

/** 開店 */
export function openShop(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  if (s.phase !== 'prep') return { ok: false, reason: '準備時間にだけ開店できます' };
  if (s.bankruptcy) return { ok: false, reason: '破産しています' };
  // 中休みのあとの開店（2つ目以降の営業の枠。じろ1 5.1）: 時刻を次の枠の始まりにして、その日の抽選などはしない
  const idx = sessionIndex(s);
  if (idx > 0) {
    s.phase = 'open';
    s.openT = sessionSpans(todayHours(s))[idx]?.startT ?? s.openT;
    s.arrivalAcc = 0.6;
    emit(ctx, { type: 'open' });
    notify(s, ctx, 'phase', 'info', `${clockText(clockMinuteAt(todayHours(s), s.openT))}からの営業を開始しました`);
    return { ok: true };
  }
  s.phase = 'open';
  s.openT = 0;
  s.arrivalAcc = 0.6;
  // その日の広告費（店の方針。払えなければ出さない）
  if (s.company && !s.tutorial) payAds(s, activeStore(s), s.day);
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
  // あとに営業の枠が残っていれば中休み（店内のお客さんに提供を済ませたら、仕込みの時間に戻る）
  const last = sessionIndex(s) >= todayHours(s).sessions.length - 1;
  s.breakPending = !last;
  emit(ctx, { type: 'closing' });
  notify(s, ctx, 'phase', 'info', last ? '営業時間が終わりました。店内のお客さんに提供を済ませましょう' : 'この枠の営業が終わりました。店内のお客さんに提供を済ませたら中休みです');
}

/** 中休みに入る（2つ目以降の営業の枠の前。時間は止まり、「開店する」で次の枠を始める） */
export function startBreak(s: GameState, ctx: SimCtx): void {
  s.phase = 'prep';
  s.breakPending = false;
  s.sessionIdx = sessionIndex(s) + 1;
  const next = todayHours(s).sessions[s.sessionIdx];
  notify(s, ctx, 'phase', 'info', `中休みです。仕込み・片付けをして、${next ? clockText(next.open) : ''}からの営業を「開店する」で始めましょう`);
  emit(ctx, { type: 'break' });
}

/** 店内の客がいなくなったか */
export function allCustomersGone(s: GameState): boolean {
  // 店の前でタバコを吸っている客は店の外なので待たない
  return s.customers.every((c) => c.state === 'left' || c.state === 'abandoned' || c.state === 'dead' || c.state === 'smoking' || c.state === 'crew' || c.forLostItem !== null);
}

/** 今いる店の1日の家賃（広さ × 立地 × 場所の人口） */
export function storeRent(s: GameState): number {
  const st = STAGES[s.career.stage]!;
  return Math.round(st.rent * (s.company ? storeRentMult(activeStore(s)) : 1));
}

/** 当日の固定費（翌日の予測支出にも使う） */
export function fixedCosts(s: GameState): { rent: number; wages: number; upkeep: number; utilities: number; loans: number; total: number } {
  const rent = storeRent(s);
  // 給与はシフトどおりに働いた場合の見込み（閉店後は翌日の分）
  const wages = expectedWages(s, s.phase === 'closed' ? s.day + 1 : s.day);
  const upkeep = upkeepTotal(s);
  const utilities = utilitiesBaseOf(storeHours(s), true);
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
  closeStaffDay(s);
  // 短期バイトはその日だけ（給与は wages に入っている）
  releaseTemps(s);
  // 家賃は店の広さ × 立地 × 場所（前は手動で営業している支店で立地の倍率が抜けていた）
  const rent = storeRent(s);
  recordPL(s, 'rent', rent);
  payOrAccrue(s, 'rent', rent, `家賃（${s.day}日目）`, key('rent'));
  recordPL(s, 'wages', wages);
  payOrAccrue(s, 'wage', wages, `給与（${s.day}日目）`, key('wage'));
  const upkeep = upkeepTotal(s);
  recordPL(s, 'upkeep', upkeep);
  payOrAccrue(s, 'upkeep', upkeep, '設備維持費', key('upkeep'));
  // 光熱費の基本（1日の固定分 + 営業の時間）と、閉店の時刻のあとに提供していた時間の分
  recordPL(s, 'utilities', utilitiesBaseOf(todayHours(s), s.openT > 0) + Math.round((BALANCE.hours.utilitiesPerHour * (s.today.afterHoursSec ?? 0)) / (60 * SEC_PER_MIN)));
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
    stockoutItems: { ...(s.today.stockoutItems ?? {}) },
    usedItems: { ...(s.today.usedItems ?? {}) },
    day: s.day,
    operatingProfit: op,
    netSales: netSales(s.today),
    finalProfit: finalProfit(s.today),
    cashStart: s.cashAtDayStart,
    cashEnd: s.money,
    reputation: Math.round(s.reputation * 100) / 100,
    reviews: reviews.length,
    avgSatisfaction: s.today.satisfactionCount > 0 ? s.today.satisfactionSum / s.today.satisfactionCount : 0,
    avgWait: s.today.served > 0 ? s.today.totalSeatWait / s.today.served : 0,
    demandWeight: Math.round(hoursDemandWeight(todayHours(s)) * 1000) / 1000,
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
  // 品切れの原因（どの食材が足りなかったか）と、どの自動発注を増やせばよいか
  explainStockouts(s, ctx);
  // 翌朝便の自動発注
  runAutoOrder(s, ctx);
  // 店長の毎週のシフト（日曜の閉店後に翌週の分。オーナーの指示 2026-11-11）
  managerWeeklyShifts(s, ctx);
  emit(ctx, { type: 'dayEnd', value: op });
  return report;
}

/**
 * 閉店後に、品切れが多かった食材と、どの自動発注を増やせばよいかを知らせる（設計書 v2.1 §11「数値だけでなく原因を説明」）。
 * 調理担当を雇って杯数が増えると、豚の仕入れ（自動発注の初期値）が足りなくなることが多い
 */
export function explainStockouts(s: GameState, ctx: SimCtx): void {
  const items = s.today.stockoutItems ?? {};
  let worst: string | null = null;
  for (const [k, n] of Object.entries(items)) if (STOCKOUT_SOURCE[k] && n >= 3 && (!worst || n > (items[worst] ?? 0))) worst = k;
  if (!worst) {
    clearNotice(s, 'stockout:cause');
    return;
  }
  const src = STOCKOUT_SOURCE[worst]!;
  const raws = src.raw.map((id) => `${INGREDIENTS[id]?.name ?? id}（今の目安 ${(s.autoOrder[id] ?? 0).toLocaleString('ja-JP')}）`).join('・');
  notify(s, ctx, 'stockout:cause', 'warn', `今日は${src.label}の品切れが${items[worst]}回ありました。在庫・発注で ${raws} の自動発注を増やすか、仕込みを早めにしましょう`);
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
  const loan = loanLimit(s).max;
  return sell + loan;
}

/** 返済能力（直近の営業利益の平均 × 30日分。最低20万円。会社の日報、なければ店の日報） */
export function repaymentCapacity(s: GameState): number {
  const L = BALANCE.loan;
  const hist = s.company?.history?.length ? s.company.history : s.history;
  const recent = hist.slice(-L.capacityRecentDays);
  const avg = recent.length > 0 ? recent.reduce((a, r) => a + r.operatingProfit, 0) / recent.length : 0;
  return Math.max(L.minCapacity, Math.round(avg * L.capacityDays));
}

export interface LoanLimit {
  /** 今借りられる最大の額（5万円刻み。借りられなければ 0） */
  max: number;
  /** 借入の残りの合計 */
  outstanding: number;
  /** 返済能力 */
  capacity: number;
  /** 借入の残りの合計の上限（50万円と返済能力の小さいほう） */
  cap: number;
  /** 借りられない理由（借りられるなら null） */
  reason: string | null;
}

/** 銀行の融資の上限（じろ2: 改修設計書04。オーナーの判断「額を選べる・返済能力で上限」） */
export function loanLimit(s: GameState): LoanLimit {
  const L = BALANCE.loan;
  const outstanding = s.loans.reduce((a, l) => a + l.remaining, 0);
  const capacity = repaymentCapacity(s);
  const cap = Math.min(L.maxTotal, capacity);
  const room = Math.max(0, cap - outstanding);
  let max = Math.floor(room / L.step) * L.step;
  let reason: string | null = null;
  if (s.bankruptcy) reason = '破産しています';
  else if (s.creditBlocked) reason = s.creditBlocked;
  else if (s.reputation < L.minReputation) reason = '評判が低く融資を受けられません';
  else if (max < L.step) reason = `借入の上限です（残り ¥${outstanding.toLocaleString('ja-JP')}／上限 ¥${cap.toLocaleString('ja-JP')}）`;
  if (reason) max = 0;
  return { max, outstanding, capacity, cap, reason };
}

export function loanAvailable(s: GameState): boolean {
  return loanLimit(s).reason === null;
}

/** 融資を受ける。amount を省くと 20万円（借りられる額が少なければその額） */
export function takeLoan(s: GameState, ctx: SimCtx, amount?: number): { ok: boolean; reason?: string } {
  const lim = loanLimit(s);
  if (lim.reason) return { ok: false, reason: lim.reason };
  const L = BALANCE.loan;
  const amt = amount ?? Math.min(L.amount, lim.max);
  if (!Number.isInteger(amt) || amt < L.step || amt % L.step !== 0) return { ok: false, reason: `融資は ¥${L.step.toLocaleString('ja-JP')} 刻みで選んでください` };
  if (amt > lim.max) return { ok: false, reason: `今借りられるのは ¥${lim.max.toLocaleString('ja-JP')} までです（借入の残りの合計は ¥${lim.cap.toLocaleString('ja-JP')} まで）` };
  const loan = { id: newId(s, 'loan'), principal: amt, remaining: amt, dailyRate: L.dailyRate, dailyPayment: Math.ceil(amt / L.days), takenDay: s.day };
  s.loans.push(loan);
  cash(s, 'loan', amt, `融資（日利${(L.dailyRate * 100).toFixed(1)}%・${L.days}日返済）`, `loan:${loan.id}`);
  notify(s, ctx, 'loan', 'warn', `¥${amt.toLocaleString('ja-JP')}の融資を受けました。毎日¥${loan.dailyPayment.toLocaleString('ja-JP')}＋利息を返済します`);
  updateFinanceWarnings(s, ctx);
  return { ok: true };
}

/** 期限を過ぎた未払金を払うための融資の額（5万円刻みで足りる額。上限まで） */
export function rescueLoanAmount(s: GameState, overdue: number): number {
  const L = BALANCE.loan;
  const lim = loanLimit(s);
  const need = Math.max(L.step, Math.ceil(Math.max(0, overdue - Math.max(0, s.money)) / L.step) * L.step);
  return Math.min(lim.max, need);
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

/**
 * 期限を過ぎた未払金があって次の日に進めないときの数字（画面で選択肢を出すため。オーナーの指示 2026-11-12）。
 * なければ null。loanPick: 足りない額をまかなう銀行の融資の額（借りられる上限まで・刻みに合わせる）
 */
export function overdueShortfall(s: GameState): { overdue: number; money: number; shortfall: number; loanMax: number; loanPick: number; sellable: number } | null {
  const bc = bankruptcyCheck(s);
  if (bc.overdue <= 0) return null;
  const shortfall = Math.max(0, bc.overdue - Math.max(0, s.money));
  const lim = loanLimit(s);
  const step = BALANCE.loan.step;
  const loanMax = lim.reason ? 0 : lim.max;
  const loanPick = loanMax > 0 ? Math.min(loanMax, Math.max(step, Math.ceil(shortfall / step) * step)) : 0;
  const sellable = s.equipment.reduce((a, e) => a + resaleValue(e), 0);
  return { overdue: bc.overdue, money: s.money, shortfall, loanMax, loanPick, sellable };
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
  // その日の結果を確定する（営業の終わりに確定していれば、もうしない。じろ7 5）
  if (s.finalizedDay !== s.day) closeOutDay(s, ctx);
  return startNextDay(s, ctx);
}

/**
 * その日の結果を確定する: 閉店のあとに動いたお金（夜の自動発注・閉店後の採用や設備など）をその日の日報に足し、
 * プレイヤーがいない店のその日（店長の営業）と、会社の日報（店舗の合計）を作る
 */
function closeOutDay(s: GameState, ctx: SimCtx): void {
  foldIntoLastReport(s);
  runAbsentStores(s, ctx, s.day);
  recordCompanyDay(s, s.day);
}

/**
 * 営業の終わり（精算したあと）に、その日の結果を確定する（じろ7 5「1日の営業データは、営業が終了した段階で送信・確定する」）。
 * 共通市場では、このあとすぐにその日をサーバーへ送る。何度呼んでも同じ（2回目からは何もしない）。
 * 確定のあとの閉店後の事務作業で動いたお金は、その日の日報を書き換えずに、次の日の日報に入れる（startNextDay）
 */
export function finalizeDay(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  if (s.phase !== 'closed') return { ok: false, reason: '閉店後にだけ、その日の結果を確定できます' };
  if (s.finalizedDay === s.day) return { ok: true };
  closeOutDay(s, ctx);
  s.finalizedDay = s.day;
  s.finalizeBase = Object.fromEntries(STAT_MONEY.map((k) => [k, (s.today[k] as number | undefined) ?? 0]));
  s.cashAtFinalize = s.money;
  return { ok: true };
}

/**
 * 次の日の朝（日付を進め、届いた荷物・採用の候補・出勤の確認・朝のイベントのあと仕込みへ）。
 * nextDay と、共通市場の自動営業（market.ts）の両方から使う（手動と自動で同じ朝の規則）。takeSnapshot: 爆発事故のリセット用の控えを作るか
 */
export function startNextDay(s: GameState, ctx: SimCtx, takeSnapshot = true): { ok: boolean; reason?: string } {
  // 営業の終わりに結果を確定した日なら、確定のあとに動いたお金を次の日の日報に回す（その日の日報は書き換えない。じろ7 5）
  let carry: Record<string, number> | null = null;
  let cashStart = s.money;
  if (s.finalizedDay === s.day && s.finalizeBase) {
    carry = {};
    for (const k of STAT_MONEY) {
      const d = ((s.today[k] as number | undefined) ?? 0) - (s.finalizeBase[k] ?? 0);
      if (d !== 0) carry[k] = d;
    }
    cashStart = s.cashAtFinalize ?? s.money;
  }
  delete s.finalizeBase;
  delete s.cashAtFinalize;
  s.day += 1;
  s.t = 0;
  s.openT = 0;
  s.today = emptyDayStats();
  if (carry) for (const [k, v] of Object.entries(carry)) (s.today as unknown as Record<string, number>)[k] = v;
  s.cashAtDayStart = cashStart;
  s.regularsVisitedToday = [];
  // 今日の営業時間（店の設定。変えた設定は次の営業日から。じろ1 5.1）
  s.todayHours = JSON.parse(JSON.stringify(storeHours(s))) as StoreHours;
  s.sessionIdx = 0;
  s.breakPending = false;
  for (const e of s.equipment) {
    if (e.status === 'repairing') finishRepair(s, ctx, e);
    e.process = null;
  }
  receiveDeliveries(s, ctx, true);
  // 前のセーブ・共同経営・共通市場の会社も、朝に最初から解放されているもの（採用）を足す
  ensureStartingUnlocks(s);
  // 給料が店の都道府県の最低賃金を下回っていたら上げる（じろ1 5.7）
  applyWageFloor(s);
  refreshCandidates(s);
  morningRollCall(s, ctx);
  for (const p of s.players) {
    const st = STAGES[s.career.stage]!;
    p.pos = { x: st.playerSpawn.x, z: st.playerSpawn.z };
    p.hand = { kind: 'none' };
    p.work = null;
    // 前の日に武器に当たって倒れた時刻（営業の秒は毎日0から数え直すので消す）
    delete p.downUntil;
  }
  // 常連は時間が経つと少しずつ離れる
  for (const r of s.regulars) if (s.day - r.lastVisitDay > 5) r.loyalty = Math.max(0, r.loyalty - 0.03);
  s.regulars = s.regulars.filter((r) => r.loyalty > 0.02);
  // 覆面調査員の記事の公開など（仕込み開始時点の控えより前に済ませ、控えに含める）
  onDayStartEvents(s, ctx);
  if (isClosedDay(s.todayHours, s.day) && s.closedForConstruction <= 0 && !s.tutorial) {
    // 定休日: 営業せずに精算だけ（家賃・維持費・光熱費の固定分はかかる。従業員は休み）
    notify(s, ctx, 'closedDay', 'info', `今日（${s.day}日目）は定休日です`);
    s.phase = 'closing';
    settleDay(s, ctx);
    return { ok: true };
  }
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
  if (takeSnapshot) takePrepSnapshot(s);
  else s.prepSnapshot = null;
  emit(ctx, { type: 'dayStart', value: s.day });
  return { ok: true };
}
