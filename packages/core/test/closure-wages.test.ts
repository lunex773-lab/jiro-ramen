// 工事（拡張）・出店の準備で休業する日は、従業員の給料を払わない。期限が過ぎた在庫は廃棄する（オーナーの指示 2026-11-12）
import { describe, expect, it } from 'vitest';
import { addLot, applyAction, fullTimeWageFor, nextDay, refreshCandidates, runManagerDay, stockOf, storeReport, type GameState, type SimCtx } from '../src';
import { addSoloBot, newGame, runDay } from './helpers';

function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx, 6000);
}

function hireFull(s: GameState, ctx: SimCtx) {
  refreshCandidates(s);
  expect(applyAction(s, 'p1', { type: 'hire', candidateId: s.candidates[0]!.id }, ctx).ok).toBe(true);
  const e = s.employees[s.employees.length - 1]!;
  e.availableFrom = undefined;
  e.profile.employment = 'full';
  e.profile.wage = fullTimeWageFor(e);
  delete e.shifts;
  delete e.dateShifts;
  return e;
}

describe('工事・準備の休業日', { timeout: 120_000 }, () => {
  it('拡張の工事の日は、社員もアルバイトも来ず給料は0。期限が過ぎた在庫は廃棄して損益に入る', () => {
    const { s, ctx } = newGame(51);
    addSoloBot(s);
    s.career.unlocked.push('hiring', 'stage2');
    playDay(s, ctx);
    hireFull(s, ctx);
    s.money = 3_000_000;
    // 翌日に期限が切れる在庫を入れておく（キャベツ: 期限が過ぎるように古くする）
    addLot(s, 'cabbage', 3000, 0.15);
    const lots = s.inventory.filter((l) => l.itemId === 'cabbage');
    expect(lots.length).toBeGreaterThan(0);
    for (const l of lots) l.expiresDay = s.day;
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    expect(s.closedForConstruction).toBeGreaterThan(0);
    const before = stockOf(s, 'cabbage');
    expect(nextDay(s, ctx).ok).toBe(true);
    // 工事の日は営業せずに精算まで
    expect(s.phase).toBe('closed');
    const r = s.history.at(-1)!;
    expect(r.wages).toBe(0);
    expect(r.served).toBe(0);
    expect(s.employees.every((e) => !e.presentToday)).toBe(true);
    expect(s.employees.every((e) => e.att?.status === 'closed')).toBe(true);
    // 期限が過ぎた分は廃棄（損益の廃棄に入る）
    // （朝の入荷で新しいキャベツが届くことがあるので、期限が過ぎた分が残っていないことで確かめる）
    expect(s.inventory.filter((l) => l.itemId === 'cabbage' && l.expiresDay < s.day)).toHaveLength(0);
    expect(before).toBeGreaterThan(0);
    expect(r.waste).toBeGreaterThan(0);
  });

  it('閉店後の「翌営業日の支出の見込み」も、翌日が工事なら給与は0', () => {
    const { s, ctx } = newGame(52);
    addSoloBot(s);
    s.career.unlocked.push('hiring', 'stage2');
    playDay(s, ctx);
    hireFull(s, ctx);
    s.money = 3_000_000;
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    // fixedCosts は経営の画面の「翌営業日の支出の見込み」
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return import('../src').then(({ fixedCosts }) => {
      expect(fixedCosts(s).wages).toBe(0);
    });
  });

  it('出店の準備の日（店長の店）は給料0。準備が終わって開いた日は給料がかかる', () => {
    const { s, ctx } = newGame(53);
    addSoloBot(s);
    s.career.unlocked.push('hiring');
    playDay(s, ctx);
    s.money = 5_000_000;
    s.career.stage = 1;
    s.reputation = 4.3;
    const mgr = hireFull(s, ctx);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'roadside', managerId: mgr.id }, ctx).ok).toBe(true);
    const b = s.company.stores[1]!;
    expect(b.snapshot!.closedForConstruction).toBe(2);
    const start = s.day;
    const reps = [1, 2, 3].map((d) => {
      s.day = start + d;
      return runManagerDay(s, b, s.day, ctx);
    });
    expect(reps[0]!.managed).toBe('closed');
    expect(reps[0]!.wages).toBe(0);
    expect(reps[1]!.wages).toBe(0);
    expect(reps[2]!.managed).toBe('manager');
    expect(reps[2]!.wages).toBeGreaterThan(0);
    expect(storeReport(s, b, start + 1)?.wages).toBe(0);
  });
});
