// 注視対象の判定。画面中央からの視線と、操作できる対象の箱（AABB）の交差で決める。
// 視線が何にも当たらないときは、手が届く範囲で正面に近い対象を選ぶ（スマホで狙いやすくするため）。

import {
  CELL,
  EQUIPMENT,
  equipmentRect,
  inReach,
  stageOf,
  seatPos,
  type Actor,
  type GameState,
  type Target,
  resolveTarget,
} from '@jiro/core';

export interface Box {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
}

export function interactableBoxes(s: GameState): Box[] {
  const out: Box[] = [];
  const st = stageOf(s);
  for (const e of s.equipment) {
    if (!e.placed) continue;
    const def = EQUIPMENT[e.type];
    if (!def || def.w === 0) continue;
    const r = equipmentRect(e);
    out.push({ id: e.id, min: [r.x0, 0, r.z0], max: [r.x1, Math.max(0.6, def.h), r.z1] });
  }
  const cz0 = st.counter.z0 * CELL;
  const cz1 = st.counter.z1 * CELL;
  for (const seat of s.seats) {
    if (!seat.installed || seat.index >= st.seats.length) continue;
    const sp = st.seats[seat.index]!;
    // カウンターの天板（その席の幅）
    out.push({ id: seat.id, min: [sp.x - 0.38, 0.75, cz0 - 0.05], max: [sp.x + 0.38, 1.3, cz1 + 0.15] });
    // 椅子と客
    const p = seatPos(s, seat);
    out.push({ id: seat.id, min: [p.x - 0.28, 0, p.z - 0.3], max: [p.x + 0.28, 1.5, p.z + 0.25] });
  }
  for (const d of s.dirt) {
    out.push({ id: d.id, min: [d.pos.x - 0.4, 0, d.pos.z - 0.4], max: [d.pos.x + 0.4, 0.08, d.pos.z + 0.4] });
  }
  return out;
}

/** レイと箱の交差距離（当たらなければ Infinity） */
export function rayBox(o: [number, number, number], d: [number, number, number], b: Box): number {
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const oi = o[i]!;
    const di = d[i]!;
    const mn = b.min[i]!;
    const mx = b.max[i]!;
    if (Math.abs(di) < 1e-9) {
      if (oi < mn || oi > mx) return Infinity;
    } else {
      let t1 = (mn - oi) / di;
      let t2 = (mx - oi) / di;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return Infinity;
    }
  }
  return tmin;
}

export interface FocusResult {
  target: Target;
  /** 視線で直接狙っているか */
  aimed: boolean;
}

/**
 * 注視対象を求める。
 * @param eye 目の位置, dir 視線方向（正規化済み）
 */
export function findFocus(s: GameState, actor: Actor, eye: [number, number, number], dir: [number, number, number]): FocusResult | null {
  const boxes = interactableBoxes(s);
  let best: { id: string; t: number } | null = null;
  for (const b of boxes) {
    const t = rayBox(eye, dir, b);
    if (t < 3.2 && (!best || t < best.t)) best = { id: b.id, t };
  }
  if (best) {
    const tgt = resolveTarget(s, best.id);
    if (tgt && inReach(s, actor, tgt)) return { target: tgt, aimed: true };
  }
  // 正面に近く手の届くもの
  let alt: { id: string; score: number } | null = null;
  const fx = dir[0];
  const fz = dir[2];
  const fl = Math.hypot(fx, fz) || 1;
  for (const b of boxes) {
    const cx = (b.min[0] + b.max[0]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const dx = cx - actor.pos.x;
    const dz = cz - actor.pos.z;
    const dl = Math.hypot(dx, dz) || 1;
    const dot = (dx * fx + dz * fz) / (dl * fl);
    if (dot < 0.55) continue;
    const tgt = resolveTarget(s, b.id);
    if (!tgt || !inReach(s, actor, tgt)) continue;
    const score = dot * 2 - dl;
    if (!alt || score > alt.score) alt = { id: b.id, score };
  }
  if (alt) {
    const tgt = resolveTarget(s, alt.id);
    if (tgt) return { target: tgt, aimed: false };
  }
  return null;
}

export function targetName(s: GameState, t: Target): string {
  switch (t.kind) {
    case 'equipment':
      return EQUIPMENT[t.e.type]?.name ?? t.e.type;
    case 'seat': {
      const c = s.customers.find((x) => x.id === t.seat.customerId);
      return `${t.seat.index + 1}番席${c ? '（お客さん）' : ''}`;
    }
    case 'dirt':
      return t.dirt.kind === 'spill' ? 'こぼれたスープ' : '床の汚れ';
    case 'lost':
      return `忘れ物（${t.lost.kind}）`;
  }
}
