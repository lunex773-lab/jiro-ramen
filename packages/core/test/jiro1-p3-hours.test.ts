// じろ1 P3（docs/JIRO1_PLAN.md 5.1・5.2）: 営業時間（枠・定休日・日またぎ）・時間帯の需要・光熱費・給料の割り増し
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, timeCurve, type GameState, type SimCtx, type StoreHours } from '../src';
import { activeStore } from '../src/sim/company';
import { clockMinuteAt, clockText, DEFAULT_HOURS, hourDemand, hoursProblem, lateNightMinutes, openDurationOf, paidHoursWithPremium, SEC_PER_MIN, sessionSpans, todayHours, utilitiesBaseOf } from '../src/sim/hours';
import { expectedPay, fullTimePayFor, shiftTimeText } from '../src/sim/staff';
import { addBot, addSoloBot, newGame, run, runDay } from './helpers';

const H = (sessions: [number, number][], closedDays: number[] = []): StoreHours => ({ sessions: sessions.map(([o, c]) => ({ open: o * 60, close: c * 60 })), closedDays });

function nextDay(s: GameState, ctx: SimCtx): void {
  expect(applyAction(s, 'p1', { type: 'nextDay' }, ctx).ok).toBe(true);
}

describe('営業時間の設定', () => {
  it('枠は1〜3つ・30分刻み・1時間以上・間は30分以上・1日18時間まで。日をまたぐ枠も決められる', () => {
    expect(hoursProblem(DEFAULT_HOURS)).toBeNull();
    expect(hoursProblem(H([[11, 15], [17.5, 23]]))).toBeNull();
    expect(hoursProblem(H([[18, 26]]))).toBeNull();
    expect(hoursProblem(H([[11, 11.5]]))).not.toBeNull();
    expect(hoursProblem(H([[11, 15], [15, 20]]))).not.toBeNull();
    expect(hoursProblem(H([[17, 23], [11, 15]]))).not.toBeNull();
    expect(hoursProblem(H([[6, 26]]))).not.toBeNull();
    expect(hoursProblem(H([[11, 15]], [0, 1, 2, 3, 4, 5, 6]))).not.toBeNull();
    expect(hoursProblem({ sessions: [{ open: 665, close: 900 }], closedDays: [] })).not.toBeNull();
    expect(hoursProblem(H([[11, 13], [14, 16], [17, 19], [20, 22]]))).not.toBeNull();
  });

  it('時刻の表示: 日をまたぐと「翌」', () => {
    const h = H([[18, 26]]);
    expect(clockText(clockMinuteAt(h, 0))).toBe('18:00');
    expect(clockText(clockMinuteAt(h, 7 * 60 * SEC_PER_MIN))).toBe('翌1:00');
    expect(lateNightMinutes(h)).toBe(4 * 60);
    // 閉店の時刻ちょうど（シフトの「〜閉店」）とそのあとは、最後の枠の閉店の時刻（前は最初の開店の時刻に戻っていた）
    expect(clockText(clockMinuteAt(DEFAULT_HOURS, 240 * SEC_PER_MIN))).toBe('15:00');
    expect(clockText(clockMinuteAt(DEFAULT_HOURS, 300 * SEC_PER_MIN))).toBe('15:00');
    const two = H([[11, 14], [18, 25]]);
    expect(clockText(clockMinuteAt(two, 3 * 60 * SEC_PER_MIN))).toBe('18:00');
    expect(clockText(clockMinuteAt(two, 10 * 60 * SEC_PER_MIN))).toBe('翌1:00');
    // 終わりの時刻（退勤）として読むと、昼の枠の終わりは 14:00
    expect(shiftTimeText(180, two, true)).toBe('14:00');
    expect(shiftTimeText(180, two)).toBe('18:00');
    expect(shiftTimeText(240, DEFAULT_HOURS, true)).toBe('15:00');
  });
});

describe('時間帯の需要', () => {
  it('11〜15時は今までの山と同じ（難易度を変えない）。夜の山があり、深夜・早朝は低い', () => {
    for (const x of [0, 0.1, 0.42, 0.7, 0.99]) expect(hourDemand(660 + x * 240)).toBeCloseTo(timeCurve(x), 2);
    expect(hourDemand(19.5 * 60)).toBeGreaterThan(hourDemand(16 * 60));
    expect(hourDemand(4 * 60)).toBeLessThan(0.2);
    expect(hourDemand(25 * 60)).toBeCloseTo(hourDemand(60), 6);
  });
});

