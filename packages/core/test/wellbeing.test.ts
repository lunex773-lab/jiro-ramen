// 疲れ・社員の休みの曜日・希望シフト・満足度・辞める（オーナーの判断 12・13。仕様書 4.2）
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  attendanceChances,
  BALANCE,
  checkQuits,
  endOfDayWellbeing,
  expectedPay,
  fatigueOf,
  fatigueSpeed,
  isWishDay,
  makeCtx,
  moraleOf,
  moraleText,
  payDue,
  planManagerDay,
  restDaysOf,
  shiftFor,
  storeCapacity,
  storeLead,
  weekdayOf,
  wishDaysFor,
} from '../src';
import { addBot, newGame } from './helpers';

describe('疲れ（判断 12）', () => {
  it('毎日働くと 0.6 に近づき（作業が12%遅い）、週5日・2日休みなら休みのあとはほぼ回復する', () => {
    const { s } = newGame(1);
    const e = addBot(s, 'cook');
    for (let d = 0; d < 40; d++) endOfDayWellbeing(s, e, true, 1);
    const F = BALANCE.staff.fatigue;
    expect(fatigueOf(e)).toBeCloseTo(F.gainPerDay / (1 - F.keepWorking), 2);
    expect(fatigueSpeed(e)).toBeCloseTo(1 - F.speedPenalty * fatigueOf(e), 10);
    expect(fatigueSpeed(e)).toBeLessThan(0.9);
    // 週5日・2日休み
    e.fatigue = 0;
    let peak = 0;
    for (let w = 0; w < 6; w++) {
      for (let d = 0; d < 5; d++) endOfDayWellbeing(s, e, true, 1);
      peak = Math.max(peak, fatigueOf(e));
      endOfDayWellbeing(s, e, false, 0);
      endOfDayWellbeing(s, e, false, 0);
    }
    expect(peak).toBeLessThan(0.45);
    expect(fatigueOf(e)).toBeLessThan(0.1);
  });

  it('疲れていると遅刻・欠勤の確率が上がる（最大 1 + absentMult 倍）', () => {
    const { s } = newGame(1);
    const e = addBot(s, 'cook');
    e.profile.diligence = 0.5;
    e.fatigue = 0;
    const a0 = attendanceChances(e);
    e.fatigue = 1;
    const a1 = attendanceChances(e);
    expect(a1.absent / a0.absent).toBeCloseTo(1 + BALANCE.staff.fatigue.absentMult, 6);
    expect(a1.late).toBeGreaterThan(a0.late);
  });
});

describe('社員の休みの曜日', () => {
  it('休みの曜日は来ず、日給もかからない。アルバイトには使えない。毎日休みにはできない', () => {
    const { s, ctx } = newGame(2);
    const e = addBot(s, 'cook', 0.7, 8000);
    const wd = weekdayOf(s.day);
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: e.id, days: [wd, (wd + 1) % 7] }, ctx).ok).toBe(true);
    expect(restDaysOf(e).sort()).toEqual([wd, (wd + 1) % 7].sort());
    expect(shiftFor(e, s.day)).toBeNull();
    expect(expectedPay(e, s.day)).toBe(0);
    expect(shiftFor(e, s.day + 2)).not.toBeNull();
    expect(expectedPay(e, s.day + 2)).toBe(8000);
    // 今日は休み（仕込みに来ていたら帰る）→ 精算で日給なし
    expect(['off', 'left']).toContain(e.att?.status);
    expect(payDue(e, s)).toBe(0);
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: e.id, days: [0, 1, 2, 3, 4, 5, 6] }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: e.id, days: [] }, ctx).ok).toBe(true);
    expect(e.shifts).toBeUndefined();
    const p = addBot(s, 'server');
    p.profile.employment = 'part';
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: p.id, days: [1] }, ctx).ok).toBe(false);
  });

  it('店長が休みの曜日は、その店は店長がいない日（1日単位の計算では休業）', () => {
    const { s, ctx } = newGame(3);
    const mgr = addBot(s, 'cook', 0.7, 8000);
    applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: mgr.id }, ctx);
    expect(storeLead(s, activeStore(s))?.id).toBe(mgr.id);
    applyAction(s, 'p1', { type: 'setRestDays', employeeId: mgr.id, days: [weekdayOf(s.day)] }, ctx);
    expect(storeLead(s, activeStore(s))).toBeNull();
    expect(planManagerDay(s, activeStore(s)).open).toBe(false);
  });

  it('1日単位の計算でも、疲れている人の分だけ人手が減る', () => {
    const { s } = newGame(4);
    const mgr = addBot(s, 'cook', 0.65, 8000);
    addBot(s, 'cook', 0.65, 6000);
    const lead = { id: mgr.id, skill: 0.65 };
    const fresh = storeCapacity(s, lead).labor;
    for (const e of s.employees) e.fatigue = 1;
    const tired = storeCapacity(s, lead).labor;
    expect(tired / fresh).toBeCloseTo(1 - BALANCE.staff.fatigue.speedPenalty, 6);
  });
});

describe('希望シフトと満足度（判断 13）', () => {
  it('アルバイトの希望の曜日は3〜6日（種から決まる）', () => {
    for (let i = 0; i < 50; i++) {
      const w = wishDaysFor(`k${i}`);
      const n = w.filter(Boolean).length;
      expect(n).toBeGreaterThanOrEqual(BALANCE.staff.wishDaysMin);
      expect(n).toBeLessThanOrEqual(BALANCE.staff.wishDaysMax);
      expect(wishDaysFor(`k${i}`)).toEqual(w);
    }
  });

  it('希望していない曜日に働くと満足度が下がり、遅刻・欠勤が増える。希望どおりなら基準へ戻る', () => {
    const { s } = newGame(5);
    const e = addBot(s, 'server');
    e.profile.employment = 'part';
    e.profile.wishDays = Array.from({ length: 7 }, (_, i) => i !== weekdayOf(s.day));
    e.profile.diligence = 0.5;
    expect(isWishDay(e, weekdayOf(s.day))).toBe(false);
    const before = attendanceChances(e);
    for (let i = 0; i < 20; i++) endOfDayWellbeing(s, e, true, 1);
    expect(moraleOf(e)).toBeLessThan(0.35);
    expect(moraleText(e)).toBe('辞めたがっている');
    expect(attendanceChances(e).absent).toBeGreaterThan(before.absent * 1.5);
    expect(e.record?.log.some((l) => l.kind === 'offWish')).toBe(true);
    // 希望どおり（休み）なら戻る
    for (let i = 0; i < 30; i++) endOfDayWellbeing(s, e, false, 0);
    expect(moraleOf(e)).toBeGreaterThan(0.7);
  });

  it('不満がたまった人は、朝に辞めることがある（解雇手当なし）。店長が辞めたら店長がいなくなる', () => {
    const { s } = newGame(6);
    const ctx = makeCtx();
    const mgr = addBot(s, 'cook', 0.7, 8000);
    activeStore(s).managerId = mgr.id;
    mgr.morale = 0.05;
    const money = s.money;
    let quit: string[] = [];
    for (let i = 0; i < 400 && quit.length === 0; i++) quit = checkQuits(s, ctx);
    expect(quit).toEqual([mgr.profile.name]);
    expect(s.employees.some((e) => e.id === mgr.id)).toBe(false);
    expect(activeStore(s).managerId).toBeNull();
    expect(s.money).toBe(money);
    // 満足している人は辞めない
    const ok = addBot(s, 'cook');
    ok.morale = 0.75;
    for (let i = 0; i < 200; i++) expect(checkQuits(s, ctx)).toEqual([]);
  });
});
