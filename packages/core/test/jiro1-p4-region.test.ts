// じろ1 P4（docs/JIRO1_PLAN.md 5.5・5.6・5.10）: 地域の経済（人口密度・物価・所得）・値段の上限 5,000円・出店の範囲・店の周り
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  BALANCE,
  chooseMenu,
  expectedTicket,
  locationInfo,
  MENU,
  MUNICIPALITIES,
  priceDemandFactor,
  purchaseUnitCost,
  scopeForNth,
  storeRangeProblem,
  surroundingsOf,
  type GameState,
} from '../src';
import { MUNICIPALITY_AREA_KM2 } from '../src/data/areas';
import { addBot, newGame } from './helpers';

const SHINJUKU = '13104';
const OSAKA = '27100';
const SAPPORO = '01100';
const NAHA = '47201';
const OMACHI = '20212'; // 長野県 大町市（人口密度 約45人/km²）
const KYOTO = '26100';
const TAKAMATSU = '37201';

const setHome = (s: GameState, code: string) => {
  activeStore(s).location = code;
};

describe('地域の数字', () => {
  it('面積は地図の形から（実際の面積に近い）。人口密度は都心で高く、山の町で低い', () => {
    expect(Object.keys(MUNICIPALITY_AREA_KM2).length).toBeGreaterThan(1700);
    // 新宿区 約18.2km²・大阪市 約225km²・大町市 約565km²（国土地理院の面積調。小さな区はずれが大きい）
    expect(MUNICIPALITY_AREA_KM2[SHINJUKU]!).toBeGreaterThan(16);
    expect(MUNICIPALITY_AREA_KM2[SHINJUKU]!).toBeLessThan(21);
    expect(MUNICIPALITY_AREA_KM2[OSAKA]!).toBeGreaterThan(205);
    expect(MUNICIPALITY_AREA_KM2[OSAKA]!).toBeLessThan(245);
    expect(MUNICIPALITY_AREA_KM2[OMACHI]!).toBeGreaterThan(520);
    expect(MUNICIPALITY_AREA_KM2[OMACHI]!).toBeLessThan(610);
    const tokyo = locationInfo(SHINJUKU)!;
    const omachi = locationInfo(OMACHI)!;
    expect(tokyo.density).toBeGreaterThan(10_000);
    expect(omachi.density).toBeLessThan(100);
    expect(tokyo.densityIndex).toBeGreaterThan(0.8);
    expect(omachi.densityIndex).toBe(-1);
    expect(tokyo.region).toBe('関東');
    expect(locationInfo(NAHA)!.region).toBe('九州・沖縄');
  });

  it('来客・家賃・仕入れ値の倍率は小さめ（少し差がある）。都会は家賃が高く、沖縄は仕入れが高い', () => {
    for (const code of Object.keys(MUNICIPALITIES)) {
      const l = locationInfo(code)!;
      if (l.population <= 0) continue;
      expect(l.demand).toBeGreaterThanOrEqual(0.85);
      expect(l.demand).toBeLessThanOrEqual(1.15);
      expect(l.rent).toBeGreaterThanOrEqual(0.5);
      expect(l.rent).toBeLessThanOrEqual(1.6);
      expect(l.purchase).toBeGreaterThanOrEqual(0.94);
      expect(l.purchase).toBeLessThanOrEqual(1.08);
      expect(l.tolerance).toBeGreaterThanOrEqual(1);
      expect(l.tolerance).toBeLessThanOrEqual(BALANCE.location.toleranceMax);
      expect(l.priceSensitivity).toBeGreaterThanOrEqual(1);
    }
    expect(locationInfo(SHINJUKU)!.rent).toBeGreaterThan(locationInfo(OMACHI)!.rent + 0.5);
    expect(locationInfo(NAHA)!.purchase).toBeGreaterThan(1.05);
  });

  it('値段の許容度: 東京の都心は高い値段でも客が減りにくく、田舎は定価より高いと大きく減る（定価では同じ）', () => {
    const at = (code: string, mult: number) => {
      const { s } = newGame(1);
      setHome(s, code);
      for (const m of Object.values(MENU)) s.prices[m.id] = Math.round((m.defaultPrice * mult) / 10) * 10;
      return priceDemandFactor(s);
    };
    expect(locationInfo(SHINJUKU)!.tolerance).toBeGreaterThan(1.1);
    expect(locationInfo(OMACHI)!.tolerance).toBe(1);
    expect(locationInfo(OMACHI)!.priceSensitivity).toBeGreaterThan(1.1);
    // 定価: 都会は少し増え（許容度の分）、田舎は今までと同じ
    expect(at(OMACHI, 1)).toBeCloseTo(1, 6);
    expect(at(SHINJUKU, 1)).toBeGreaterThan(1);
    // 2割高い: 都会は今までより減りにくく、田舎は今までより減る
    const { s: plain } = newGame(1);
    for (const m of Object.values(MENU)) plain.prices[m.id] = Math.round((m.defaultPrice * 1.2) / 10) * 10;
    const base = priceDemandFactor(plain);
    expect(at(SHINJUKU, 1.2)).toBeGreaterThan(base + 0.1);
    expect(at(OMACHI, 1.2)).toBeLessThan(base - 0.03);
  });

  it('田舎・所得の低い地域は量の多いメニュー、都会は高いメニューが選ばれやすい。客単価の見込みも地域で変わる', () => {
    const share = (code: string | undefined) => {
      const { s } = newGame(3);
      s.career.unlocked.push(...Object.values(MENU).map((m) => m.unlock).filter((x): x is string => !!x));
      if (code) setHome(s, code);
      let big = 0;
      const n = 3000;
      for (let i = 0; i < n; i++) {
        const c = { traits: { appetite: 0.5, priceSensitivity: 0.45 }, regularId: null } as unknown as Parameters<typeof chooseMenu>[1];
        const id = chooseMenu(s, c).menuId!;
        if (MENU[id]!.size === 'large' || MENU[id]!.buta >= 5) big++;
      }
      return { big: big / n, ticket: expectedTicket(s) };
    };
    const plain = share(undefined);
    const rural = share(OMACHI);
    const city = share(SHINJUKU);
    // 田舎は量の多い品を多く選ぶ。都会は高い品を選び、客単価の見込みが上がる（場所のない店と比べて）
    expect(rural.big).toBeGreaterThan(plain.big + 0.02);
    expect(city.ticket).toBeGreaterThan(plain.ticket + 8);
  });

  it('仕入れ値は都道府県の食料の物価で変わる（場所のない店は今までと同じ）', () => {
    const { s } = newGame(1);
    const base = purchaseUnitCost('noodle', false, s);
    setHome(s, NAHA);
    expect(purchaseUnitCost('noodle', false, s)).toBeCloseTo(base * locationInfo(NAHA)!.purchase, 6);
    expect(purchaseUnitCost('noodle', false)).toBeCloseTo(base, 6);
  });
});

