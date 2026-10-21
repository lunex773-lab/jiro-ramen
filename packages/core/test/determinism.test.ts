import { describe, expect, it } from 'vitest';
import { applyAction, canonicalJson } from '../src';
import { addBot, newGame, runDay } from './helpers';

describe('決定性', () => {
  it('同じシードと同じ操作なら同じ結果になる（サーバーとクライアントで再現可能）', () => {
    const play = () => {
      const { s, ctx } = newGame(123);
      addBot(s, 'cook');
      addBot(s, 'server');
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      return canonicalJson(s);
    };
    expect(play()).toBe(play());
  });
});
