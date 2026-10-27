import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, listVerbs, type GameState } from '../src';
import { eqByType, newGame, run, seatCustomer, standAt } from './helpers';

type Ctx = ReturnType<typeof newGame>['ctx'];

function act(s: GameState, ctx: Ctx, targetId: string, verb: string, args?: Record<string, number>) {
  const r = applyAction(s, 'p1', { type: 'interact', targetId, verb, args }, ctx);
  if (!r.ok) throw new Error(`${verb}: ${r.reason}`);
  const p = s.players[0]!;
  let guard = 0;
  while (p.work && guard++ < 1000) run(s, ctx, 0.1);
}

/** コールを聞かずに（トッピングなしで）提供して、必ずクレームになる客を作る */
function serveWrongBowl(s: GameState, ctx: Ctx, seatIndex: number) {
  const o = seatCustomer(s, seatIndex, 'small', undefined, { complaintPropensity: 1 });
  const rack = eqByType(s, 'bowl_rack');
  const asm = eqByType(s, 'assembly');
  const boiler = eqByType(s, 'noodle_boiler');
  standAt(s, 'p1', rack.id);
  act(s, ctx, rack.id, 'bowls_take', { count: 1 });
  standAt(s, 'p1', asm.id);
  act(s, ctx, asm.id, 'bowls_place');
  act(s, ctx, asm.id, 'tare');
  act(s, ctx, asm.id, 'soup');
  standAt(s, 'p1', boiler.id);
  act(s, ctx, boiler.id, 'noodles_in');
  run(s, ctx, BALANCE.cooking.noodleIdeal - 1);
  act(s, ctx, boiler.id, 'noodles_up');
  standAt(s, 'p1', asm.id);
  act(s, ctx, asm.id, 'bowl_take');
  s.players[0]!.pos = { x: 1.6, z: 2.85 };
  act(s, ctx, o.seatId, 'serve');
  return o;
}

describe('クレームで返金した客（食べずに帰る）', () => {
  it('残った丼を下げられ、席が空き、来店の評価も記録される', () => {
    const { s, ctx } = newGame(5);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.arrivalAcc = -1e9; // 自然来店を止める
    const o = serveWrongBowl(s, ctx, 0);
    const seat = s.seats.find((x) => x.id === o.seatId)!;
    const cust = s.customers.find((c) => c.id === o.customerId)!;
    expect(cust.state).toBe('complaint');
    const counted = s.today.satisfactionCount;

    act(s, ctx, seat.id, 'complaint_refund');
    expect(o.status).toBe('refunded');
    // 席は空き、客は帰る
    expect(seat.customerId).toBeNull();
    expect(cust.state).toBe('leaving');
    expect(s.today.satisfactionCount).toBe(counted + 1);
    // 手を付けていない丼は席に残り、下げられる
    const bowl = s.bowls.find((b) => b.id === seat.bowlId)!;
    expect(bowl.state).toBe('dirty');
    expect(bowl.contents).toBeNull();
    const collect = listVerbs(s, 'p1', seat.id).find((v) => v.verb === 'collect');
    expect(collect?.enabled).toBe(true);
    act(s, ctx, seat.id, 'collect');
    expect(seat.bowlId).toBeNull();
    expect(s.players[0]!.hand).toEqual({ kind: 'dirty', bowlIds: [bowl.id] });
  });
});

describe('忘れ物を受け取りに来た客', () => {
  it('返したあと、店内の待ち列の場所を空けて帰る', () => {
    const { s, ctx } = newGame(6);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.arrivalAcc = -1e9;
    const owner = seatCustomer(s, 0);
    const c = s.customers.find((x) => x.id === owner.customerId)!;
    // 席ではなく店内の待ち列にいる、忘れ物を取りに来た客にする
    s.seats[0]!.customerId = null;
    s.orders = s.orders.filter((x) => x.id !== owner.id);
    c.seatId = null;
    c.orderId = null;
    c.state = 'waitingSeat';
    s.lostItems.push({ id: 'L1', kind: '傘', ownerCustomerId: c.id, ownerRegularId: null, seatId: s.seats[0]!.id, state: 'stored', createdAt: 0, createdDay: s.day, neglect: 0, returnDay: s.day });
    c.forLostItem = 'L1';
    s.insideQueue.push(c.id);

    const desk = eqByType(s, 'desk');
    standAt(s, 'p1', desk.id);
    act(s, ctx, desk.id, 'lost_return');
    expect(s.lostItems.find((l) => l.id === 'L1')!.state).toBe('returned');
    expect(c.state).toBe('leaving');
    expect(s.insideQueue).not.toContain(c.id);
  });
});
