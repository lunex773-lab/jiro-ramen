// 経路探索（設計書 3 Navigation, 11.5 動線）。
// 店内を CELL 単位のグリッドにし、A* で経路を求める。通路幅1セル（0.5m）の箇所は移動コストを上げる。

import { EQUIPMENT } from './data/equipment';
import { CELL } from './data/stages';
import { equipmentRect, stageOf } from './geometry';
import type { GameState, Vec2 } from './types';

export type AgentKind = 'staff' | 'customer';

export interface NavGrid {
  w: number;
  d: number;
  /** 0=通行可, 1=障害物 */
  blocked: Uint8Array;
  /** 客が入れないセル（厨房） */
  staffOnly: Uint8Array;
  /** 幅1セルの狭い通路 */
  narrow: Uint8Array;
}

const cache = new Map<string, NavGrid>();

function signature(s: GameState): string {
  const parts: string[] = [String(s.career.stage)];
  for (const e of s.equipment) {
    if (!e.placed) continue;
    parts.push(`${e.type}@${e.gx},${e.gz},${e.rot},${e.offset.x.toFixed(2)},${e.offset.z.toFixed(2)}`);
  }
  return parts.join('|');
}

export function buildNavGrid(s: GameState): NavGrid {
  const key = signature(s);
  const hit = cache.get(key);
  if (hit) return hit;
  const st = stageOf(s);
  const w = st.w;
  const d = st.d;
  const blocked = new Uint8Array(w * d);
  const staffOnly = new Uint8Array(w * d);
  const narrow = new Uint8Array(w * d);
  const rects = [
    { x0: st.counter.x0 * CELL, z0: st.counter.z0 * CELL, x1: st.counter.x1 * CELL, z1: st.counter.z1 * CELL },
  ];
  for (const e of s.equipment) {
    if (!e.placed) continue;
    const def = EQUIPMENT[e.type];
    if (!def || def.w === 0) continue;
    rects.push(equipmentRect(e));
  }
  for (let gz = 0; gz < d; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const cx = (gx + 0.5) * CELL;
      const cz = (gz + 0.5) * CELL;
      const i = gz * w + gx;
      for (const r of rects) {
        if (cx > r.x0 && cx < r.x1 && cz > r.z0 && cz < r.z1) {
          blocked[i] = 1;
          break;
        }
      }
      if (gz >= st.counter.z0) staffOnly[i] = 1;
    }
  }
  const free = (x: number, z: number) => x >= 0 && z >= 0 && x < w && z < d && blocked[z * w + x] === 0;
  for (let gz = 0; gz < d; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (!free(gx, gz)) continue;
      const horizontalPinch = !free(gx - 1, gz) && !free(gx + 1, gz);
      const verticalPinch = !free(gx, gz - 1) && !free(gx, gz + 1);
      // 壁際（グリッド端）は壁を障害物とみなす
      if (horizontalPinch || verticalPinch) narrow[gz * w + gx] = 1;
    }
  }
  const grid: NavGrid = { w, d, blocked, staffOnly, narrow };
  if (cache.size > 16) cache.clear();
  cache.set(key, grid);
  return grid;
}

export function cellOf(p: Vec2): { gx: number; gz: number } {
  return { gx: Math.floor(p.x / CELL), gz: Math.floor(p.z / CELL) };
}

function passable(g: NavGrid, gx: number, gz: number, agent: AgentKind): boolean {
  if (gx < 0 || gz < 0 || gx >= g.w || gz >= g.d) return false;
  const i = gz * g.w + gx;
  if (g.blocked[i]) return false;
  if (agent === 'customer' && g.staffOnly[i]) return false;
  return true;
}

/** 位置から最も近い通行可能セルを探す */
export function nearestPassable(g: NavGrid, p: Vec2, agent: AgentKind, maxR = 6): { gx: number; gz: number } | null {
  const c = cellOf(p);
  if (passable(g, c.gx, c.gz, agent)) return c;
  let best: { gx: number; gz: number } | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= maxR; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const gx = c.gx + dx;
        const gz = c.gz + dz;
        if (!passable(g, gx, gz, agent)) continue;
        const cx = (gx + 0.5) * CELL;
        const cz = (gz + 0.5) * CELL;
        const dd = (cx - p.x) ** 2 + (cz - p.z) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = { gx, gz };
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** 2セル間の直線が通行可能か（経路の平滑化用） */
function lineOfSight(g: NavGrid, a: Vec2, b: Vec2, agent: AgentKind): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(len / (CELL * 0.25)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    // 体の幅を考慮して左右も確認
    for (const [ox, oz] of [[0, 0], [0.18, 0], [-0.18, 0], [0, 0.18], [0, -0.18]] as const) {
      const c = cellOf({ x: x + ox, z: z + oz });
      if (!passable(g, c.gx, c.gz, agent)) return false;
    }
  }
  return true;
}

export interface PathResult {
  points: Vec2[];
  /** 移動距離（狭い通路の補正込みのコスト） */
  cost: number;
  narrowCells: number;
}

