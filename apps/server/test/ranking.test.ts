// 企業間ランキングと報酬（docs/MARKET_RANKING_PLAN.md。仕様書 5 章・12章 14〜17）。
import { addDays, autoPlayDay, jstDateKey, jstMidnight, scopeKey, weekdayOfKey, type GameState } from '@jiro/core';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { MarketRoom } from '../src/market';
import { grantCommunityRewards, grantGlobalRewards, scopesEndingOn } from '../src/rank-store';
import { computeRanking, type RankAggRow } from '../src/ranking';
import { callJson, newPlayer, type TestPlayer } from './helpers';

const stub = (id: string) => env.MARKETS.get(env.MARKETS.idFromName(id));
const inMarket = <R>(id: string, fn: (m: MarketRoom) => R | Promise<R>) => runInDurableObject(stub(id), (x: MarketRoom) => fn(x));

function row(p: Partial<RankAggRow> & { company_id: string }): RankAggRow {
  return {
    scope_key: 'W2026-11-02',
    market_id: 'm1',
    entry: 'grown',
    kind: 'player',
    player_id: `p-${p.company_id}`,
    name: p.company_id,
    days: 5,
    manual_days: 5,
    flagged_days: 0,
    net_sales: 100_000,
    operating_profit: 10_000,
    final_profit: 9_000,
    sat_sum: 4,
    sat_count: 5,
    market_net_sales: 300_000,
    emp_sat_sum: 3.5,
    emp_sat_days: 5,
    quality_sum: 3,
    quality_days: 5,
    value_start: 300_000,
    value_end: 330_000,
    ...p,
  };
}

describe('ランキングの計算', () => {
  it('コミュニティ内は合計、全体はゲーム内の1日あたりで比べる（同じ値は同じ順位）', () => {
    const rows = [row({ company_id: 'a', net_sales: 500_000, days: 10 }), row({ company_id: 'b', net_sales: 300_000, days: 3 }), row({ company_id: 'c', net_sales: 300_000, days: 3 })];
    const c = computeRanking(rows, 'community', 'sales');
    expect(c.map((x) => [x.companyId, x.rank])).toEqual([['a', 1], ['b', 2], ['c', 2]]);
    const g = computeRanking(rows, 'grown', 'sales');
    expect(g.map((x) => x.companyId)).toEqual(['b', 'c', 'a']);
    expect(g[0]!.value).toBeCloseTo(100_000, 6);
  });

  it('企業価値成長率は (終わり − 始め) ÷ max(|始め|, 初期資金)。市場シェアは純売上 ÷ 市場全体', () => {
    const rows = [row({ company_id: 'a', value_start: 300_000, value_end: 450_000 }), row({ company_id: 'b', value_start: 100_000, value_end: 200_000 })];
    const g = computeRanking(rows, 'community', 'growth');
    expect(g[0]!.companyId).toBe('a');
    expect(g[0]!.value).toBeCloseTo(0.5, 6);
    expect(g[1]!.value).toBeCloseTo(100_000 / 300_000, 6);
    const s = computeRanking([row({ company_id: 'x', net_sales: 60_000, market_net_sales: 200_000 })], 'community', 'share');
    expect(s[0]!.value).toBeCloseTo(0.3, 6);
  });

  it('総合評価は8種別の順位を同じ重みで平均（値のない種別は最下位）。確定した日がない企業は入らない', () => {
    const rows = [
      row({ company_id: 'a', net_sales: 900_000, operating_profit: 90_000, final_profit: 80_000 }),
      row({ company_id: 'b', sat_count: 0, sat_sum: 0 }),
      row({ company_id: 'z', days: 0 }),
    ];
    const o = computeRanking(rows, 'community', 'overall');
    expect(o.map((x) => x.companyId)).toEqual(['a', 'b']);
    expect(o[0]!.value).toBeLessThan(o[1]!.value);
  });

  it('期間が終わる日（週は日曜・月は末日・年は12月31日）', () => {
    expect(scopesEndingOn('2026-11-08')).toEqual(['W2026-11-02']);
    expect(scopesEndingOn('2026-11-30')).toEqual(['M2026-11']);
    expect(scopesEndingOn('2026-12-31')).toEqual(['M2026-12', 'Y2026']);
    expect(scopesEndingOn('2027-01-03')).toEqual(['W2026-12-28']);
    expect(scopesEndingOn('2026-11-04')).toEqual([]);
  });
});

async function create(p: TestPlayer) {
  const r = await callJson<{ marketId: string }>('/api/v1/market/create', { token: p.token, body: { name: 'ランキング', companyName: `${p.name}亭` } });
  expect(r.status).toBe(201);
  return r.body.marketId;
}

async function setClock(id: string, target: number) {
  await inMarket(id, (x) => {
    x.skewMs = target - Date.now();
  });
}

async function playDay(p: TestPlayer, id: string) {
  const v = await callJson<{ mine: { state: GameState; progress: { stateVersion: number } } }>(`/api/v1/market/${id}`, { token: p.token });
  const token = `tok-${Math.random().toString(36).slice(2, 12)}`;
  const st = await callJson<{ ticket: { gameDate: number; demand: Record<string, number> } }>(`/api/v1/market/${id}/day/start`, { token: p.token, body: { token, baseVersion: v.body.mine.progress.stateVersion } });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const s = v.body.mine.state;
  autoPlayDay(s, st.body.ticket.gameDate, st.body.ticket.demand, { allowLoan: false });
  const c = await callJson<{ ok: boolean }>(`/api/v1/market/${id}/day/commit`, { token: p.token, body: { token, state: s } });
  expect(c.body.ok).toBe(true);
}

