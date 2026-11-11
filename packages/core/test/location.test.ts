// 出店の場所（日本地図の出店マップ。docs/STORE_MAP_PLAN.md）
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  arrivalRate,
  BALANCE,
  candidateSites,
  createMarket,
  jstMidnight,
  locationInfo,
  locationLabel,
  makeSaveFile,
  marketAction,
  MUNICIPALITIES,
  nextDay,
  normalizeSettings,
  parseSave,
  playerCompany,
  PREFECTURES,
  STAGES,
  storeDemandMult,
  storeRent,
  priceDemandFactor,
  storeRentMult,
  validateState,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, addSoloBot, newGame, runDay } from './helpers';

const OSAKA = '27100';
const TOKYO_SHINJUKU = '13104';
const FUTABA = Object.entries(MUNICIPALITIES).find(([, [, name, pop]]) => name === '双葉町' && pop === 0)![0];

function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 12席・評判★4.2・資金300万円の会社（本店は大阪市。2〜5店目は大阪府の中に出せる） */
function readyCompany(seed: number) {
  const { s, ctx } = newGame(seed);
  activeStore(s).location = OSAKA;
  addSoloBot(s);
  const cook = addBot(s, 'cook', 0.7, 6000);
  playDay(s, ctx);
  s.money = 3_000_000;
  s.career.unlocked.push('stage2');
  expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
  s.reputation = 4.2;
  return { s, ctx, cook };
}

describe('市区町村の表', () => {
  it('47都道府県・約1,700の市区町村。名前・人口がある', () => {
    expect(Object.keys(PREFECTURES)).toHaveLength(47);
    expect(Object.keys(MUNICIPALITIES).length).toBeGreaterThan(1700);
    expect(locationInfo(OSAKA)).toMatchObject({ prefName: '大阪府', name: '大阪市' });
    expect(locationInfo(OSAKA)!.population).toBeGreaterThan(2_000_000);
    expect(locationLabel(TOKYO_SHINJUKU)).toBe('東京都 新宿区');
    expect(locationInfo('99999')).toBeNull();
  });

  it('候補地は市区町村ごとに駅前・住宅街・郊外の3か所', () => {
    expect(candidateSites(OSAKA).map((c) => c.name)).toEqual(['大阪市 駅前', '大阪市 住宅街', '大阪市 郊外']);
    expect(candidateSites(OSAKA).map((c) => c.propertyId)).toEqual(['station', 'residential', 'roadside']);
  });

  it('人口と人口密度の多い街は来客も家賃も多く、少ない町は少ない（倍率は小さめ。じろ1 5.5）', () => {
    const L = BALANCE.location;
    const big = locationInfo(OSAKA)!;
    expect(big.index).toBe(1);
    expect(big.demand).toBeCloseTo(1 + L.demandSpan * big.index + L.densityDemandSpan * big.densityIndex, 6);
    expect(big.rent).toBeCloseTo((1 + L.rentSpan * big.index + L.densityRentSpan * big.densityIndex) * (big.priceIndex / 100) ** L.rentPriceExp, 6);
    const small = Object.keys(MUNICIPALITIES).map(locationInfo).find((l) => l && l.population > 0 && l.population < 5000)!;
    expect(small.index).toBe(-1);
    expect(small.demand).toBeLessThan(1);
    expect(small.rent).toBeLessThan(1);
    expect(big.demand).toBeGreaterThan(1);
    expect(big.rent).toBeGreaterThan(1);
  });
});

