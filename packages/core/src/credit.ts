// 企業間の貸し借り（じろ2: 改修設計書04。オーナーの判断「自動で返す形」2026-11-11）。市場のサーバーだけが動かす（サーバー権威）。
//
//   ・貸し手が、借り手（プレイヤーの会社）・金額・返す日数・日利（0 = 無利子）を決めて申し込む。借り手が承認すると、サーバーでお金を動かす
//   ・日数は市場の日付（全社がそろった日付）で数える。利息は0時の同期で、市場の日付が進んだ日数分を足す（前倒しの返済は日割り）
//   ・期限の日の同期で、借り手の現金から自動で返す。足りなければ延滞（利息に上乗せ）、毎日の同期で自動で回収する
//   ・期限から14日たっても返せなければ債務不履行: 借り手は新しく借りられない（銀行も）・評判が下がる
//   ・借り手はいつでも前倒しで全部返せる（その日までの利息）
//   ・借り手が抜けた・破産した・市場が終わったときは、現金から返せるだけ返し、残りは貸し手の損
//
// お金はすぐ動かす（オーナーの判断 2026-11-13「貸し借りは即反映」）。端末で営業中の会社のお金はサーバーでは動かせない
// （日の終わりに端末から届く状態で置き換わる）ので、「届け物」（CreditDelivery）にして端末へ届ける。営業中の端末は数秒ごとに
// 届け物を受け取り、自分の状態に入れて返事をする（出金はお金が足りるか確かめ、足りなければ断る）。返事が来たら続き（貸し出しの成立・
// 返済の完了）をすぐ行う。端末が受け取らないまま営業が終わったとき（日の確定・無効・同期）は、サーバーの状態に入れる。
// 同じ操作の送り直しはサーバーの操作の ID で一度だけ（MarketRoom）。契約の状態で二重に動かさない。

import { BALANCE } from './data/balance';
import type { GameState, Id, TxnType } from './types';
import type { MarketCompany, MarketState } from './market';
import { cash } from './sim/economy';
import { jstDateKey } from './jst';

export type CreditStatus =
  /** 返事待ち */
  | 'offered'
  /** 承認された（貸し手が端末で営業中のため、営業が終わったらお金を動かす） */
  | 'approved'
  | 'active'
  /** 期限を過ぎて返し終わっていない */
  | 'overdue'
  /** 期限から14日を過ぎた（債務不履行） */
  | 'defaulted'
  | 'repaid'
  | 'declined'
  | 'cancelled'
  | 'expired'
  /** 承認のときに貸し手のお金が足りなかった */
  | 'failed'
  /** 借り手が抜けた・破産した・市場が終わった（返せなかった分は貸し手の損） */
  | 'writtenOff';

export type CreditEventKind = 'offer' | 'approve' | 'start' | 'decline' | 'cancel' | 'expire' | 'fail' | 'collect' | 'overdue' | 'default' | 'repay' | 'writeOff';

export interface CreditEvent {
  /** サーバーの時刻（ミリ秒） */
  at: number;
  /** 市場の日付 */
  day: number;
  kind: CreditEventKind;
  amount?: number;
  text: string;
}

export interface CompanyCredit {
  id: string;
  lenderId: Id;
  borrowerId: Id;
  lenderName: string;
  borrowerName: string;
  principal: number;
  /** 日利（0 = 無利子） */
  dailyRate: number;
  /** 返す日数（市場の日付で数える） */
  days: number;
  status: CreditStatus;
  offeredAt: number;
  offeredDay: number;
  /** お金が動いた市場の日付と、返す期限の市場の日付 */
  startDay: number | null;
  dueDay: number | null;
  /** 元本の残り */
  remaining: number;
  /** まだ払っていない利息 */
  interestDue: number;
  /** 利息を数えた最後の市場の日付 */
  accruedTo: number;
  /** 返した合計（元本＋利息） */
  paid: number;
  /** 返せなかった分（貸し手の損） */
  lost: number;
  /** 端末で営業中に前倒しの返済を頼んだ（営業が終わったら返す） */
  repayRequested?: boolean;
  events: CreditEvent[];
}

/** 前の版の「営業が終わったら入れるお金」（読み込んだら届け物にする） */
export interface PendingCredit {
  companyId: Id;
  amount: number;
  type: TxnType;
  memo: string;
  key: string;
}

/**
 * 端末で営業中の会社への届け物（入金は正・出金は負）。id は取引の key と同じ（端末で二重に入れない）。
 * needsFunds: 出金で、端末のお金が足りるか確かめてから（足りなければ断る）。then: 端末が入れたあとの続き（lend:<契約> / repay:<契約>）
 */
