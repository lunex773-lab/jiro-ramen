// 仕込みの調整（オーナーの指示 2026-11-12）: ①仕込むときに量を選べる ③開店前の仕込みの計画 ④時間帯・曜日で量を変える
// （②仕込み専用の画面は client。ここでは画面が使う数字を確かめる）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  listVerbs,
  PREP_RECIPES,
  prepPlanProgress,
  prepScheduleMult,
  restockTarget,
  STORE_KEYS,
  stockOf,
  suggestPrepPlan,
  weekdayOf,
  type GameState,
  type SimCtx,
} from '../src';
import { addLot } from '../src/sim/inventory';
import { addBot, eqByType, newGame, run, standAt } from './helpers';

const act = (s: GameState, ctx: SimCtx, targetId: string, verb: string, mult?: number) =>
  applyAction(s, 'p1', { type: 'interact', targetId, verb, ...(mult !== undefined ? { args: { mult } } : {}) }, ctx);

describe('仕込むときに量を選べる', () => {
  it('豚を煮込む量を2倍にすると、豚肉8本・醤油を使い、少し長くかかって8本のブロックとタレができる', () => {
    const { s, ctx } = newGame(61);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'pork_block' && l.itemId !== 'pork_raw');
    addLot(s, 'pork_raw', 10, 300);
    addLot(s, 'soy', 5000, 1);
    const pot = eqByType(s, 'braise_pot');
    standAt(s, 'p1', pot.id);
    const v = listVerbs(s, 'p1', pot.id).find((x) => x.verb === 'prep:braise_pork');
    expect(v?.label).toContain('豚');
    expect(act(s, ctx, pot.id, 'prep:braise_pork', 2).ok).toBe(true);
    run(s, ctx, 2);
    expect(stockOf(s, 'pork_raw')).toBe(2);
    expect(pot.process?.mult).toBe(2);
    expect(pot.process?.duration).toBeCloseTo(PREP_RECIPES.braise_pork!.time * 1.5, 5);
    run(s, ctx, PREP_RECIPES.braise_pork!.time * 1.5 + 2);
    expect(stockOf(s, 'pork_block')).toBe(8);
  });

  it('レシピにない量は1倍。材料が足りない量は選べない', () => {
    const { s, ctx } = newGame(62);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'pork_raw');
    addLot(s, 'pork_raw', 5, 300);
    const pot = eqByType(s, 'braise_pot');
    standAt(s, 'p1', pot.id);
    expect(act(s, ctx, pot.id, 'prep:braise_pork', 2).ok).toBe(false);
    expect(act(s, ctx, pot.id, 'prep:braise_pork', 7).ok).toBe(true);
    run(s, ctx, 2);
    expect(stockOf(s, 'pork_raw')).toBe(1);
  });

  it('豚を切る量を3本にすると、3本のブロックから54枚', () => {
    const { s, ctx } = newGame(63);
    s.inventory = s.inventory.filter((l) => l.itemId !== 'pork_block' && l.itemId !== 'buta');
    addLot(s, 'pork_block', 3, 800);
    const prep = eqByType(s, 'prep_table');
    standAt(s, 'p1', prep.id);
    expect(act(s, ctx, prep.id, 'prep:slice_pork', 3).ok).toBe(true);
    run(s, ctx, PREP_RECIPES.slice_pork!.time * 3 * 3);
    expect(stockOf(s, 'pork_block')).toBe(0);
    expect(stockOf(s, 'buta')).toBe(54);
  });
});

describe('開店前の仕込みの計画', () => {
  it('仕込みの時間に計画を決めると、店員がその量まで仕込み、進み具合が見える。開店後は計画を使わない', () => {
    const { s, ctx } = newGame(64);
    const e = addBot(s, 'server', 0.8);
    e.priorities = { prep: 1, prepUrgent: 1 };
    s.inventory = s.inventory.filter((l) => l.itemId !== 'garlic');
    addLot(s, 'garlic', 50, 1);
    addLot(s, 'garlic_raw', 4000, 1);
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: { garlic: 1500 } }, ctx).ok).toBe(true);
    const target = restockTarget(s, PREP_RECIPES.chop_garlic!);
    expect(target).toBeGreaterThanOrEqual(1500);
    expect(prepPlanProgress(s)[0]).toMatchObject({ itemId: 'garlic', plan: 1500 });
    run(s, ctx, 120);
    expect(stockOf(s, 'garlic')).toBeGreaterThanOrEqual(1500);
    expect(prepPlanProgress(s)[0]!.ratio).toBe(1);
    // 開店すると計画は使わない（自動の目安に戻る）
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    expect(restockTarget(s, PREP_RECIPES.chop_garlic!)).toBeLessThan(1500);
  });

  it('計画は仕込みの時間だけ決められ、範囲を外れた量・仕込まない品は断る。案は予想から作る', () => {
    const { s, ctx } = newGame(65);
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: { garlic: 999_999 } }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: { noodle: 100 } }, ctx).ok).toBe(false);
    const plan = suggestPrepPlan(s);
    expect(Object.keys(plan)).toContain('buta');
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: plan }, ctx).ok).toBe(true);
    expect(s.prepPlan?.day).toBe(s.day);
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: Object.fromEntries(Object.keys(plan).map((k) => [k, null])) }, ctx).ok).toBe(true);
    expect(s.prepPlan).toBeUndefined();
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'setPrepPlan', items: { garlic: 500 } }, ctx).ok).toBe(false);
    // 店ごとに持つ（支店へ移ってもその店の計画）
    expect(STORE_KEYS).toContain('prepPlan');
    expect(STORE_KEYS).toContain('prepSchedule');
  });
});

describe('時間帯・曜日で仕込みの量を変える', () => {
  it('今日の曜日の倍率が仕込みの目安に掛かる。全部1に戻すと設定は消える。決まった値以外は断る', () => {
    const { s, ctx } = newGame(66);
    s.prepTargets = { garlic: 400 };
    const wd = weekdayOf(s.day);
    const weekday = [1, 1, 1, 1, 1, 1, 1];
    weekday[wd] = 1.5;
    expect(applyAction(s, 'p1', { type: 'setPrepSchedule', weekday }, ctx).ok).toBe(true);
    expect(prepScheduleMult(s)).toBe(1.5);
    expect(restockTarget(s, PREP_RECIPES.chop_garlic!)).toBe(600);
    // 時間帯: 開店から1時間目を少なめ
    expect(applyAction(s, 'p1', { type: 'setPrepSchedule', hours: [0.5, 1, 1, 1] }, ctx).ok).toBe(true);
    expect(prepScheduleMult(s)).toBe(0.75);
    expect(applyAction(s, 'p1', { type: 'setPrepSchedule', weekday: [1, 1, 1, 1, 1, 1, 1], hours: [1] }, ctx).ok).toBe(true);
    expect(s.prepSchedule).toBeUndefined();
    expect(applyAction(s, 'p1', { type: 'setPrepSchedule', weekday: [1, 1, 1, 1, 1, 1, 3] }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setPrepSchedule', hours: [0.6] }, ctx).ok).toBe(false);
  });
});
