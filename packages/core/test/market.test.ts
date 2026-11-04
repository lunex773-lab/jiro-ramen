import { describe, expect, it } from 'vitest';
import {
  advanceMarketDay,
  advanceMarketTo,
  BALANCE,
  competitionFactors,
  createMarket,
  freeSlots,
  joinMarket,
  marketAction,
  marketShare,
  marketStandings,
  MARKET_HOME_AREAS,
  playerCompany,
  type MarketState,
} from '../src';

const mk = (seed = 5, creator = true): MarketState =>
  createMarket({ id: 'm', name: 'テスト市場', seed, creator: creator ? { ownerId: 'u1', companyName: 'テスト亭' } : null });

describe('オンライン市場（Phase 3-1）', () => {
  it('作った人と AI 企業で合わせて6社。AI だけの市場も作れる。本店は3つの地域に分かれる', () => {
    const m = mk();
    expect(m.companies).toHaveLength(BALANCE.market.maxCompanies);
    expect(m.companies.filter((c) => c.kind === 'player').map((c) => c.name)).toEqual(['テスト亭']);
    expect(m.companies.filter((c) => c.kind === 'ai')).toHaveLength(5);
    const ai = mk(5, false);
    expect(ai.companies.every((c) => c.kind === 'ai')).toBe(true);
    for (const a of MARKET_HOME_AREAS) expect(m.companies.filter((c) => c.homeArea === a.id)).toHaveLength(2);
    // 市場用に新しく始める: 全社が資金30万円・8席から。店主が本店を回す
    for (const c of m.companies) {
      expect(c.state.money).toBe(BALANCE.initialMoney);
      expect(c.state.career.stage).toBe(0);
      expect(c.state.company.ownerStoreId).toBe(c.state.company.stores[0]!.id);
    }
  });

  it('1日進めると、すべての企業の店が営業し、会社の日報と市場シェア（合計1）ができる', () => {
    const m = mk();
    expect(marketShare(m, 'c1')).toBe(0);
    advanceMarketDay(m);
    expect(m.day).toBe(2);
    for (const c of m.companies) {
      expect(c.state.company.history.map((r) => r.day)).toEqual([1]);
      expect(c.state.company.history[0]!.served).toBeGreaterThan(0);
      expect(c.state.day).toBe(2);
    }
    const shares = m.companies.map((c) => marketShare(m, c.id));
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(m.history).toHaveLength(1);
    expect(marketStandings(m)).toHaveLength(6);
  });

  it('同じ地域の店どうしで客を取り合う。同じくらいの店なら 1 ÷ (1 + 強さ)、安い店は客を多く取る', () => {
    const m = mk();
    advanceMarketTo(m, 4);
    const f = competitionFactors(m);
    const k = BALANCE.market.competition;
    // c1 と c4 は同じ地域（北口商店街）
    const c1 = m.companies[0]!;
    const c4 = m.companies[3]!;
    expect(c1.homeArea).toBe(c4.homeArea);
    expect(f.get(`c1:${c1.state.company.stores[0]!.id}`)!).toBeLessThan(1);
    expect(f.get(`c1:${c1.state.company.stores[0]!.id}`)!).toBeGreaterThan(1 / (1 + k * 2));
    // 地域にひとりなら取り合いなし
    c4.homeArea = 'solo';
    expect(competitionFactors(m).get(`c1:${c1.state.company.stores[0]!.id}`)).toBe(1);
    c4.homeArea = c1.homeArea;
    // 値段を下げると、同じ地域の相手より多く客を取る
    c4.state.company.stores[0]!.policy.priceMult = 1;
    expect(marketAction(m, 'u1', { type: 'setStorePolicy', storeId: c1.state.company.stores[0]!.id, policy: { priceMult: 0.85 } }).ok).toBe(true);
    const g = competitionFactors(m);
    expect(g.get(`c1:${c1.state.company.stores[0]!.id}`)!).toBeGreaterThan(g.get(`c4:${c4.state.company.stores[0]!.id}`)!);
  });

  it('同じ種と同じ操作の列なら、同じ結果になる', { timeout: 60_000 }, () => {
    const run = () => {
      const m = mk(77);
      advanceMarketTo(m, 6);
      marketAction(m, 'u1', { type: 'setStorePolicy', storeId: m.companies[0]!.state.company.stores[0]!.id, policy: { priceMult: 1.1 } });
      advanceMarketTo(m, 16);
      return JSON.stringify(m);
    };
    expect(run()).toBe(run());
  });

  it('市場では経営の操作だけが使える（日を進める・店の中の操作は使えない）。参加していなければ操作できない', () => {
    const m = mk();
    expect(marketAction(m, 'u1', { type: 'nextDay' }).ok).toBe(false);
    expect(marketAction(m, 'u1', { type: 'interact', targetId: 'x', verb: 'x' }).ok).toBe(false);
    expect(marketAction(m, 'u1', { type: 'buyEquipment', equipType: 'fridge' }).ok).toBe(false);
    expect(marketAction(m, 'nobody', { type: 'takeLoan' }).reason).toContain('参加していません');
    const r = marketAction(m, 'u1', { type: 'rename', name: '新しい名前' });
    expect(r.ok).toBe(true);
    expect(playerCompany(m, 'u1')!.name).toBe('新しい名前');
  });

  it('出店先の物件は全社で取り合う（空いていなければ出店できない）', () => {
    const m = mk();
    const n = freeSlots(m, 'roadside');
    expect(n).toBe(BALANCE.market.branchSlots.roadside);
    // ほかの2社が郊外に出店している状態にする
    for (const c of m.companies.slice(1, 1 + n)) c.state.company.stores.push({ ...c.state.company.stores[0]!, id: `x-${c.id}`, propertyId: 'roadside', snapshot: c.state.company.stores[0]!.snapshot });
    expect(freeSlots(m, 'roadside')).toBe(0);
    const r = marketAction(m, 'u1', { type: 'openStore', propertyId: 'roadside', managerId: 'e' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('空いていません');
  });

  it('6社でいっぱいの市場にプレイヤーが入ると、シェアがいちばん小さい AI 企業が撤退する。プレイヤーは4社まで', () => {
    const m = mk(9, false);
    advanceMarketTo(m, 3);
    const before = m.companies.filter((c) => c.bankruptDay === null).length;
    const j = joinMarket(m, 'u2', '新顔亭');
    expect(j.ok).toBe(true);
    expect(m.companies.filter((c) => c.bankruptDay === null)).toHaveLength(before);
    expect(m.companies.filter((c) => c.kind === 'ai' && c.bankruptDay !== null)).toHaveLength(1);
    expect(joinMarket(m, 'u2', 'もう一度').company!.id).toBe(j.company!.id);
    for (const u of ['u3', 'u4', 'u5']) joinMarket(m, u, u);
    expect(m.companies.filter((c) => c.kind === 'player')).toHaveLength(4);
    expect(joinMarket(m, 'u6', 'u6').ok).toBe(false);
    // 撤退した企業の店は取り合いに入らない
    advanceMarketDay(m);
    const gone = m.companies.find((c) => c.kind === 'ai' && c.bankruptDay !== null)!;
    expect([...competitionFactors(m).keys()].some((k) => k.startsWith(`${gone.id}:`))).toBe(false);
  });

  it('期限を過ぎた未払金を払えない企業は、融資を受けても足りなければ破産して市場から消える', () => {
    const m = mk();
    advanceMarketDay(m);
    const c = m.companies[1]!;
    c.state.money = 0;
    c.state.loans.push({ id: 'L', principal: 1, remaining: 1, dailyRate: 0, dailyPayment: 1, takenDay: 1 });
    c.state.arrears.push({ id: 'a', amount: 5_000_000, reason: 'テスト', sinceDay: 1, dueDay: 1 });
    advanceMarketDay(m);
    expect(c.bankruptDay).toBe(2);
    expect(m.decisions.some((d) => d.companyId === c.id && d.text.includes('破産'))).toBe(true);
  });

  it('AI 企業は理由つきで意思決定する（値段・人・拡張）', { timeout: 60_000 }, () => {
    const m = mk(3, false);
    advanceMarketTo(m, 30);
    const texts = m.decisions.map((d) => d.text);
    expect(texts.some((t) => t.includes('雇いました'))).toBe(true);
    expect(texts.some((t) => t.includes('値下げ') || t.includes('値上げ'))).toBe(true);
    for (const d of m.decisions) expect(d.text.length).toBeGreaterThan(8);
  });
});
