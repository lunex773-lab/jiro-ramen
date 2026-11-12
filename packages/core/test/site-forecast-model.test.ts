// 出店の見込みを店長の営業と同じ計算に（オーナーの判断 2026-11-12）。
// 前の見込みは席と人手の上限を考えず、駅前・郊外で実際（店長の営業）より大きく、住宅街で小さく出ていた
import { describe, expect, it } from 'vitest';
import { activeStore, applyAction, BALANCE, fullTimeWageFor, nextDay, refreshCandidates, runManagerDay, siteForecast, STAGES, type DayReport, type GameState, type SimCtx } from '../src';
import { addSoloBot, newGame, runDay } from './helpers';

function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx, 6000);
}

/** 12席・評判★4.2・資金500万円の会社（本店の場所 code） */
function readyCompany(seed: number, code: string) {
  const { s, ctx } = newGame(seed);
  activeStore(s).location = code;
  addSoloBot(s);
  playDay(s, ctx);
  s.money = 5_000_000;
  s.career.unlocked.push('stage2', 'hiring');
  expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
  s.reputation = 4.2;
  return { s, ctx };
}

describe('出店の見込み（店長の営業と同じ計算）', { timeout: 300_000 }, () => {
  it('見込みの杯数は、その物件の席と人手で出せる上限を超えない。見込みを出しても今の状態は変わらない', () => {
    const { s } = readyCompany(40, '13104');
    const before = JSON.stringify(s);
    for (const pid of ['residential', 'station', 'roadside']) {
      const f = siteForecast(s, '13104', pid);
      const seats = STAGES[pid === 'roadside' ? 1 : 0]!.seats.length;
      expect(f.served).toBeGreaterThan(0);
      expect(f.served).toBeLessThanOrEqual(f.capacity);
      expect(f.capacity).toBeLessThanOrEqual(Math.ceil(seats * BALANCE.company.model.seatTurns));
      expect(f.served).toBeLessThanOrEqual(f.customers);
    }
    expect(JSON.stringify(s)).toBe(before);
  });

  it('見込みの利益は、同じ店を店長＋接客担当のアルバイト1人で3週間営業した3週目の利益と大きくずれない', () => {
    for (const [code, pid] of [['13104', 'residential'], ['13104', 'station'], ['20212', 'roadside']] as const) {
      const { s, ctx } = readyCompany(41, code);
      const f = siteForecast(s, code, pid);
      // 実際に出店する: 雇ったアルバイトを社員にして店長に、接客担当のアルバイトを1人送る
      const hireOne = () => {
        refreshCandidates(s);
        expect(applyAction(s, 'p1', { type: 'hire', candidateId: s.candidates[0]!.id }, ctx).ok).toBe(true);
        const e = s.employees[s.employees.length - 1]!;
        e.availableFrom = undefined;
        return e;
      };
      const mgr = hireOne();
      mgr.profile.role = 'cook';
      mgr.profile.skills = { speed: 0.65, cooking: 0.65, service: 0.65, hygiene: 0.65, movement: 0.65 };
      mgr.profile.employment = 'full';
      mgr.profile.wage = fullTimeWageFor(mgr);
      delete mgr.shifts;
      delete mgr.dateShifts;
    // 社員にすると毎日・仕込みから閉店までの勤務になる（promote と同じ）
    delete mgr.shifts;
    delete mgr.dateShifts;
      expect(applyAction(s, 'p1', { type: 'openStore', propertyId: pid, managerId: mgr.id, location: code }, ctx).ok).toBe(true);
      const entry = s.company.stores[s.company.stores.length - 1]!;
      const part = hireOne();
      part.profile.role = 'server';
      part.profile.skills = { speed: 0.6, cooking: 0.6, service: 0.6, hygiene: 0.6, movement: 0.6 };
      part.profile.wishDays = [true, true, true, true, true, true, true];
      expect(applyAction(s, 'p1', { type: 'transferEmployee', employeeId: part.id, toStoreId: entry.id }, ctx).ok).toBe(true);
      const reps: DayReport[] = [];
      const start = s.day;
      for (let d = 1; d <= 21; d++) {
        s.day = start + d;
        const r = runManagerDay(s, entry, s.day, ctx);
        if (d > 14 && r.managed === 'manager') reps.push(r);
      }
      const actual = reps.reduce((a, r) => a + r.operatingProfit, 0) / reps.length;
      const served = reps.reduce((a, r) => a + r.served, 0) / reps.length;
      console.log(`${code} ${pid}: 見込み 杯${f.served}・利益${f.profit} / 実際 杯${Math.round(served)}・利益${Math.round(actual)}`);
      // 杯数は±20%、利益は±6,000円/日（人の休み・疲れ・評判の近づき方で日ごとに揺れる）
      expect(Math.abs(f.served - served)).toBeLessThanOrEqual(Math.max(8, served * 0.2));
      expect(Math.abs(f.profit - actual)).toBeLessThanOrEqual(6_000);
    }
  });
});
