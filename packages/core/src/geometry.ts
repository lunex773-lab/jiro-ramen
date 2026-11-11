// 店舗のジオメトリ: 設備の占有範囲・操作位置・衝突判定。
// クライアントの描画・移動、サーバーの位置検証、従業員AIの経路探索で共通に使う。

import { EQUIPMENT } from './data/equipment';
import { CELL, STAGES, type StageDef } from './data/stages';
import type { Equipment, GameState, Rot, Seat, Vec2 } from './types';

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export function stageOf(s: GameState): StageDef {
  const st = STAGES[s.career.stage];
  if (!st) throw new Error(`unknown stage ${s.career.stage}`);
  return st;
}

export const FACING: Record<Rot, Vec2> = {
  0: { x: 0, z: -1 },
  1: { x: 1, z: 0 },
  2: { x: 0, z: 1 },
  3: { x: -1, z: 0 },
};

export function footprint(type: string, rot: Rot): { w: number; d: number } {
  const def = EQUIPMENT[type];
  if (!def) throw new Error(`unknown equipment ${type}`);
  return rot % 2 === 0 ? { w: def.w, d: def.d } : { w: def.d, d: def.w };
}

export function equipmentRect(e: Pick<Equipment, 'type' | 'gx' | 'gz' | 'rot' | 'offset'>): Rect {
  const fp = footprint(e.type, e.rot);
  const x0 = e.gx * CELL + e.offset.x;
  const z0 = e.gz * CELL + e.offset.z;
  return { x0, z0, x1: x0 + fp.w * CELL, z1: z0 + fp.d * CELL };
}

export function rectCenter(r: Rect): Vec2 {
  return { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 };
}

export function equipmentCenter(e: Pick<Equipment, 'type' | 'gx' | 'gz' | 'rot' | 'offset'>): Vec2 {
  return rectCenter(equipmentRect(e));
}

/** 設備を操作するときに立つ位置（正面の少し手前） */
export function accessPoint(e: Pick<Equipment, 'type' | 'gx' | 'gz' | 'rot' | 'offset'>): Vec2 {
  const r = equipmentRect(e);
  const c = rectCenter(r);
  const f = FACING[e.rot];
  const half = f.x !== 0 ? (r.x1 - r.x0) / 2 : (r.z1 - r.z0) / 2;
  return { x: c.x + f.x * (half + 0.35), z: c.z + f.z * (half + 0.35) };
}

export function seatPos(s: GameState, seat: Seat): Vec2 {
  const st = stageOf(s);
  const p = st.seats[seat.index];
  if (!p) return { x: 0, z: 0 };
  return { x: p.x + seat.offset.x, z: p.z + seat.offset.z };
}

/** カウンター越しに配膳・回収するときの厨房側の位置 */
export function seatKitchenPoint(s: GameState, seat: Seat): Vec2 {
  const st = stageOf(s);
  const p = st.seats[seat.index];
  if (!p) return { x: 0, z: 0 };
  return { x: p.x, z: st.counter.z1 * CELL + 0.35 };
}

/** カウンター上の丼の位置 */
export function seatCounterPoint(s: GameState, seat: Seat): Vec2 {
  const st = stageOf(s);
  const p = st.seats[seat.index];
  if (!p) return { x: 0, z: 0 };
  return { x: p.x, z: (st.counter.z0 + st.counter.z1) * 0.5 * CELL };
}

export function counterRect(st: StageDef): Rect {
  return {
    x0: st.counter.x0 * CELL,
    z0: st.counter.z0 * CELL,
    x1: st.counter.x1 * CELL,
    z1: st.counter.z1 * CELL,
  };
}

export function interiorRect(st: StageDef): Rect {
  return { x0: 0, z0: 0, x1: st.w * CELL, z1: st.d * CELL };
}

/** 歩道（店外）の範囲 */
export function streetRect(st: StageDef): Rect {
  return { x0: -3, z0: -4.5, x1: st.w * CELL + 6, z1: 0 };
}

/** 店の壁の厚み（client の描画と同じ） */
export const STORE_WALL_T = 0.12;
/**
 * 店の右の横の壁の外側の「ふかし壁」の厚み。横の壁ぜんぶを同じ見た目でこの厚みにして、その中に武器庫を隠す
 * （オーナーの指示: 武器庫をわかりにくく。前は物置だけが出っ張り、店の壁の厚みに入り込んで店の中から透けて見えた）
 */
export const ARMORY_DEPTH = 0.5;

/** 武器庫（店の右の横の壁の外のふかし壁の中の小さな物置。じろ1 5.12）の範囲 */
export function armoryRect(st: StageDef): Rect {
  const x0 = st.w * CELL + STORE_WALL_T;
  return { x0, z0: 0.6, x1: x0 + ARMORY_DEPTH, z1: 1.8 };
}

