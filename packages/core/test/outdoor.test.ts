// 店の外（オーナーの指示 2026-11-12）: 店のある区画を、裏通りも含めて1周歩ける。建物の中・車道には入れない。歩道の物にはぶつかる
import { describe, expect, it } from 'vitest';
import { blockRect, BLOCK_WALK, isWalkable, moveWithCollision, outdoorBays, stageOf, type GameState, type Vec2 } from '../src';
import { newGame } from './helpers';

const R = 0.25;

/** 目的地へ少しずつ歩く（壁沿いに滑る）。着いたら true */
function walkTo(s: GameState, from: Vec2, to: Vec2): { at: Vec2; ok: boolean } {
  let p = { ...from };
  for (let i = 0; i < 4000; i++) {
    const dx = to.x - p.x;
    const dz = to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.1) return { at: p, ok: true };
    const k = Math.min(0.08, d) / d;
    p = moveWithCollision(s, p, dx * k, dz * k, R);
  }
  return { at: p, ok: false };
}

describe('区画を1周歩ける', () => {
  it('店の前 → 左の通り → 裏通り → 右の通り → 店の前と、区画のまわりを1周できる', () => {
    const { s } = newGame(71);
    const st = stageOf(s);
    const b = blockRect(st);
    const m = BLOCK_WALK / 2;
    const route: Vec2[] = [
      { x: b.x0 - m, z: -2 },
      { x: b.x0 - m, z: b.z1 + m },
      { x: b.x1 + m, z: b.z1 + m },
      { x: b.x1 + m, z: -2 },
      { x: 3, z: -2 },
    ];
    let p: Vec2 = { x: 3, z: -2 };
    for (const w of route) {
      const r = walkTo(s, p, w);
      expect(r.ok, `(${w.x.toFixed(1)}, ${w.z.toFixed(1)}) まで歩けない（${r.at.x.toFixed(2)}, ${r.at.z.toFixed(2)} で止まった）`).toBe(true);
      p = r.at;
    }
  });

  it('区画の建物の中・車道・歩道の外には入れない。歩道の物（自販機など）にはぶつかる', () => {
    const { s } = newGame(72);
    const st = stageOf(s);
    const b = blockRect(st);
    expect(isWalkable(s, { x: -3, z: 3 }, R)).toBe(false); // 左の隣の建物の中
    expect(isWalkable(s, { x: 3, z: b.z1 - 1 }, R)).toBe(false); // 店の裏の建物の中
    expect(isWalkable(s, { x: 3, z: -6 }, R)).toBe(false); // 車道
    expect(isWalkable(s, { x: b.x0 - BLOCK_WALK - 1, z: 3 }, R)).toBe(false); // 左の通りの車道
    expect(isWalkable(s, { x: 3, z: b.z1 + BLOCK_WALK + 1 }, R)).toBe(false); // 裏通りの向こう
    for (const bay of outdoorBays(st)) expect(isWalkable(s, { x: (bay.x0 + bay.x1) / 2, z: (bay.z0 + bay.z1) / 2 }, R)).toBe(false);
    // 店の中と入口・路地は今までどおり
    expect(isWalkable(s, { x: 2, z: 1 }, R)).toBe(true);
  });
});
