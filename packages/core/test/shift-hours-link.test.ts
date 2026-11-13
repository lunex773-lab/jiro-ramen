// シフトの時間が営業時間とリンクしていない（オーナーの指示 2026-11-13「21:30まで営業しているのに19:30までしかシフトを組めない」）。
// 「仕込みから閉店まで」は前は 11〜15時の 240分で表していたので、営業時間の長い店で「仕込み〜19:30」のように出ていた
import { describe, expect, it } from 'vitest';
import { activeStore, applyAction, fullDayShift, initNewHire, isFullShift, openMinutesOf, shiftEndOf, shiftFor, shiftPaidHours, shiftProblem, shiftTimeText, storeHours, type ShiftDay } from '../src';
import { addBot, newGame } from './helpers';

const TWO = { sessions: [{ open: 11 * 60, close: 15 * 60 }, { open: 17 * 60, close: 21 * 60 + 30 }], closedDays: [] };

describe('シフトは店の営業時間の閉店まで', () => {
  it('昼と夜の店（〜21:30）で、仕込みから閉店までの予定は21:30まで。古いデータ（240分）も閉店まで', () => {
    const { s, ctx } = newGame(71);
    const st = activeStore(s);
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: st.id, hours: TWO }, ctx).ok).toBe(true);
    const open = openMinutesOf(storeHours(s));
    expect(open).toBe(510);
    const full = fullDayShift();
    expect(isFullShift(full)).toBe(true);
    expect(shiftTimeText(shiftEndOf(full, open), TWO, true)).toBe('21:30');
    expect(shiftProblem(full, open)).toBeNull();
    expect(shiftPaidHours(full, open)).toBeGreaterThan(8);
    // 古いデータの「仕込みから閉店まで」（240分）
    const legacy: ShiftDay = { start: 0, end: 240, breakAt: 0, breakLen: 0, fromPrep: true };
    expect(isFullShift(legacy)).toBe(true);
    expect(shiftTimeText(shiftEndOf(legacy, open), TWO, true)).toBe('21:30');
    // 新しく採用したアルバイトの初めのシフトも閉店まで
    const e = addBot(s, 'server');
    e.profile.employment = undefined;
    initNewHire(e);
    for (let d = s.day; d < s.day + 7; d++) {
      const sh = shiftFor(e, d);
      if (sh) expect(shiftTimeText(shiftEndOf(sh, open), TWO, true)).toBe('21:30');
    }
  });

  it('仕込みから15:00まで（240分）を選ぶと、その時刻に帰る予定として残る（閉店までにはならない）。21:30 までの予定も組める', () => {
    const { s, ctx } = newGame(72);
    const st = activeStore(s);
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: st.id, hours: TWO }, ctx).ok).toBe(true);
    const e = addBot(s, 'server');
    e.profile.employment = 'part';
    initNewHire(e);
    const day = s.day + 3;
    const pick = (end: number): ShiftDay => ({ start: 0, end, breakAt: 0, breakLen: 0, fromPrep: true });
    expect(applyAction(s, 'p1', { type: 'setDateShift', employeeId: e.id, days: [day], shift: pick(240), mode: 'once' }, ctx).ok).toBe(true);
    const a = shiftFor(e, day)!;
    expect(isFullShift(a)).toBe(false);
    expect(shiftTimeText(shiftEndOf(a, 510), TWO, true)).toBe('15:00');
    // 21:30（510分）まで
    expect(applyAction(s, 'p1', { type: 'setDateShift', employeeId: e.id, days: [day + 1], shift: { start: 300, end: 510, breakAt: 0, breakLen: 0, fromPrep: false }, mode: 'once' }, ctx).ok).toBe(true);
    const b = shiftFor(e, day + 1)!;
    expect([shiftTimeText(b.start, TWO), shiftTimeText(shiftEndOf(b, 510), TWO, true)]).toEqual(['18:00', '21:30']);
  });
});