/** 隠し扉（ふかし壁の路地側の面の真ん中） */
export function armoryDoorPos(st: StageDef): Vec2 {
  return { x: armoryRect(st).x1, z: 1.2 };
}

/** 隠し扉の前の路地（歩道から店の右の横の壁沿いに入れる） */
export function alleyRect(st: StageDef): Rect {
  return { x0: armoryRect(st).x1, z0: -0.5, x1: st.w * CELL + 1.9, z1: 2.2 };
}

/** 衝突判定用の箱（壁・カウンター・設備） */
export function colliders(s: GameState): Rect[] {
  const st = stageOf(s);
  const out: Rect[] = [counterRect(st)];
  for (const e of s.equipment) {
    if (!e.placed) continue;
    const def = EQUIPMENT[e.type];
    if (!def || def.w === 0) continue;
    out.push(equipmentRect(e));
  }
  return out;
}

function inRect(p: Vec2, r: Rect, pad = 0): boolean {
  return p.x > r.x0 - pad && p.x < r.x1 + pad && p.z > r.z0 - pad && p.z < r.z1 + pad;
}

/** 位置が歩ける場所か（壁の内外・入口・障害物） */
export function isWalkable(s: GameState, p: Vec2, radius: number): boolean {
  const st = stageOf(s);
  const inside = interiorRect(st);
  const street = streetRect(st);
  const W = inside.x1;
  const D = inside.z1;
  const inInterior = p.x >= radius && p.x <= W - radius && p.z >= radius && p.z <= D - radius;
  const inStreet = p.x >= street.x0 && p.x <= street.x1 && p.z >= street.z0 && p.z <= -radius;
  const inDoor = p.x >= st.door.x0 + radius && p.x <= st.door.x1 - radius && p.z > -radius - 0.01 && p.z < radius + 0.01;
  const alley = alleyRect(st);
  const inAlley = p.x >= alley.x0 + radius && p.x <= alley.x1 - radius && p.z >= alley.z0 && p.z <= alley.z1 - radius;
  if (!inInterior && !inStreet && !inDoor && !inAlley) return false;
  for (const r of colliders(s)) {
    if (inRect(p, r, radius)) return false;
  }
  return true;
}

/**
 * 衝突を考慮して移動する。軸ごとに試して壁沿いに滑らせる。
 * 移動距離が大きい場合は細かく刻んで壁抜けを防ぐ。
 */
export function moveWithCollision(s: GameState, from: Vec2, dx: number, dz: number, radius: number): Vec2 {
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / 0.1));
  let p = { x: from.x, z: from.z };
  const sx = dx / steps;
  const sz = dz / steps;
  for (let i = 0; i < steps; i++) {
    const tryX = { x: p.x + sx, z: p.z };
    if (isWalkable(s, tryX, radius)) p = tryX;
    const tryZ = { x: p.x, z: p.z + sz };
    if (isWalkable(s, tryZ, radius)) p = tryZ;
  }
  return p;
}

export function zoneAt(s: GameState, p: Vec2): 'kitchen' | 'dining' | 'street' | 'counter' | 'out' {
  const st = stageOf(s);
  if (p.z < 0) return 'street';
  const gx = Math.floor(p.x / CELL);
  const gz = Math.floor(p.z / CELL);
  const inR = (r: { x0: number; z0: number; x1: number; z1: number }) => gx >= r.x0 && gx < r.x1 && gz >= r.z0 && gz < r.z1;
  if (inR(st.kitchen)) return 'kitchen';
  if (inR(st.counter)) return 'counter';
  if (inR(st.dining)) return 'dining';
  if (gz === st.counter.z0 && gx < st.counter.x0) return 'kitchen';
  return 'out';
}

/** 警察のパトカーを止める場所（店の前の道。車体は x の向きに長い。画面の armory-fx と同じ） */
export function policeCarPos(st: StageDef): Vec2 {
  return { x: st.w * CELL + 2.5, z: -6.2 };
}

/** パトカーの後ろの扉の前（乗せる人が立つ場所） */
export function policeCarDoor(st: StageDef): Vec2 {
  const c = policeCarPos(st);
  return { x: c.x + 0.55, z: c.z + 1.3 };
}

/** パトカーの後ろの席 */
export function policeCarSeat(st: StageDef): Vec2 {
  const c = policeCarPos(st);
  return { x: c.x + 0.55, z: c.z + 0.25 };
}

/** 警察官が乗り降りする場所（0 = 前の扉、1 = 後ろの扉。店の側。開いた扉のところ） */
export function policeSpawn(st: StageDef, i: number): Vec2 {
  const c = policeCarPos(st);
  return { x: c.x + (i === 0 ? -0.55 : 0.55), z: c.z + 0.85 };
}

/** 扉の外（乗り降りの前に立つ場所） */
export function policeDoorFront(st: StageDef, i: number): Vec2 {
  const p = policeSpawn(st, i);
  return { x: p.x, z: p.z + 0.45 };
}

