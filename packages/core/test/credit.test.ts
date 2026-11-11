// 企業間の貸し借りと銀行の融資の上限（じろ2: 改修設計書04。オーナーの判断 2026-11-11）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  autoPlayDay,
  BALANCE,
  commitDay,
  createMarket,
  creditOwed,
  enterpriseValue,
  finishSync,
  joinMarket,
  jstMidnight,
  loanLimit,
  marketCredit,
  marketView,
  playerCompany,
  repaymentCapacity,
  retireCompany,
  runSync,
  settleCredits,
  startDay,
  verifyCommit,
  type GameState,
  type MarketState,
} from '../src';
import { clone, newGame } from './helpers';

const P0 = '2026-11-04';
const T0 = jstMidnight(P0) + 10 * 3_600_000;
const C = BALANCE.market.credit;
let tok = 0;

function market(): MarketState {
  const m = createMarket({ id: 'cr', name: 'cr', seed: 7, now: T0, settings: { aiFill: false, maxCompanies: 4 }, creator: { ownerId: 'u1', companyName: '貸し亭' } });
  expect(m.companies).toHaveLength(1);
  return m;
}

/** 貸し手（u1）と借り手（u2）の2社の市場 */
function withBorrower(): MarketState {
  const m = market();
  expect(joinMarket(m, 'u2', '借り軒', T0).ok).toBe(true);
  return m;
}

const lender = (m: MarketState) => playerCompany(m, 'u1')!;
const borrower = (m: MarketState) => playerCompany(m, 'u2')!;

function offer(m: MarketState, amount = 100_000, days = 3, dailyRate = 0.005) {
  return marketCredit(m, 'u1', { op: 'offer', borrowerId: borrower(m).id, amount, days, dailyRate }, T0);
}

/** 市場の日付を n 日進めて、0時の同期の貸し借りの処理をする */
function advance(m: MarketState, n: number, now = T0) {
  m.commonMarketDate += n;
  settleCredits(m, now, false);
}

describe('銀行の融資（5万円刻み・合計50万円まで・返済能力まで）', () => {
  it('額を選べる。刻みに合わない額・上限を超える額は断る。日報がなければ返済能力は最低の20万円', () => {
    const { s, ctx } = newGame(901);
    const lim = loanLimit(s);
    expect(lim.capacity).toBe(BALANCE.loan.minCapacity);
    expect(lim.max).toBe(200_000);
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: 70_000 }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: 250_000 }, ctx).ok).toBe(false);
    const before = s.money;
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: 150_000 }, ctx).ok).toBe(true);
    expect(s.money).toBe(before + 150_000);
    // 2件目も借りられる（残りの合計が上限まで）
    expect(loanLimit(s).max).toBe(50_000);
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: 50_000 }, ctx).ok).toBe(true);
    expect(loanLimit(s).max).toBe(0);
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: 50_000 }, ctx).reason).toContain('上限');
    expect(s.loans.map((l) => l.dailyPayment)).toEqual([Math.ceil(150_000 / 30), Math.ceil(50_000 / 30)]);
  });

  it('返済能力 = 直近7日の営業利益の平均 × 30日。50万円より上には借りられない', () => {
    const { s } = newGame(902);
    s.company.history = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, stores: [], netSales: 0, operatingProfit: 10_000, interest: 0, finalProfit: 10_000, served: 0, cashEnd: 0 }));
    expect(repaymentCapacity(s)).toBe(300_000);
    expect(loanLimit(s).max).toBe(300_000);
    s.company.history.forEach((r) => (r.operatingProfit = 100_000));
    expect(loanLimit(s).cap).toBe(BALANCE.loan.maxTotal);
    expect(loanLimit(s).max).toBe(500_000);
  });

  it('額を選ばない融資は前と同じ20万円。債務不履行の会社は借りられない', () => {
    const { s, ctx } = newGame(903);
    expect(applyAction(s, 'p1', { type: 'takeLoan' }, ctx).ok).toBe(true);
    expect(s.loans[0]!.principal).toBe(BALANCE.loan.amount);
    const b = newGame(904);
    b.s.creditBlocked = '債務不履行';
    expect(applyAction(b.s, 'p1', { type: 'takeLoan' }, b.ctx).ok).toBe(false);
  });

  it('端末から届いた日の融資も、銀行の決まりのとおりか確かめる（刻み・利率・上限）', () => {
    const { s } = newGame(905);
    const next = clone(s);
    next.loans.push({ id: 'L1', principal: 520_000, remaining: 520_000, dailyRate: BALANCE.loan.dailyRate, dailyPayment: Math.ceil(520_000 / 30), takenDay: s.day });
    next.money += 520_000;
    next.transactions.push({ id: 'T999', day: s.day, t: 0, type: 'loan', amount: 520_000, memo: '', key: 'loan:L1' });
    const v = verifyCommit(s, next, { gameDate: s.day, demand: {} });
    expect(v.reject.some((x) => x.includes('上限'))).toBe(true);
    const cheap = clone(s);
    cheap.loans.push({ id: 'L2', principal: 100_000, remaining: 100_000, dailyRate: 0, dailyPayment: 1, takenDay: s.day });
    cheap.money += 100_000;
    cheap.transactions.push({ id: 'T998', day: s.day, t: 0, type: 'loan', amount: 100_000, memo: '', key: 'loan:L2' });
    expect(verifyCommit(s, cheap, { gameDate: s.day, demand: {} }).reject.some((x) => x.includes('銀行の決まり'))).toBe(true);
  });
});