export interface CreditDelivery {
  id: string;
  companyId: Id;
  amount: number;
  type: TxnType;
  memo: string;
  needsFunds?: boolean;
  status: 'pending' | 'applied' | 'refused';
  then?: string;
  at: number;
}

/** 端末に渡す届け物 */
export interface DeliveryView {
  id: string;
  amount: number;
  type: TxnType;
  memo: string;
  needsFunds?: boolean;
}

const C = () => BALANCE.market.credit;
const OPEN: CreditStatus[] = ['active', 'overdue', 'defaulted'];
const yen = (n: number) => `¥${Math.round(n).toLocaleString('ja-JP')}`;

export function creditsOf(m: MarketState): CompanyCredit[] {
  return (m.credits ??= []);
}

/** 届け物の一覧（前の版の「営業が終わったら入れるお金」は届け物にする） */
export function deliveriesOf(m: MarketState): CreditDelivery[] {
  const list = (m.creditDeliveries ??= []);
  if (m.pendingCredits && m.pendingCredits.length > 0) {
    for (const p of m.pendingCredits) {
      if (!list.some((d) => d.id === p.key)) list.push({ id: p.key, companyId: p.companyId, amount: p.amount, type: p.type, memo: p.memo, status: 'pending', at: 0 });
    }
    m.pendingCredits = [];
  }
  return list;
}

function deliver(m: MarketState, d: CreditDelivery): void {
  const list = deliveriesOf(m);
  if (!list.some((x) => x.id === d.id)) list.push(d);
}

/** その会社の端末がまだ受け取っていない届け物（端末に渡す形） */
export function inboxOf(m: MarketState, companyId: Id): DeliveryView[] {
  return deliveriesOf(m)
    .filter((d) => d.companyId === companyId && d.status === 'pending')
    .map((d) => ({ id: d.id, amount: d.amount, type: d.type, memo: d.memo, ...(d.needsFunds ? { needsFunds: true } : {}) }));
}

/** 返している最中の契約か */
export function creditOpen(c: CompanyCredit): boolean {
  return OPEN.includes(c.status);
}

/**
 * その会社が今借りている相手（返している最中の契約の貸し手）。借りられるのは同時に1社まで（オーナーの指示 2026-11-12。
 * 貸すのは何社にでもできる）。同じ相手からはもう一度借りられる
 */
export function currentLenderOf(m: MarketState, companyId: Id): { id: Id; name: string } | null {
  const cr = creditsOf(m).find((x) => x.borrowerId === companyId && creditOpen(x));
  return cr ? { id: cr.lenderId, name: cr.lenderName } : null;
}

/** 今返すと払う額（元本の残り＋その日までの利息） */
export function creditOwed(c: CompanyCredit): number {
  return c.remaining + c.interestDue;
}

function byId(m: MarketState, id: Id): MarketCompany | undefined {
  return m.companies.find((x) => x.id === id);
}

function event(m: MarketState, cr: CompanyCredit, now: number, kind: CreditEventKind, text: string, amount?: number): void {
  cr.events.push({ at: now, day: m.commonMarketDate, kind, text, ...(amount !== undefined ? { amount } : {}) });
  if (cr.events.length > 60) cr.events.splice(0, cr.events.length - 60);
}

function decide(m: MarketState, companyId: Id, text: string): void {
  m.decisions.push({ day: m.commonMarketDate, companyId, text });
  if (m.decisions.length > 300) m.decisions.splice(0, m.decisions.length - 300);
}

function touched(c: MarketCompany): void {
  c.progress.stateVersion += 1;
}

/** 端末で営業中か（営業中の会社のお金は動かさない） */
function busy(c: MarketCompany): boolean {
  return c.openDay !== null;
}

/** 会社の状態に、企業間の貸し借りの残り（借りている額・貸している額）を書く（企業価値と負債に入れる） */
export function refreshCreditBook(m: MarketState): void {
  const owed = new Map<string, number>();
  const lent = new Map<string, number>();
  for (const cr of creditsOf(m)) {
    if (!creditOpen(cr)) continue;
    owed.set(cr.borrowerId, (owed.get(cr.borrowerId) ?? 0) + creditOwed(cr));
    lent.set(cr.lenderId, (lent.get(cr.lenderId) ?? 0) + creditOwed(cr));
  }
  for (const c of m.companies) {
    const o = owed.get(c.id) ?? 0;
    const l = lent.get(c.id) ?? 0;
    const blocked = creditsOf(m).some((x) => x.borrowerId === c.id && x.status === 'defaulted') ? '企業間の借金を返さず債務不履行になっているため、新しく借りられません' : null;
    const prev = c.state.companyCredit;
    const changed = (prev?.owed ?? 0) !== o || (prev?.lent ?? 0) !== l || (c.state.creditBlocked ?? null) !== blocked;
    if (!changed) continue;
    if (busy(c)) continue; // 営業が終わったときに書く
    if (o === 0 && l === 0) delete c.state.companyCredit;
    else c.state.companyCredit = { owed: o, lent: l };
    if (blocked) c.state.creditBlocked = blocked;
    else delete c.state.creditBlocked;
    touched(c);
  }
}

