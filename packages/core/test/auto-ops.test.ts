// 自動経営の方針と自動営業（共通市場の仕様書 4.2〜4.5・12章 10〜13）。
// 自動営業は「店長の営業」（1日単位の計算）で、手動（細かいシミュレーション）と同じ需要・容量・価格・在庫・給与・家賃・借入の式を使う。
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  addDays,
  applyAction,
  autoPlayDay,
  BALANCE,
  commitDay,
  companyPolicyOf,
  createMarket,
  DEFAULT_COMPANY_POLICY,
  expectedAttendance,
  finishSync,
  jstMidnight,
  playerCompany,
  runManagerDay,
  runSync,
  setStorePolicy,
  startDay,
  storeReport,
  type GameState,
} from '../src';
import { addBot, clone, newGame } from './helpers';

/** 店主が回す1店舗の会社（市場の企業と同じ形） */
function ownerRun(seed: number) {
  const { s, ctx } = newGame(seed);
  s.tutorial = null;
  s.company.ownerStoreId = s.company.activeStoreId;
  return { s, ctx };
}

describe('自動経営の方針（会社全体と店ごと。仕様書 4.3・4.5）', () => {
  it('初期値は保守的: 借入も拡張もしない。赤字が3日続いたら広告と短期バイトを止める', () => {
    const { s, ctx } = newGame(1);
    expect(companyPolicyOf(s)).toEqual(DEFAULT_COMPANY_POLICY);
    expect(DEFAULT_COMPANY_POLICY).toEqual({ allowLoan: false, allowExpansion: false, deficit: 'cutCosts' });
    expect(applyAction(s, 'p1', { type: 'setCompanyPolicy', policy: { allowLoan: true } }, ctx).ok).toBe(true);
    expect(companyPolicyOf(s).allowLoan).toBe(true);
    expect(applyAction(s, 'p1', { type: 'setCompanyPolicy', policy: { deficit: 'oops' as never } }, ctx).ok).toBe(false);
    // 店ごとの方針: 在庫の安全基準と短期バイト
    expect(setStorePolicy(s, activeStore(s).id, { safetyStock: 1.5, tempWhenShort: true }).ok).toBe(true);
    expect(setStorePolicy(s, activeStore(s).id, { safetyStock: 5 }).ok).toBe(false);
  });

  it('借入を許可しないと、期限を過ぎた未払金を払えない自動営業の日に破産する。許可すると緊急の融資を受ける', () => {
    const mk = () => {
      const { s } = ownerRun(2);
      s.money = 0;
      s.arrears.push({ id: 'a1', amount: 120_000, reason: 'テスト', sinceDay: 0, dueDay: 0 });
      return s;
    };
    const a = mk();
    expect(autoPlayDay(a, a.day, {}, { allowLoan: companyPolicyOf(a).allowLoan }).bankrupt).toBe(true);
    const b = mk();
    b.company.policy = { ...DEFAULT_COMPANY_POLICY, allowLoan: true };
    const r = autoPlayDay(b, b.day, {}, { allowLoan: companyPolicyOf(b).allowLoan });
    expect(r.loan).toBe(true);
    expect(r.bankrupt).toBe(false);
    expect(b.loans.length).toBeGreaterThan(0);
  });

  it('赤字が3日続くと、方針の広告を出さない（赤字のときの対応 = 経費を減らす）', () => {
    const { s, ctx } = ownerRun(3);
    setStorePolicy(s, activeStore(s).id, { adBudget: 3000 });
    const ok = runManagerDay(clone(s), activeStore(s), s.day, ctx);
    expect(ok.ads).toBe(3000);
    s.company.history = [1, 2, 3].map((d) => ({ day: d, stores: [], netSales: 0, operatingProfit: -5000, interest: 0, finalProfit: -5000, served: 0, cashEnd: 0 }));
    const cut = runManagerDay(clone(s), activeStore(s), s.day, ctx);
    expect(cut.ads ?? 0).toBe(0);
    s.company.policy = { ...DEFAULT_COMPANY_POLICY, deficit: 'none' };
    expect(runManagerDay(clone(s), activeStore(s), s.day, ctx).ads).toBe(3000);
  });
});

