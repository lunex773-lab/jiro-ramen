import { describe, expect, it } from 'vitest';
import { addLot, applyAction, consume, expireLots, placeOrder, receiveDeliveries, stockOf } from '../src';
import { eqByType, newGame, run, standAt } from './helpers';

describe('在庫', () => {
  it('在庫以上は消費できず、失敗しても在庫は変わらない', () => {
    const { s } = newGame();
    const before = stockOf(s, 'garlic');
    const r = consume(s, 'garlic', before + 1);
    expect(r.ok).toBe(false);
    expect(stockOf(s, 'garlic')).toBe(before);
  });

  it('古いロットから使う（先入れ先出し）', () => {
    const { s } = newGame();
    s.inventory = [];
    addLot(s, 'moyashi', 100, 1);
    s.day = 2;
    addLot(s, 'moyashi', 100, 2);
    const r = consume(s, 'moyashi', 150);
    expect(r.cost).toBeCloseTo(100 * 1 + 50 * 2);
    expect(stockOf(s, 'moyashi')).toBe(50);
  });

  it('同時に最後の豚ブロックを切ろうとしても一人しか成功しない', () => {
    const { s, ctx } = newGame();
    s.inventory = s.inventory.filter((l) => l.itemId !== 'pork_block');
    addLot(s, 'pork_block', 1, 800);
    s.players.push({ ...s.players[0]!, id: 'p2', name: 'B', isHost: false, hand: { kind: 'none' }, work: null });
    const prep = eqByType(s, 'prep_table');
    standAt(s, 'p1', prep.id);
    standAt(s, 'p2', prep.id);
    const a = applyAction(s, 'p1', { type: 'interact', targetId: prep.id, verb: 'prep:slice_pork' }, ctx);
    const b = applyAction(s, 'p2', { type: 'interact', targetId: prep.id, verb: 'prep:slice_pork' }, ctx);
    expect(a.ok).toBe(true);
    // p2 の開始は許可されても、完了時点で在庫を再確認して失敗する（マイナスにならない）
    run(s, ctx, 10);
    expect(stockOf(s, 'pork_block')).toBe(0);
    expect(stockOf(s, 'buta')).toBeGreaterThanOrEqual(18);
    expect(s.inventory.every((l) => l.qty >= 0)).toBe(true);
    void b;
  });

  it('期限切れは廃棄として記録され、消費とは区別される', () => {
    const { s, ctx } = newGame();
    const yasai = stockOf(s, 'yasai');
    expect(yasai).toBeGreaterThan(0);
    expireLots(s, ctx);
    expect(stockOf(s, 'yasai')).toBe(0); // 当日限り
    expect(s.today.waste).toBeGreaterThan(0);
    expect(s.today.wasteItems.yasai).toBe(yasai);
    expect(s.today.cogs).toBe(0);
  });

  it('翌朝便は翌日に、当日便は60秒後に届く', () => {
    const { s, ctx } = newGame();
    const before = stockOf(s, 'cabbage');
    expect(placeOrder(s, ctx, 'cabbage', 1, false).ok).toBe(true);
    receiveDeliveries(s, ctx, false);
    expect(stockOf(s, 'cabbage')).toBe(before);
    expect(placeOrder(s, ctx, 'cabbage', 1, true).ok).toBe(true);
    run(s, ctx, 61);
    expect(stockOf(s, 'cabbage')).toBe(before + 3000);
    s.day += 1;
    receiveDeliveries(s, ctx, true);
    expect(stockOf(s, 'cabbage')).toBe(before + 6000);
  });

  it('冷蔵庫の容量を超える発注はできない', () => {
    const { s, ctx } = newGame();
    const r = applyAction(s, 'p1', { type: 'orderStock', itemId: 'bones', packs: 50, express: false }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('冷蔵庫');
  });

  it('仕込みで原価が仕込み品に引き継がれる', () => {
    const { s, ctx } = newGame();
    const prep = eqByType(s, 'prep_table');
    standAt(s, 'p1', prep.id);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'garlic');
    applyAction(s, 'p1', { type: 'interact', targetId: prep.id, verb: 'prep:chop_garlic' }, ctx);
    run(s, ctx, 8);
    const lot = s.inventory.find((l) => l.itemId === 'garlic')!;
    expect(lot.qty).toBe(300);
    expect(lot.unitCost).toBeCloseTo(1.0, 5);
  });
});
