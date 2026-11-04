import { describe, expect, it } from 'vitest';
import { applyAction, canonicalJson, nextDay, rollCall } from '../src';
import { addBot, addSoloBot, newGame, runDay } from './helpers';

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

  it('前に別のゲームを動かしていても、同じシードなら同じ結果（ゲームの状態の外に記録を持たない）', () => {
    const play = (seed: number, days: number) => {
      const { s, ctx } = newGame(seed);
      addSoloBot(s);
      addBot(s, 'server');
      for (let d = 0; d < days; d++) {
        applyAction(s, 'p1', { type: 'openShop' }, ctx);
        runDay(s, ctx);
        if (d < days - 1) nextDay(s, ctx);
      }
      return canonicalJson(s);
    };
    const first = play(55, 3);
    // 別のゲームを動かす（同じ従業員の ID・仕事の名前が使われる）
    play(77, 2);
    expect(play(55, 3)).toBe(first);
  });

  it('失敗した仕事を避ける記録は従業員の状態に持ち、毎朝消える（前日の時刻が翌日に残らない）', () => {
    const { s, ctx } = newGame(9);
    const e = addBot(s, 'cook');
    e.ai.failed = { 'serve:o1': 500 };
    s.phase = 'prep';
    rollCall(s, ctx);
    expect(e.ai.failed).toBeUndefined();
  });
});
