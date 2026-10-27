import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BALANCE,
  DEFAULT_CALL,
  evaluateBowl,
  emptyContents,
  noodleQualityFor,
  stockOf,
  type GameState,
} from '../src';
import { eqByType, newGame, run, seatCustomer, standAt } from './helpers';

function act(s: GameState, ctx: ReturnType<typeof newGame>['ctx'], targetId: string, verb: string, args?: Record<string, number>) {
  const r = applyAction(s, 'p1', { type: 'interact', targetId, verb, args }, ctx);
  if (!r.ok) throw new Error(`${verb}: ${r.reason}`);
  // 長押し作業は完了まで時間を進める
  const p = s.players[0]!;
  let guard = 0;
  while (p.work && guard++ < 1000) run(s, ctx, 0.1);
  return r;
}

describe('調理: 注文から提供まで', () => {
  it('タレ→スープ→麺→コール→トッピング→提供 で売上と原価が一度だけ計上される', () => {
    const { s, ctx } = newGame(1);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.arrivalAcc = -1e9; // 自然来店を止める
    const o = seatCustomer(s, 0);
    const rack = eqByType(s, 'bowl_rack');
    const asm = eqByType(s, 'assembly');
    const boiler = eqByType(s, 'noodle_boiler');
    const money0 = s.money;

    standAt(s, 'p1', rack.id);
    act(s, ctx, rack.id, 'bowls_take', { count: 1 });
    expect(s.players[0]!.hand.kind).toBe('clean');
    standAt(s, 'p1', asm.id);
    act(s, ctx, asm.id, 'bowls_place');
    const bowl = s.bowls.find((b) => b.orderId === o.id)!;
    expect(bowl).toBeTruthy();
    act(s, ctx, asm.id, 'tare');
    act(s, ctx, asm.id, 'soup');
    standAt(s, 'p1', boiler.id);
    act(s, ctx, boiler.id, 'noodles_in');
    expect(boiler.slots.filter(Boolean)).toHaveLength(1);
    run(s, ctx, BALANCE.cooking.noodleIdeal - 1);
    act(s, ctx, boiler.id, 'noodles_up');
    expect(bowl.contents!.noodleG).toBe(300);
    // コールを聞く（カウンター越し）
    s.players[0]!.pos = { x: 1.6, z: 2.85 };
    act(s, ctx, o.seatId, 'ask_call');
    expect(o.callRevealed).toBe(true);
    standAt(s, 'p1', asm.id);
    act(s, ctx, asm.id, 'toppings');
    expect(bowl.contents!.toppings.ninniku).toBe(1);
    expect(bowl.contents!.buta).toBe(2);
    act(s, ctx, asm.id, 'bowl_take');
    s.players[0]!.pos = { x: 1.6, z: 2.85 };
    act(s, ctx, o.seatId, 'serve');
    expect(o.status).toBe('served');
    expect(o.mistakes).toEqual([]);
    expect(o.quality!).toBeGreaterThan(0.75);
    expect(s.today.sales).toBe(o.price);
    expect(s.today.served).toBe(1);
    expect(s.today.cogs).toBeGreaterThan(100);
    expect(s.today.cogs).toBeLessThan(o.price * 0.5);
    expect(s.money).toBe(money0 + o.price);
    // 同じ注文に二度提供はできない
    const again = applyAction(s, 'p1', { type: 'interact', targetId: o.seatId, verb: 'serve' }, ctx);
    expect(again.ok).toBe(false);
    expect(s.transactions.filter((t) => t.type === 'sale')).toHaveLength(1);
  });

  it('ゆで加減: 理想に近いほど品質が高く、ゆですぎは低い', () => {
    const ideal = BALANCE.cooking.noodleIdeal;
    expect(noodleQualityFor(ideal, ideal)).toBe(1);
    expect(noodleQualityFor(ideal + 10, ideal)).toBeLessThan(0.8);
    expect(noodleQualityFor(ideal + 40, ideal)).toBeLessThan(0.3);
    expect(noodleQualityFor(ideal - 8, ideal)).toBeGreaterThan(noodleQualityFor(ideal + 8, ideal) - 0.2);
  });

  it('コールと違う盛り付けはミスとして判定される（ニンニク不要に入れた）', () => {
    const c = emptyContents(0);
    c.tare = 1; c.soupL = 0.35; c.soupQuality = 0.9; c.heat = 90; c.noodleG = 300; c.noodleQuality = 1; c.buta = 2; c.butaQuality = 1;
    c.toppings = { yasai: 1, ninniku: 1, abura: 0, ichimi: 0 };
    c.steps = ['tare', 'soup', 'noodles', 'toppings'];
    const ok = evaluateBowl(c, { menuId: 'small', call: { ...DEFAULT_CALL, ninniku: 1 } });
    const ng = evaluateBowl(c, { menuId: 'small', call: { ...DEFAULT_CALL } });
    expect(ok.mistakes).toEqual([]);
    expect(ng.mistakes).toContain('ニンニクを入れてしまった');
    expect(ng.quality).toBeLessThan(ok.quality);
    // 大と小の取り違え
    const big = evaluateBowl(c, { menuId: 'large', call: { ...DEFAULT_CALL, ninniku: 1 } });
    expect(big.mistakes.some((m) => m.includes('取り違え'))).toBe(true);
  });

  it('冷めた丼は品質が下がる', () => {
    const c = emptyContents(0);
    c.tare = 1; c.soupL = 0.35; c.soupQuality = 0.9; c.noodleG = 300; c.noodleQuality = 1; c.buta = 2; c.butaQuality = 1; c.steps = ['tare', 'soup', 'noodles', 'toppings'];
    c.heat = 92;
    const hot = evaluateBowl(c, { menuId: 'small', call: DEFAULT_CALL }).quality;
    c.heat = 55;
    const cold = evaluateBowl(c, { menuId: 'small', call: DEFAULT_CALL }).quality;
    expect(cold).toBeLessThan(hot * 0.75);
  });

  it('麺の在庫がないと麺を入れられない（在庫以上は消費しない）', () => {
    const { s, ctx } = newGame(2);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'noodle');
    const boiler = eqByType(s, 'noodle_boiler');
    standAt(s, 'p1', boiler.id);
    const r = applyAction(s, 'p1', { type: 'interact', targetId: boiler.id, verb: 'noodles_in' }, ctx);
    expect(r.ok).toBe(false);
    expect(stockOf(s, 'noodle')).toBe(0);
  });

  it('遠くからは操作できない', () => {
    const { s, ctx } = newGame(3);
    const boiler = eqByType(s, 'noodle_boiler');
    s.players[0]!.pos = { x: 0.5, z: 0.5 };
    const r = applyAction(s, 'p1', { type: 'interact', targetId: boiler.id, verb: 'noodles_in' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('遠すぎます');
  });

  it('作業中に離れると長押し作業は中断される', () => {
    const { s, ctx } = newGame(4);
    const prep = eqByType(s, 'prep_table');
    standAt(s, 'p1', prep.id);
    const before = stockOf(s, 'garlic');
    applyAction(s, 'p1', { type: 'interact', targetId: prep.id, verb: 'prep:chop_garlic' }, ctx);
    run(s, ctx, 1);
    s.players[0]!.pos = { x: 6, z: 3 };
    run(s, ctx, 10);
    expect(s.players[0]!.work).toBeNull();
    expect(stockOf(s, 'garlic')).toBe(before);
  });
});
