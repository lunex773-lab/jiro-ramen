// 第2版 12-5・18-4: サインは壁の決まった場所に飾る（レイアウトに関係なく、拡張しても場所がある）
import { describe, expect, it } from 'vitest';
import { CELL, STAGES } from '@jiro/core';
import { SIGN_H, SIGN_W, signSlots } from '../src/render/sign-slots';

describe('サインを飾る場所', () => {
  it('どの店の段階でも、壁の中に重ならずに十分な数の場所がある。拡張すると増え、前の段階の場所は同じ並び', () => {
    let prev = 0;
    for (const st of STAGES) {
      const slots = signSlots(st);
      expect(slots.length).toBeGreaterThanOrEqual(8);
      expect(slots.length).toBeGreaterThanOrEqual(prev);
      prev = slots.length;
      const W = st.w * CELL;
      for (const p of slots) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(W);
        expect(p.y + SIGN_H / 2).toBeLessThan(2.6);
        expect(p.z).toBeGreaterThanOrEqual(0);
        expect(p.z).toBeLessThanOrEqual(st.dining.z1 * CELL);
      }
      for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
          const a = slots[i]!;
          const b = slots[j]!;
          if (a.ry !== b.ry) continue;
          const d = a.ry === 0 ? Math.abs(a.x - b.x) : Math.abs(a.z - b.z);
          expect(d > SIGN_W || Math.abs(a.y - b.y) > SIGN_H).toBe(true);
        }
      }
    }
  });
});
