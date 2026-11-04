import { describe, expect, it } from 'vitest';
import { addLot, applyAction, autoOrderTarget, BALANCE, consume, expireLots, fridgeCapacity, fridgeUsage, nextDay, pendingOf, placeOrder, receiveDeliveries, runAutoOrder, stockOf } from '../src';
import { addBot, addSoloBot, eqByType, newGame, run, runDay, standAt } from './helpers';

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
    expect(lot.qty).toBe(500);
    expect(lot.unitCost).toBeCloseTo(1.0, 5);
  });
});

describe('自動発注と冷蔵庫の容量（統合進化設計書 v2.1 の測定で見つけた問題）', () => {
  it('目安が冷蔵庫に入りきらないときは比例して減らし、残りが少ない食材（もやし）も入る。知らせが出る', () => {
    const { s, ctx } = newGame(41);
    for (const [itemId, qty] of Object.entries(s.autoOrder)) applyAction(s, 'p1', { type: 'setAutoOrder', itemId, qty: qty * 4 }, ctx);
    // もやしを使い切った状態にする
    s.inventory = s.inventory.filter((l) => l.itemId !== 'moyashi');
    runAutoOrder(s, ctx);
    expect(fridgeUsage(s, true)).toBeLessThanOrEqual(fridgeCapacity(s) + 1e-6);
    expect(pendingOf(s, 'moyashi')).toBeGreaterThan(0);
    expect(s.notices.some((n) => n.code === 'autoorder:fridge')).toBe(true);
  });

  it('自動発注を3倍にしても店は回り続ける（以前は止まった）。ただし廃棄が増えて損をする', { timeout: 60_000 }, () => {
    const play = (mult: number) => {
      const { s, ctx } = newGame(42);
      addSoloBot(s);
      for (const [itemId, qty] of Object.entries(s.autoOrder)) applyAction(s, 'p1', { type: 'setAutoOrder', itemId, qty: Math.round(qty * mult) }, ctx);
      for (let d = 0; d < 10; d++) {
        applyAction(s, 'p1', { type: 'openShop' }, ctx);
        runDay(s, ctx);
        nextDay(s, ctx);
      }
      return s.history;
    };
    const base = play(1);
    const over = play(3);
    const served = (h: typeof base) => h.slice(3).reduce((a, r) => a + r.served, 0) / (h.length - 3);
    const waste = (h: typeof base) => h.reduce((a, r) => a + r.waste, 0);
    expect(served(over)).toBeGreaterThan(20);
    expect(waste(over)).toBeGreaterThan(waste(base));
  });
});

describe('自動発注「売れ行きに合わせる」', () => {
  it('最近の使用量に余裕をみた量まで発注し、品切れした食材は多めにする。手動の目安の半分は必ず持つ。手動では目安のまま', () => {
    const { s, ctx } = newGame(43);
    expect(autoOrderTarget(s, 'pork_raw')).toBe(s.autoOrder.pork_raw);
    expect(applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx).ok).toBe(true);
    // 使用量が多い日（豚ウデ肉を1日12本）
    s.today.usedItems = { pork_raw: 12 };
    const t = autoOrderTarget(s, 'pork_raw');
    expect(t).toBe(Math.round(12 * BALANCE.autoOrderSales.safety));
    s.today.stockoutItems = { buta: 6 };
    expect(autoOrderTarget(s, 'pork_raw')).toBe(Math.round(12 * BALANCE.autoOrderSales.safety * BALANCE.autoOrderSales.stockoutBoost));
    // 使わなかった食材も、手動の目安の半分は持つ
    s.today.usedItems = {};
    s.today.stockoutItems = {};
    expect(autoOrderTarget(s, 'ichimi')).toBe(Math.round(s.autoOrder.ichimi! * BALANCE.autoOrderSales.floorOfManual));
    expect(applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'manual' }, ctx).ok).toBe(true);
    expect(autoOrderTarget(s, 'pork_raw')).toBe(s.autoOrder.pork_raw);
    expect(applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'x' as 'manual' }, ctx).ok).toBe(false);
  });

  it('調理担当を雇って杯数が増えても、売れ行きに合わせると豚の品切れが目安の量のままより少ない', { timeout: 120_000 }, () => {
    const play = (mode: 'manual' | 'sales') => {
      const { s, ctx } = newGame(44);
      addSoloBot(s);
      addBot(s, 'cook', 0.6);
      applyAction(s, 'p1', { type: 'setAutoOrderMode', mode }, ctx);
      for (let d = 0; d < 12; d++) {
        applyAction(s, 'p1', { type: 'openShop' }, ctx);
        runDay(s, ctx);
        nextDay(s, ctx);
      }
      return s.history.slice(4).reduce((a, r) => a + (r.stockoutItems?.buta ?? 0) + (r.stockoutItems?.['menu:buta'] ?? 0), 0);
    };
    expect(play('sales')).toBeLessThan(play('manual'));
  });
});
