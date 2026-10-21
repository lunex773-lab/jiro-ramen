import { describe, expect, it } from 'vitest';
import { applyAction, arrivalRate, timeCurve } from '../src';
import { addBot, newGame, run, runDay } from './helpers';

describe('客AI', () => {
  it('提供されないと客は途中で帰り、注文はキャンセルされる', () => {
    const { s, ctx } = newGame(71);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    run(s, ctx, 300);
    expect(s.today.customers).toBeGreaterThan(0);
    expect(s.today.served).toBe(0);
    expect(s.today.lost).toBeGreaterThan(0);
    expect(s.notices.some((n) => n.code === 'walkout')).toBe(true);
  });

  it('来店→着席→食事→退店 の後、席が再び使える状態に戻る', () => {
    const { s, ctx } = newGame(72);
    addBot(s, 'cook');
    addBot(s, 'server');
    addBot(s, 'cleaner');
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    const rep = s.history[0]!;
    expect(rep.served).toBeGreaterThan(5);
    expect(s.seats.every((x) => x.customerId === null && x.bowlId === null)).toBe(true);
    expect(s.bowls.every((b) => b.state === 'clean')).toBe(true);
  });

  it('評判が高いほど来客が多い', () => {
    const { s } = newGame();
    s.phase = 'open';
    s.openT = 200;
    s.reputation = 2;
    const low = arrivalRate(s);
    s.reputation = 4.5;
    const high = arrivalRate(s);
    expect(high).toBeGreaterThan(low * 2);
  });

  it('値上げすると来客が減る', () => {
    const { s } = newGame();
    s.openT = 200;
    const base = arrivalRate(s);
    for (const k of Object.keys(s.prices)) s.prices[k] = s.prices[k]! + 400;
    expect(arrivalRate(s)).toBeLessThan(base);
  });

  it('昼にピークがある', () => {
    expect(timeCurve(0.42)).toBeGreaterThan(timeCurve(0.05));
    expect(timeCurve(0.42)).toBeGreaterThan(timeCurve(0.95));
  });

  it('満足した客の一部は常連になり、口コミが評判に反映される', () => {
    const { s, ctx } = newGame(73);
    addBot(s, 'cook', 0.9);
    addBot(s, 'cook', 0.9);
    addBot(s, 'server', 0.9);
    addBot(s, 'cleaner', 0.9);
    for (let d = 0; d < 3; d++) {
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    }
    expect(s.reviews.length).toBeGreaterThan(0);
    expect(s.regulars.length).toBeGreaterThan(0);
    expect(s.history[2]!.reputation).not.toBe(s.history[0]!.reputation);
  });
});
