// じろ7 Phase 4: ゲーム内の時刻（場面から）・月齢・光害・夜の度合い（設計書 1）
import { describe, expect, it } from 'vitest';
import {
  gameClockMinute,
  LUNAR_DAYS,
  lightPollution,
  locationInfo,
  moonIllumination,
  moonPhase,
  MUNICIPALITIES,
  nightness,
  SEC_PER_MIN,
  skyPeriod,
  skyState,
  type GameState,
  type StoreHours,
} from '../src';
import { activeStore } from '../src/sim/company';
import { newGame } from './helpers';

const LUNCH: StoreHours = { sessions: [{ open: 660, close: 900 }], closedDays: [] };

function at(s: GameState, phase: GameState['phase'], hours: StoreHours, o: Partial<GameState> = {}): GameState {
  s.todayHours = hours;
  s.phase = phase;
  Object.assign(s, o);
  return s;
}

describe('ゲーム内の時刻（場面から。現実の時刻とは関係ない）', () => {
  it('仕込みは開店前の朝、営業中は時計、閉店作業は閉店のすぐあと、閉店後は夜（21時か閉店の30分後）', () => {
    const { s } = newGame(1);
    expect(gameClockMinute(at(s, 'prep', LUNCH, { t: 0, sessionIdx: 0 }))).toBe(570);
    expect(gameClockMinute(at(s, 'prep', LUNCH, { t: 600 * SEC_PER_MIN }))).toBe(655);
    expect(gameClockMinute(at(s, 'open', LUNCH, { openT: 0 }))).toBe(660);
    expect(gameClockMinute(at(s, 'open', LUNCH, { openT: 60 * SEC_PER_MIN }))).toBe(720);
    expect(gameClockMinute(at(s, 'closing', LUNCH, { openT: 240 * SEC_PER_MIN, sessionIdx: 0 }))).toBe(910);
    expect(gameClockMinute(at(s, 'closed', LUNCH))).toBe(21 * 60);
    // 夜の店: 閉店の30分後。日をまたぐ店（25:00 閉店）は翌1:30
    expect(gameClockMinute(at(s, 'closed', { sessions: [{ open: 1080, close: 1380 }], closedDays: [] }))).toBe(1410);
    expect(gameClockMinute(at(s, 'closed', { sessions: [{ open: 1200, close: 1500 }], closedDays: [] }))).toBe(90);
    // 中休み（2つ目の枠の前）は、前の枠の閉店と次の枠の開店の間
    expect(gameClockMinute(at(s, 'prep', { sessions: [{ open: 660, close: 900 }, { open: 1080, close: 1320 }], closedDays: [] }, { sessionIdx: 1 }))).toBe(990);
  });

  it('夜の度合いは昼0・夜1で、夜明け・夕暮れの間は滑らかに変わる。時間帯の名前', () => {
    expect(nightness(12 * 60)).toBe(0);
    expect(nightness(0)).toBe(1);
    expect(nightness(21 * 60)).toBe(1);
    const dawn = nightness(5 * 60 + 40);
    expect(dawn).toBeGreaterThan(0);
    expect(dawn).toBeLessThan(1);
    // 夕方から夜へ、少しずつ暗くなる
    const seq = [17 * 60, 18 * 60, 18 * 60 + 30, 19 * 60, 19 * 60 + 30].map(nightness);
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThanOrEqual(seq[i - 1]!);
    expect(skyPeriod(2 * 60)).toBe('深夜');
    expect(skyPeriod(4 * 60 + 30)).toBe('夜明け前');
    expect(skyPeriod(5 * 60 + 40)).toBe('朝焼け');
    expect(skyPeriod(8 * 60)).toBe('朝');
    expect(skyPeriod(12 * 60)).toBe('昼');
    expect(skyPeriod(17 * 60)).toBe('夕方');
    expect(skyPeriod(18 * 60 + 10)).toBe('夕焼け');
    expect(skyPeriod(19 * 60)).toBe('日没');
    expect(skyPeriod(21 * 60)).toBe('夜');
  });

  it('月齢はゲーム内の日付で約29.5日ごとにめぐり、新月は暗く満月は明るい', () => {
    expect(moonPhase(1)).toBeCloseTo(moonPhase(1 + LUNAR_DAYS), 6);
    expect(moonIllumination(0)).toBeCloseTo(0, 6);
    expect(moonIllumination(0.5)).toBeCloseTo(1, 6);
    const phases = Array.from({ length: 30 }, (_, i) => moonPhase(i + 1));
    expect(Math.max(...phases)).toBeLessThan(1);
    expect(Math.min(...phases)).toBeGreaterThanOrEqual(0);
  });
});

describe('光害（地域の人口密度と店の周りから、同じ式で）', () => {
  it('都会は明るく、田舎は暗い。どちらも端の値にはしない（都会でも星は少し見え、田舎も真っ暗ではない）', () => {
    const { s } = newGame(2);
    const st = activeStore(s);
    st.location = '13104';
    const city = lightPollution(s);
    const rural = Object.keys(MUNICIPALITIES).find((c) => (locationInfo(c)?.densityIndex ?? 0) < -0.9)!;
    st.location = rural;
    const country = lightPollution(s);
    delete st.location;
    const town = lightPollution(s);
    expect(city).toBeGreaterThan(0.85);
    expect(country).toBeLessThan(0.15);
    expect(town).toBeGreaterThan(country);
    expect(town).toBeLessThan(city);
    for (const v of [city, country, town]) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
    // 空の状態にまとめて入る
    s.phase = 'closed';
    s.todayHours = LUNCH;
    const sky = skyState(s);
    expect(sky.night).toBe(1);
    expect(sky.period).toBe('夜');
    expect(sky.lightPollution).toBeCloseTo(town, 6);
  });
});
