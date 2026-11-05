// コミュニティ（公開の一覧・育てた会社の持ち込み・引退・大会の称号）のサーバー（仕様書 6.2・12章 16。オーナーの判断 15〜18）
import { addDays, autoPlayDay, jstDateKey, jstMidnight, type GameState } from '@jiro/core';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { MarketRoom } from '../src/market';
import { grantEndedCommunities } from '../src/rank-store';
import { callJson, newPlayer, settleMarketSync, type TestPlayer } from './helpers';

const stub = (id: string) => env.MARKETS.get(env.MARKETS.idFromName(id));
const inMarket = <R>(id: string, fn: (m: MarketRoom) => R | Promise<R>) => runInDurableObject(stub(id), (x: MarketRoom) => fn(x));

type View = {
  commonMarketDate: number;
  settings: { entry: string; endsAt: number | null };
  ended?: boolean;
  myStatus: string | null;
  companies: { name: string; kind: string; mine: boolean; status: string }[];
  mine: { companyId: string; state: GameState; progress: { stateVersion: number; lastProcessedGameDate: number } } | null;
};
type Ticket = { token: string; gameDate: number; demand: Record<string, number> };

async function create(p: TestPlayer, companyName: string, settings?: Record<string, unknown>) {
  const r = await callJson<{ marketId: string; code: string }>('/api/v1/market/create', { token: p.token, body: { name: `${companyName}の市場`, companyName, settings } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
const view = (p: TestPlayer, id: string) => callJson<View>(`/api/v1/market/${id}`, { token: p.token });
let seq = 0;

async function playDay(p: TestPlayer, id: string) {
  const v = await view(p, id);
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const token = `cm-${Date.now().toString(36)}-${++seq}`;
  const st = await callJson<{ ticket: Ticket }>(`/api/v1/market/${id}/day/start`, { token: p.token, body: { token, baseVersion: v.body.mine!.progress.stateVersion } });
  expect(st.status, JSON.stringify(st.body)).toBe(200);
  const s = v.body.mine!.state;
  autoPlayDay(s, st.body.ticket.gameDate, st.body.ticket.demand, { allowLoan: false });
  const c = await callJson<{ ok: boolean }>(`/api/v1/market/${id}/day/commit`, { token: p.token, body: { token, state: s } });
  expect(c.body.ok, JSON.stringify(c.body)).toBe(true);
  return st.body.ticket;
}

/** Durable Object の時計を、今から見た JST の dayOffset 日後の h 時 m 分にする */
async function setClock(id: string, dayOffset: number, h: number, min = 0) {
  const target = jstMidnight(addDays(jstDateKey(Date.now()), dayOffset)) + h * 3_600_000 + min * 60_000;
  await inMarket(id, (x) => {
    x.skewMs = target - Date.now();
  });
}

const code = (r: { body: unknown }) => (r.body as { code?: string }).code;

describe('公開のコミュニティ（判断 18）', () => {
  it('一覧から誰でも招待コードなしで入れる。非公開・終わった市場は一覧に出ず、id では入れない', async () => {
    const a = await newPlayer('公開主');
    const pub = await create(a, '公開店', { visibility: 'public', periodDays: 30, maxCompanies: 4 });
    const priv = await create(a, '内緒店');
    const b = await newPlayer('通りすがり');
    const list = await callJson<{ communities: { marketId: string; name: string; players: number; maxCompanies: number; endsAt: number | null; entry: string }[] }>('/api/v1/communities', { token: b.token });
    expect(list.status).toBe(200);
    const row = list.body.communities.find((x) => x.marketId === pub.marketId);
    expect(row).toMatchObject({ players: 1, maxCompanies: 4, entry: 'grown' });
    expect(row!.endsAt).not.toBeNull();
    expect(list.body.communities.some((x) => x.marketId === priv.marketId)).toBe(false);
    // 非公開は id では入れない（招待コードだけ）
    const ng = await callJson('/api/v1/market/join', { token: b.token, body: { marketId: priv.marketId, companyName: 'のぞき' } });
    expect(ng.status).toBe(404);
    const ok = await callJson<{ marketId: string; companyId: string }>('/api/v1/market/join', { token: b.token, body: { marketId: pub.marketId, companyName: '通りの店' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await view(b, pub.marketId)).body.mine).not.toBeNull();
    // 競争期間が終わった市場は一覧から消え、入れない
    await env.DB.prepare('UPDATE communities SET ends_at = ? WHERE market_id = ?').bind(Date.now() - 1000, pub.marketId).run();
    const after = await callJson<{ communities: { marketId: string }[] }>('/api/v1/communities', { token: b.token });
    expect(after.body.communities.some((x) => x.marketId === pub.marketId)).toBe(false);
    const c = await newPlayer('遅刻');
    const late = await callJson('/api/v1/market/join', { token: c.token, body: { marketId: pub.marketId, companyName: '遅い店' } });
    expect(late.status).toBe(409);
    expect(code(late)).toBe('market_ended');
  });
});

describe('育てた会社を別のコミュニティへ（判断 15・16）', () => {
  it('終わった市場の会社を、お金・店をそのままに入る市場の日付に合わせて持っていける。新規の企業だけの市場・終わる前は断る', async () => {
    const a = await newPlayer('育てる人');
    const src = await create(a, '老舗', { periodDays: 30 });
    await playDay(a, src.marketId);
    await playDay(a, src.marketId);
    const b = await newPlayer('迎える人');
    const dst = await create(b, '新天地', { visibility: 'public' });
    const fresh = await create(b, '新人戦', { visibility: 'public', entry: 'fresh' });
    const mine = (await view(a, src.marketId)).body.mine!;
    const bring = { marketId: src.marketId, companyId: mine.companyId };
    // 終わる前は移せない（元の会社はそのまま）
    const early = await callJson('/api/v1/market/join', { token: a.token, body: { marketId: dst.marketId, bring } });
    expect(early.status).toBe(409);
    expect(code(early)).toBe('export_refused');
    expect((await view(a, src.marketId)).body.companies.find((x) => x.mine)!.status).toBe('active');
    // 競争期間を終わらせる（市場の時計を31日後に）
    await setClock(src.marketId, 31, 9);
    expect((await view(a, src.marketId)).body.ended).toBe(true);
    // 新規の企業だけの市場には持っていけない
    const ng = await callJson('/api/v1/market/join', { token: a.token, body: { marketId: fresh.marketId, bring } });
    expect(ng.status).toBe(409);
    expect(code(ng)).toBe('fresh_only');
    // 持っていく
    const before = (await view(a, src.marketId)).body.mine!.state;
    const j = await callJson<{ marketId: string; companyId: string }>('/api/v1/market/join', { token: a.token, body: { marketId: dst.marketId, bring } });
    expect(j.status, JSON.stringify(j.body)).toBe(200);
    const v = await view(a, dst.marketId);
    expect(v.body.mine!.state.money).toBe(before.money);
    expect(v.body.mine!.state.company.stores.length).toBe(before.company.stores.length);
    expect(v.body.mine!.state.day).toBe(v.body.commonMarketDate + 1);
    expect(v.body.mine!.progress.lastProcessedGameDate).toBe(v.body.commonMarketDate);
    expect(v.body.companies.find((x) => x.mine)!.name).toBe('老舗');
    // 元の市場では「移った」（記録は残る）。D1 の状態も同じ。移った会社は数に入らない
    const old = await view(a, src.marketId);
    expect(old.body.myStatus).toBe('moved');
    expect(old.body.mine).toBeNull();
    const rows = await env.DB.prepare('SELECT market_id, status FROM market_companies WHERE player_id = ? ORDER BY created_at').bind(a.playerId).all<{ market_id: string; status: string }>();
    expect(rows.results).toEqual([
      { market_id: src.marketId, status: 'moved' },
      { market_id: dst.marketId, status: 'active' },
    ]);
    // 持っていった会社で、新しい市場の次の日を営業できる
    const t = await playDay(a, dst.marketId);
    expect(t.gameDate).toBe(v.body.commonMarketDate + 1);
    // 同じ会社を二度は持っていけない
    const again = await callJson('/api/v1/market/join', { token: a.token, body: { marketId: fresh.marketId, bring } });
    expect(again.status).toBe(409);
  });

  it('入る市場で受け取れなかったら、元の市場に戻す', async () => {
    const a = await newPlayer('戻る人');
    const src = await create(a, '戻り店', { periodDays: 30 });
    await playDay(a, src.marketId);
    const dst = await create(a, '自分の別の店', { visibility: 'public' });
    await setClock(src.marketId, 31, 9);
    const mine = (await view(a, src.marketId)).body.mine!;
    // もう会社がある市場には入れない → 元に戻る
    const r = await callJson('/api/v1/market/join', { token: a.token, body: { marketId: dst.marketId, bring: { marketId: src.marketId, companyId: mine.companyId } } });
    expect(r.status).toBe(409);
    expect(code(r)).toBe('import_refused');
    expect((await view(a, src.marketId)).body.companies.find((x) => x.mine)!.status).toBe('active');
    const row = await env.DB.prepare('SELECT status FROM market_companies WHERE market_id = ? AND player_id = ?').bind(src.marketId, a.playerId).first<{ status: string }>();
    expect(row!.status).toBe('active');
  });
});

describe('引退と終わったあとの営業（判断 16）', () => {
  it('競争期間中は引退できない。終わったら引退でき、1人5社の数から外れる。終わったあとも営業でき、同期はしない', async () => {
    const a = await newPlayer('引退する人');
    const m = await create(a, '最後の店', { periodDays: 30 });
    const early = await callJson(`/api/v1/market/${m.marketId}/retire`, { token: a.token, body: {} });
    expect(early.status).toBe(409);
    await setClock(m.marketId, 31, 9);
    // 終わったあとも営業できる（その日の期間は同期しない）
    await playDay(a, m.marketId);
    const v = await callJson<View & { pendingPeriods: string[] }>(`/api/v1/market/${m.marketId}`, { token: a.token });
    expect(v.body.pendingPeriods).toEqual([]);
    const r = await callJson(`/api/v1/market/${m.marketId}/retire`, { token: a.token, body: {} });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await env.DB.prepare('SELECT status FROM market_companies WHERE market_id = ? AND player_id = ?').bind(m.marketId, a.playerId).first<{ status: string }>();
    expect(row!.status).toBe('retired');
    const list = await callJson<{ markets: { marketId: string; ended: boolean; companyStatus: string }[] }>('/api/v1/markets', { token: a.token });
    expect(list.body.markets.find((x) => x.marketId === m.marketId)).toMatchObject({ companyStatus: 'retired' });
    // 5社まで作れる（引退した会社・終わった市場は数えない）
    await env.DB.prepare('UPDATE communities SET ends_at = ? WHERE market_id = ?').bind(Date.now() - 1000, m.marketId).run();
    for (let i = 0; i < 5; i++) await create(a, `次の店${i}`);
    // 参加していない市場では引退できない
    const b = await newPlayer('よその人');
    expect((await callJson(`/api/v1/market/${m.marketId}/retire`, { token: b.token, body: {} })).status).toBe(404);
  });
});

describe('大会の称号（判断 17）', () => {
  it('競争期間の最後の日の同期のあと、上位3社に優勝・準優勝・3位の称号。二度は渡さない', async () => {
    const a = await newPlayer('優勝候補');
    const b = await newPlayer('準優勝候補');
    const m = await create(a, '大会店A', { periodDays: 30, aiFill: false, visibility: 'public' });
    expect((await callJson('/api/v1/market/join', { token: b.token, body: { marketId: m.marketId, companyName: '大会店B' } })).status).toBe(200);
    await playDay(a, m.marketId);
    await playDay(b, m.marketId);
    // 最後の日（30日目の JST 0時の前の日）に営業 → 0時に同期
    await setClock(m.marketId, 29, 12);
    await playDay(a, m.marketId);
    await setClock(m.marketId, 30, 0, 1);
    await runDurableObjectAlarm(stub(m.marketId));
    await settleMarketSync(m.marketId);
    const finals = await env.DB.prepare("SELECT player_id, rank, title FROM rewards WHERE market_id = ? AND metric = 'final' ORDER BY rank").bind(m.marketId).all<{ player_id: string; rank: number; title: string }>();
    // 2社とも上位3社に入る（総合が同じなら同じ順位）。順位と称号が合っている
    expect(finals.results).toHaveLength(2);
    expect(finals.results[0]!.rank).toBe(1);
    for (const r of finals.results) expect(r.title).toBe(r.rank === 1 ? '🏆 大会店Aの市場 優勝' : '🥈 大会店Aの市場 準優勝');
    // 渡し忘れを拾う定時の処理（終わって1日あと）を何度呼んでも増えない
    const endsAt = (await view(a, m.marketId)).body.settings.endsAt!;
    await env.DB.prepare('UPDATE communities SET ends_at = ? WHERE market_id = ?').bind(endsAt, m.marketId).run();
    await grantEndedCommunities(env.DB, endsAt + 2 * 86_400_000);
    await grantEndedCommunities(env.DB, endsAt + 2 * 86_400_000);
    const again = await env.DB.prepare("SELECT COUNT(*) AS n FROM rewards WHERE market_id = ? AND metric = 'final'").bind(m.marketId).first<{ n: number }>();
    expect(again!.n).toBe(2);
    const mine = await callJson<{ rewards: { title: string; metric: string }[] }>('/api/v1/rewards', { token: a.token });
    expect(mine.body.rewards.some((r) => r.metric === 'final')).toBe(true);
  });

  it('最後の日に誰も遊ばなかった市場も、終わって1日たてば定時の処理で称号を渡す', async () => {
    const a = await newPlayer('ひとり大会');
    const m = await create(a, 'ひとり店', { periodDays: 30, aiFill: false });
    await playDay(a, m.marketId);
    await setClock(m.marketId, 1, 0, 1);
    await runDurableObjectAlarm(stub(m.marketId));
    await settleMarketSync(m.marketId);
    const endsAt = (await view(a, m.marketId)).body.settings.endsAt!;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rewards WHERE market_id = ? AND metric = 'final'").bind(m.marketId).first<{ n: number }>()).toEqual({ n: 0 });
    // 終わってすぐ（1日たつ前）は渡さない
    await grantEndedCommunities(env.DB, endsAt + 3_600_000);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM rewards WHERE market_id = ? AND metric = 'final'").bind(m.marketId).first<{ n: number }>()).toEqual({ n: 0 });
    await grantEndedCommunities(env.DB, endsAt + 86_400_000 + 1);
    const r = await env.DB.prepare("SELECT rank, title FROM rewards WHERE market_id = ? AND metric = 'final'").bind(m.marketId).all<{ rank: number; title: string }>();
    expect(r.results).toEqual([{ rank: 1, title: '🏆 ひとり店の市場 優勝' }]);
  });
});
