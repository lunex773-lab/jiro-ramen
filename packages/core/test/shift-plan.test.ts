// アルバイトのシフトを営業時間に合わせて管理する（オーナーの指示 2026-11-11）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  autoShifts,
  DEFAULT_HOURS,
  emptyDayStats,
  managerWeeklyShifts,
  openMinutesOf,
  remapShift,
  shiftProblem,
  shiftsOf,
  shiftTable,
  shiftTimeText,
  type DayReport,
  type Employee,
  type GameState,
  type ShiftDay,
  type StoreHours,
} from '../src';
import { activeStore } from '../src/sim/company';
import { addBot, newGame } from './helpers';

const TWO: StoreHours = { sessions: [{ open: 660, close: 840 }, { open: 1080, close: 1500 }], closedDays: [] }; // 11–14・18–翌1
const DINNER: StoreHours = { sessions: [{ open: 1020, close: 1320 }], closedDays: [] }; // 17–22
const sh = (start: number, end: number, fromPrep = false): ShiftDay => ({ start, end, breakAt: 0, breakLen: 0, fromPrep });

function partTimer(s: GameState, name: string, week: (ShiftDay | null)[] = Array.from({ length: 7 }, () => sh(0, 240, true))): Employee {
  const e = addBot(s, 'server', 0.5, 0);
  e.profile.name = name;
  e.profile.employment = 'part';
  e.profile.hourly = 1100;
  e.profile.wishDays = [true, true, true, true, true, true, true];
  e.shifts = week;
  return e;
}

/** ふつうの日に来客60人の店の記録（11〜15時） */
function history(s: GameState, days = 7): void {
  s.history = [];
  for (let d = 1; d <= days; d++) {
    s.history.push({
      ...emptyDayStats(),
      day: d,
      customers: 60,
      balked: 0,
      served: 50,
      operatingProfit: 0,
      netSales: 0,
      finalProfit: 0,
      cashStart: 0,
      cashEnd: 0,
      reputation: 3,
      reviews: 0,
      avgSatisfaction: 0,
      avgWait: 0,
    } as DayReport);
  }
  s.day = days;
}

describe('営業時間を変えたら、アルバイトのシフトを合わせる', () => {
  it('同じ時刻に働く（新しい営業時間の外の分は削る）。「仕込みから最後まで」は新しい営業時間でも最後まで', () => {
    // 12:00〜14:00（11〜15時の店の60〜180分）→ 昼11〜14時・夜18時〜の店でも 12:00〜14:00
    const a = remapShift(sh(60, 180), DEFAULT_HOURS, TWO);
    expect([shiftTimeText(a.start, TWO), shiftTimeText(a.end, TWO, true)]).toEqual(['12:00', '14:00']);
    // 13:00〜15:00 → 14時で昼が終わるので 13:00〜14:00
    const b = remapShift(sh(120, 240), DEFAULT_HOURS, TWO);
    expect([shiftTimeText(b.start, TWO), shiftTimeText(b.end, TWO, true)]).toEqual(['13:00', '14:00']);
    // 仕込みから最後まで → 新しい営業時間の最後まで
    const c = remapShift(sh(0, 240, true), DEFAULT_HOURS, TWO);
    expect(c).toEqual(sh(0, openMinutesOf(TWO), true));
    // 夜だけの店（17〜22時）: 昼のシフトは重ならない → 同じ割合の位置・同じ長さ
    const d = remapShift(sh(60, 180), DEFAULT_HOURS, DINNER);
    expect(d.end - d.start).toBe(120);
    expect(shiftProblem(d, openMinutesOf(DINNER))).toBeNull();
  });

  it('店の営業時間を変えると、アルバイトの曜日ごとのシフトとあす以降の予定を直して知らせる（社員・今日の予定はそのまま）', () => {
    const { s, ctx } = newGame(41);
    const p = partTimer(s, '山田', Array.from({ length: 7 }, () => sh(120, 240)));
    p.dateShifts = { [String(s.day)]: sh(120, 240), [String(s.day + 2)]: sh(120, 240) };
    const f = addBot(s, 'cook', 0.6, 9000);
    f.shifts = Array.from({ length: 7 }, () => sh(0, 240, true));
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: activeStore(s).id, hours: TWO }, ctx).ok).toBe(true);
    expect(shiftsOf(p)[0]).toEqual(remapShift(sh(120, 240), DEFAULT_HOURS, TWO));
    expect(p.dateShifts![String(s.day)]).toEqual(sh(120, 240));
    expect(p.dateShifts![String(s.day + 2)]).toEqual(remapShift(sh(120, 240), DEFAULT_HOURS, TWO));
    expect(s.notices.find((n) => n.code.startsWith('hoursShifts:'))?.text).toContain('山田さん');
  });
});