describe('値段の上限 5,000円', () => {
  it('5,000円まで決められ、5,010円はだめ。とても高い値段では客がほとんど来ない', () => {
    const { s, ctx } = newGame(1);
    const id = Object.keys(MENU)[0]!;
    expect(applyAction(s, 'p1', { type: 'setPrice', menuId: id, price: 5000 }, ctx).ok).toBe(true);
    expect(s.prices[id]).toBe(5000);
    expect(applyAction(s, 'p1', { type: 'setPrice', menuId: id, price: 5010 }, ctx).ok).toBe(false);
    for (const m of Object.values(MENU)) s.prices[m.id] = 5000;
    expect(priceDemandFactor(s)).toBeLessThan(0.05);
    // 定価の1.5倍までは今までと同じ下がり方（下限は効かない）
    for (const m of Object.values(MENU)) s.prices[m.id] = Math.round((m.defaultPrice * 1.4) / 10) * 10;
    expect(priceDemandFactor(s)).toBeGreaterThan(0.35);
  });
});

describe('出店の範囲（2〜5店目は同じ都道府県・6〜10店目は同じ地方・11店目から全国）', () => {
  it('何店目でどこまで出せるか', () => {
    expect(scopeForNth(2)).toBe('prefecture');
    expect(scopeForNth(5)).toBe('prefecture');
    expect(scopeForNth(6)).toBe('region');
    expect(scopeForNth(10)).toBe('region');
    expect(scopeForNth(11)).toBe('national');
    expect(scopeForNth(40)).toBe('national');
  });

  it('本店の場所から範囲を決める（本店の場所がないと出せない）', () => {
    const { s } = newGame(1);
    expect(storeRangeProblem(s, OSAKA)).toMatch(/本店の場所/);
    setHome(s, OSAKA);
    expect(storeRangeProblem(s, '27140')).toBeNull(); // 堺市（同じ大阪府）
    expect(storeRangeProblem(s, KYOTO)).toMatch(/大阪府/);
    // 6店目（今5店）: 近畿の中なら京都も出せる、香川は出せない
    const extra = (n: number) => {
      while (s.company.stores.length < n) s.company.stores.push({ ...activeStore(s), id: `x${s.company.stores.length}`, propertyId: 'station', snapshot: null });
    };
    extra(5);
    expect(storeRangeProblem(s, KYOTO)).toBeNull();
    expect(storeRangeProblem(s, TAKAMATSU)).toMatch(/近畿/);
    extra(10);
    expect(storeRangeProblem(s, TAKAMATSU)).toBeNull();
    expect(storeRangeProblem(s, SAPPORO)).toBeNull();
  });

  it('店の数の上限はなく、同じ市区町村の同じ種類の物件には1店まで', () => {
    const { s, ctx } = newGame(5);
    setHome(s, OSAKA);
    s.money = 50_000_000;
    s.career.stage = 1;
    s.reputation = 4.5;
    s.phase = 'closed';
    const open = (code: string, pid: string) => {
      const m = addBot(s, 'cook', 0.6, 9000);
      m.profile.employment = 'full';
      return applyAction(s, 'p1', { type: 'openStore', propertyId: pid, managerId: m.id, location: code }, ctx);
    };
    expect(open(OSAKA, 'station').ok).toBe(true);
    expect(open(OSAKA, 'station').ok).toBe(false);
    expect(open('27140', 'station').ok).toBe(true);
    expect(open('27140', 'residential').ok).toBe(true);
    expect(open('27203', 'station').ok).toBe(true); // 5店目（豊中市）
    expect(s.company.stores).toHaveLength(5);
    // 6店目は近畿（京都）
    expect(open(KYOTO, 'roadside').ok).toBe(true);
    expect(s.company.stores).toHaveLength(6);
  });
});

describe('店の周り', () => {
  it('人口密度と物件で決まる（都会・駅前・街・住宅街・郊外・田舎）。場所のない店は今までの街', () => {
    const { s } = newGame(1);
    const e = activeStore(s);
    expect(surroundingsOf(e)).toBe('town');
    expect(surroundingsOf({ ...e, location: SHINJUKU, propertyId: 'station' })).toBe('metro');
    expect(surroundingsOf({ ...e, location: OMACHI, propertyId: 'station' })).toBe('rural');
    expect(surroundingsOf({ ...e, location: TAKAMATSU, propertyId: 'station' })).toBe('station');
    expect(surroundingsOf({ ...e, location: TAKAMATSU, propertyId: 'residential' })).toBe('residential');
    expect(surroundingsOf({ ...e, location: TAKAMATSU, propertyId: 'roadside' })).toBe('suburb');
  });
});