/** お金を入れる（端末で営業中なら、端末へ届ける。すぐ届く） */
function payIn(m: MarketState, c: MarketCompany, amount: number, type: TxnType, memo: string, key: string, now = 0): void {
  if (amount <= 0) return;
  if (busy(c)) {
    deliver(m, { id: key, companyId: c.id, amount, type, memo, status: 'pending', at: now });
    return;
  }
  cash(c.state, type, amount, memo, key);
  touched(c);
}

/** お金を出す（営業中でないこと。足りなければ出せるだけ。出した額を返す） */
function payOut(c: MarketCompany, amount: number, type: TxnType, memo: string, key: string, all: boolean): number {
  if (amount <= 0 || busy(c)) return 0;
  const pay = all ? amount : Math.min(amount, Math.max(0, c.state.money));
  if (pay <= 0) return 0;
  if (!cash(c.state, type, -pay, memo, key)) return 0;
  touched(c);
  return pay;
}

/** 借り手の返済を、利息から先に当てる */
function applyPayment(cr: CompanyCredit, pay: number): void {
  const toInterest = Math.min(cr.interestDue, pay);
  cr.interestDue -= toInterest;
  cr.remaining -= pay - toInterest;
  cr.paid += pay;
}

/**
 * 営業が終わった会社（日の確定・無効・同期）の届け物を片付け、承認済みの貸し出しを動かす。
 * 端末が入れて確定した届け物（状態の appliedCredits にある）はそのまま。端末が入れないまま終わった届け物は、サーバーの状態に入れる
 * （端末が入れたと返事をしたあとに、その日が受け取られなかった出金は、相手にもう渡しているので足りなくても引く）
 */
export function flushCredits(m: MarketState, c: MarketCompany, now: number): void {
  if (busy(c)) return;
  const list = deliveriesOf(m);
  const mine = list.filter((d) => d.companyId === c.id);
  if (mine.length > 0) {
    m.creditDeliveries = list.filter((d) => d.companyId !== c.id);
    const onState = new Set(c.state.appliedCredits ?? []);
    for (const d of mine) {
      if (d.status === 'refused') continue;
      if (onState.has(d.id)) {
        // 端末が入れて、その日が受け取られた（返事が届いていなければ、ここで続きを行う）
        if (d.status === 'pending') {
          d.status = 'applied';
          runThen(m, d, now);
        }
        continue;
      }
      if (d.amount > 0) {
        cash(c.state, d.type, d.amount, d.memo, d.id);
        touched(c);
        if (d.status === 'pending') {
          d.status = 'applied';
          runThen(m, d, now);
        }
        continue;
      }
      if (d.status === 'applied') {
        cash(c.state, d.type, d.amount, d.memo, d.id, true);
        touched(c);
        continue;
      }
      // まだ端末が受け取っていない出金: 今のお金で確かめる
      if (!d.needsFunds || c.state.money >= -d.amount) {
        cash(c.state, d.type, d.amount, d.memo, d.id, true);
        touched(c);
        d.status = 'applied';
      } else d.status = 'refused';
      runThen(m, d, now);
    }
    if (c.state.appliedCredits) {
      const left = new Set((m.creditDeliveries ?? []).map((d) => d.id));
      c.state.appliedCredits = c.state.appliedCredits.filter((k) => left.has(k));
      if (c.state.appliedCredits.length === 0) delete c.state.appliedCredits;
    }
  }
  for (const cr of creditsOf(m)) if (cr.status === 'approved' && cr.lenderId === c.id) startCredit(m, cr, now);
  // 前の版で営業中に頼まれた前倒しの返済
  for (const cr of creditsOf(m)) {
    if (!cr.repayRequested || cr.borrowerId !== c.id) continue;
    if (!creditOpen(cr)) {
      delete cr.repayRequested;
      continue;
    }
    if (deliveriesOf(m).some((d) => d.then === `repay:${cr.id}`)) continue;
    if (c.state.money >= creditOwed(cr)) repayNow(m, cr, c, now);
    else {
      delete cr.repayRequested;
      event(m, cr, now, 'repay', `お金が足りず、前倒しの返済はできませんでした（${yen(creditOwed(cr))} が要る）`);
    }
  }
  refreshCreditBook(m);
}

