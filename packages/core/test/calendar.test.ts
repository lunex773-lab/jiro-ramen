import { describe, expect, it } from 'vitest';
import { BALANCE, calendarDemand, dateLabel, gameDate, seasonDemand, seasonName, weekdayDemand, YEAR_DAYS } from '../src';

describe('ゲームの暦と、曜日・季節の需要（オーナーの判断 11: 小さめ・平均は変えない）', () => {
  it('1日目は1年目の4月1日（月）。365日でめぐり、月末・年末がつながる', () => {
    expect(gameDate(1)).toMatchObject({ year: 1, month: 4, date: 1, weekday: 0, doy: 0 });
    expect(dateLabel(1)).toBe('4月1日（月）');
    expect(gameDate(30)).toMatchObject({ month: 4, date: 30 });
    expect(gameDate(31)).toMatchObject({ month: 5, date: 1 });
    expect(gameDate(275)).toMatchObject({ month: 12, date: 31 });
    expect(gameDate(276)).toMatchObject({ month: 1, date: 1 });
    expect(gameDate(365)).toMatchObject({ year: 1, month: 3, date: 31 });
    expect(gameDate(366)).toMatchObject({ year: 2, month: 4, date: 1, doy: 0 });
    expect(seasonName(1)).toBe('春');
    expect(seasonName(100)).toBe('夏');
    expect(seasonName(290)).toBe('冬');
  });

  it('曜日の倍率は1週間の平均が1。土日は多く、平日は少ない', () => {
    let sum = 0;
    for (let d = 1; d <= 7; d++) sum += weekdayDemand(d);
    expect(sum / 7).toBeCloseTo(1, 10);
    expect(weekdayDemand(6)).toBeGreaterThan(1.1); // 土
    expect(weekdayDemand(1)).toBeLessThan(0.95); // 月
    expect(Math.max(...[1, 2, 3, 4, 5, 6, 7].map(weekdayDemand))).toBeLessThan(1.16);
    expect(Math.min(...[1, 2, 3, 4, 5, 6, 7].map(weekdayDemand))).toBeGreaterThan(0.9);
  });

  it('季節の倍率は1年の平均が1。1月中旬がいちばん多く（+8%）、7月中旬がいちばん少ない（−8%）', () => {
    let sum = 0;
    for (let d = 1; d <= YEAR_DAYS; d++) sum += seasonDemand(d);
    expect(sum / YEAR_DAYS).toBeCloseTo(1, 6);
    const peak = BALANCE.calendar.seasonPeakDoy + 1;
    expect(gameDate(peak)).toMatchObject({ month: 1, date: 15 });
    expect(seasonDemand(peak)).toBeCloseTo(1.08, 6);
    const low = [...Array(YEAR_DAYS).keys()].map((i) => i + 1).reduce((a, d) => (seasonDemand(d) < seasonDemand(a) ? d : a), 1);
    expect(gameDate(low).month).toBe(7);
    expect(seasonDemand(low)).toBeCloseTo(0.92, 3);
  });

  it('練習の日（0日目）は倍率1。曜日 × 季節を掛ける', () => {
    expect(calendarDemand(0)).toBe(1);
    expect(calendarDemand(10)).toBeCloseTo(weekdayDemand(10) * seasonDemand(10), 12);
  });
});
