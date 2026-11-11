// 市場の参加は25社まで（じろ2: 改修設計書04）。26社目は断る。25社の0時の同期の負荷を測る
import { describe, expect, it } from 'vitest';
import { autoPlayDay, BALANCE, commitDay, createMarket, finishSync, joinMarket, jstMidnight, playerCompany, runSync, startDay, updateMarketSettings, type GameState } from '../src';
import { clone } from './helpers';

const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;

describe('市場の参加は25社まで', () => {
  it('プレイヤーだけで25社まで入れる。26社目は断る。同じ人の2回目の参加は同じ会社', () => {
    expect(BALANCE.market.maxCompanies).toBe(25);
    const m = createMarket({ id: 'm25', name: 'm25', seed: 3, now: T0, settings: { aiFill: false, maxCompanies: 25 }, creator: { ownerId: 'u0', companyName: 'c0' } });
    for (let i = 1; i < 25; i++) expect(joinMarket(m, `u${i}`, `c${i}`, T0).ok).toBe(true);
    expect(m.companies).toHaveLength(25);
    const r = joinMarket(m, 'u25', 'c25', T0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('25社');
    expect(joinMarket(m, 'u3', 'again', T0).company!.id).toBe(playerCompany(m, 'u3')!.id);
    // 上限は25社より上にはできない
    expect(updateMarketSettings(m, { maxCompanies: 26 }).ok).toBe(false);
  });

  it('AI で埋めると25社になる。新しい市場の既定は6社', () => {
    const m = createMarket({ id: 'a25', name: 'a25', seed: 4, now: T0, settings: { maxCompanies: 25 }, creator: { ownerId: 'u0', companyName: 'c0' } });
    expect(m.companies).toHaveLength(25);
    expect(new Set(m.companies.map((c) => c.name)).size).toBe(25);
    const d = createMarket({ id: 'd', name: 'd', seed: 5, now: T0, creator: { ownerId: 'u0', companyName: 'c0' } });
    expect(d.settings.maxCompanies).toBe(BALANCE.market.defaultCompanies);
  });

  it('25社の0時の同期（1日分）の時間を測る', () => {
    const m = createMarket({ id: 'p25', name: 'p25', seed: 6, now: T0, settings: { maxCompanies: 25 }, creator: { ownerId: 'u0', companyName: 'c0' } });
    const c = playerCompany(m, 'u0')!;
    const t = startDay(m, 'u0', T0, 'tok-25-1', c.progress.stateVersion);
    if (!t.ok) throw new Error(t.reason);
    const s: GameState = clone(c.state);
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    expect(commitDay(m, 'u0', T0 + 1000, t.ticket.token, s).ok).toBe(true);
    const now = jstMidnight('2026-11-05') + 60_000;
    const t0 = Date.now();
    let steps = 0;
    for (;;) {
      // サーバーと同じ小分け（1回に4社・日）
      const r = runSync(m, now, 4);
      steps++;
      if (r.status === 'more') continue;
      if (r.status === 'ranking') finishSync(m, now);
      break;
    }
    const ms = Date.now() - t0;
    expect(m.commonMarketDate).toBe(1);
    // 24社の自動営業（1日）。測った値は docs/JIRO2_PLAN.md に書く
    console.log(`[market25] 24社×1日の自動営業: ${ms.toFixed(1)}ms（${steps}回に分けて。1社1日 ${(ms / 24).toFixed(2)}ms）`);
    expect(ms).toBeLessThan(5000);
  });
});