/**
 * 端末からの返事（届け物を入れた・断った）。入れた出金は続き（貸し出しの成立・前倒しの返済の完了）をすぐ行う。
 * 同じ返事の送り直しは何もしない
 */
export function ackDeliveries(m: MarketState, c: MarketCompany, acks: { id: string; applied: boolean }[], now: number): void {
  for (const a of acks) {
    const d = deliveriesOf(m).find((x) => x.id === a.id && x.companyId === c.id);
    if (!d || d.status !== 'pending') continue;
    // 入金は断れない（入れたことにする）
    d.status = a.applied || d.amount > 0 ? 'applied' : 'refused';
    runThen(m, d, now);
  }
  refreshCreditBook(m);
}

/** 届け物の続き: 貸し手が貸すお金を出した → 借り手に入れて契約が始まる。借り手が返すお金を出した → 貸し手に入れて返し終わる */
function runThen(m: MarketState, d: CreditDelivery, now: number): void {
  if (!d.then) return;
  const [kind, id] = d.then.split(':');
  const cr = creditsOf(m).find((x) => x.id === id);
  if (!cr) return;
  if (kind === 'lend') {
    if (cr.status !== 'approved') return;
    if (d.status === 'applied') activate(m, cr, now);
    else {
      cr.status = 'failed';
      event(m, cr, now, 'fail', '貸し手のお金が足りず、貸し出せませんでした');
      decide(m, cr.lenderId, `${cr.borrowerName}への貸し出し ${yen(cr.principal)} は、お金が足りず取りやめになりました`);
    }
    return;
  }
  if (kind === 'repay') {
    delete cr.repayRequested;
    if (!creditOpen(cr)) return;
    if (d.status !== 'applied') {
      event(m, cr, now, 'repay', `お金が足りず、前倒しの返済はできませんでした（${yen(-d.amount)} が要る）`);
      return;
    }
    const paid = -d.amount;
    applyPayment(cr, paid);
    const lender = byId(m, cr.lenderId);
    if (lender) payIn(m, lender, paid, 'companyCollect', `${cr.borrowerName}からの返済（前倒し）`, `${d.id}:in`, now);
    cr.status = 'repaid';
    event(m, cr, now, 'repay', `借り手が前倒しで全部返しました（${yen(paid)}）`, paid);
    decide(m, cr.borrowerId, `${cr.borrowerName}が${cr.lenderName}への借金を前倒しで返しました（${yen(paid)}）`);
  }
}

/**
 * 承認された貸し出しのお金を動かす。貸し手が端末で営業中なら、貸すお金を出す届け物を貸し手の端末へ送る（すぐ届く。
 * お金が足りれば成立、足りなければ不成立）。営業中でなければ、その場で貸し手から引き、借り手に入れる
 */
function startCredit(m: MarketState, cr: CompanyCredit, now: number): void {
  const lender = byId(m, cr.lenderId);
  const borrower = byId(m, cr.borrowerId);
  if (!lender || !borrower) return;
  if (borrower.status !== 'active' || lender.status !== 'active') {
    cr.status = 'cancelled';
    event(m, cr, now, 'cancel', '相手の会社が市場にいないため取り消しました');
    return;
  }
  const key = `credit:${cr.id}:lend`;
  if (busy(lender)) {
    if (deliveriesOf(m).some((d) => d.id === key)) return;
    deliver(m, { id: key, companyId: lender.id, amount: -cr.principal, type: 'companyLend', memo: `${borrower.name}への貸し出し`, needsFunds: true, status: 'pending', then: `lend:${cr.id}`, at: now });
    return;
  }
  if (lender.state.money < cr.principal) {
    cr.status = 'failed';
    event(m, cr, now, 'fail', `貸し手のお金（${yen(lender.state.money)}）が足りず、貸し出せませんでした`);
    decide(m, lender.id, `${borrower.name}への貸し出し ${yen(cr.principal)} は、お金が足りず取りやめになりました`);
    return;
  }
  payOut(lender, cr.principal, 'companyLend', `${borrower.name}への貸し出し`, key, true);
  activate(m, cr, now);
}

