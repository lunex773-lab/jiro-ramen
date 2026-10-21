import { describe, expect, it } from 'vitest';
import { applyAction, validateLayout } from '../src';
import { addBot, newGame, runDay } from './helpers';

describe('smoke', () => {
  it('default layout is valid', () => {
    const { s } = newGame();
    const r = validateLayout(s);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('a day with bots runs to settlement', () => {
    const { s, ctx } = newGame(7);
    addBot(s, 'cook');
    addBot(s, 'cook');
    addBot(s, 'server');
    addBot(s, 'cleaner');
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    const rep = s.history[0]!;
    console.log(JSON.stringify({ served: rep.served, customers: rep.customers, lost: rep.lost, balked: rep.balked, sales: rep.sales, cogs: rep.cogs, op: rep.operatingProfit, rep: rep.reputation, sat: rep.avgSatisfaction.toFixed(2), wait: rep.avgWait.toFixed(1), mistakes: rep.mistakes, stockouts: rep.stockouts, complaints: rep.complaints, waste: rep.waste }));
    console.log(s.notices.map((n) => n.text).join('\n'));
    expect(s.phase).toBe('closed');
    expect(rep.served).toBeGreaterThan(0);
  });
});
