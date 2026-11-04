import { describe, expect, it } from 'vitest';
import { DEBRIS_COUNT, equipmentWreck, lingeringFires, wreckLayout } from '../src/render/wreck';

const opts = { w: 8, d: 6.5, blast: { x: 5, z: 4.5 }, ceiling: 2.6, seed: 'ev12' };

describe('爆発のあとの散らかり方', () => {
  it('同じ事故なら同じ散らかり方、違う事故なら違う', () => {
    expect(wreckLayout(opts)).toEqual(wreckLayout(opts));
    expect(wreckLayout({ ...opts, seed: 'ev13' })).not.toEqual(wreckLayout(opts));
  });

  it('たくさんの物が散らばり、すべて店の内側（床から天井まで）に収まる', () => {
    const list = wreckLayout(opts);
    const total = Object.values(DEBRIS_COUNT).reduce((a, b) => a + b, 0);
    expect(list.length).toBeGreaterThan(total * 0.8);
    for (const d of list) {
      expect(d.x).toBeGreaterThanOrEqual(0);
      expect(d.x).toBeLessThanOrEqual(opts.w);
      expect(d.z).toBeGreaterThanOrEqual(0);
      expect(d.z).toBeLessThanOrEqual(opts.d);
      expect(d.y).toBeGreaterThanOrEqual(0);
      expect(d.y).toBeLessThanOrEqual(opts.ceiling);
    }
    // 種類がそろっている（落ちた天井・板・かけら・ガラス・焦げ跡・スープ・麺・電線・紙）
    expect(new Set(list.map((d) => d.kind)).size).toBe(Object.keys(DEBRIS_COUNT).length);
  });

  it('爆心の近くほど多く散らばる', () => {
    const list = wreckLayout(opts).filter((d) => d.kind === 'chunk' || d.kind === 'plank');
    const near = list.filter((d) => Math.hypot(d.x - opts.blast.x, d.z - opts.blast.z) < 2).length;
    const far = list.filter((d) => Math.hypot(d.x - 1, d.z - 1) < 2).length;
    expect(near).toBeGreaterThan(far);
  });

  it('広い店ほど散らばる物が多い', () => {
    expect(wreckLayout({ ...opts, w: 18, d: 9 }).length).toBeGreaterThan(wreckLayout(opts).length);
  });

  it('設備は爆心から離れる向きに押され、近いほど遠くへ。いくつかは横倒し', () => {
    const near = equipmentWreck('eq1', { x: 5.5, z: 4.5 }, opts.blast, 'ev12');
    expect(near.dx).toBeGreaterThan(0);
    expect(equipmentWreck('eq1', { x: 5.5, z: 4.5 }, opts.blast, 'ev12')).toEqual(near);
    const ids = Array.from({ length: 80 }, (_, i) => `eq${i}`);
    const nearPush = ids.map((id) => Math.hypot(equipmentWreck(id, { x: 5.6, z: 4.5 }, opts.blast, 's').dx, equipmentWreck(id, { x: 5.6, z: 4.5 }, opts.blast, 's').dz));
    const farPush = ids.map((id) => Math.hypot(equipmentWreck(id, { x: 0.5, z: 0.5 }, opts.blast, 's').dx, equipmentWreck(id, { x: 0.5, z: 0.5 }, opts.blast, 's').dz));
    const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(avg(nearPush)).toBeGreaterThan(avg(farPush));
    const toppledNear = ids.filter((id) => equipmentWreck(id, { x: 5.6, z: 4.5 }, opts.blast, 's').toppled).length;
    expect(toppledNear).toBeGreaterThan(10);
    expect(toppledNear).toBeLessThan(80);
  });

  it('爆発のあとも燃え残る設備は、先に燃えたものから数台', () => {
    expect(lingeringFires(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(lingeringFires(['a'])).toEqual(['a']);
  });
});