/** 貸し手からお金が出た: 借り手に入れて、返す期限を決める */
function activate(m: MarketState, cr: CompanyCredit, now: number): void {
  const lender = byId(m, cr.lenderId);
  const borrower = byId(m, cr.borrowerId);
  if (!lender || !borrower) return;
  payIn(m, borrower, cr.principal, 'companyLoan', `${lender.name}からの借入（${cr.days}日・日利${(cr.dailyRate * 100).toFixed(1)}%）`, `credit:${cr.id}:loan`, now);
  cr.status = 'active';
  cr.startDay = m.commonMarketDate;
  cr.dueDay = m.commonMarketDate + cr.days;
  cr.accruedTo = m.commonMarketDate;
  event(m, cr, now, 'start', `${yen(cr.principal)} を貸し出しました（期限は市場の${cr.dueDay}日目）`, cr.principal);
  decide(m, lender.id, `${lender.name}が${borrower.name}に ${yen(cr.principal)} を貸しました（${cr.days}日・日利${(cr.dailyRate * 100).toFixed(1)}%）`);
}

// ───────────────────────── 操作（プレイヤー） ─────────────────────────

export interface CreditOfferInput {
  borrowerId: Id;
  amount: number;
  days: number;
  /** 日利（0〜0.01。0.001 刻み） */
  dailyRate: number;
}

export type CreditOp =
  | ({ op: 'offer' } & CreditOfferInput)
  | { op: 'accept'; creditId: string }
  | { op: 'decline'; creditId: string }
  | { op: 'cancel'; creditId: string }
  | { op: 'repay'; creditId: string };

export interface CreditEnv {
  /** 操作した人の会社（プレイヤー企業。サーバーが決める） */
  me: MarketCompany;
  now: number;
  /** 0時の同期が済んでいない */
  syncing: boolean;
  /** 競争期間が終わった */
  ended: boolean;
}

export type CreditResult = { ok: true; credit: CompanyCredit } | { ok: false; reason: string };

