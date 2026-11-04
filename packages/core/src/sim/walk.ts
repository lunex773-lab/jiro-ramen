// 従業員の歩き方（経路・速さ・移動）。仕事（employees.ts）と出退勤（commute.ts）で使う。

import { BALANCE } from '../data/balance';
import { stageOf } from '../geometry';
import { findPath, isNarrowAt } from '../nav';
import type { Employee, GameState, Vec2 } from '../types';
import { dist } from '../util';

/** 店の中と外（入口を通る）をまたぐ経路 */
export function staffRoute(s: GameState, from: Vec2, to: Vec2): { points: Vec2[]; cost: number } | null {
  const st = stageOf(s);
  const doorX = (st.door.x0 + st.door.x1) / 2;
  const inner = { x: doorX, z: 0.35 };
  const outer = { x: doorX, z: -0.5 };
  if (from.z >= 0 && to.z >= 0) return findPath(s, from, to, 'staff');
  if (from.z >= 0 && to.z < 0) {
    const r = findPath(s, from, inner, 'staff');
    if (!r) return null;
    return { points: [...r.points, outer, to], cost: r.cost + dist(inner, outer) + dist(outer, to) };
  }
  if (from.z < 0 && to.z < 0) return { points: [to], cost: dist(from, to) };
  const r = findPath(s, inner, to, 'staff');
  if (!r) return null;
  return { points: [outer, inner, ...r.points], cost: dist(from, outer) + dist(outer, inner) + r.cost };
}

export function walkSpeed(s: GameState, e: Employee): number {
  let v = BALANCE.staff.baseWalkSpeed * (0.7 + 0.6 * e.profile.skills.movement);
  if (isNarrowAt(s, e.pos)) v *= 0.75;
  if (s.dirt.some((d) => d.kind === 'spill' && dist(d.pos, e.pos) < 0.6)) v *= 0.6;
  return v;
}

export function moveAlong(e: Employee, dt: number, speed: number): boolean {
  let left = speed * dt;
  while (left > 0 && e.ai.path.length > 0) {
    const tgt = e.ai.path[0]!;
    const d = dist(e.pos, tgt);
    if (d > 1e-6) e.yaw = Math.atan2(tgt.x - e.pos.x, tgt.z - e.pos.z);
    if (d <= left) {
      e.pos = { x: tgt.x, z: tgt.z };
      e.ai.path.shift();
      left -= d;
    } else {
      e.pos = { x: e.pos.x + ((tgt.x - e.pos.x) / d) * left, z: e.pos.z + ((tgt.z - e.pos.z) / d) * left };
      left = 0;
    }
  }
  return e.ai.path.length === 0;
}