describe('費用', () => {
  it('光熱費の基本: 11〜15時の4時間は今までと同じ 2,500円。長いほど増え、休みの日は固定分だけ', () => {
    expect(utilitiesBaseOf(DEFAULT_HOURS, true)).toBe(BALANCE.utilitiesBase);
    expect(utilitiesBaseOf(H([[11, 23]]), true)).toBe(1000 + 375 * 12);
    expect(utilitiesBaseOf(H([[11, 23]]), false)).toBe(1000);
  });

  it('給料: 6時間を超えると休憩、8時間を超えた分と深夜は25%増し。11〜15時の店は今までと同じ', () => {
    expect(paidHoursWithPremium(4.5)).toBe(4.5);
    expect(paidHoursWithPremium(7)).toBe(6.25);
    expect(paidHoursWithPremium(10)).toBeCloseTo(9 + 0.25, 6);
    expect(paidHoursWithPremium(4, 2)).toBeCloseTo(4.5, 6);
    const { s } = newGame(1);
    const full = addBot(s, 'cook', 0.6, 8000);
    expect(fullTimePayFor(full, DEFAULT_HOURS)).toBe(8000);
    expect(fullTimePayFor(full, H([[11, 23]]))).toBeGreaterThan(8000 * 2.5);
    expect(expectedPay(full, 1, H([[11, 15]], [0]))).toBe(0);
  });
});

describe('営業時間どおりに営業する', () => {
  it('決めた営業時間は次の営業日から。今日は変わらない', () => {
    const { s, ctx } = newGame(11);
    addSoloBot(s);
    const id = activeStore(s).id;
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: id, hours: H([[11, 13]]) }, ctx).ok).toBe(true);
    expect(todayHours(s)).toEqual(DEFAULT_HOURS);
    expect(openDurationOf(s)).toBe(BALANCE.openDuration);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    nextDay(s, ctx);
    expect(todayHours(s)).toEqual(H([[11, 13]]));
    expect(openDurationOf(s)).toBe(BALANCE.openDuration / 2);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    run(s, ctx, BALANCE.openDuration / 2 - 5);
    expect(s.phase).toBe('open');
    run(s, ctx, 10);
    expect(s.phase).not.toBe('open');
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: id, hours: H([[11, 11.5]]) }, ctx).ok).toBe(false);
  });

  it('2つの枠: 1つ目が終わると中休み（仕込みの時間）になり、「開店する」で2つ目が始まって、終わると精算する', { timeout: 60_000 }, () => {
    const { s, ctx } = newGame(12);
    addSoloBot(s);
    activeStore(s).hours = H([[11, 13], [18, 20]]);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    nextDay(s, ctx);
    const spans = sessionSpans(todayHours(s));
    expect(spans).toHaveLength(2);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    for (let i = 0; i < 20_000 && !(s.phase === 'prep' && s.sessionIdx === 1); i++) run(s, ctx, 0.1);
    expect(s.phase).toBe('prep');
    expect(s.sessionIdx).toBe(1);
    const servedLunch = s.today.served;
    // 中休みは時間が止まる
    const t = s.openT;
    run(s, ctx, 30);
    expect(s.openT).toBe(t);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    expect(s.openT).toBe(spans[1]!.startT);
    expect(clockText(clockMinuteAt(todayHours(s), s.openT))).toBe('18:00');
    runDay(s, ctx);
    expect(s.phase).toBe('closed');
    const r = s.history.at(-1)!;
    expect(r.served).toBeGreaterThanOrEqual(servedLunch);
    expect(r.utilities).toBeGreaterThanOrEqual(1000 + 375 * 4);
  });

  it('定休日は営業せずに精算する（家賃はかかる。従業員は休みで給料なし）', () => {
    const { s, ctx } = newGame(13);
    addSoloBot(s);
    const e = addBot(s, 'server', 0.6, 7000);
    // 2日目は火曜（1日目 = 月曜）
    activeStore(s).hours = H([[11, 15]], [1]);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    nextDay(s, ctx);
    expect(s.phase).toBe('closed');
    const r = s.history.at(-1)!;
    expect(r.day).toBe(2);
    expect(r.served).toBe(0);
    expect(r.rent).toBeGreaterThan(0);
    expect(r.wages).toBe(0);
    expect(r.utilities).toBe(1000);
    expect(e.att?.status).toBe('off');
    nextDay(s, ctx);
    expect(s.phase).toBe('prep');
  });
});