function rateOk(r: number): boolean {
  if (!Number.isFinite(r) || r < 0 || r > C().maxDailyRate + 1e-12) return false;
  const k = r / C().rateStep;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/** 貸し借りの操作の問題（なければ null） */
export function creditOp(m: MarketState, env: CreditEnv, op: CreditOp): CreditResult {
  const { me, now } = env;
  if (me.status !== 'active') return { ok: false, reason: '営業している会社だけが使えます' };
  if (env.syncing) return { ok: false, reason: '0時の計算中です。終わるまでお待ちください' };
  // 端末で営業中でも申し込み・承認・断る・取り消すはできる（営業中の経営メニューからも。オーナーの指示 2026-11-11）。
  // 営業中の会社のお金は、営業が終わったときに動かす
  expireOffers(m, now);
  if (op.op === 'offer') {
    if (env.ended) return { ok: false, reason: 'この市場の競争期間は終わっています' };
    const to = byId(m, op.borrowerId);
    if (!to || to.id === me.id) return { ok: false, reason: '貸す相手を選んでください' };
    if (to.kind !== 'player' || to.status !== 'active') return { ok: false, reason: '貸せるのは、この市場で営業しているプレイヤーの会社だけです' };
    if (to.state.creditBlocked) return { ok: false, reason: '相手は債務不履行のため、新しく借りられません' };
    const toLender = currentLenderOf(m, to.id);
    if (toLender && toLender.id !== me.id) return { ok: false, reason: `相手は${toLender.name}から借りて返している最中です（借りられるのは同時に1社まで。返し終わってから申し込んでください）` };
    const amt = op.amount;
    if (!Number.isInteger(amt) || amt < C().minAmount || amt > C().maxAmount || amt % C().step !== 0) {
      return { ok: false, reason: `金額は ${yen(C().minAmount)}〜${yen(C().maxAmount)}（${yen(C().step)}刻み）です` };
    }
    if (amt > me.state.money) return { ok: false, reason: `お金が足りません（今 ${yen(me.state.money)}）` };
    if (!Number.isInteger(op.days) || op.days < C().minDays || op.days > C().maxDays) return { ok: false, reason: `返す日数は${C().minDays}〜${C().maxDays}日です` };
    if (!rateOk(op.dailyRate)) return { ok: false, reason: `日利は0〜${(C().maxDailyRate * 100).toFixed(1)}%（0.1%刻み）です` };
    const open = creditsOf(m).filter((x) => x.lenderId === me.id && (x.status === 'offered' || x.status === 'approved')).length;
    if (open >= C().maxOpenOffers) return { ok: false, reason: `返事待ちの申し込みは${C().maxOpenOffers}件までです` };
    m.creditSeq = (m.creditSeq ?? 0) + 1;
    const cr: CompanyCredit = {
      id: `cr${m.creditSeq}`,
      lenderId: me.id,
      borrowerId: to.id,
      lenderName: me.name,
      borrowerName: to.name,
      principal: amt,
      dailyRate: Math.round(op.dailyRate * 1000) / 1000,
      days: op.days,
      status: 'offered',
      offeredAt: now,
      offeredDay: m.commonMarketDate,
      startDay: null,
      dueDay: null,
      remaining: amt,
      interestDue: 0,
      accruedTo: m.commonMarketDate,
      paid: 0,
      lost: 0,
      events: [],
    };
    event(m, cr, now, 'offer', `${me.name}が${to.name}に ${yen(amt)} の貸し出しを申し込みました（${op.days}日・${cr.dailyRate === 0 ? '無利子' : `日利${(cr.dailyRate * 100).toFixed(1)}%`}）`, amt);
    creditsOf(m).push(cr);
    trimCredits(m);
    return { ok: true, credit: cr };
  }
  const cr = creditsOf(m).find((x) => x.id === op.creditId);
  if (!cr) return { ok: false, reason: '契約が見つかりません' };
  if (op.op === 'cancel') {
    if (cr.lenderId !== me.id) return { ok: false, reason: '自分の申し込みだけ取り消せます' };
    if (cr.status !== 'offered') return { ok: false, reason: '返事待ちの申し込みだけ取り消せます' };
    cr.status = 'cancelled';
    event(m, cr, now, 'cancel', '貸し手が申し込みを取り消しました');
    return { ok: true, credit: cr };
  }
  if (cr.borrowerId !== me.id) return { ok: false, reason: '自分あての契約だけ操作できます' };
  if (op.op === 'decline' || op.op === 'accept') {
    if (cr.status !== 'offered') return { ok: false, reason: cr.status === 'expired' ? '申し込みの期限が切れています' : 'もう返事をした申し込みです' };
    if (op.op === 'decline') {
      cr.status = 'declined';
      event(m, cr, now, 'decline', '借り手が断りました');
      return { ok: true, credit: cr };
    }
    if (env.ended) return { ok: false, reason: 'この市場の競争期間は終わっています' };
    if (me.state.creditBlocked) return { ok: false, reason: me.state.creditBlocked };
    const cur = currentLenderOf(m, me.id);
    if (cur && cur.id !== cr.lenderId) return { ok: false, reason: `借りられるのは同時に1社までです（今は${cur.name}から借りています。返し終わってから承認してください）` };
    const lender = byId(m, cr.lenderId);
    if (!lender || lender.status !== 'active') {
      cr.status = 'cancelled';
      event(m, cr, now, 'cancel', '貸し手が市場にいないため取り消しました');
      return { ok: false, reason: '貸し手が市場にいません' };
    }
    cr.status = 'approved';
    event(m, cr, now, 'approve', '借り手が承認しました');
    startCredit(m, cr, now);
    refreshCreditBook(m);
    return { ok: true, credit: cr };
  }
  // 前倒しで全部返す（その日までの利息）
  if (!creditOpen(cr)) return { ok: false, reason: '返している最中の契約ではありません' };
  const owed = creditOwed(cr);
  if (busy(me)) {
    // 端末で営業中: 返すお金を出す届け物を自分の端末へ送る（すぐ届く。お金が足りれば返し終わる）
    if (deliveriesOf(m).some((d) => d.then === `repay:${cr.id}` && d.status === 'pending')) return { ok: true, credit: cr };
    cr.repayRequested = true;
    deliver(m, { id: `credit:${cr.id}:early:${cr.paid}:${cr.events.length}`, companyId: me.id, amount: -owed, type: 'companyRepay', memo: `${cr.lenderName}への返済（前倒し）`, needsFunds: true, status: 'pending', then: `repay:${cr.id}`, at: now });
    event(m, cr, now, 'repay', `借り手が前倒しで返します（${yen(owed)}）`);
    return { ok: true, credit: cr };
  }
  if (me.state.money < owed) return { ok: false, reason: `全部返すには ${yen(owed)} が要ります（今 ${yen(me.state.money)}）` };
  repayNow(m, cr, me, now);
  return { ok: true, credit: cr };
}

/** 前倒しで全部返す（借り手が営業中でないこと。お金が足りること） */
function repayNow(m: MarketState, cr: CompanyCredit, me: MarketCompany, now: number): boolean {
  const owed = creditOwed(cr);
  const lender = byId(m, cr.lenderId)!;
  const paid = payOut(me, owed, 'companyRepay', `${cr.lenderName}への返済（前倒し）`, `credit:${cr.id}:early:${cr.paid}`, true);
  if (paid < owed) return false;
  applyPayment(cr, paid);
  payIn(m, lender, paid, 'companyCollect', `${cr.borrowerName}からの返済（前倒し）`, `credit:${cr.id}:earlyIn:${cr.paid}`, now);
  cr.status = 'repaid';
  delete cr.repayRequested;
  event(m, cr, now, 'repay', `借り手が前倒しで全部返しました（${yen(paid)}）`, paid);
  decide(m, me.id, `${me.name}が${cr.lenderName}への借金を前倒しで返しました（${yen(paid)}）`);
  refreshCreditBook(m);
  return true;
}

/** 返事のない申し込みを取り消す（72時間） */
export function expireOffers(m: MarketState, now: number): void {
  for (const cr of creditsOf(m)) {
    if (cr.status === 'offered' && now > cr.offeredAt + C().offerTtlMs) {
      cr.status = 'expired';
      event(m, cr, now, 'expire', '返事がないまま期限が切れました');
    }
  }
}

function trimCredits(m: MarketState): void {
  const list = creditsOf(m);
  const over = list.length - C().keep;
  if (over <= 0) return;
  let drop = over;
  m.credits = list.filter((cr) => {
    if (drop > 0 && !creditOpen(cr) && cr.status !== 'offered' && cr.status !== 'approved') {
      drop -= 1;
      return false;
    }
    return true;
  });
}

// ───────────────────────── 0時の同期・退出 ─────────────────────────

/** 返せるだけ返し、残りは貸し手の損にする */
function writeOff(m: MarketState, cr: CompanyCredit, now: number, why: string): void {
  const borrower = byId(m, cr.borrowerId);
  const lender = byId(m, cr.lenderId);
  const owed = creditOwed(cr);
  let paid = 0;
  if (borrower && !busy(borrower)) paid = payOut(borrower, owed, 'companyRepay', `${cr.lenderName}への返済（${why}）`, `credit:${cr.id}:wo`, false);
  if (paid > 0) {
    applyPayment(cr, paid);
    if (lender) payIn(m, lender, paid, 'companyCollect', `${cr.borrowerName}からの返済（${why}）`, `credit:${cr.id}:woIn`);
  }
  cr.lost = creditOwed(cr);
  cr.remaining = 0;
  cr.interestDue = 0;
  cr.status = cr.lost > 0 ? 'writtenOff' : 'repaid';
  event(m, cr, now, 'writeOff', `${why}ため、${yen(paid)} を返して終わりました${cr.lost > 0 ? `（返せなかった ${yen(cr.lost)} は貸し手の損）` : ''}`, paid);
  if (lender) decide(m, lender.id, `${cr.borrowerName}への貸し出しは${why}ため終わりました（回収 ${yen(paid)}・損 ${yen(cr.lost)}）`);
}

/** 会社が市場を抜けた・破産した（借りている契約は返せるだけ返して終わり。申し込みは取り消し） */
export function exitCredits(m: MarketState, c: MarketCompany, now: number, why: string): void {
  for (const cr of creditsOf(m)) {
    if ((cr.status === 'offered' || cr.status === 'approved') && (cr.lenderId === c.id || cr.borrowerId === c.id)) {
      cr.status = 'cancelled';
      event(m, cr, now, 'cancel', `${c.name}が${why}ため取り消しました`);
    } else if (creditOpen(cr) && cr.borrowerId === c.id) {
      writeOff(m, cr, now, `借り手が${why}`);
    }
  }
  refreshCreditBook(m);
}

/**
 * 0時の同期で市場の日付が進んだあと: 利息を足し、期限が来た契約を借り手の現金から返す（足りなければ延滞・不履行）。
 * 抜けた・破産した借り手、終わった市場の契約は返せるだけ返して終える。何度呼んでも同じ日の利息は一度だけ
 */
export function settleCredits(m: MarketState, now: number, ended: boolean): void {
  const day = m.commonMarketDate;
  expireOffers(m, now);
  for (const c of m.companies) flushCredits(m, c, now);
  for (const cr of creditsOf(m)) {
    if (ended && (cr.status === 'offered' || cr.status === 'approved')) {
      cr.status = 'cancelled';
      event(m, cr, now, 'cancel', '市場の競争期間が終わったため取り消しました');
      continue;
    }
    if (!creditOpen(cr)) continue;
    const borrower = byId(m, cr.borrowerId);
    const lender = byId(m, cr.lenderId);
    // 利息（期限を過ぎた日は延滞の上乗せ）
    for (let d = cr.accruedTo + 1; d <= day; d++) {
      const rate = cr.dailyRate + (cr.dueDay !== null && d > cr.dueDay ? C().overdueRate : 0);
      cr.interestDue += Math.round(cr.remaining * rate);
    }
    cr.accruedTo = Math.max(cr.accruedTo, day);
    if (!borrower || borrower.status !== 'active') {
      writeOff(m, cr, now, borrower?.status === 'bankrupt' ? '借り手が破産した' : '借り手が市場を抜けた');
      continue;
    }
    if (ended) {
      writeOff(m, cr, now, '市場の競争期間が終わった');
      continue;
    }
    if (cr.dueDay === null || day < cr.dueDay) continue;
    // 期限が来た: 借り手の現金から返す
    const owed = creditOwed(cr);
    const paid = payOut(borrower, owed, 'companyRepay', `${cr.lenderName}への返済（自動）`, `credit:${cr.id}:auto:${day}`, false);
    if (paid > 0) {
      applyPayment(cr, paid);
      if (lender) payIn(m, lender, paid, 'companyCollect', `${cr.borrowerName}からの返済（自動）`, `credit:${cr.id}:autoIn:${day}`);
    }
    if (creditOwed(cr) <= 0) {
      cr.status = 'repaid';
      event(m, cr, now, 'collect', `期限の日に自動で返し終わりました（${yen(paid)}）`, paid);
      continue;
    }
    if (paid > 0) event(m, cr, now, 'collect', `自動で ${yen(paid)} を回収しました（残り ${yen(creditOwed(cr))}）`, paid);
    if (cr.status === 'active') {
      cr.status = 'overdue';
      event(m, cr, now, 'overdue', `期限までに返し終わらず延滞になりました（残り ${yen(creditOwed(cr))}。利息に日${(C().overdueRate * 100).toFixed(1)}%を上乗せし、毎日自動で回収します）`);
      decide(m, borrower.id, `${borrower.name}は${cr.lenderName}への借金が延滞しています（残り ${yen(creditOwed(cr))}）`);
    }
    if (cr.status === 'overdue' && day >= cr.dueDay + C().defaultAfterDays) {
      cr.status = 'defaulted';
      event(m, cr, now, 'default', `期限から${C().defaultAfterDays}日たっても返せず、債務不履行になりました（新しく借りられない・評判が下がる）`);
      decide(m, borrower.id, `${borrower.name}は債務不履行になりました（評判 −${C().defaultReputation}）`);
      lowerReputation(borrower.state, C().defaultReputation);
      touched(borrower);
    }
  }
  refreshCreditBook(m);
}

/** 会社の全部の店の評判を下げる */
function lowerReputation(s: GameState, by: number): void {
  s.reputation = Math.max(1, s.reputation - by);
  for (const entry of s.company.stores) if (entry.snapshot) entry.snapshot.reputation = Math.max(1, entry.snapshot.reputation - by);
}

/** 見ている会社にかかわる契約（貸し手・借り手のどちらか）。新しい順 */
export function creditsFor(m: MarketState, companyId: Id): CompanyCredit[] {
  return creditsOf(m)
    .filter((cr) => cr.lenderId === companyId || cr.borrowerId === companyId)
    .slice()
    .reverse()
    .slice(0, 50);
}

/** 申し込みの期限（表示用） */
export function offerExpiresAt(cr: CompanyCredit): number {
  return cr.offeredAt + C().offerTtlMs;
}

/** 申し込みの期限の日付（JST。表示用） */
export function offerExpiresDate(cr: CompanyCredit): string {
  return jstDateKey(offerExpiresAt(cr));
}

// ───────────────────────── 端末（営業中の会社） ─────────────────────────

/**
 * 届け物を端末の状態に入れる（同じものは二度入れない）。出金で needsFunds のものは、お金が足りなければ断る。
 * 返事（入れた・断った）を返す。入れたものは appliedCredits に残す（サーバーが日の確定のときに確かめる）
 */
export function applyDeliveries(s: GameState, items: DeliveryView[]): { id: string; applied: boolean; amount: number; memo: string }[] {
  const out: { id: string; applied: boolean; amount: number; memo: string }[] = [];
  for (const it of items) {
    if (!it || typeof it.id !== 'string' || !Number.isFinite(it.amount)) continue;
    const done = (s.appliedCredits ?? []).includes(it.id) || s.transactions.some((t) => t.key === it.id);
    if (done) {
      out.push({ id: it.id, applied: true, amount: 0, memo: it.memo });
      continue;
    }
    if (it.amount < 0 && it.needsFunds && s.money < -it.amount) {
      out.push({ id: it.id, applied: false, amount: it.amount, memo: it.memo });
      continue;
    }
    cash(s, it.type, it.amount, it.memo, it.id, true);
    s.appliedCredits = [...(s.appliedCredits ?? []), it.id].slice(-100);
    out.push({ id: it.id, applied: true, amount: it.amount, memo: it.memo });
  }
  return out;
}
