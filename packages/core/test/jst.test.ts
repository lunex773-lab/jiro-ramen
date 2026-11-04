import { describe, expect, it } from 'vitest';
import {
  addDays,
  DAY_MS,
  daysBetween,
  daysInMonth,
  isDateKey,
  isLeapYear,
  jstDateKey,
  jstMidnight,
  jstParts,
  nextJstMidnight,
  previousScopeKey,
  scopeKey,
  scopeKeys,
  scopeRange,
  weekStart,
  weekdayOfKey,
} from '../src/jst';

const utc = (s: string) => Date.parse(s);

describe('JST の日付（仕様書 12 章 1〜3・15）', () => {
  it('JST 0:00 で日付が切り替わる（UTC 15:00）', () => {
    expect(jstDateKey(utc('2026-11-04T14:59:59.999Z'))).toBe('2026-11-04');
    expect(jstDateKey(utc('2026-11-04T15:00:00.000Z'))).toBe('2026-11-05');
    expect(jstMidnight('2026-11-05')).toBe(utc('2026-11-04T15:00:00.000Z'));
  });

  it('次の 0:00 は、ちょうど 0:00 なら翌日の 0:00', () => {
    const m = jstMidnight('2026-11-05');
    expect(nextJstMidnight(m)).toBe(m + DAY_MS);
    expect(nextJstMidnight(m - 1)).toBe(m);
    expect(nextJstMidnight(m + 1)).toBe(m + DAY_MS);
  });

  it('月末・年末の切り替え', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(jstDateKey(utc('2026-12-31T15:00:00Z'))).toBe('2027-01-01');
    expect(scopeKey('year', '2026-12-31')).toBe('Y2026');
    expect(scopeKey('year', '2027-01-01')).toBe('Y2027');
    expect(scopeKey('month', '2026-12-31')).toBe('M2026-12');
    expect(scopeKey('month', '2027-01-01')).toBe('M2027-01');
  });

  it('閏年（2月29日・400年と100年の規則）', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(isDateKey('2028-02-29')).toBe(true);
    expect(isDateKey('2027-02-29')).toBe(false);
    expect(scopeRange('M2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(daysBetween('2028-01-01', '2029-01-01')).toBe(366);
  });

  it('週は JST の月曜日から日曜日', () => {
    // 2026-11-02 は月曜日
    expect(weekdayOfKey('2026-11-02')).toBe(1);
    expect(weekStart('2026-11-02')).toBe('2026-11-02');
    expect(weekStart('2026-11-08')).toBe('2026-11-02'); // 日曜日は同じ週
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(scopeKey('week', '2026-11-08')).toBe('W2026-11-02');
    expect(scopeRange('W2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    // 年をまたぐ週（2026-12-28 は月曜日）
    expect(weekStart('2027-01-03')).toBe('2026-12-28');
    // 日曜日の 23:59 JST と月曜日の 0:00 JST
    const sunLate = jstMidnight('2026-11-09') - 1;
    expect(scopeKey('week', jstDateKey(sunLate))).toBe('W2026-11-02');
    expect(scopeKey('week', jstDateKey(sunLate + 1))).toBe('W2026-11-09');
  });

  it('期間のキーと前の期間', () => {
    expect(scopeKeys('2026-11-04')).toEqual({ week: 'W2026-11-02', month: 'M2026-11', year: 'Y2026', total: 'T' });
    expect(previousScopeKey('W2026-11-02')).toBe('W2026-10-26');
    expect(previousScopeKey('M2027-01')).toBe('M2026-12');
    expect(previousScopeKey('M2028-03')).toBe('M2028-02');
    expect(previousScopeKey('Y2027')).toBe('Y2026');
    expect(previousScopeKey('T')).toBeNull();
  });

  it('端末の時刻のずれと関係なく、同じ時刻なら同じ日付', () => {
    const t = utc('2026-11-04T20:30:00Z');
    expect(jstParts(t)).toMatchObject({ year: 2026, month: 11, day: 5, hour: 5, minute: 30 });
  });

  it('不正なキーは受け付けない', () => {
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('2026-1-01')).toBe(false);
    expect(isDateKey(20261101)).toBe(false);
    expect(() => jstMidnight('x')).toThrow();
  });
});