describe('企業間の貸し借り: 申し込みと承認', () => {
  it('申し込みの条件（金額の刻み・持っているお金・日数・利率・相手）を確かめる', () => {
    const m = withBorrower();
    const b = borrower(m).id;
    const bad = (amount: number, days: number, rate: number) => marketCredit(m, 'u1', { op: 'offer', borrowerId: b, amount, days, dailyRate: rate }, T0);
    expect(bad(5_000, 3, 0).ok).toBe(false);
    expect(bad(15_000, 3, 0).ok).toBe(false);
    expect(bad(lender(m).state.money + C.step, 3, 0).ok).toBe(false);
    expect(bad(100_000, 0, 0).ok).toBe(false);
    expect(bad(100_000, C.maxDays + 1, 0).ok).toBe(false);
    expect(bad(100_000, 3, 0.0055).ok).toBe(false);
    expect(bad(100_000, 3, 0.02).ok).toBe(false);
    expect(marketCredit(m, 'u1', { op: 'offer', borrowerId: lender(m).id, amount: 100_000, days: 3, dailyRate: 0 }, T0).ok).toBe(false);
    expect(bad(100_000, 3, 0).ok).toBe(true);
  });

  it('借り手が承認するとお金が動く。同じ申し込みを二度承認しても二重には動かない', () => {
    const m = withBorrower();
    const l0 = lender(m).state.money;
    const b0 = borrower(m).state.money;
    const o = offer(m);
    expect(o.ok).toBe(true);
    const id = o.ok ? o.credit.id : '';
    // 申し込みだけではお金は動かない
    expect(lender(m).state.money).toBe(l0);
    const a = marketCredit(m, 'u2', { op: 'accept', creditId: id }, T0);
    expect(a.ok).toBe(true);
    expect(lender(m).state.money).toBe(l0 - 100_000);
    expect(borrower(m).state.money).toBe(b0 + 100_000);
    expect(marketCredit(m, 'u2', { op: 'accept', creditId: id }, T0).ok).toBe(false);
    expect(borrower(m).state.money).toBe(b0 + 100_000);
    const cr = m.credits![0]!;
    expect(cr.status).toBe('active');
    expect(cr.dueDay).toBe(m.commonMarketDate + 3);
    // 貸している額は資産、借りている額は負債（企業価値は貸し借りで変わらない）
    expect(lender(m).state.companyCredit).toEqual({ owed: 0, lent: 100_000 });
    expect(borrower(m).state.companyCredit).toEqual({ owed: 100_000, lent: 0 });
    expect(borrower(m).state.transactions.some((t) => t.type === 'companyLoan' && t.amount === 100_000)).toBe(true);
    // 両方の会社から見える
    expect(marketView(m, 'u1', T0).mine!.credits!.map((x) => x.id)).toEqual([id]);
    expect(marketView(m, 'u2', T0).mine!.credits!.map((x) => x.id)).toEqual([id]);
  });

  it('断る・取り消す。ほかの会社あての申し込みは操作できない。返事がなければ72時間で期限切れ', () => {
    const m = withBorrower();
    const a = offer(m);
    const id = a.ok ? a.credit.id : '';
    expect(marketCredit(m, 'u1', { op: 'accept', creditId: id }, T0).ok).toBe(false);
    expect(marketCredit(m, 'u2', { op: 'cancel', creditId: id }, T0).ok).toBe(false);
    expect(marketCredit(m, 'u2', { op: 'decline', creditId: id }, T0).ok).toBe(true);
    expect(m.credits![0]!.status).toBe('declined');
    const b = offer(m);
    expect(marketCredit(m, 'u1', { op: 'cancel', creditId: b.ok ? b.credit.id : '' }, T0).ok).toBe(true);
    const c = offer(m);
    const late = T0 + C.offerTtlMs + 1;
    expect(marketCredit(m, 'u2', { op: 'accept', creditId: c.ok ? c.credit.id : '' }, late).ok).toBe(false);
    expect(m.credits!.find((x) => x.id === (c.ok ? c.credit.id : ''))!.status).toBe('expired');
  });

  it('貸し手が端末で営業中なら、承認しても営業が終わってからお金が動く', () => {
    const m = withBorrower();
    const o = offer(m);
    const L = lender(m);
    const t = startDay(m, 'u1', T0, `t${++tok}`, L.progress.stateVersion);
    expect(t.ok).toBe(true);
    const b0 = borrower(m).state.money;
    expect(marketCredit(m, 'u2', { op: 'accept', creditId: o.ok ? o.credit.id : '' }, T0).ok).toBe(true);
    expect(m.credits![0]!.status).toBe('approved');
    expect(borrower(m).state.money).toBe(b0);
    // 貸し手の日の確定（端末の状態はお金が動く前のまま。確かめに通る）
    const s: GameState = clone(L.state);
    if (!t.ok) return;
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    const lm = s.money;
    expect(commitDay(m, 'u1', T0 + 1000, t.ticket.token, s).ok).toBe(true);
    expect(m.credits![0]!.status).toBe('active');
    expect(lender(m).state.money).toBe(lm - 100_000);
    expect(borrower(m).state.money).toBe(b0 + 100_000);
  });
});

