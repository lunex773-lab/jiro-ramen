// 広告予算・短期バイト・通常の採用は2日後から（オーナーの判断 14。仕様書 4.3）
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  adFactor,
  applyAction,
  BALANCE,
  expectedDailyArrivals,
  lastCompanyDay,
  nextDay,
  operatingProfit,
  refreshCandidates,
  runManagerDay,
  setStorePolicy,
  step,
  tempHourly,
  verifyCommit,
} from '../src';
import { addSoloBot, autoRepair, clone, newGame } from './helpers';

describe('広告予算（控えめ）', () => {
  it('1日3,000円で約+8%、どれだけ出しても+20%まで', () => {
    expect(adFactor(0)).toBe(1);
    expect(adFactor(3000)).toBeCloseTo(1.08, 2);
    expect(adFactor(1e9)).toBeCloseTo(1 + BALANCE.ads.max, 6);
    expect(adFactor(8000)).toBeLessThan(1.2);
  });

  it('開店のときに払い、その日の来客の見込みが増え、日報の広告費として営業利益から引く', () => {
    const { s, ctx } = newGame(11);
    addSoloBot(s);
    expect(setStorePolicy(s, activeStore(s).id, { adBudget: 3000 }).ok).toBe(true);
    const before = expectedDailyArrivals(s, { events: false });
    const m = s.money;
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    expect(s.money).toBe(m - 3000);
    expect(s.today.ads).toBe(3000);
    expect(expectedDailyArrivals(s, { events: false }) / before).toBeCloseTo(adFactor(3000), 6);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 30000) step(s, 0.1, ctx);
    const r = s.history[s.history.length - 1]!;
    expect(r.ads).toBe(3000);
    expect(r.operatingProfit).toBe(operatingProfit(r));
    expect(setStorePolicy(s, activeStore(s).id, { adBudget: 50_000 }).ok).toBe(false);
  });

  it('お金が足りなければ出さない。1日単位の計算でも同じ（払って、来客に効く）', () => {
    const { s, ctx } = newGame(12);
    setStorePolicy(s, activeStore(s).id, { adBudget: 3000 });
    s.money = 100;
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(s.today.ads ?? 0).toBe(0);
    // 1日単位の計算（店主が回す店）
    const { s: t } = newGame(13);
    t.company.ownerStoreId = t.company.activeStoreId;
    const a = clone(t);
    const b = clone(t);
    setStorePolicy(b, activeStore(b).id, { adBudget: 5000 });
    const ra = runManagerDay(a, activeStore(a), a.day, ctx);
    const rb = runManagerDay(b, activeStore(b), b.day, ctx);
    expect(rb.ads).toBe(5000);
    expect(rb.customers + rb.balked).toBeGreaterThan(ra.customers + ra.balked);
  });
});

describe('短期バイトと、通常の採用は2日後から', () => {
  it('短期バイトは開店前に呼べて、その日すぐ来て、精算のあと辞める。採用費なし・時給は通常の1.5倍・1日2人まで', () => {
    const { s, ctx } = newGame(21);
    s.career.unlocked.push('hiring');
    const m = s.money;
    expect(applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx).ok).toBe(true);
    expect(s.money).toBe(m);
    const t = s.employees[0]!;
    expect(t.profile.temp).toBe(true);
    expect(t.profile.hourly).toBe(tempHourly());
    const st = BALANCE.staff;
    expect(tempHourly()).toBe(Math.round((((st.wageMin + st.wageMax) / 2 / st.employment.fullShiftHours) * st.temp.wageMult) / 10) * 10);
    expect(t.profile.skills.cooking).toBeLessThanOrEqual(st.temp.skillTo);
    expect(t.att?.prepWorked).toBe(true);
    expect(applyAction(s, 'p1', { type: 'promote', employeeId: t.id }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'hireTemp', role: 'server' }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx).ok).toBe(false);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx).ok).toBe(false);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 30000) step(s, 0.1, ctx);
    const r = s.history[s.history.length - 1]!;
    expect(r.wages).toBeGreaterThan(0);
    expect(s.employees.filter((e) => e.profile.temp)).toHaveLength(0);
  });

  it('通常の採用は採用の2日後から出勤する（チュートリアルの練習はすぐ）', () => {
    const { s, ctx } = newGame(22);
    s.career.unlocked.push('hiring');
    refreshCandidates(s);
    applyAction(s, 'p1', { type: 'hire', candidateId: s.candidates[0]!.id }, ctx);
    const e = s.employees[0]!;
    expect(e.availableFrom).toBe(s.day + 2);
    expect(e.presentToday).toBe(false);
  });

  it('広告と短期バイトを使った日も、サーバーの確かめ方で引っかからない', { timeout: 60_000 }, () => {
    const { s, ctx } = newGame(23);
    s.tutorial = null;
    addSoloBot(s, 0.65);
    s.career.unlocked.push('hiring');
    setStorePolicy(s, activeStore(s).id, { adBudget: 3000 });
    const prev = clone(s);
    applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let guard = 0;
    while ((s.phase as string) !== 'closed' && guard++ < 30000) {
      step(s, 0.1, ctx);
      autoRepair(s, ctx);
    }
    expect(nextDay(s, ctx).ok).toBe(true);
    const v = verifyCommit(prev, s, { gameDate: lastCompanyDay(prev) + 1, demand: {} });
    expect(v.reject).toEqual([]);
    expect(v.flags).toEqual([]);
  });
});
