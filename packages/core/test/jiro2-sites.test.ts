// じろ2 段階D（改修設計書03）: 候補地の数字（公的な統計）・距離の取り合い・同じ会社の食い合い・新規参入の保護・出店の見込み
import { describe, expect, it } from 'vitest';
import {
  BALANCE,
  createMarket,
  demandFor,
  entryNovelty,
  entryRamp,
  FORECAST_DISCLAIMER,
  joinMarket,
  jstMidnight,
  MUNICIPALITIES,
  playerCompany,
  siteForecast,
  siteStats,
  siteWeight,
  storeDemandMult,
} from '../src';
import { MUNICIPALITY_DAYTIME } from '../src/data/daytime';
import { newGame } from './helpers';

const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;

describe('候補地の数字（国勢調査2020・経済センサス2021を同梱）', () => {
  it('人口のある市区町村はすべて数字がある（北方領土の人口のない区域を除く）', () => {
    const missing = Object.entries(MUNICIPALITIES).filter(([code, row]) => row[2] > 0 && !MUNICIPALITY_DAYTIME[code]);
    expect(missing).toEqual([]);
    expect(MUNICIPALITY_DAYTIME['13101']![0]).toBeGreaterThan(1000); // 千代田区は昼の人がとても多い
  });

  it('駅前は昼の人が多い街ほど、住宅街は夜の人が多い街ほど少し来客が多い（少しだけ: ±6%まで）', () => {
    const chiyoda = siteStats('13101', 'station');
    const chiyodaRes = siteStats('13101', 'residential');
    expect(chiyoda.dayNightRatio).toBeGreaterThan(1000);
    expect(chiyoda.demandMult).toBeGreaterThan(1);
    expect(chiyodaRes.demandMult).toBeLessThan(chiyoda.demandMult);
    expect(chiyoda.trafficLabel).toBe('多い');
    for (const code of ['13101', '01100', '47382', '27128']) {
      for (const p of ['station', 'residential', 'roadside']) {
        const m = siteStats(code, p).demandMult;
        expect(m).toBeGreaterThanOrEqual(1 - BALANCE.location.siteSpan * 1.5 - 1e-9);
        expect(m).toBeLessThanOrEqual(1 + BALANCE.location.siteSpan * 1.5 + 1e-9);
      }
    }
    // 場所のない店は今までと同じ
    expect(siteStats('99999', 'station').demandMult).toBe(1);
  });

  it('店の来客の倍率に入る', () => {
    const { s } = newGame(401);
    const e = { ...s.company.stores[0]!, location: '13101', propertyId: 'station' };
    const p = 1.3; // 駅前
    expect(storeDemandMult(e) / p).toBeCloseTo(siteStats('13101', 'station').demandMult * (storeDemandMult({ ...e, propertyId: 'home' }) / siteStats('13101', 'home').demandMult), 6);
  });
});

describe('距離の取り合い・新規参入の保護', () => {
  it('同じ場所は強く、同じ市区町村の別の場所は弱く、ほかの市区町村とは取り合わない', () => {
    expect(siteWeight('27100', 'station', '27100', 'station')).toBe(1);
    expect(siteWeight('27100', 'station', '27100', 'residential')).toBe(BALANCE.market.nearShare);
    expect(siteWeight('27100', 'station', '13101', 'station')).toBe(0);
  });

  it('新店の話題性は14日で1.3倍→1倍、取り合いは7日かけて強める', () => {
    expect(entryNovelty(10, 11)).toBeCloseTo(1.3, 6);
    expect(entryNovelty(10, 10 + 14)).toBeGreaterThan(1);
    expect(entryNovelty(10, 10 + 15)).toBe(1);
    expect(entryRamp(10, 11)).toBeCloseTo(1 / 7, 6);
    expect(entryRamp(10, 17)).toBe(1);
    expect(entryRamp(10, 30)).toBe(1);
  });

  it('同じ会社の店どうしも、同じ場所なら客を食い合う', () => {
    const m = createMarket({ id: 'cann', name: 'cann', seed: 9, now: T0, settings: { aiFill: false, maxCompanies: 3, cityCode: '27100' }, creator: { ownerId: 'u1', companyName: '一号' } });
    const c = playerCompany(m, 'u1')!;
    const home = c.state.company.stores[0]!;
    const alone = demandFor(m, c, 30)[home.id]!;
    expect(alone).toBeCloseTo(1, 6);
    // 同じ場所（市場の街の本店の地域）に、同じ会社の2店目があるとする
    c.state.company.stores.push({ ...home, id: 'store2', propertyId: c.homeArea, openedDay: 0, snapshot: null });
    // その日の見込み（同じくらいの店）
    m.ledger['30'] = { [`${c.id}:${home.id}`]: 50, [`${c.id}:store2`]: 50 };
    const two = demandFor(m, c, 30)[home.id]!;
    expect(two).toBeCloseTo(1 / (1 + BALANCE.market.competition), 6);
    expect(two).toBeLessThan(1);
    // ほかの会社の店も入ってくると、もっと減る
    joinMarket(m, 'u2', '二号');
    const r = playerCompany(m, 'u2')!;
    r.homeArea = c.homeArea;
    m.ledger['30']![`${r.id}:${r.state.company.stores[0]!.id}`] = 50;
    expect(demandFor(m, c, 30)[home.id]!).toBeLessThan(two);
  });
});

describe('出店のときの見込み', () => {
  it('想定人口・想定客数・家賃・物価・競合・予想売上と利益・初期投資・回収の見込み。過密なら注意', () => {
    const { s } = newGame(402);
    s.company.stores[0]!.location = '27100';
    const f = siteForecast(s, '27100', 'station');
    expect(f.population).toBeGreaterThan(2_000_000);
    expect(f.customers).toBeGreaterThan(0);
    expect(f.rent).toBeGreaterThan(0);
    expect(f.initialCost).toBe(700_000);
    expect(f.sales).toBeGreaterThan(0);
    if (f.profit > 0) expect(f.paybackDays).toBe(Math.ceil(700_000 / f.profit));
    expect(f.crowded).toBeNull();
    const crowd = siteForecast(s, '27100', 'station', [
      { location: '27100', propertyId: 'station' },
      { location: '27100', propertyId: 'station' },
      { location: '27100', propertyId: 'station' },
    ]);
    expect(crowd.crowded).toContain('過密');
    expect(crowd.customers).toBeLessThan(f.customers);
    expect(FORECAST_DISCLAIMER).toContain('保証');
  });
});