describe('自動営業の中の出来事（12章 10〜13）', () => {
  it('10. 在庫切れ: お金も在庫もない日は仕入れられず、出せる杯数が減る（払えない家賃などは未払金になる）', () => {
    const { s, ctx } = ownerRun(10);
    const full = runManagerDay(clone(s), activeStore(s), s.day, ctx);
    s.money = 0;
    s.inventory = [];
    s.deliveries = [];
    const r = runManagerDay(s, activeStore(s), s.day, ctx);
    expect(r.served).toBeLessThan(full.served);
    expect(r.served).toBe(0);
    expect(s.arrears.length).toBeGreaterThan(0);
  });

  it('11. 従業員不足: 当日欠勤・遅刻は見込みで人手を減らし、方針で許可すれば短期バイトを1人呼ぶ（給与は1.5倍）', () => {
    const { s, ctx } = ownerRun(11);
    const e = addBot(s, 'cook', 0.65, 6000);
    e.profile.diligence = 1;
    const steady = expectedAttendance(e);
    e.profile.diligence = 0.2;
    expect(expectedAttendance(e)).toBeLessThan(steady);
    // 席が多く、人手が足りない店（12席・店主だけ）
    const { s: t } = ownerRun(12);
    t.career.unlocked.push('hiring');
    t.reputation = 4.5;
    const base = runManagerDay(clone(t), activeStore(t), t.day, ctx);
    setStorePolicy(t, activeStore(t).id, { tempWhenShort: true });
    const withTemp = runManagerDay(clone(t), activeStore(t), t.day, ctx);
    expect(withTemp.wages).toBeGreaterThan(base.wages);
    expect(withTemp.served).toBeGreaterThanOrEqual(base.served);
    void s;
  });

  it('12. 設備の修理: 杯数に応じた修理費がかかり、1日の上限を超えない。定期メンテをしないと高くなる', () => {
    const { s, ctx } = ownerRun(13);
    const a = runManagerDay(clone(s), activeStore(s), s.day, ctx);
    expect(a.repairs).toBeGreaterThan(0);
    setStorePolicy(s, activeStore(s).id, { maintenance: false });
    const b = runManagerDay(clone(s), activeStore(s), s.day, ctx);
    expect(b.repairs).toBeGreaterThan(a.repairs);
    setStorePolicy(s, activeStore(s).id, { repairCap: 500 });
    expect(runManagerDay(clone(s), activeStore(s), s.day, ctx).repairs).toBeLessThanOrEqual(500);
  });

  it('13. 複数店舗: 自動営業の日に全店が営業し、会社の日報は店の合計', () => {
    const { s, ctx } = newGame(14);
    s.tutorial = null;
    const cook = addBot(s, 'cook', 0.7, 6000);
    s.money = 3_000_000;
    s.career.unlocked.push('stage2', 'hiring');
    s.phase = 'closed';
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    s.reputation = 4.2;
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    branch.snapshot!.closedForConstruction = 0;
    branch.openedDay = s.day - 1;
    s.company.stores[0]!.openedDay = s.day - 1;
    s.company.ownerStoreId = s.company.activeStoreId;
    s.closedForConstruction = 0;
    const day = s.day;
    autoPlayDay(s, day, {}, { allowLoan: false });
    const home = storeReport(s, s.company.stores[0]!, day)!;
    const br = storeReport(s, branch, day)!;
    expect(home.managed).toBe('manager');
    expect(br.managed).toBe('manager');
    expect(br.served).toBeGreaterThan(0);
    const cr = s.company.history.find((x) => x.day === day)!;
    expect(cr.netSales).toBe((home.netSales ?? 0) + (br.netSales ?? 0));
    expect(cr.operatingProfit).toBe(home.operatingProfit + br.operatingProfit);
  });
});

describe('拡張を許可した会社は、自動営業の日に本店を拡張する（AI 企業と同じ条件）', () => {
  it('資金に余裕があって方針で許可していれば、0時の同期で拡張する。許可しなければしない', () => {
    const run = (allow: boolean) => {
      const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;
      const m = createMarket({ id: 'm', name: 'x', seed: 8, now: T0, settings: { aiFill: false, maxCompanies: 2 }, creator: { ownerId: 'u1', companyName: 'a' } });
      const c = playerCompany(m, 'u1')!;
      c.state.money = 5_000_000;
      c.state.career.unlocked.push('stage2');
      c.state.company.policy = { ...DEFAULT_COMPANY_POLICY, allowExpansion: allow };
      // もう1社（人）が5日進む → この会社は自動営業で追いつく
      const join = { ok: true };
      void join;
      m.companies.push({ ...clone(c), id: 'c2', ownerId: 'u2', name: 'b', state: clone(c.state) });
      const other = m.companies[1]!;
      for (let i = 0; i < 5; i++) {
        const t = startDay(m, 'u2', T0 + i, `t${i}`, other.progress.stateVersion);
        if (!t.ok) throw new Error(t.reason);
        const st: GameState = clone(other.state);
        autoPlayDay(st, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
        expect(commitDay(m, 'u2', T0 + i + 1, t.ticket.token, st).ok).toBe(true);
      }
      for (;;) {
        const r = runSync(m, jstMidnight(addDays('2026-11-04', 1)) + 60_000);
        if (r.status === 'more') continue;
        if (r.status === 'ranking') finishSync(m, 0);
        break;
      }
      return { stage: c.state.career.stage, log: m.decisions.filter((d) => d.companyId === c.id).map((d) => d.text) };
    };
    const yes = run(true);
    expect(yes.log.some((t) => t.includes('拡張'))).toBe(true);
    const no = run(false);
    expect(no.stage).toBe(0);
    expect(no.log.some((t) => t.includes('拡張'))).toBe(false);
    expect(BALANCE.market.ai.expandReserve).toBeGreaterThan(0);
  });
});

describe('AI 企業の拡張（閉店後の判断）', () => {
  it('資金がたまった AI 企業は、0時の同期の自動営業の日に本店を12席に拡張し、次の日は工事で休む', () => {
    const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;
    const m = createMarket({ id: 'm', name: 'x', seed: 9, now: T0, settings: { maxCompanies: 2 }, creator: { ownerId: 'u1', companyName: 'a' } });
    const ai = m.companies.find((c) => c.kind === 'ai')!;
    ai.state.money = 5_000_000;
    ai.state.career.unlocked.push('stage2');
    const me = playerCompany(m, 'u1')!;
    for (let i = 0; i < 3; i++) {
      const t = startDay(m, 'u1', T0 + i, `t${i}`, me.progress.stateVersion);
      if (!t.ok) throw new Error(t.reason);
      const st: GameState = clone(me.state);
      autoPlayDay(st, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
      expect(commitDay(m, 'u1', T0 + i + 1, t.ticket.token, st).ok).toBe(true);
    }
    for (;;) {
      const r = runSync(m, jstMidnight(addDays('2026-11-04', 1)) + 60_000);
      if (r.status === 'more') continue;
      if (r.status === 'ranking') finishSync(m, 0);
      break;
    }
    expect(ai.state.career.stage).toBe(1);
    expect(m.decisions.some((d) => d.companyId === ai.id && d.text.includes('12席に拡張'))).toBe(true);
    expect(ai.state.company.history.some((r) => r.served === 0)).toBe(true);
  });
});
