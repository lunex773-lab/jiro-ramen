// 複数店舗の売上の反映（オーナーの指示 2026-11-12「売り上げがちゃんと反映されているか」）。
// 店ごとの日報 = 会社の日報の店の行、会社の合計 = 店の合計、店長の店のお金の動き = 売上 − 仕入れ − 費用
import { describe, expect, it } from 'vitest';
import { activeStore, applyAction, fullTimeWageFor, nextDay, refreshCandidates, runManagerDay, storeLead, storeReport, weekdayOf, type GameState, type SimCtx } from '../src';
import { addSoloBot, newGame, runDay } from './helpers';

function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx, 6000);
}

describe('複数店舗の売上の反映', { timeout: 300_000 }, () => {
  it('2店の会社で10日: 会社の日報の店の行は店の日報と同じ。店長の店の現金の増減は売上から仕入れと費用を引いた額', () => {
    const { s, ctx } = newGame(31);
    activeStore(s).location = '27100';
    addSoloBot(s);
    playDay(s, ctx);
    s.money = 5_000_000;
    s.career.unlocked.push('stage2', 'hiring');
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    s.reputation = 4.2;
    refreshCandidates(s);
    expect(applyAction(s, 'p1', { type: 'hire', candidateId: s.candidates[0]!.id }, ctx).ok).toBe(true);
    const mgr = s.employees[s.employees.length - 1]!;
    mgr.profile.employment = 'full';
    mgr.profile.wage = fullTimeWageFor(mgr);
    // 社員にすると毎日・仕込みから閉店までの勤務になる（promote と同じ）
    delete mgr.shifts;
    delete mgr.dateShifts;
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: mgr.id, location: '27100' }, ctx).ok).toBe(true);
    const b = s.company.stores[1]!;
    let managerDays = 0;
    for (let d = 0; d < 10; d++) {
      playDay(s, ctx);
      const day = s.day;
      nextDay(s, ctx);
      const ch = s.company.history.find((x) => x.day === day)!;
      expect(ch).toBeTruthy();
      expect(ch.stores).toHaveLength(2);
      for (const line of ch.stores) {
        const entry = s.company.stores.find((x) => x.id === line.storeId)!;
        const r = storeReport(s, entry, day);
        expect(r).toBeTruthy();
        expect(line.netSales).toBe(r!.netSales ?? r!.sales - r!.refunds);
        expect(line.operatingProfit).toBe(r!.operatingProfit);
        expect(line.served).toBe(r!.served);
      }
      expect(ch.netSales).toBe(ch.stores.reduce((a, x) => a + x.netSales, 0));
      expect(ch.operatingProfit).toBe(ch.stores.reduce((a, x) => a + x.operatingProfit, 0));
      const rb = storeReport(s, b, day)!;
      if (rb.managed === 'manager') {
        managerDays += 1;
        expect(rb.sales).toBeGreaterThan(0);
      }
      if (s.arrears.length === 0) {
        const flow = rb.sales - rb.purchases - rb.rent - rb.wages - rb.upkeep - rb.utilities - rb.repairs - (rb.ads ?? 0) - rb.hiring;
        expect(Math.abs(rb.cashEnd - rb.cashStart - flow)).toBeLessThanOrEqual(1);
      }
    }
    expect(managerDays).toBeGreaterThanOrEqual(8);
  });

  it('店長の休みの曜日は、勤務のあるシフトリーダーが店長代理として店長の店を開ける（いなければ休業）', () => {
    const { s, ctx } = newGame(32);
    s.money = 5_000_000;
    s.career.stage = 1;
    s.reputation = 4.3;
    s.career.unlocked.push('hiring');
    s.phase = 'closed';
    const mk = (role: 'cook' | 'leader') => {
      refreshCandidates(s);
      expect(applyAction(s, 'p1', { type: 'hire', candidateId: s.candidates[0]!.id }, ctx).ok).toBe(true);
      const e = s.employees[s.employees.length - 1]!;
      e.availableFrom = undefined;
      e.profile.employment = 'full';
      e.profile.role = role;
      e.profile.wage = fullTimeWageFor(e);
      delete e.shifts;
      delete e.dateShifts;
      return e;
    };
    const mgr = mk('cook');
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: mgr.id }, ctx).ok).toBe(true);
    const b = s.company.stores[1]!;
    const snap = b.snapshot!;
    const m = snap.employees.find((e) => e.id === mgr.id)!;
    // 店長は毎週この曜日が休み
    const off = weekdayOf(s.day + 3);
    m.shifts = Array.from({ length: 7 }, (_, i) => (i === off ? null : { start: 0, end: 240, breakAt: 0, breakLen: 0, fromPrep: true }));
    const leader = mk('leader');
    expect(applyAction(s, 'p1', { type: 'transferEmployee', employeeId: leader.id, toStoreId: b.id }, ctx).ok).toBe(true);
    const start = s.day;
    for (let d = 1; d <= 7; d++) {
      s.day = start + d;
      const r = runManagerDay(s, b, s.day, ctx);
      if (weekdayOf(s.day) === off && d > 1) expect(r.managed).toBe('manager');
    }
    // シフトリーダーがいなければ、店長の休みの日は休業
    b.snapshot!.employees = b.snapshot!.employees.filter((e) => e.id !== leader.id);
    for (let d = 8; d <= 14; d++) {
      s.day = start + d;
      const r = runManagerDay(s, b, s.day, ctx);
      if (weekdayOf(s.day) === off) expect(r.managed).toBe('closed');
    }
    expect(storeLead).toBeTypeOf('function');
  });
});