/** A* 経路探索。到達できなければ null */
export function findPath(s: GameState, from: Vec2, to: Vec2, agent: AgentKind): PathResult | null {
  const g = buildNavGrid(s);
  const start = nearestPassable(g, from, agent);
  const goal = nearestPassable(g, to, agent);
  if (!start || !goal) return null;
  const W = g.w;
  const N = g.w * g.d;
  const gScore = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const si = start.gz * W + start.gx;
  const gi = goal.gz * W + goal.gx;
  gScore[si] = 0;
  // 単純な二分ヒープ
  const heap: { i: number; f: number }[] = [{ i: si, f: 0 }];
  const push = (n: { i: number; f: number }) => {
    heap.push(n);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p]!.f <= heap[k]!.f) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]!.f < heap[m]!.f) m = l;
        if (r < heap.length && heap[r]!.f < heap[m]!.f) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  const h = (i: number) => {
    const x = i % W;
    const z = (i / W) | 0;
    const dx = Math.abs(x - goal.gx);
    const dz = Math.abs(z - goal.gz);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };
  const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ] as const;
  let found = false;
  while (heap.length > 0) {
    const { i } = pop();
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === gi) {
      found = true;
      break;
    }
    const x = i % W;
    const z = (i / W) | 0;
    for (const [dx, dz, c] of dirs) {
      const nx = x + dx;
      const nz = z + dz;
      if (!passable(g, nx, nz, agent)) continue;
      if (dx !== 0 && dz !== 0 && (!passable(g, x + dx, z, agent) || !passable(g, x, z + dz, agent))) continue;
      const ni = nz * W + nx;
      if (closed[ni]) continue;
      const cost = c * (g.narrow[ni] ? 1.35 : 1);
      const ng = gScore[i]! + cost;
      if (ng < gScore[ni]!) {
        gScore[ni] = ng;
        came[ni] = i;
        push({ i: ni, f: ng + h(ni) });
      }
    }
  }
  if (!found) return null;
  const cells: number[] = [];
  let cur = gi;
  while (cur !== -1) {
    cells.push(cur);
    if (cur === si) break;
    cur = came[cur]!;
  }
  cells.reverse();
  let narrowCells = 0;
  const raw: Vec2[] = cells.map((i) => {
    if (g.narrow[i]) narrowCells++;
    return { x: ((i % W) + 0.5) * CELL, z: (((i / W) | 0) + 0.5) * CELL };
  });
  // 最後は正確な目的地に置き換える（障害物内なら最寄りセル中心のまま）
  const goalCell = cellOf(to);
  if (goalCell.gx === goal.gx && goalCell.gz === goal.gz) raw[raw.length - 1] = { x: to.x, z: to.z };
  // 平滑化
  const pts: Vec2[] = [];
  let anchor: Vec2 = from;
  let k = 0;
  while (k < raw.length) {
    let far = k;
    for (let j = raw.length - 1; j > k; j--) {
      if (lineOfSight(g, anchor, raw[j]!, agent)) {
        far = j;
        break;
      }
    }
    const p = raw[far]!;
    pts.push(p);
    anchor = p;
    k = far + 1;
  }
  return { points: pts, cost: gScore[gi]! * CELL, narrowCells };
}

/** 経路が存在するか（レイアウト検証用） */
export function reachable(s: GameState, from: Vec2, to: Vec2, agent: AgentKind): boolean {
  return findPath(s, from, to, agent) !== null;
}

/** そのセルが狭い通路か */
export function isNarrowAt(s: GameState, p: Vec2): boolean {
  const g = buildNavGrid(s);
  const c = cellOf(p);
  if (c.gx < 0 || c.gz < 0 || c.gx >= g.w || c.gz >= g.d) return false;
  return g.narrow[c.gz * g.w + c.gx] === 1;
}

/** 到達可能なセルを塗りつぶす（レイアウト検証用） */
export function floodFill(s: GameState, from: Vec2, agent: AgentKind): { grid: NavGrid; visited: Uint8Array } {
  const g = buildNavGrid(s);
  const visited = new Uint8Array(g.w * g.d);
  const start = nearestPassable(g, from, agent, 2);
  if (!start) return { grid: g, visited };
  const stack = [start.gz * g.w + start.gx];
  visited[stack[0]!] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % g.w;
    const z = (i / g.w) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const nz = z + dz;
      if (!passable(g, nx, nz, agent)) continue;
      const ni = nz * g.w + nx;
      if (visited[ni]) continue;
      visited[ni] = 1;
      stack.push(ni);
    }
  }
  return { grid: g, visited };
}

export function cellVisited(f: { grid: NavGrid; visited: Uint8Array }, p: Vec2): boolean {
  const c = cellOf(p);
  if (c.gx < 0 || c.gz < 0 || c.gx >= f.grid.w || c.gz >= f.grid.d) return false;
  return f.visited[c.gz * f.grid.w + c.gx] === 1;
}

export function cellBlocked(g: NavGrid, p: Vec2): boolean {
  const c = cellOf(p);
  if (c.gx < 0 || c.gz < 0 || c.gx >= g.w || c.gz >= g.d) return true;
  return g.blocked[c.gz * g.w + c.gx] === 1;
}
