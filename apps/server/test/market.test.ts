// オンライン市場（MarketRoom Durable Object と API）。
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { DORMANT_MS, type MarketRoom } from '../src/market';
import { callJson, newPlayer, type TestPlayer } from './helpers';

function stub(id: string) {
  return env.MARKETS.get(env.MARKETS.idFromName(id));
}
const inMarket = <R>(id: string, fn: (m: MarketRoom) => R | Promise<R>) => runInDurableObject(stub(id), (x: MarketRoom) => fn(x));

async function create(p: TestPlayer, companyName = '一号店') {
  const r = await callJson<{ marketId: string; code: string }>('/api/v1/market/create', { token: p.token, body: { name: '友達の市場', companyName } });
  expect(r.status).toBe(201);
  return r.body;
}

type View = {
  day: number;
  code: string;
  joined: boolean;
  companies: { name: string; kind: string; mine: boolean; share: number }[];
  mine: { companyId: string; state: { money: number; company: { stores: { id: string; policy: { priceMult: number } }[] } } } | null;
  clock: { day: number; nextDayAt: number; dayMs: number; serverNow: number };
};

describe('オンライン市場（Phase 3+4 のサーバー）', () => {
  it('市場を作ると、作った人の企業と AI 5社の6社で始まり、招待コードで友達が入れる（AI が1社撤退する）', async () => {
    const a = await newPlayer('アキラ');
    const m = await create(a);
    expect(m.code).toMatch(/^[A-Z2-9]{6}$/);
    const v = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    expect(v.status).toBe(200);
    expect(v.body.companies).toHaveLength(6);
    expect(v.body.companies.filter((c) => c.kind === 'ai')).toHaveLength(5);
    expect(v.body.mine?.state.money).toBe(300_000);
    expect(v.body.joined).toBe(true);
    // 参加していない人は見られない
    const b = await newPlayer('ベン');
    expect((await callJson(`/api/v1/market/${m.marketId}`, { token: b.token })).status).toBe(404);
    // 招待コードで参加
    const j = await callJson<{ marketId: string; companyId: string }>('/api/v1/market/join', { token: b.token, body: { code: m.code.toLowerCase(), companyName: 'ベン屋' } });
    expect(j.status).toBe(200);
    expect(j.body.marketId).toBe(m.marketId);
    const v2 = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: b.token });
    expect(v2.body.companies.filter((c) => c.kind === 'player').map((c) => c.name).sort()).toEqual(['ベン屋', '一号店']);
    // 撤退した AI を除いて6社
    const live = await inMarket(m.marketId, (x) => x.market!.companies.filter((c) => c.bankruptDay === null).length);
    expect(live).toBe(6);
    // 一覧
    const list = await callJson<{ markets: { marketId: string }[] }>('/api/v1/markets', { token: b.token });
    expect(list.body.markets.map((x) => x.marketId)).toContain(m.marketId);
    // 間違ったコード
    expect((await callJson('/api/v1/market/join', { token: b.token, body: { code: 'ZZZZZZ', companyName: 'x' } })).status).toBe(404);
  });

  it('市場の日はサーバーの時計で進む。アクセスしたときに、過ぎた日をまとめて計算する（同じ日を二度計算しない）', async () => {
    const a = await newPlayer('時計');
    const m = await create(a);
    // 市場の開始を5日と少し前にずらす（時計が進んだのと同じ）
    await inMarket(m.marketId, (x) => {
      x.meta!.startedAt -= x.meta!.dayMs * 5 + 1000;
    });
    const v = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    expect(v.body.day).toBe(5);
    expect(v.body.clock.nextDayAt).toBeGreaterThan(v.body.clock.serverNow);
    // もう一度見ても日は進まない（同じ時刻の範囲なら二度計算しない）
    const v2 = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    expect(v2.body.day).toBe(5);
    const hist = await inMarket(m.marketId, (x) => x.market!.companies[0]!.state.company.history.map((r) => r.day));
    expect(hist).toEqual([1, 2, 3, 4, 5]);
    // アラームでも追いつく
    await inMarket(m.marketId, (x) => {
      x.meta!.startedAt -= x.meta!.dayMs * 2;
    });
    expect(await runDurableObjectAlarm(stub(m.marketId))).toBe(true);
    expect(await inMarket(m.marketId, (x) => x.market!.day - 1)).toBe(7);
  });

  it('長くだれもアクセスしなかった市場は、眠っていた分の時間を数えない', async () => {
    const a = await newPlayer('眠り');
    const m = await create(a);
    await inMarket(m.marketId, (x) => {
      const ms = DORMANT_MS + 30 * x.meta!.dayMs;
      x.meta!.startedAt -= ms;
      x.meta!.lastAccessAt -= ms;
    });
    const v = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    // 眠る前（DORMANT_MS の間）の日だけ進む
    expect(v.body.day).toBe(Math.floor(DORMANT_MS / v.body.clock.dayMs));
  });

  it('経営の操作は市場の規則で検証し、同じ cid の操作は二度適用しない。日を進める操作は使えない', async () => {
    const a = await newPlayer('操作');
    const m = await create(a);
    const v = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    const storeId = v.body.mine!.state.company.stores[0]!.id;
    const act = (cid: string, action: unknown) => callJson<{ ok: boolean; reason?: string; duplicate?: boolean }>(`/api/v1/market/${m.marketId}/act`, { token: a.token, body: { cid, action } });
    const r1 = await act('c-1', { type: 'setStorePolicy', storeId, policy: { priceMult: 1.1 } });
    expect(r1.body.ok).toBe(true);
    const r2 = await act('c-1', { type: 'setStorePolicy', storeId, policy: { priceMult: 0.9 } });
    expect(r2.body.duplicate).toBe(true);
    const pm = await inMarket(m.marketId, (x) => x.market!.companies[0]!.state.company.stores[0]!.policy.priceMult);
    expect(pm).toBe(1.1);
    const r3 = await act('c-2', { type: 'nextDay' });
    expect(r3.body.ok).toBe(false);
    expect(r3.body.reason).toContain('市場では使えない');
    const bad = await act('c-3', { type: 'setStorePolicy', storeId, policy: { evil: 1 } });
    expect(bad.status).toBe(400);
    // 参加していない人は操作できない
    const b = await newPlayer('よそ者');
    expect((await callJson(`/api/v1/market/${m.marketId}/act`, { token: b.token, body: { cid: 'x', action: { type: 'takeLoan' } } })).status).toBe(404);
  });

  it('市場の状態は保存され、Durable Object が作り直されても同じ状態で続く', async () => {
    const a = await newPlayer('保存');
    const m = await create(a);
    await inMarket(m.marketId, (x) => {
      x.meta!.startedAt -= x.meta!.dayMs * 3 + 500;
    });
    const v = await callJson<View>(`/api/v1/market/${m.marketId}`, { token: a.token });
    expect(v.body.day).toBe(3);
    const before = await inMarket(m.marketId, (x) => JSON.stringify(x.market));
    // 保存した断片から読み直す
    const after = await inMarket(m.marketId, (x) => {
      (x as unknown as { load(): void }).load();
      return JSON.stringify(x.market);
    });
    expect(after).toBe(before);
  });
});
