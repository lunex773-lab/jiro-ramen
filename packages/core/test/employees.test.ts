import { describe, expect, it } from 'vitest';
import { applyAction, refreshCandidates, step, buildTasks } from '../src';
import { addBot, newGame, runDay } from './helpers';

describe('従業員', () => {
  it('同じ仕事を複数の従業員が同時に担当しない', () => {
    const { s, ctx } = newGame(21);
    for (let i = 0; i < 3; i++) addBot(s, 'cook');
    addBot(s, 'server');
    addBot(s, 'cleaner');
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    for (let i = 0; i < 3000; i++) {
      step(s, 0.1, ctx);
      const ids = s.employees.map((e) => e.ai.taskId).filter((x): x is string => !!x);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('従業員だけでも営業でき、雇うと処理量が増える', () => {
    const solo = newGame(31);
    addBot(solo.s, 'cook', 0.6);
    applyAction(solo.s, 'p1', { type: 'openShop' }, solo.ctx);
    solo.s.reputation = 4;
    runDay(solo.s, solo.ctx);
    const team = newGame(31);
    addBot(team.s, 'cook', 0.6);
    addBot(team.s, 'cook', 0.6);
    addBot(team.s, 'server', 0.6);
    addBot(team.s, 'cleaner', 0.6);
    team.s.reputation = 4;
    applyAction(team.s, 'p1', { type: 'openShop' }, team.ctx);
    runDay(team.s, team.ctx);
    const a = solo.s.history[0]!;
    const b = team.s.history[0]!;
    expect(a.served).toBeGreaterThan(0);
    // 人手が増えると提供数が大きく増える（席数が上限になるので、それ以上は拡張が必要）
    expect(b.served).toBeGreaterThan(a.served * 2);
    expect(b.lost / b.customers).toBeLessThan(a.lost / a.customers);
  });

  it('採用費と給与が支払われ、解雇には解雇手当がかかる', () => {
    const { s, ctx } = newGame(41);
    s.career.unlocked.push('hiring');
    refreshCandidates(s);
    const cand = s.candidates[0]!;
    const m = s.money;
    expect(applyAction(s, 'p1', { type: 'hire', candidateId: cand.id }, ctx).ok).toBe(true);
    expect(s.money).toBe(m - cand.profile.hireFee);
    expect(s.employees).toHaveLength(1);
    const emp = s.employees[0]!;
    // 営業中は解雇できない
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(applyAction(s, 'p1', { type: 'fire', employeeId: emp.id }, ctx).ok).toBe(false);
    runDay(s, ctx);
    expect(s.history[0]!.wages).toBe(emp.profile.wage);
    const m2 = s.money;
    expect(applyAction(s, 'p1', { type: 'fire', employeeId: emp.id }, ctx).ok).toBe(true);
    expect(s.money).toBe(m2 - emp.profile.wage);
    expect(s.employees).toHaveLength(0);
  });

  it('担当者がいなくなった仕事は他の人が引き継げる', () => {
    const { s, ctx } = newGame(51);
    const a = addBot(s, 'cleaner');
    const b = addBot(s, 'cleaner');
    s.seats[2]!.dirt = 1;
    s.seats[3]!.dirt = 1;
    step(s, 0.1, ctx);
    const keyA = a.ai.taskId;
    expect(keyA).toBeTruthy();
    // a が離脱
    s.employees = s.employees.filter((x) => x.id !== a.id);
    for (let i = 0; i < 300; i++) step(s, 0.1, ctx);
    expect(s.seats[2]!.dirt).toBe(0);
    expect(s.seats[3]!.dirt).toBe(0);
    void b;
  });

  it('担当設定で仕事を外すと、その仕事はしない', () => {
    const { s, ctx } = newGame(61);
    const c = addBot(s, 'cleaner');
    applyAction(s, 'p1', { type: 'setPriority', employeeId: c.id, kind: 'wipe', value: -100 }, ctx);
    s.seats[0]!.dirt = 1;
    for (let i = 0; i < 200; i++) step(s, 0.1, ctx);
    expect(s.seats[0]!.dirt).toBe(1);
    expect(buildTasks(s).some((t) => t.kind === 'wipe')).toBe(true);
  });
});