describe('シフト表と自動で組む', () => {
  it('シフト表: 曜日ごと・1時間ごとの人数（店主を入れる）と必要な人数の目安。定休日の曜日は営業しない', () => {
    const { s } = newGame(42);
    history(s);
    activeStore(s).hours = { ...DEFAULT_HOURS, closedDays: [2] };
    partTimer(s, '佐藤', [sh(60, 180), null, null, null, null, null, null]);
    const t = shiftTable(s);
    expect(t).toHaveLength(7);
    expect(t[2]!.closed).toBe(true);
    expect(t[2]!.cells).toHaveLength(0);
    expect(t[0]!.cells).toHaveLength(4);
    // 月曜: 11時台は店主だけ・12〜13時台は店主＋佐藤さん
    expect(t[0]!.cells.map((c) => c.staff)).toEqual([1, 2, 2, 1]);
    expect(t[1]!.cells.map((c) => c.staff)).toEqual([1, 1, 1, 1]);
    // 昼の山（12時台）は 11時台より客が多い
    expect(t[0]!.cells[1]!.customers).toBeGreaterThan(t[0]!.cells[0]!.customers);
    expect(t[0]!.cells.every((c) => c.need >= 1)).toBe(true);
  });

  it('自動で組む: 客の多い時間に入れる・出られない曜日と定休日には入れない・週5回まで・シフトは正しい形', () => {
    const { s, ctx } = newGame(43);
    history(s);
    s.history.forEach((r) => (r.customers = 110)); // 忙しい店
    activeStore(s).hours = { ...DEFAULT_HOURS, closedDays: [0] };
    const a = partTimer(s, 'A');
    const b = partTimer(s, 'B');
    b.profile.wishDays = [true, true, true, false, false, true, true];
    const r = autoShifts(s, ctx);
    expect(r.ok).toBe(true);
    const open = openMinutesOf(activeStore(s).hours!);
    for (const e of [a, b]) {
      const w = shiftsOf(e);
      expect(w[0]).toBeNull();
      expect(w.filter(Boolean).length).toBeLessThanOrEqual(5);
      for (const x of w) if (x) expect(shiftProblem(x, open)).toBeNull();
    }
    expect(shiftsOf(b)[3]).toBeNull();
    expect(shiftsOf(b)[4]).toBeNull();
    // 土曜の昼の山（12時台）にはだれか入っている
    const sat = shiftTable(s)[5]!;
    expect(sat.cells[1]!.staff).toBeGreaterThanOrEqual(2);
    expect(s.notices.some((n) => n.code === 'autoShifts')).toBe(true);
  });

  it('暇な店では人を入れない（店主だけで足りる）。アルバイトがいなければ組めない', () => {
    const { s, ctx } = newGame(44);
    history(s);
    s.history.forEach((r) => (r.customers = 20));
    const a = partTimer(s, 'A');
    expect(autoShifts(s, ctx).ok).toBe(true);
    expect(shiftsOf(a).every((x) => x === null)).toBe(true);
    const { s: s2, ctx: c2 } = newGame(45);
    expect(applyAction(s2, 'p1', { type: 'autoShifts' }, c2).ok).toBe(false);
  });

  it('店長がいる店は、日曜の閉店後に店長が翌週のシフトを組み直す（方針で「自分で組む」にすると組まない）', () => {
    const { s, ctx } = newGame(46);
    history(s);
    s.history.forEach((r) => (r.customers = 110));
    s.career.unlocked.push('hiring');
    const m = addBot(s, 'cook', 0.7, 9000);
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: m.id }, ctx).ok).toBe(true);
    const a = partTimer(s, 'A');
    const before = JSON.stringify(a.shifts);
    activeStore(s).policy.shiftBy = 'self';
    s.day = 7; // 日曜
    managerWeeklyShifts(s, ctx);
    expect(JSON.stringify(a.shifts)).toBe(before);
    activeStore(s).policy.shiftBy = undefined;
    s.day = 6; // 土曜は組まない
    managerWeeklyShifts(s, ctx);
    expect(JSON.stringify(a.shifts)).toBe(before);
    s.day = 7;
    managerWeeklyShifts(s, ctx);
    expect(JSON.stringify(a.shifts)).not.toBe(before);
    expect(s.notices.find((n) => n.code === 'autoShifts')?.text).toContain('店長');
  });
});
