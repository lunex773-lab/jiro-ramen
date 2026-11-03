// 第2版 6-2: 食事の動きと丼の中身（18-3「通常客の食事動作が正常に動く」）
import { describe, expect, it } from 'vitest';
import type { BowlContents } from '@jiro/core';
import { EAT_DONE_AT, eatenContents, eatenStep, eatMotion, eatProgress } from '../src/render/eat-motion';

const bowl = (): BowlContents => ({
  tare: 1,
  tareQuality: 1,
  soupL: 0.35,
  soupQuality: 1,
  soupTemp: 90,
  noodleG: 300,
  noodleQuality: 1,
  noodleBoilDelta: 0,
  toppings: { yasai: 2, ninniku: 1, abura: 1, ichimi: 0 } as BowlContents['toppings'],
  buta: 2,
  butaQuality: 1,
  freshness: 1,
  steps: [],
  startedAt: 0,
  heat: 90,
  cost: 300,
});

describe('食事の動き', () => {
  it('食事の間に、顔を近づける・麺を持ち上げる・すする・具を食べる・スープを飲む をすべて行う', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 60; t += 0.05) seen.add(eatMotion(0.4, t, 0.3).phase);
    for (const p of ['lean', 'lift', 'slurp', 'topping', 'soup']) expect(seen.has(p)).toBe(true);
    expect(seen.has('done')).toBe(false);
  });

  it('麺を持ち上げると箸が高く上がり、スープのときは丼を持ち上げる', () => {
    let maxLift = 0;
    let maxBowl = 0;
    for (let t = 0; t < 30; t += 0.05) {
      const m = eatMotion(0.5, t, 0.1);
      if (m.phase === 'lift') maxLift = Math.max(maxLift, m.handR);
      if (m.phase === 'soup') maxBowl = Math.max(maxBowl, m.bowlLift);
      if (m.phase !== 'soup') expect(m.bowlLift).toBe(0);
    }
    expect(maxLift).toBeGreaterThan(0.9);
    expect(maxBowl).toBeGreaterThan(0.9);
  });

  it('食べ終わると箸を置いて背を起こす', () => {
    const m = eatMotion(EAT_DONE_AT + 0.01, 3, 0.2);
    expect(m.phase).toBe('done');
    expect(m.chopsticks).toBe(false);
    expect(m.lean).toBeLessThan(eatMotion(0.3, 3, 0.2).lean);
  });

  it('人ごとに動きがずれる（全員が同じ動きにならない）', () => {
    const a = eatMotion(0.4, 10, 0.1).phase + eatMotion(0.4, 11, 0.1).phase;
    const b = eatMotion(0.4, 10, 0.77).phase + eatMotion(0.4, 11, 0.77).phase;
    const c = eatMotion(0.4, 10, 0.45).phase + eatMotion(0.4, 11, 0.45).phase;
    expect(new Set([a, b, c]).size).toBeGreaterThan(1);
  });

  it('食べ方の汚い客は前のめりで速く食べる', () => {
    expect(eatMotion(0.4, 1, 0.1, true).lean).toBeGreaterThan(eatMotion(0.4, 1, 0.1, false).lean);
  });
});

describe('丼の中身', () => {
  it('食事の進み具合で中身が減り、食べ終わりには麺と具がなくなる（スープは少し残る）', () => {
    const c = bowl();
    expect(eatProgress(30, 60)).toBeCloseTo(0.5);
    expect(eatProgress(0, undefined)).toBe(0);
    expect(eatenStep(0)).toBe(0);
    expect(eatenStep(0.5)).toBe(2);
    expect(eatenStep(1)).toBe(5);
    const half = eatenContents(c, 2);
    expect(half.noodleG).toBeLessThan(c.noodleG);
    expect(half.noodleG).toBeGreaterThan(0);
    expect(half.toppings.yasai).toBeLessThan(c.toppings.yasai);
    const done = eatenContents(c, 5);
    expect(done.noodleG).toBe(0);
    expect(done.buta).toBe(0);
    expect(done.toppings.yasai).toBe(0);
    expect(done.soupL).toBeGreaterThan(0);
    expect(done.soupL).toBeLessThan(c.soupL);
    // 元の中身は変えない（表示用の写し）
    expect(c.noodleG).toBe(300);
    // 段階が進むほど少なくなる
    for (let i = 1; i <= 5; i++) expect(eatenContents(c, i).noodleG).toBeLessThanOrEqual(eatenContents(c, i - 1).noodleG);
  });
});