describe('ランキングの集計と API（12章 14・15・17）', () => {
  it('0時の同期で週・月・年・累計の集計ができ、同じ期間を二度書いても二重に数えない。日曜で週が終わると上位に称号', async () => {
    const a = await newPlayer('一位');
    const id = await create(a);
    // 次の日曜日（JST）の10時に3日営業する
    const today = jstDateKey(Date.now());
    let sunday = today;
    while (weekdayOfKey(sunday) !== 0) sunday = addDays(sunday, 1);
    await setClock(id, jstMidnight(sunday) + 10 * 3_600_000);
    for (let i = 0; i < 3; i++) await playDay(a, id);
    // 月曜の0時1分: 同期 → 集計 → 週が終わったので称号
    await setClock(id, jstMidnight(addDays(sunday, 1)) + 60_000);
    expect(await runDurableObjectAlarm(stub(id))).toBe(true);
    const week = scopeKey('week', sunday);
    const agg = await env.DB.prepare('SELECT scope_key, company_id, days, net_sales FROM rank_agg WHERE market_id = ? ORDER BY scope_key, company_id').bind(id).all<{ scope_key: string; company_id: string; days: number; net_sales: number }>();
    const keys = new Set(agg.results.map((r) => r.scope_key));
    expect(keys).toEqual(new Set([week, scopeKey('month', sunday), scopeKey('year', sunday), 'T']));
    const mine = agg.results.find((r) => r.scope_key === week && r.company_id === 'c1')!;
    expect(mine.days).toBe(3);
    // 同じ期間の集計をもう一度書いても同じ値（二重に数えない）
    const before = JSON.stringify(agg.results);
    await inMarket(id, async (x) => {
      const w = x as unknown as { writePeriod(p: string, now: number): Promise<void>; market: { sync: unknown } };
      w.market.sync = { periodId: sunday, status: 'ranking', targetDate: 3, startedAt: 0, closeDeadline: 0, finishedAt: null, autoDays: 0, expiredDays: 0 };
      await w.writePeriod(sunday, Date.now());
      w.market.sync = null;
    });
    const again = await env.DB.prepare('SELECT scope_key, company_id, days, net_sales FROM rank_agg WHERE market_id = ? ORDER BY scope_key, company_id').bind(id).all();
    expect(JSON.stringify(again.results)).toBe(before);
    // 称号（コミュニティの総合の上位3社）。何度渡しても1つ
    const rw = await callJson<{ rewards: { title: string; scopeKey: string }[] }>('/api/v1/rewards', { token: a.token });
    expect(rw.body.rewards.filter((x) => x.scopeKey === week)).toHaveLength(1);
    // 総合評価は AI 企業も含めた順位。上位3社に入ったプレイヤー企業に称号
    expect(rw.body.rewards[0]!.title).toMatch(/総合[123]位/);
    await grantCommunityRewards(env.DB, id, sunday, Date.now());
    const rw2 = await callJson<{ rewards: unknown[] }>('/api/v1/rewards', { token: a.token });
    expect(rw2.body.rewards).toHaveLength(rw.body.rewards.length);
    // ランキングの API（コミュニティ・全体）
    const r = await callJson<{ rows: { companyId: string; rank: number; mine: boolean }[]; mine: { rank: number }[]; total: number; perDay: boolean }>(
      `/api/v1/rankings?board=community&marketId=${id}&scope=week&date=${sunday}&metric=sales`,
      { token: a.token },
    );
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(6);
    expect(r.body.perDay).toBe(false);
    expect(r.body.mine).toHaveLength(1);
    expect(r.body.rows.some((x) => x.mine)).toBe(true);
    const g = await callJson<{ rows: unknown[]; perDay: boolean }>(`/api/v1/rankings?board=grown&scope=week&date=${sunday}&metric=overall`, { token: a.token });
    expect(g.status).toBe(200);
    expect(g.body.perDay).toBe(true);
    expect(g.body.rows.length).toBeGreaterThan(0);
    // 全体の称号（定時の処理。昨日で終わった週）。二度呼んでも同じ
    const n1 = await grantGlobalRewards(env.DB, addDays(sunday, 1), Date.now());
    expect(n1).toBeGreaterThan(0);
    await grantGlobalRewards(env.DB, addDays(sunday, 1), Date.now());
    const rw3 = await callJson<{ rewards: { key: string }[] }>('/api/v1/rewards', { token: a.token });
    expect(new Set(rw3.body.rewards.map((x) => x.key)).size).toBe(rw3.body.rewards.length);
  });

  it('参加していないコミュニティのランキングは見られない。指定が不正なら断る', async () => {
    const a = await newPlayer('持ち主');
    const id = await create(a);
    const b = await newPlayer('よそ者');
    expect((await callJson(`/api/v1/rankings?board=community&marketId=${id}&scope=week`, { token: b.token })).status).toBe(404);
    expect((await callJson('/api/v1/rankings?board=nope&scope=week', { token: b.token })).status).toBe(400);
    expect((await callJson('/api/v1/rankings?board=fresh&scope=decade', { token: b.token })).status).toBe(400);
    expect((await callJson('/api/v1/rankings?board=fresh&scope=week&metric=luck', { token: b.token })).status).toBe(400);
  });
});
