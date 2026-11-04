// 共通市場（MarketRoom Durable Object と API。docs/MARKET_RANKING_PLAN.md）。
import { addDays, autoPlayDay, canonicalJson, checksum, jstDateKey, jstMidnight, type GameState } from '@jiro/core';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { MarketRoom } from '../src/market';
import { callJson, newPlayer, type TestPlayer } from './helpers';

function stub(id: string) {
  return env.MARKETS.get(env.MARKETS.idFromName(id));
}
const inMarket = <R>(id: string, fn: (m: MarketRoom) => R | Promise<R>) => runInDurableObject(stub(id), (x: MarketRoom) => fn(x));

async function create(p: TestPlayer, companyName = '一号店', settings?: Record<string, unknown>) {
  const r = await callJson<{ marketId: string; code: string }>('/api/v1/market/create', { token: p.token, body: { name: '友達の市場', companyName, settings } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

type View = {
  day: number;
  code: string;
  joined: boolean;
  today: string;
  leaderDay: number;
  commonMarketDate: number;
  settings: { maxCompanies: number; aiFill: boolean; entry: string; endsAt: number | null };
  companies: { name: string; kind: string; mine: boolean; share: number; lastDay: number; status: string }[];
  mine: { companyId: string; state: GameState; progress: { stateVersion: number; lastProcessedGameDate: number; manualProgressDays: number } } | null;
  clock: { serverNow: number; nextMidnight: number; nextSyncAt: number | null; syncPending: boolean };
  pendingPeriods: string[];
};
type Ticket = { token: string; gameDate: number; periodId: string; demand: Record<string, number>; resumed: boolean };
type Commit = { ok: boolean; code?: string; reject?: string[]; flags?: string[]; duplicate?: boolean; gameDate?: number; stateVersion?: number };

const view = (p: TestPlayer, id: string) => callJson<View>(`/api/v1/market/${id}`, { token: p.token });
let seq = 0;
const newToken = () => `tok-${Date.now().toString(36)}-${++seq}`;

/** 端末の代わりに1日を営業して送る（日の始め → 店長の営業で1日 → 確定） */
async function playDay(p: TestPlayer, id: string, tamper?: (s: GameState) => void) {
  const v = await view(p, id);
  const token = newToken();
  const st = await callJson<{ ok: boolean; ticket: Ticket }>(`/api/v1/market/${id}/day/start`, { token: p.token, body: { token, baseVersion: v.body.mine!.progress.stateVersion } });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const s = v.body.mine!.state;
  autoPlayDay(s, st.body.ticket.gameDate, st.body.ticket.demand, { allowLoan: false });
  tamper?.(s);
  const c = await callJson<Commit>(`/api/v1/market/${id}/day/commit`, { token: p.token, body: { token, state: s } });
  return { ticket: st.body.ticket, commit: c };
}

/** Durable Object の時計を、今から見た JST の時刻に合わせる（dayOffset 日後の h 時 m 分） */
async function setClock(id: string, dayOffset: number, h: number, min = 0) {
  const today = jstDateKey(Date.now());
  const target = jstMidnight(addDays(today, dayOffset)) + h * 3_600_000 + min * 60_000;
  await inMarket(id, (x) => {
    x.skewMs = target - Date.now();
  });
  return { today, target };
}

describe('共通市場のサーバー: 作る・参加する', () => {
  it('作った人の企業と AI 5社で始まり、招待コードで友達が入れる（AI が1社撤退する）。D1 に企業と設定を記録する', async () => {
    const a = await newPlayer('アキラ');
    const m = await create(a);
    expect(m.code).toMatch(/^[A-Z2-9]{6}$/);
    const v = await view(a, m.marketId);
    expect(v.status).toBe(200);
    expect(v.body.companies).toHaveLength(6);
    expect(v.body.mine?.state.money).toBe(300_000);
    expect(v.body.mine?.state.phase).toBe('prep');
    expect(v.body.settings.maxCompanies).toBe(6);
    const b = await newPlayer('ベン');
    expect((await view(b, m.marketId)).status).toBe(404);
    const j = await callJson<{ marketId: string; companyId: string }>('/api/v1/market/join', { token: b.token, body: { code: m.code.toLowerCase(), companyName: 'ベン屋' } });
    expect(j.status).toBe(200);
    const v2 = await view(b, m.marketId);
    expect(v2.body.companies.filter((c) => c.kind === 'player').map((c) => c.name).sort()).toEqual(['ベン屋', '一号店']);
    expect(v2.body.companies.filter((c) => c.status === 'active')).toHaveLength(6);
    const rows = await env.DB.prepare('SELECT player_id, name, status FROM market_companies WHERE market_id = ? ORDER BY name').bind(m.marketId).all<{ player_id: string; name: string; status: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(['ベン屋', '一号店']);
    const cm = await env.DB.prepare('SELECT entry, ai_fill, max_companies FROM communities WHERE market_id = ?').bind(m.marketId).first<{ entry: string; ai_fill: number; max_companies: number }>();
    expect(cm).toEqual({ entry: 'grown', ai_fill: 1, max_companies: 6 });
    const list = await callJson<{ markets: { marketId: string }[] }>('/api/v1/markets', { token: b.token });
    expect(list.body.markets.map((x) => x.marketId)).toContain(m.marketId);
    expect((await callJson('/api/v1/market/join', { token: b.token, body: { code: 'ZZZZZZ', companyName: 'x' } })).status).toBe(404);
  });

  it('作る人が設定を決める（AI なし・社数・期間・新規の企業だけ）。範囲外は断る', async () => {
    const a = await newPlayer('設定');
    const m = await create(a, '一号店', { aiFill: false, maxCompanies: 3, periodDays: 30, entry: 'fresh', visibility: 'public' });
    const v = await view(a, m.marketId);
    expect(v.body.companies.map((c) => c.kind)).toEqual(['player']);
    expect(v.body.settings).toMatchObject({ maxCompanies: 3, aiFill: false, entry: 'fresh' });
    expect(v.body.settings.endsAt).toBe(jstMidnight(addDays(jstDateKey(v.body.clock.serverNow), 30)));
    for (const bad of [{ maxCompanies: 7 }, { maxCompanies: 1 }, { periodDays: 45 }, { entry: 'x' }, { aiFill: 'yes' }]) {
      const r = await callJson('/api/v1/market/create', { token: a.token, body: { name: 'x', companyName: 'y', settings: bad } });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('1人が持てる市場の企業は5社まで', async () => {
    const a = await newPlayer('五社');
    const owner = await newPlayer('持ち主');
    const other = await create(owner);
    for (let i = 0; i < 5; i++) await create(a, `店${i}`);
    const r = await callJson<{ error: string }>('/api/v1/market/join', { token: a.token, body: { code: other.code, companyName: '六社目' } });
    expect(r.status).toBe(409);
    expect((r.body as unknown as { code: string }).code).toBe('too_many_companies');
  });
});

describe('共通市場のサーバー: 端末の1日と0時の同期', () => {
  it('日の始めに条件をもらい、日の終わりに送る。送り直しは二度数えない。古い版からは始められない', async () => {
    const a = await newPlayer('一日');
    const m = await create(a);
    const { ticket, commit } = await playDay(a, m.marketId);
    expect(ticket.gameDate).toBe(1);
    expect(commit.body.ok).toBe(true);
    expect(commit.body.gameDate).toBe(1);
    const v = await view(a, m.marketId);
    expect(v.body.mine!.progress.lastProcessedGameDate).toBe(1);
    expect(v.body.mine!.progress.manualProgressDays).toBe(1);
    expect(v.body.leaderDay).toBe(1);
    expect(v.body.pendingPeriods).toEqual([v.body.today]);
    // 同じ token の送り直し
    const again = await callJson<Commit>(`/api/v1/market/${m.marketId}/day/commit`, { token: a.token, body: { token: ticket.token, state: v.body.mine!.state } });
    expect(again.body.duplicate).toBe(true);
    expect((await view(a, m.marketId)).body.mine!.progress.manualProgressDays).toBe(1);
    // 古い版
    const stale = await callJson<{ code: string }>(`/api/v1/market/${m.marketId}/day/start`, { token: a.token, body: { token: newToken(), baseVersion: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('stale');
    // 参加していない人
    const b = await newPlayer('よそ者');
    expect((await callJson(`/api/v1/market/${m.marketId}/day/start`, { token: b.token, body: { token: newToken(), baseVersion: 1 } })).status).toBe(404);
  });

  it('前の日から説明できない状態は受け取らず、監査記録に残す', async () => {
    const a = await newPlayer('改ざん');
    const m = await create(a);
    const { commit } = await playDay(a, m.marketId, (s) => {
      s.money += 1_000_000;
    });
    expect(commit.body.ok).toBe(false);
    expect(commit.body.code).toBe('rejected');
    const v = await view(a, m.marketId);
    expect(v.body.mine!.progress.lastProcessedGameDate).toBe(0);
    expect(v.body.mine!.state.money).toBe(300_000);
    // 監査記録（waitUntil のあと）
    let row: { detail: string } | null = null;
    for (let i = 0; i < 20 && !row; i++) {
      row = await env.DB.prepare("SELECT detail FROM audit_log WHERE kind = 'market_day_rejected' AND player_id = ?").bind(a.playerId).first<{ detail: string }>();
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).not.toBeNull();
    expect(row!.detail).toContain('お金');
  });

  it('0時を過ぎたら、いちばん進んだ企業の日付まで全社をそろえ、期間の集計を D1 に書く（アラーム）', async () => {
    const a = await newPlayer('同期');
    const m = await create(a);
    for (let i = 0; i < 3; i++) expect((await playDay(a, m.marketId)).commit.body.ok).toBe(true);
    const before = await view(a, m.marketId);
    const period = before.body.today;
    expect(before.body.clock.nextSyncAt).toBe(before.body.clock.nextMidnight);
    await setClock(m.marketId, 1, 0, 1);
    expect(await runDurableObjectAlarm(stub(m.marketId))).toBe(true);
    const v = await view(a, m.marketId);
    expect(v.body.commonMarketDate).toBe(3);
    expect(v.body.companies.filter((c) => c.status === 'active').every((c) => c.lastDay === 3)).toBe(true);
    expect(v.body.pendingPeriods).toEqual([]);
    expect(v.body.clock.syncPending).toBe(false);
    const rows = await env.DB.prepare('SELECT company_id, kind, days, manual_days, auto_days, net_sales FROM company_periods WHERE market_id = ? AND period = ? ORDER BY company_id').bind(m.marketId, period).all<{
      company_id: string;
      kind: string;
      days: number;
      manual_days: number;
      auto_days: number;
      net_sales: number;
    }>();
    expect(rows.results).toHaveLength(6);
    const mine = rows.results.find((r) => r.kind === 'player')!;
    expect(mine.manual_days).toBe(3);
    expect(rows.results.filter((r) => r.kind === 'ai').every((r) => r.auto_days === 3 && r.days === 3 && r.net_sales > 0)).toBe(true);
    const run = await env.DB.prepare('SELECT target_date, auto_days FROM sync_runs WHERE market_id = ? AND period = ?').bind(m.marketId, period).first<{ target_date: number; auto_days: number }>();
    expect(run).toEqual({ target_date: 3, auto_days: 15 });
    // 二重に実行しても進みすぎない
    await runDurableObjectAlarm(stub(m.marketId));
    expect((await view(a, m.marketId)).body.commonMarketDate).toBe(3);
    // 新しい期間はすぐ遊べる
    expect((await playDay(a, m.marketId)).commit.body.ok).toBe(true);
  });

  it('アラームが遅れても、0時のあとの最初の要求で同期してから答える', async () => {
    const a = await newPlayer('遅れ');
    const m = await create(a);
    await playDay(a, m.marketId);
    await setClock(m.marketId, 1, 0, 5);
    const v = await view(a, m.marketId);
    expect(v.body.commonMarketDate).toBe(1);
    expect(v.body.clock.syncPending).toBe(false);
  });

  it('0時に営業中の日は、届くまで待って前の期間に数える（30分を過ぎたら無効）', async () => {
    const a = await newPlayer('深夜');
    const m = await create(a);
    const { today } = await setClock(m.marketId, 0, 23, 55);
    const v = await view(a, m.marketId);
    const token = newToken();
    const st = await callJson<{ ticket: Ticket }>(`/api/v1/market/${m.marketId}/day/start`, { token: a.token, body: { token, baseVersion: v.body.mine!.progress.stateVersion } });
    expect(st.body.ticket.periodId).toBe(today);
    // 0時5分: 待っている（新しい日は始められない）
    await setClock(m.marketId, 1, 0, 5);
    await runDurableObjectAlarm(stub(m.marketId));
    const w = await view(a, m.marketId);
    expect(w.body.clock.syncPending).toBe(true);
    expect(w.body.commonMarketDate).toBe(0);
    const alarm = await inMarket(m.marketId, (x) => (x as unknown as { ctx: DurableObjectState }).ctx.storage.getAlarm());
    expect(alarm).toBe(jstMidnight(addDays(today, 1)) + 30 * 60_000);
    // 0時10分に届く → 前の期間に数えて、そのまま同期が終わる
    await setClock(m.marketId, 1, 0, 10);
    const s = v.body.mine!.state;
    autoPlayDay(s, 1, st.body.ticket.demand, { allowLoan: false });
    const c = await callJson<Commit>(`/api/v1/market/${m.marketId}/day/commit`, { token: a.token, body: { token, state: s } });
    expect(c.body.ok).toBe(true);
    const done = await view(a, m.marketId);
    expect(done.body.commonMarketDate).toBe(1);
    expect(done.body.clock.syncPending).toBe(false);
    const row = await env.DB.prepare('SELECT manual_days FROM company_periods WHERE market_id = ? AND period = ? AND kind = ?').bind(m.marketId, today, 'player').first<{ manual_days: number }>();
    expect(row?.manual_days).toBe(1);
  });

  it('30分を過ぎても届かない日は無効になり、あとから送っても受け取らない', async () => {
    const a = await newPlayer('寝落ち');
    const m = await create(a);
    await setClock(m.marketId, 0, 23, 50);
    const v = await view(a, m.marketId);
    const token = newToken();
    await callJson(`/api/v1/market/${m.marketId}/day/start`, { token: a.token, body: { token, baseVersion: v.body.mine!.progress.stateVersion } });
    await setClock(m.marketId, 1, 0, 31);
    await runDurableObjectAlarm(stub(m.marketId));
    const s = v.body.mine!.state;
    autoPlayDay(s, 1, {}, { allowLoan: false });
    const c = await callJson<Commit>(`/api/v1/market/${m.marketId}/day/commit`, { token: a.token, body: { token, state: s } });
    expect(c.body.ok).toBe(false);
    expect(c.body.code).toBe('no_open_day');
    expect((await view(a, m.marketId)).body.mine!.progress.lastProcessedGameDate).toBe(0);
  });
});

describe('共通市場のサーバー: 操作・保存・移行', () => {
  it('経営の操作は市場の規則で検証し、同じ cid の操作は二度適用しない', async () => {
    const a = await newPlayer('操作');
    const m = await create(a);
    const v = await view(a, m.marketId);
    const storeId = v.body.mine!.state.company.stores[0]!.id;
    const act = (cid: string, action: unknown) => callJson<{ ok: boolean; reason?: string; duplicate?: boolean }>(`/api/v1/market/${m.marketId}/act`, { token: a.token, body: { cid, action } });
    expect((await act('c-1', { type: 'setStorePolicy', storeId, policy: { priceMult: 1.1 } })).body.ok).toBe(true);
    expect((await act('c-1', { type: 'setStorePolicy', storeId, policy: { priceMult: 0.9 } })).body.duplicate).toBe(true);
    const after = await view(a, m.marketId);
    expect(after.body.mine!.state.company.stores[0]!.policy.priceMult).toBe(1.1);
    expect(after.body.mine!.progress.stateVersion).toBe(v.body.mine!.progress.stateVersion + 1);
    expect((await act('c-2', { type: 'nextDay' })).body.reason).toContain('市場では使えない');
    expect((await act('c-3', { type: 'setStorePolicy', storeId, policy: { evil: 1 } })).status).toBe(400);
  });

  it('市場の状態は企業ごとに保存され、Durable Object が作り直されても同じ状態で続く', async () => {
    const a = await newPlayer('保存');
    const m = await create(a);
    await playDay(a, m.marketId);
    const before = await inMarket(m.marketId, (x) => canonicalJson(x.market));
    const after = await inMarket(m.marketId, (x) => {
      (x as unknown as { load(): void }).load();
      return canonicalJson(x.market);
    });
    expect(after).toBe(before);
  });

  it('古い形（schema 1。600秒ごとに1日の時計）の市場を読み込むと、企業を消さずに新しい形にする', async () => {
    const a = await newPlayer('移行');
    const m = await create(a);
    // 新しい形の市場の中身から、古い保存の形を作る
    const legacy = await inMarket(m.marketId, (x) => {
      const mk = x.market!;
      const old = {
        schema: 1,
        id: mk.id,
        name: mk.name,
        seed: mk.seed,
        day: 1,
        companies: mk.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, ownerId: c.ownerId, strategy: c.strategy, homeArea: c.homeArea, joinedDay: 1, bankruptDay: null, state: { ...c.state, phase: 'closed' }, memory: c.memory })),
        decisions: [],
        history: [],
      };
      const text = JSON.stringify({ market: old, cids: {} });
      const storage = (x as unknown as { ctx: DurableObjectState }).ctx.storage;
      const sql = storage.sql;
      storage.transactionSync(() => {
        sql.exec('DELETE FROM chunks');
        sql.exec("DELETE FROM kv WHERE k LIKE 'blob:%'");
        sql.exec('CREATE TABLE IF NOT EXISTS market_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)');
        sql.exec('INSERT INTO market_chunks (idx, data) VALUES (0, ?)', text);
        sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('market', ?)", JSON.stringify({ n: 1, sum: checksum(text), length: text.length }));
      });
      (x as unknown as { load(): void }).load();
      return { companies: x.market!.companies.length, schema: x.market!.schema, phase: x.market!.companies[0]!.state.phase };
    });
    expect(legacy).toEqual({ companies: 6, schema: 2, phase: 'prep' });
    const v = await view(a, m.marketId);
    expect(v.status).toBe(200);
    expect(v.body.mine!.state.money).toBe(300_000);
    // 古い保存は消え、新しい形で読み直せる
    const again = await inMarket(m.marketId, (x) => {
      (x as unknown as { load(): void }).load();
      return x.market!.schema;
    });
    expect(again).toBe(2);
  });
});
