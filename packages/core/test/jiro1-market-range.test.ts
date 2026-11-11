// オンライン市場の出店の範囲（じろ1 Q13。オーナーの指示: 市場の街 → 同じ都道府県 → 同じ地方 → 全国。条件はオーナーが承認した案）
import { describe, expect, it } from 'vitest';
import { createMarket, jstMidnight, marketAction, marketRangeChecks, playerCompany, refreshMarketRange, type CompanyDayReport, type MarketCompany, type MarketState } from '../src';
import { addBot } from './helpers';

const OSAKA = '27100';
const SAKAI = '27140';
const KYOTO = '26100';
const SAPPORO = '01100';
const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;

function market(): { m: MarketState; me: MarketCompany } {
  const m = createMarket({ id: 'range', name: 'range', seed: 21, now: T0, settings: { cityCode: OSAKA, maxCompanies: 4 }, creator: { ownerId: 'u1', companyName: '一号店' } });
  const me = playerCompany(m, 'u1')!;
  const s = me.state;
  s.money = 50_000_000;
  s.reputation = 4.5;
  s.career.stage = 1;
  return { m, me };
}

/** 会社の日報を days 日分つくる（市場シェア = 純売上の割合・営業利益） */
function history(c: MarketCompany, days: number, netSales: number, op: number): void {
  const h: CompanyDayReport[] = [];
  for (let d = 1; d <= days; d++) h.push({ ...(c.state.company.history[0] ?? {}), day: d, netSales, operatingProfit: op } as CompanyDayReport);
  c.state.company.history = h;
}

function open(m: MarketState, me: MarketCompany, propertyId: string, location?: string) {
  const mgr = addBot(me.state, 'cook', 0.6, 9000);
  mgr.profile.employment = 'full';
  return marketAction(m, 'u1', { type: 'openStore', propertyId, managerId: mgr.id, ...(location ? { location } : {}) }, T0);
}

describe('オンライン市場の出店の範囲', () => {
  it('はじめは市場の街の中だけ。同じ都道府県（堺市）には出せない', () => {
    const { m, me } = market();
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange).toEqual({ city: OSAKA, scope: 'city' });
    const r = open(m, me, 'station', SAKAI);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('市場の街');
    expect(open(m, me, 'station', OSAKA).ok).toBe(true);
  });

  it('市場の街に2店以上＋シェアが平均以上で、同じ都道府県へ広がる（シェアが低いままなら広がらない）', () => {
    const { m, me } = market();
    expect(open(m, me, 'station').ok).toBe(true);
    m.commonMarketDate = 10;
    for (const c of m.companies) history(c, 10, c === me ? 10_000 : 40_000, 1000);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('city');
    const checks = marketRangeChecks(m, me)!;
    expect(checks.next).toBe('prefecture');
    expect(checks.checks.find((x) => x.key === 'cityStores')!.ok).toBe(true);
    expect(checks.checks.find((x) => x.key === 'share')!.ok).toBe(false);
    for (const c of m.companies) history(c, 10, c === me ? 60_000 : 20_000, 1000);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('prefecture');
    expect(open(m, me, 'station', SAKAI).ok).toBe(true);
    expect(open(m, me, 'station', KYOTO).ok).toBe(false);
  });

  it('市場の街の物件が満室なら、シェアが低くても同じ都道府県へ広がる', () => {
    const { m, me } = market();
    // ほかの会社で街の物件を全部埋める
    const others = m.companies.filter((c) => c !== me);
    let i = 0;
    for (const pid of ['station', 'station', 'station', 'residential', 'residential', 'residential', 'roadside', 'roadside']) {
      const c = others[i++ % others.length]!;
      c.state.company.stores.push({ ...c.state.company.stores[0]!, id: `fill${i}`, propertyId: pid, location: OSAKA, snapshot: null });
    }
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('prefecture');
  });

  it('同じ地方は4店以上＋シェアが平均の1.5倍以上＋直近7日が黒字。全国は7店以上＋シェア1位＋直近30日が黒字。一度広がると戻らない', () => {
    const { m, me } = market();
    me.state.company.marketRange = { city: OSAKA, scope: 'prefecture' };
    m.commonMarketDate = 30;
    for (const c of m.companies) history(c, 30, c === me ? 90_000 : 10_000, c === me ? 5_000 : -1_000);
    const add = (n: number) => {
      while (me.state.company.stores.length < n) me.state.company.stores.push({ ...me.state.company.stores[0]!, id: `s${me.state.company.stores.length}`, propertyId: 'station', location: SAKAI, snapshot: null });
    };
    add(3);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('prefecture');
    add(4);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('region');
    expect(open(m, me, 'roadside', KYOTO).ok).toBe(true);
    expect(open(m, me, 'roadside', SAPPORO).ok).toBe(false);
    add(7);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('national');
    expect(open(m, me, 'roadside', SAPPORO).ok).toBe(true);
    // シェアが下がっても戻らない
    for (const c of m.companies) history(c, 30, c === me ? 1_000 : 90_000, -5_000);
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('national');
  });

  it('赤字のままなら同じ地方へは広がらない', () => {
    const { m, me } = market();
    me.state.company.marketRange = { city: OSAKA, scope: 'prefecture' };
    m.commonMarketDate = 30;
    for (const c of m.companies) history(c, 30, c === me ? 90_000 : 10_000, c === me ? -2_000 : 1_000);
    while (me.state.company.stores.length < 5) me.state.company.stores.push({ ...me.state.company.stores[0]!, id: `s${me.state.company.stores.length}`, propertyId: 'station', location: SAKAI, snapshot: null });
    refreshMarketRange(m, me);
    expect(me.state.company.marketRange!.scope).toBe('prefecture');
    expect(marketRangeChecks(m, me)!.checks.find((x) => x.key === 'profit')!.ok).toBe(false);
  });
});
