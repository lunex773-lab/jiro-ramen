// 企業間の貸し借りと銀行の融資の上限のサーバー（じろ2: 改修設計書04）
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { callJson, newPlayer, type TestPlayer } from './helpers';

async function create(p: TestPlayer, companyName: string, settings?: Record<string, unknown>) {
  const r = await callJson<{ marketId: string; code: string }>('/api/v1/market/create', { token: p.token, body: { name: `${companyName}の市場`, companyName, settings } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

type Credit = { id: string; status: string; principal: number; lenderId: string; borrowerId: string };
type View = {
  companies: { id: string; name: string; kind: string }[];
  mine: { companyId: string; state: { money: number; loans: { principal: number }[] }; credits: Credit[] } | null;
};
const view = (p: TestPlayer, id: string) => callJson<View>(`/api/v1/market/${id}`, { token: p.token });
let seq = 0;
const cid = () => `credit-${Date.now().toString(36)}-${++seq}`;
const credit = (p: TestPlayer, id: string, op: Record<string, unknown>, c = cid()) =>
  callJson<{ ok: boolean; reason?: string; creditId?: string; status?: string; duplicate?: boolean }>(`/api/v1/market/${id}/credit`, { token: p.token, body: { cid: c, op } });

describe('企業間の貸し借り（サーバー）', () => {
  it('申し込み → 承認でお金が動く。同じ操作の ID を送り直しても二度は動かない。ほかの会社は操作できない', async () => {
    const a = await newPlayer('貸す人');
    const b = await newPlayer('借りる人');
    const c = await newPlayer('関係ない人');
    const m = await create(a, '貸し亭', { aiFill: false, maxCompanies: 4 });
    for (const [p, n] of [[b, '借り軒'], [c, '外野屋']] as const) expect((await callJson('/api/v1/market/join', { token: p.token, body: { code: m.code, companyName: n } })).status).toBe(200);
    const vb = await view(b, m.marketId);
    const borrowerId = vb.body.mine!.companyId;
    const a0 = (await view(a, m.marketId)).body.mine!.state.money;
    const b0 = vb.body.mine!.state.money;
    const o = await credit(a, m.marketId, { op: 'offer', borrowerId, amount: 100_000, days: 5, dailyRate: 0.002 });
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.ok).toBe(true);
    const creditId = o.body.creditId!;
    // 関係ない会社は承認できない
    const ng = await credit(c, m.marketId, { op: 'accept', creditId });
    expect(ng.body.ok).toBe(false);
    const id = cid();
    const ok = await credit(b, m.marketId, { op: 'accept', creditId }, id);
    expect(ok.body).toMatchObject({ ok: true, status: 'active' });
    const again = await credit(b, m.marketId, { op: 'accept', creditId }, id);
    expect(again.body.duplicate).toBe(true);
    expect((await view(a, m.marketId)).body.mine!.state.money).toBe(a0 - 100_000);
    const after = await view(b, m.marketId);
    expect(after.body.mine!.state.money).toBe(b0 + 100_000);
    expect(after.body.mine!.credits.map((x) => [x.id, x.status])).toEqual([[creditId, 'active']]);
    // 前倒しで全部返す（利息はまだ0日分）
    const r = await credit(b, m.marketId, { op: 'repay', creditId });
    expect(r.body).toMatchObject({ ok: true, status: 'repaid' });
    expect((await view(a, m.marketId)).body.mine!.state.money).toBe(a0);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE kind = 'market_credit' AND player_id = ?").bind(b.playerId).first<{ n: number }>();
    expect(audit!.n).toBe(2);
  });

  it('形が違う操作は断る（400）。参加していない市場は404', async () => {
    const a = await newPlayer('形');
    const m = await create(a, '形の店');
    for (const op of [{ op: 'offer', borrowerId: 'c2', amount: 1.5, days: 3, dailyRate: 0 }, { op: 'offer', borrowerId: 'x', amount: 10_000, days: 3, dailyRate: 0 }, { op: 'accept', creditId: '../x' }, { op: 'steal' }, { op: 'repay', creditId: 'cr1', extra: 1 }]) {
      expect((await credit(a, m.marketId, op)).status, JSON.stringify(op)).toBe(400);
    }
    const z = await newPlayer('よそ');
    expect((await credit(z, m.marketId, { op: 'accept', creditId: 'cr1' })).status).toBe(404);
  });

  it('銀行の融資は額を選べる（5万円刻み・上限まで）', async () => {
    const a = await newPlayer('銀行');
    const m = await create(a, '銀行の店');
    const act = (amount?: number) => callJson<{ ok: boolean; reason?: string }>(`/api/v1/market/${m.marketId}/act`, { token: a.token, body: { cid: cid(), action: { type: 'takeLoan', ...(amount !== undefined ? { amount } : {}) } } });
    expect((await act(60_000)).body.ok).toBe(false);
    expect((await act(150_000)).body.ok).toBe(true);
    expect((await act(100_000)).body.ok).toBe(false);
    expect((await act(50_000)).body.ok).toBe(true);
    expect((await view(a, m.marketId)).body.mine!.state.loans.map((l) => l.principal)).toEqual([150_000, 50_000]);
    expect((await act(600_000)).status).toBe(400);
  });
});
