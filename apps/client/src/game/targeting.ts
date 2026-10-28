// 注視対象の判定。画面中央の視点カーソルからの視線と、操作できる対象の箱（AABB）の交差で決める。
// カーソルが重なっている物を必ず選ぶ（手が届かなくても選び、近づくよう案内する）。
// 何にも重なっていないときだけ、カーソルのすぐ近く（約4°以内）にある手の届く物を選ぶ（スマホで狙いやすくするため）。

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
  /** カーソルが重なっているか（false はカーソルのすぐ近くを補助で選んだ） */
  aimed: boolean;
  /** 手が届くか（届かなければ操作できないので「近づいてください」と出す） */
  reachable: boolean;
}

/** 視線で選べる距離（m）。壁越しの物を選ばないよう短めにする */
const AIM_RANGE = 3.2;
/** カーソルが外れていても選ぶ角度（約4°）の正接 */
const ASSIST = Math.tan((4 * Math.PI) / 180);

/**
 * 注視対象を求める。
 * @param eye 目の位置, dir 視線方向（正規化済み）
 */
export function findFocus(s: GameState, actor: Actor, eye: [number, number, number], dir: [number, number, number]): FocusResult | null {
  const boxes = interactableBoxes(s);
  // 1. カーソルが重なっている物（一番手前）
  let best: { id: string; t: number } | null = null;
  for (const b of boxes) {
    const t = rayBox(eye, dir, b);
    if (t < AIM_RANGE && (!best || t < best.t)) best = { id: b.id, t };
  }
  if (best) {
    const tgt = resolveTarget(s, best.id);
    if (tgt) return { target: tgt, aimed: true, reachable: inReach(s, actor, tgt) };
  }
  // 2. 何にも重なっていなければ、カーソルのすぐ近く（外れている角度が約4°以内）で手の届く物のうち、
  //    一番カーソルに近い（外れている角度が小さい）物
  let alt: { id: string; miss: number } | null = null;
  for (const b of boxes) {
    const d = Math.max(0.3, distToBox(eye, b));
    const m = missMargin(eye, dir, b, d * ASSIST);
    if (m === Infinity) continue;
    const miss = m / d;
    if (alt && miss >= alt.miss) continue;
    const tgt = resolveTarget(s, b.id);
    if (!tgt || !inReach(s, actor, tgt)) continue;
    alt = { id: b.id, miss };
  }
  if (alt) {
    const tgt = resolveTarget(s, alt.id);
    if (tgt) return { target: tgt, aimed: false, reachable: true };
  }
  return null;
}

function inflate(b: Box, m: number): Box {
  return { id: b.id, min: [b.min[0] - m, b.min[1] - m, b.min[2] - m], max: [b.max[0] + m, b.max[1] + m, b.max[2] + m] };
}

/** 視線を箱に当てるのに必要な、箱のふくらみ（m）。max まで広げても当たらなければ Infinity */
function missMargin(eye: [number, number, number], dir: [number, number, number], b: Box, max: number): number {
  if (rayBox(eye, dir, inflate(b, max)) >= AIM_RANGE) return Infinity;
  let lo = 0;
  let hi = max;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (rayBox(eye, dir, inflate(b, mid)) < AIM_RANGE) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** 点から箱までの距離 */
function distToBox(p: [number, number, number], b: Box): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i]!;
    const c = Math.max(b.min[i]!, Math.min(b.max[i]!, v));
    d2 += (v - c) ** 2;
  }
  return Math.sqrt(d2);
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