describe('場所つきの出店', () => {
  it('出店先の市区町村を記録し、名前に入れる。表にない場所・人口のいない区域には出店できない', () => {
    const { s, ctx, cook } = readyCompany(701);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id, location: '99999' }, ctx).ok).toBe(false);
    const ng = applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id, location: FUTABA }, ctx);
    expect(ng.ok).toBe(false);
    expect(ng.reason).toContain('人口');
    const r = applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id, location: OSAKA }, ctx);
    expect(r.ok, r.reason).toBe(true);
    const branch = s.company.stores[1]!;
    expect(branch.location).toBe(OSAKA);
    expect(branch.name).toBe(`${s.shopName} 大阪市駅前店`);
    // 屋号を変えると、自動の名前の支店も合わせる（場所は名前に残る）
    expect(applyAction(s, 'p1', { type: 'rename', name: '豚の星' }, ctx).ok).toBe(true);
    expect(branch.name).toBe('豚の星 大阪市駅前店');
    expect(storeDemandMult(branch)).toBeCloseTo(1.3 * locationInfo(OSAKA)!.demand, 6);
    expect(storeRentMult(branch)).toBeCloseTo(1.6 * locationInfo(OSAKA)!.rent, 6);
    expect(validateState(s)).toEqual([]);
  });

  it('場所を決めていない1店目は、あとで1回だけ場所を決められる（倍率はそこから）', () => {
    const { s, ctx } = newGame(702);
    const home = activeStore(s);
    expect(home.location).toBeUndefined();
    const before = arrivalRate(s);
    expect(storeRent(s)).toBe(STAGES[0]!.rent);
    expect(applyAction(s, 'p1', { type: 'setStoreLocation', storeId: home.id, location: OSAKA }, ctx).ok).toBe(true);
    expect(home.location).toBe(OSAKA);
    // 来客は場所の倍率と、地域の値段の許容度（大阪市は少し高くても来る）の分だけ変わる
    expect(arrivalRate(s)).toBeCloseTo(before * locationInfo(OSAKA)!.demand * priceDemandFactor(s), 6);
    expect(storeRent(s)).toBe(Math.round(STAGES[0]!.rent * locationInfo(OSAKA)!.rent));
    const again = applyAction(s, 'p1', { type: 'setStoreLocation', storeId: home.id, location: TOKYO_SHINJUKU }, ctx);
    expect(again.ok).toBe(false);
    expect(home.location).toBe(OSAKA);
  });

  it('手動で営業している支店も、立地と場所の家賃を払う（前は立地の倍率が抜けていた）', { timeout: 60_000 }, () => {
    const { s, ctx, cook } = readyCompany(703);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id, location: OSAKA }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    // 準備の日数が過ぎるまで回してから、支店に入って1日営業する
    for (let i = 0; i < 3; i++) playDay(s, ctx);
    expect(applyAction(s, 'p1', { type: 'enterStore', storeId: branch.id }, ctx).ok).toBe(true);
    playDay(s, ctx);
    const rent = s.history[s.history.length - 1]!.rent;
    expect(rent).toBe(Math.round(STAGES[s.career.stage]!.rent * 1.6 * locationInfo(OSAKA)!.rent));
  });

  it('場所つきの店はセーブして読み込んでも同じ', () => {
    const { s, ctx } = newGame(704);
    applyAction(s, 'p1', { type: 'setStoreLocation', storeId: activeStore(s).id, location: TOKYO_SHINJUKU }, ctx);
    const r = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 0)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.save.state.company.stores[0]!.location).toBe(TOKYO_SHINJUKU);
  });
});

describe('共通市場の街（市場は1つの街）', () => {
  const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;
  it('作る人が選んだ街に全社の店がある。出店ははじめ街の中だけ（市場の成績で広がる。じろ1 Q11・Q13）。街のない市場・不正な街は ×1', () => {
    const m = createMarket({ id: 'loc', name: 'loc', seed: 9, now: T0, settings: { cityCode: OSAKA }, creator: { ownerId: 'u1', companyName: '一号店' } });
    expect(m.settings.cityCode).toBe(OSAKA);
    for (const c of m.companies) expect(c.state.company.stores.every((st) => st.location === OSAKA)).toBe(true);
    const s = playerCompany(m, 'u1')!.state;
    s.money = 3_000_000;
    s.reputation = 4.2;
    s.career.unlocked.push('stage2');
    const cook = addBot(s, 'cook', 0.7, 6000);
    cook.profile.employment = 'full';
    // 12席の店（市場では拡張は営業の画面から。ここでは段階を直接上げる）
    s.career.stage = 1;
    // 出店の範囲ははじめ市場の街の中だけ（じろ1 Q13）: 東京にも、同じ大阪府の堺市にもまだ出せない
    const far = marketAction(m, 'u1', { type: 'openStore', propertyId: 'residential', managerId: cook.id, location: TOKYO_SHINJUKU }, T0);
    expect(far.ok).toBe(false);
    expect(far.reason).toContain('市場の街');
    expect(marketAction(m, 'u1', { type: 'openStore', propertyId: 'residential', managerId: cook.id, location: '27140' }, T0).ok).toBe(false);
    // 場所を指定しなければ市場の街
    const r = marketAction(m, 'u1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, T0);
    expect(r.ok, r.reason).toBe(true);
    expect(s.company.stores[1]!.location).toBe(OSAKA);
    expect(s.company.marketRange).toEqual({ city: OSAKA, scope: 'city' });
    expect(normalizeSettings({ cityCode: '99999' }, T0).cityCode).toBeNull();
    expect(normalizeSettings({ cityCode: FUTABA }, T0).cityCode).toBeNull();
    const old = createMarket({ id: 'old', name: 'old', seed: 9, now: T0, settings: {}, creator: { ownerId: 'u1', companyName: 'x' } });
    expect(old.settings.cityCode).toBeNull();
    expect(playerCompany(old, 'u1')!.state.company.stores[0]!.location).toBeUndefined();
  });
});