describe('企業間の貸し借り: 返す（自動・延滞・不履行・前倒し）', () => {
  function lent(amount = 100_000, days = 3, rate = 0.005) {
    const m = withBorrower();
    const o = offer(m, amount, days, rate);
    expect(marketCredit(m, 'u2', { op: 'accept', creditId: o.ok ? o.credit.id : '' }, T0).ok).toBe(true);
    return { m, cr: m.credits![0]! };
  }

  it('利息は市場の日付が進んだ日数分。期限の日の同期で借り手の現金から自動で返す', () => {
    const { m, cr } = lent(100_000, 3, 0.005);
    advance(m, 2);
    expect(cr.interestDue).toBe(1_000);
    expect(cr.status).toBe('active');
    const l0 = lender(m).state.money;
    const b0 = borrower(m).state.money;
    advance(m, 1);
    expect(cr.status).toBe('repaid');
    expect(cr.paid).toBe(101_500);
    expect(lender(m).state.money).toBe(l0 + 101_500);
    expect(borrower(m).state.money).toBe(b0 - 101_500);
    // もう一度同期しても二重に取らない
    advance(m, 0);
    expect(borrower(m).state.money).toBe(b0 - 101_500);
    expect(borrower(m).state.companyCredit).toBeUndefined();
  });

  it('前倒しで全部返せる（利息はその日まで）', () => {
    const { m, cr } = lent(100_000, 10, 0.005);
    advance(m, 1);
    const owed = creditOwed(cr);
    expect(owed).toBe(100_500);
    const l0 = lender(m).state.money;
    expect(marketCredit(m, 'u2', { op: 'repay', creditId: cr.id }, T0).ok).toBe(true);
    expect(cr.status).toBe('repaid');
    expect(lender(m).state.money).toBe(l0 + 100_500);
    expect(marketCredit(m, 'u2', { op: 'repay', creditId: cr.id }, T0).ok).toBe(false);
  });

  it('足りなければ延滞（利息を上乗せして毎日回収）。期限から14日で債務不履行（評判が下がり、新しく借りられない）', () => {
    const { m, cr } = lent(200_000, 2, 0);
    const B = borrower(m);
    B.state.money = 50_000;
    advance(m, 2);
    expect(cr.status).toBe('overdue');
    expect(cr.paid).toBe(50_000);
    expect(B.state.money).toBe(0);
    // 延滞の利息（無利子の契約でも上乗せ）
    advance(m, 1);
    expect(cr.interestDue).toBe(Math.round(150_000 * C.overdueRate));
    B.state.money = 10_000;
    advance(m, 1);
    expect(cr.paid).toBe(60_000);
    const rep = B.state.reputation;
    advance(m, C.defaultAfterDays);
    expect(cr.status).toBe('defaulted');
    expect(B.state.reputation).toBeCloseTo(Math.max(1, rep - C.defaultReputation), 5);
    expect(B.state.creditBlocked).toBeTruthy();
    expect(loanLimit(B.state).max).toBe(0);
    expect(offer(m).ok).toBe(false);
    expect(marketView(m, 'u1', T0).companies.find((c) => c.id === B.id)!.defaulted).toBe(true);
    // 返し終われば、また借りられる
    B.state.money = 1_000_000;
    advance(m, 1);
    expect(cr.status).toBe('repaid');
    expect(B.state.creditBlocked).toBeUndefined();
  });

  it('借り手が市場を抜けると、現金から返せるだけ返し、残りは貸し手の損', () => {
    const { m, cr } = lent(200_000, 10, 0);
    borrower(m).state.money = 80_000;
    const l0 = lender(m).state.money;
    expect(retireCompany(m, 'u2', T0).ok).toBe(true);
    expect(cr.status).toBe('writtenOff');
    expect(cr.paid).toBe(80_000);
    expect(cr.lost).toBe(120_000);
    expect(lender(m).state.money).toBe(l0 + 80_000);
    expect(lender(m).state.companyCredit).toBeUndefined();
  });

  it('市場の競争期間が終わると、返せるだけ返して終わる', () => {
    const { m, cr } = lent(100_000, 30, 0);
    m.commonMarketDate += 1;
    settleCredits(m, T0, true);
    expect(cr.status).toBe('repaid');
    expect(cr.lost).toBe(0);
  });

  it('0時の同期で市場の日付が進むと、貸し借りも進む（同期につながっている）', () => {
    const { m, cr } = lent(100_000, 1, 0);
    const c = lender(m);
    const t = startDay(m, 'u1', T0, `t${++tok}`, c.progress.stateVersion);
    if (!t.ok) throw new Error(t.reason);
    const s: GameState = clone(c.state);
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    expect(commitDay(m, 'u1', T0 + 1000, t.ticket.token, s).ok).toBe(true);
    const now = jstMidnight('2026-11-05') + 60_000;
    for (;;) {
      const r = runSync(m, now);
      if (r.status === 'more') continue;
      if (r.status === 'ranking') finishSync(m, now);
      break;
    }
    expect(m.commonMarketDate).toBe(1);
    expect(cr.status).toBe('repaid');
    expect(enterpriseValue(borrower(m).state)).toBeTypeOf('number');
  });
});
