import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, seatCounterPoint, step, type GameState } from '../src';
import { addBot, newGame, run } from './helpers';

/** 食べ終わった後の席（汚れた丼が置いてある）を作る */
function finishedSeat(s: GameState, index: number, dirt: number) {
  const seat = s.seats[index]!;
  const bowl = s.bowls.find((x) => x.state === 'clean' && x.loc.at === 'rack')!;
  bowl.state = 'dirty';
  bowl.contents = null;
  bowl.loc = { at: 'seat', seatId: seat.id };
  seat.bowlId = bowl.id;
  seat.dirt = dirt;
  return { seat, bowl };
}

describe('片付け: カウンターを拭いてから丼を下げる', () => {
  it('汚れた席は拭くまで丼を下げられず、拭くと下げられる', () => {
    const { s, ctx } = newGame(5);
    const { seat } = finishedSeat(s, 0, 0.25);
    const p = s.players[0]!;
    p.pos = seatCounterPoint(s, seat);
    const early = applyAction(s, 'p1', { type: 'interact', targetId: seat.id, verb: 'collect' }, ctx);
    expect(early.ok).toBe(false);
    expect(early.reason).toBe('先にカウンターを拭いてください');
    expect(applyAction(s, 'p1', { type: 'interact', targetId: seat.id, verb: 'wipe' }, ctx).ok).toBe(true);
    run(s, ctx, BALANCE.cleaning.wipeTime + 0.5);
    expect(seat.dirt).toBeLessThan(BALANCE.cleaning.counterCleanBelow);
    expect(applyAction(s, 'p1', { type: 'interact', targetId: seat.id, verb: 'collect' }, ctx).ok).toBe(true);
    run(s, ctx, 1);
    expect(seat.bowlId).toBeNull();
    expect(p.hand.kind).toBe('dirty');
  });

  it('汚れていない席は拭かずに丼を下げられる', () => {
    const { s, ctx } = newGame(5);
    const { seat } = finishedSeat(s, 1, 0);
    s.players[0]!.pos = seatCounterPoint(s, seat);
    expect(applyAction(s, 'p1', { type: 'interact', targetId: seat.id, verb: 'collect' }, ctx).ok).toBe(true);
  });

  it('丼が置いてある間は、次のお客さんはその席に座らない（拭いている途中で座られない）', () => {
    const { s, ctx } = newGame(5);
    // 1席だけ残して、ほかの席はふさぐ
    for (const [i, seat] of s.seats.entries()) if (i !== 2) seat.installed = false;
    const { seat } = finishedSeat(s, 2, 0.5);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.reputation = 5;
    run(s, ctx, 120);
    expect(seat.customerId).toBeNull();
    expect(seat.bowlId).not.toBeNull();
  });

  it('従業員は、汚れが少ない席でも拭いてから丼を下げ、片付けが止まらない', () => {
    const { s, ctx } = newGame(7);
    addBot(s, 'cleaner');
    // 以前は 0.3 未満の汚れでは「拭く」仕事が出ず、拭かないと下げられない今のルールだと止まってしまう
    const a = finishedSeat(s, 0, 0.1);
    const b = finishedSeat(s, 3, 0.6);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    for (let i = 0; i < 1200 && (a.seat.bowlId || b.seat.bowlId); i++) step(s, 0.1, ctx);
    expect(a.seat.bowlId).toBeNull();
    expect(b.seat.bowlId).toBeNull();
    expect(a.seat.dirt).toBeLessThan(BALANCE.cleaning.counterCleanBelow);
    expect(b.seat.dirt).toBeLessThan(BALANCE.cleaning.counterCleanBelow);
  });
});
