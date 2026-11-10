// じろ1 P1（docs/JIRO1_PLAN.md 5.9）: バズの長さ・オンライン市場の初回の爆発の確率・常連の上限
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE } from '../src';
import { accidentChance } from '../src/sim/accident';
import { buzzLengthLabel, buzzMinutes } from '../src/sim/visitors';
import { ensureEvents } from '../src/sim/events';
import { addSoloBot, newGame, run } from './helpers';

describe('バズの長さ（1〜3時間の30分刻み）', () => {
  it('60・90・120・150・180分のどれかになり、どれも出る', () => {
    const seen = new Set<number>();
    const ev = { rng: 12345 };
    for (let i = 0; i < 500; i++) seen.add(buzzMinutes(ev));
    expect([...seen].sort((a, b) => a - b)).toEqual([60, 90, 120, 150, 180]);
    expect(buzzLengthLabel(90)).toBe('1時間30分');
    expect(buzzLengthLabel(120)).toBe('2時間');
  });

  it('起きたバズの終わりの時刻は、選んだ長さ（閉店まで）', () => {
    const { s, ctx } = newGame(41);
    addSoloBot(s);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    run(s, ctx, 30);
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'sns_buzz' }, ctx).ok).toBe(true);
    const b = s.events!.buzz!;
    expect([60, 90, 120, 150, 180]).toContain(b.minutes);
    const perMin = BALANCE.openDuration / ((BALANCE.closeHour - BALANCE.openHour) * 60);
    expect(b.endT).toBeCloseTo(Math.min(BALANCE.openDuration, b.startT + b.minutes! * perMin), 5);
  });
});

describe('爆発の確率', () => {
  it('ひとりの経営は通常の確率', () => {
    const { s } = newGame(1);
    expect(accidentChance(s)).toBe(BALANCE.events.explosion.chancePerDay);
  });
  it('オンライン市場の会社は、まだ起きていなければ 0.1%、一度起きたあとは通常の確率', () => {
    const { s } = newGame(1);
    s.marketDemand = { [s.company.activeStoreId]: 1 };
    expect(accidentChance(s)).toBe(0.001);
    const ev = ensureEvents(s);
    ev.stats.explosion = { draws: 1, fired: 1, forced: 0, lastDay: 3 };
    expect(accidentChance(s)).toBe(BALANCE.events.explosion.chancePerDay);
  });
});

describe('常連の上限', () => {
  it('150人', () => {
    expect(BALANCE.reputation.maxRegulars).toBe(150);
  });
});
