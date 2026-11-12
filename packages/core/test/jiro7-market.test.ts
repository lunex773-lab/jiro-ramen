// じろ7 Phase 3: 営業の終わりで1日を確定して送る・閉店後の事務作業は次の日へ・途中のセーブの決まり（設計書 4・5）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  autoPlayDay,
  checkpointProblem,
  commitDay,
  createMarket,
  jstMidnight,
  playerCompany,
  startDay,
  step,
  validCheckpoint,
  verifyCommit,
  type GameState,
  type MarketState,
} from '../src';
import { clone } from './helpers';

const P0 = '2026-11-04';
const T0 = jstMidnight(P0) + 10 * 3_600_000;
let tok = 0;

/** 端末で1日を営業する（閉店後の状態なら事務作業 → 翌日の仕込みへ → 開店 → 閉店 → 結果を確定） */
function playManual(s: GameState, demand: Record<string, number>, paperwork?: (s: GameState) => void): void {
  const pid = s.players[0]!.id;
  const ctx = { events: [] as never[], notices: [] as never[] } as never;
  s.marketDemand = { ...demand };
  s.tutorial = null;
  if (s.phase === 'closed') {
    paperwork?.(s);
    expect(applyAction(s, pid, { type: 'nextDay' }, ctx).ok).toBe(true);
  }
  expect(applyAction(s, pid, { type: 'openShop' }, ctx).ok).toBe(true);
  for (let t = 0; t < 4000 && s.phase !== 'closed' && s.phase !== 'bankrupt'; t += 0.2) step(s, 0.2, ctx);
  expect(s.phase).toBe('closed');
  expect(applyAction(s, pid, { type: 'finalizeDay' }, ctx).ok).toBe(true);
}

function manualDay(m: MarketState, owner: string, now: number, paperwork?: (s: GameState) => void) {
  const c = playerCompany(m, owner)!;
  const t = startDay(m, owner, now, `t${++tok}`, c.progress.stateVersion);
  if (!t.ok) throw new Error(t.reason);
  const s: GameState = clone(c.state);
  playManual(s, t.ticket.demand, paperwork);
  return { ticket: t.ticket, state: s, r: commitDay(m, owner, now + 1000, t.ticket.token, s) };
}

