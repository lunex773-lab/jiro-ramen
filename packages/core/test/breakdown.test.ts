import { describe, expect, it } from 'vitest';
import { BALANCE, useEquipment } from '../src';
import { newGame } from './helpers';

// オーナーの指示 2026-11-13「設備の故障が90%でも起こる」→ 状態70%以上なら故障しない
describe('設備の故障', () => {
  it('状態が70%以上の設備は、何度使っても故障しない', () => {
    const { s, ctx } = newGame(11);
    const boiler = s.equipment.find((e) => e.type === 'noodle_boiler')!;
    for (let i = 0; i < 5000; i++) {
      boiler.condition = 90;
      useEquipment(s, ctx, boiler);
      expect(boiler.status).not.toBe('broken');
    }
    for (let i = 0; i < 5000; i++) {
      boiler.condition = BALANCE.equipment.safeCondition;
      boiler.status = 'normal';
      useEquipment(s, ctx, boiler);
    }
    expect(boiler.status).not.toBe('broken');
  });

  it('70%を下回ると、下がるほど故障しやすい', () => {
    const { s, ctx } = newGame(12);
    const boiler = s.equipment.find((e) => e.type === 'noodle_boiler')!;
    const count = (cond: number) => {
      let n = 0;
      for (let i = 0; i < 20000; i++) {
        boiler.condition = cond;
        boiler.status = 'normal';
        useEquipment(s, ctx, boiler);
        if ((boiler.status as string) === 'broken') n++;
      }
      return n;
    };
    const at60 = count(60);
    const at20 = count(20);
    expect(at20).toBeGreaterThan(at60);
    expect(at20).toBeGreaterThan(0);
  });
});
