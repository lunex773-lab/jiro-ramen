// 在庫・お金の二重処理を防ぐ（じろ2: 改修設計書04 §4）。同じ日の送り直し・同期のやり直し・同じ操作の送り直しで二重にならない
import { describe, expect, it } from 'vitest';
import { autoPlayDay, commitDay, createMarket, finishSync, jstMidnight, playerCompany, runSync, startDay, type GameState, type MarketState } from '../src';
import { clone } from './helpers';

const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;

function snapshot(s: GameState) {
  return { money: s.money, inv: s.inventory.map((l) => `${l.itemId}:${l.qty}`).sort().join(','), deliveries: s.deliveries.length, tx: s.transactions.length };
}

function market(): MarketState {
  return createMarket({ id: 'idem', name: 'idem', seed: 77, now: T0, settings: { aiFill: true, maxCompanies: 3 }, creator: { ownerId: 'u1', companyName: '二重亭' } });
}

describe('在庫とお金の二重処理を防ぐ', () => {
  it('同じ日の確定を送り直しても、在庫・お金・取引は1回分だけ', () => {
    const m = market();
    const c = playerCompany(m, 'u1')!;
    const t = startDay(m, 'u1', T0, 'idem-1', c.progress.stateVersion);
    if (!t.ok) throw new Error(t.reason);
    const s: GameState = clone(c.state);
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    expect(commitDay(m, 'u1', T0 + 1000, 'idem-1', clone(s)).ok).toBe(true);
    const once = snapshot(playerCompany(m, 'u1')!.state);
    const again = commitDay(m, 'u1', T0 + 2000, 'idem-1', clone(s));
    expect(again.duplicate).toBe(true);
    expect(snapshot(playerCompany(m, 'u1')!.state)).toEqual(once);
    expect(playerCompany(m, 'u1')!.progress.lastProcessedGameDate).toBe(1);
    // 別の token で同じ日を送っても受け取らない（始めていない日）
    expect(commitDay(m, 'u1', T0 + 3000, 'idem-x', clone(s)).ok).toBe(false);
    expect(snapshot(playerCompany(m, 'u1')!.state)).toEqual(once);
  });

  it('0時の同期を何度呼んでも、自動営業の日の在庫・お金は1回分だけ', () => {
    const m = market();
    const c = playerCompany(m, 'u1')!;
    const t = startDay(m, 'u1', T0, 'idem-2', c.progress.stateVersion);
    if (!t.ok) throw new Error(t.reason);
    const s: GameState = clone(c.state);
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    expect(commitDay(m, 'u1', T0 + 1000, 'idem-2', s).ok).toBe(true);
    const now = jstMidnight('2026-11-05') + 60_000;
    // 小分けで途中まで進め、同じ所からもう一度呼ぶ（止まって再開したのと同じ）
    expect(runSync(m, now, 1).status).toBe('more');
    const ai = m.companies.filter((x) => x.kind === 'ai');
    const mid = ai.map((x) => snapshot(x.state));
    for (;;) {
      const r = runSync(m, now, 1);
      if (r.status === 'more') continue;
      if (r.status === 'ranking') finishSync(m, now);
      break;
    }
    const done = ai.map((x) => snapshot(x.state));
    // もう一度同期しても何も変わらない
    expect(runSync(m, now).status).toBe('idle');
    expect(ai.map((x) => snapshot(x.state))).toEqual(done);
    expect(ai.every((x) => x.progress.lastProcessedGameDate === 1)).toBe(true);
    // 1社目は途中の時点で済んでいて、2回目の呼び出しで二重に営業していない
    expect(done[0]).toEqual(mid[0]);
  });
});