describe('営業の終わりで1日を確定して送る（じろ7 5）', () => {
  it('閉店後に結果を確定した状態を受け取る。会社の日報はその時点で確定し、閉店後の事務作業はその日の日報を書き換えず次の日に入る', () => {
    const m = createMarket({ id: 'J7', name: 'J7', seed: 7, now: T0, creator: { ownerId: 'u1', companyName: '確定亭' } });
    const d1 = manualDay(m, 'u1', T0);
    expect(d1.r.ok, JSON.stringify(d1.r)).toBe(true);
    expect(d1.r.resultId).toBe(`J7:${playerCompany(m, 'u1')!.id}:${d1.ticket.gameDate}`);
    const c = playerCompany(m, 'u1')!;
    expect(c.state.phase).toBe('closed');
    expect(c.state.finalizedDay).toBe(d1.ticket.gameDate);
    const day1 = d1.ticket.gameDate;
    const report1 = clone(c.state.company.history.find((r) => r.day === day1)!);
    // 同じ結果をもう一度送っても二重に数えない
    const again = commitDay(m, 'u1', T0 + 2000, d1.ticket.token, d1.state);
    expect(again.duplicate).toBe(true);
    expect(c.progress.manualProgressDays).toBe(1);
    // 次の日: 閉店後の事務作業で仕入れてから翌日へ
    let paid = 0;
    const d2 = manualDay(m, 'u1', T0 + 5000, (s) => {
      const before = s.money;
      const r = applyAction(s, s.players[0]!.id, { type: 'orderStock', itemId: 'noodle', packs: 2, express: false }, { events: [], notices: [] } as never);
      expect(r.ok).toBe(true);
      paid = before - s.money;
    });
    expect(paid).toBeGreaterThan(0);
    expect(d2.r.ok, JSON.stringify(d2.r)).toBe(true);
    const c2 = playerCompany(m, 'u1')!;
    // 1日目の会社の日報は変わらない
    const r1 = c2.state.company.history.find((r) => r.day === day1)!;
    expect([r1.netSales, r1.operatingProfit, r1.finalProfit]).toEqual([report1.netSales, report1.operatingProfit, report1.finalProfit]);
    // 閉店後の仕入れは2日目の日報に入り、2日目の始めの現金は確定したときの現金
    const h2 = c2.state.history.find((r) => r.day === day1 + 1)!;
    expect(h2.purchases).toBeGreaterThanOrEqual(paid);
    expect(h2.cashStart).toBe(d1.state.money);
  });

  it('前の版の端末（「翌日の仕込みへ」のあとに送る）の日も受け取る', () => {
    const m = createMarket({ id: 'J7b', name: 'J7b', seed: 8, now: T0, creator: { ownerId: 'u1', companyName: '旧亭' } });
    const c = playerCompany(m, 'u1')!;
    const t = startDay(m, 'u1', T0, `t${++tok}`, c.progress.stateVersion);
    if (!t.ok) throw new Error(t.reason);
    const s = clone(c.state);
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    expect(s.phase).toBe('prep');
    const r = commitDay(m, 'u1', T0 + 1000, t.ticket.token, s);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('閉店後の状態から、0時の自動営業でも次の日を進められる（朝の支払い → 営業 → 会社の日報）', () => {
    const m = createMarket({ id: 'J7c', name: 'J7c', seed: 9, now: T0, creator: { ownerId: 'u1', companyName: '自動亭' } });
    const d1 = manualDay(m, 'u1', T0);
    expect(d1.r.ok).toBe(true);
    const prev = clone(playerCompany(m, 'u1')!.state);
    const s = clone(prev);
    const day2 = d1.ticket.gameDate + 1;
    const r = autoPlayDay(s, day2, {}, { allowLoan: false });
    expect(r.bankrupt).toBe(false);
    expect(s.day).toBe(day2 + 1);
    expect(s.phase).toBe('prep');
    expect(s.company.history.some((x) => x.day === day2)).toBe(true);
    // サーバーの確かめ方でも、前の日（閉店後）から説明できる
    const v = verifyCommit(prev, s, { gameDate: day2, demand: {} });
    expect(v.reject).toEqual([]);
  });
});

describe('途中のセーブの決まり（じろ7 4）', () => {
  it('確定した状態の版・開いている日・新しい版・日付が合うときだけ受け取る', () => {
    const m = createMarket({ id: 'J7d', name: 'J7d', seed: 10, now: T0, creator: { ownerId: 'u1', companyName: '途中亭' } });
    const c = playerCompany(m, 'u1')!;
    const v0 = c.progress.stateVersion;
    const t = startDay(m, 'u1', T0, `t${++tok}`, v0);
    if (!t.ok) throw new Error(t.reason);
    const s = clone(c.state);
    const ok = { rev: 1, baseVersion: v0, token: t.ticket.token };
    expect(checkpointProblem(c, ok, s)).toBeNull();
    expect(checkpointProblem(c, { ...ok, baseVersion: v0 - 1 }, s)?.code).toBe('stale');
    expect(checkpointProblem(c, { ...ok, token: 'other' }, s)?.code).toBe('no_open_day');
    expect(checkpointProblem(c, ok, { ...s, seed: s.seed + 1 })?.code).toBe('bad_state');
    expect(checkpointProblem(c, ok, { ...s, day: s.day + 5 })?.code).toBe('bad_state');
    // 保存したセーブより古い版は受け取らない（ほかの端末の古い送信）
    c.checkpoint = { ...ok, rev: 3, savedAt: T0, day: s.day, phase: s.phase, sum: 'x', length: 1, slot: 0 };
    expect(validCheckpoint(c)?.rev).toBe(3);
    expect(checkpointProblem(c, { ...ok, rev: 2 }, s)?.code).toBe('old_rev');
    expect(checkpointProblem(c, { ...ok, rev: 4 }, s)).toBeNull();
    // その日を確定すると、途中のセーブは使わない
    playManual(s, t.ticket.demand);
    expect(commitDay(m, 'u1', T0 + 1000, t.ticket.token, s).ok).toBe(true);
    expect(validCheckpoint(c)).toBeNull();
    expect(c.checkpoint).toBeNull();
  });
});
