// 芸能人のサインを飾る壁の場所（第2版 12-5）。描画に依存しない純粋な計算（単体テストできる）。
// 設備ではなく壁の決まった場所に飾るので、レイアウトを変えてもずれない。店の段階（広さ）ごとに場所が決まり、拡張すると増える。
// 1. 正面の壁の内側、ガラスの上（厨房から見える）
// 2. 右の壁の客席側（2段）

import { CELL, type StageDef } from '@jiro/core';

export interface SignSlot {
  x: number;
  y: number;
  z: number;
  /** 向き（y 軸の回転）。0 = 店の中（+z）を向く */
  ry: number;
}

/** サインの大きさ（色紙。m） */
export const SIGN_W = 0.24;
export const SIGN_H = 0.27;
const STEP = 0.42;

export function signSlots(stage: StageDef): SignSlot[] {
  const W = stage.w * CELL;
  const out: SignSlot[] = [];
  // shop.ts の店先のガラスと同じ範囲
  const glassX0 = stage.door.x1 + 0.25;
  const glassX1 = W - 0.25;
  for (let x = glassX0 + 0.3; x <= glassX1 - 0.3 + 1e-9; x += STEP) out.push({ x, y: 2.38, z: 0.012, ry: 0 });
  const D = stage.dining.z1 * CELL;
  for (const y of [1.95, 1.55]) {
    for (let z = 0.4; z <= D - 0.3 + 1e-9; z += STEP) out.push({ x: W - 0.012, y, z, ry: -Math.PI / 2 });
  }
  return out;
}
