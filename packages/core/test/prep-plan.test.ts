import { describe, expect, it } from 'vitest';
import { applyAction, autoOrderTarget, BALANCE, nextDay, PREP_RECIPES, restockTarget, step, stockOf } from '../src';
import { addLot } from '../src/sim/inventory';
import { addBot, addSoloBot, newGame, runDay } from './helpers';

/** 1日営業して次の日にし、前日の使用量を書き換える */
function dayWithUsage(seed: number, used: Record<string, number>) {
  const { s, ctx } = newGame(seed);
  addSoloBot(s);
  applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
  nextDay(s, ctx);
  s.history[s.history.length - 1]!.usedItems = used;
  s.history[s.history.length - 1]!.stockoutItems = {};
  s.employees = [];
  return { s, ctx };
}

describe('従業員の仕込みの目安（売れ行きに合わせる）', () => {
  it('前日に多く使った物ほど、仕込みの目安が大きくなる（少なければ決まった量のまま）', () => {
    const r = PREP_RECIPES.braise_pork!;
    const { s } = dayWithUsage(81, { buta: 10 });
    expect(restockTarget(s, r)).toBe(r.restockBelow!.qty);
    const P = BALANCE.prepPlan;
    s.history[s.history.length - 1]!.usedItems = { buta: BALANCE.openDuration };
    const lead = r.time + P.leadMarginSec + PREP_RECIPES.slice_pork!.time;
    expect(restockTarget(s, r)).toBeCloseTo(1 * P.peakFactor * lead * P.safety, 5);
    // 品切れがあった日は多めに見る
    s.history[s.history.length - 1]!.stockoutItems = { 'menu:buta': 5 };
    expect(restockTarget(s, r)).toBeCloseTo(P.stockoutBoost * P.peakFactor * lead * P.safety, 5);
  });

  it('よく売れる店では煮込み鍋2台を同時に使い、煮込み中でも残りのブロックを切る', { timeout: 30_000 }, () => {
    const { s, ctx } = dayWithUsage(82, { buta: BALANCE.openDuration * 0.8 });
    s.money = 2_000_000;
    expect(applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'braise_pot', autoPlace: true }, ctx).ok).toBe(true);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'buta' && l.itemId !== 'pork_block');
    addLot(s, 'pork_raw', 12, 800);
    addLot(s, 'soy', 10_000, 1);
    addBot(s, 'prep');
    const pots = s.equipment.filter((e) => e.type === 'braise_pot');
    expect(pots).toHaveLength(2);
    let both = false;
    for (let i = 0; i < 600 && !both; i++) {
      step(s, 0.1, ctx);
      both = pots.every((p) => p.process?.recipeId === 'braise_pork');
    }
    expect(both).toBe(true);
    // 煮込み中に、残っていたブロックを切る
    addLot(s, 'pork_block', 2, 3000);
    let sliced = false;
    for (let i = 0; i < 400 && !sliced; i++) {
      step(s, 0.1, ctx);
      sliced = stockOf(s, 'buta') > 0;
    }
    expect(sliced).toBe(true);
    expect(pots.some((p) => p.process?.recipeId === 'braise_pork')).toBe(true);
  });

  it('豚の品切れのときは、煮込みに使う醤油の自動発注も増やす（売れ行きに合わせる）', () => {
    const { s, ctx } = newGame(83);
    applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx);
    s.today.usedItems = { soy: 4000 };
    const A = BALANCE.autoOrderSales;
    expect(autoOrderTarget(s, 'soy')).toBe(Math.max(Math.round((s.autoOrder.soy ?? 0) * A.floorOfManual), Math.round(4000 * A.safety)));
    s.today.stockoutItems = { 'menu:buta': 4 };
    expect(autoOrderTarget(s, 'soy')).toBe(Math.max(Math.round((s.autoOrder.soy ?? 0) * A.floorOfManual), Math.round(4000 * A.safety * A.stockoutBoost)));
  });
});
