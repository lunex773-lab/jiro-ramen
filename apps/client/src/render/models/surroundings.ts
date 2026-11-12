// 店の周り（通りの向かい側）の見た目を、出店先の地域で変える（じろ1 5.10）。
// 都会: 高いビルとネオン / 駅前: 高架の線路と中くらいのビル / 街: 今までの通り / 住宅街: 家と塀と木 /
// 郊外: 駐車場と大きな平屋の店 / 田舎: 田畑と遠くの山。どれも架空の建物（実在の店・看板は使わない）。
// 店の正面の通りは z<0（歩道 z∈[-4.5,0]、車道 z∈[-13.5,-4.5]）。向かい側は z ≤ -14。

import * as THREE from 'three';
import type { Surroundings } from '@jiro/core';
import { cached, GeoBuilder, rr } from './common';
import { glow } from './materials';

function std(key: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return cached('surr:' + key, () => new THREE.MeshStandardMaterial(p));
}

const M = {
  building: (i: number) => std('bld' + (i % 6), { color: ['#8a8076', '#6e6a66', '#9a8e7e', '#5e6064', '#7d8590', '#a39c90'][i % 6]!, roughness: 0.9 }),
  tower: (i: number) => std('tower' + (i % 4), { color: ['#8b97a3', '#76828e', '#9aa6b0', '#6d7884'][i % 4]!, roughness: 0.6, metalness: 0.05 }),
  glass: () => std('glass', { color: '#6f8297', roughness: 0.3, metalness: 0.1 }),
  window: () => std('win', { color: '#2a3440', roughness: 0.2, metalness: 0.3 }),
  litWindow: () => std('litwin', { color: '#2a2a20', emissive: '#ffe0a0', emissiveIntensity: 0.35, roughness: 0.4 }),
  concrete: () => std('concrete', { color: '#a7a49c', roughness: 0.95 }),
  rail: () => std('rail', { color: '#6f6f6a', roughness: 0.6, metalness: 0.5 }),
  train: () => std('train', { color: '#d9dcd8', roughness: 0.4, metalness: 0.2 }),
  trainBand: () => std('trainband', { color: '#2f7d4a', roughness: 0.5 }),
  wall: () => std('housewall', { color: '#e6dccb', roughness: 0.9 }),
  wall2: () => std('housewall2', { color: '#c9c1b4', roughness: 0.9 }),
  roof: () => std('roof', { color: '#3e4a57', roughness: 0.7 }),
  roof2: () => std('roof2', { color: '#6b3b2a', roughness: 0.7 }),
  block: () => std('blockwall', { color: '#b5b1a8', roughness: 0.95 }),
  leaf: () => std('leaf', { color: '#4f7a3a', roughness: 0.9 }),
  trunk: () => std('trunk', { color: '#5b4330', roughness: 0.9 }),
  lot: () => std('lot', { color: '#5b5d5f', roughness: 0.95 }),
  lotLine: () => std('lotline', { color: '#e8e8e0', roughness: 0.8 }),
  field: () => std('field', { color: '#6f8f3c', roughness: 1 }),
  paddy: () => std('paddy', { color: '#8aa25a', roughness: 1 }),
  furrow: () => std('furrow', { color: '#5a4a32', roughness: 1 }),
  mountain: () => std('mountain', { color: '#5f7a63', roughness: 1 }),
  mountain2: () => std('mountain2', { color: '#71897a', roughness: 1 }),
  pole: () => std('pole', { color: '#a9a69e', roughness: 0.9 }),
};

/** 窓の並び（正面 z の面に、w×h の建物の窓を描く） */
function windows(b: GeoBuilder, x: number, w: number, h: number, z: number, r: () => number, lit = 0.25): void {
  const cols = Math.max(1, Math.floor(w / 1.6));
  const rows = Math.max(1, Math.floor((h - 1.5) / 3));
  for (let k = 0; k < rows; k++) {
    for (let c = 0; c < cols; c++) {
      const wx = x - w / 2 + (c + 0.5) * (w / cols);
      b.box(r() < lit ? M.litWindow() : M.window(), (w / cols) * 0.6, 1.1, 0.05, { x: wx, y: 2 + k * 3, z });
    }
  }
}

function tree(b: GeoBuilder, x: number, z: number, s: number): void {
  b.cyl(M.trunk(), 0.12 * s, 0.15 * s, 1.6 * s, 6, { x, y: -0.15, z });
  b.add(M.leaf(), new THREE.SphereGeometry(1.1 * s, 8, 6), { x, y: 1.4 * s + 0.9 * s, z });
}

/** 切妻の屋根（三角柱。棟は x 方向） */
function gableRoof(b: GeoBuilder, mat: THREE.Material, x: number, y: number, z: number, w: number, d: number, h: number): void {
  const g = new THREE.CylinderGeometry(1, 1, 1, 3, 1);
  // 3角の円柱を横に寝かせて三角柱にする（底辺 d・高さ h・長さ w）
  g.rotateZ(Math.PI / 2);
  // 頂点の1つを真上に向ける（底辺は水平）
  g.rotateX(-Math.PI / 2);
  g.scale(w, (h / 1.5) * 1.0, d / Math.sqrt(3));
  b.add(mat, g, { x, y: y + h / 3, z });
}

/** 隣の建物（店の左右）の高さ */
export function neighborHeight(kind: Surroundings): number {
  return kind === 'metro' ? 9 : kind === 'station' ? 6 : kind === 'rural' || kind === 'suburb' ? 3.4 : 3.8;
}

/**
 * 通りの向かい側を作る。sx0〜sx1 は歩道の x の範囲（店の左右に少し広い）
 */
export function buildSurroundings(b: GeoBuilder, kind: Surroundings, r: () => number, sx0: number, sx1: number): void {
  const zFront = -14;
  switch (kind) {
    case 'metro': {
      // 高いビルが並び、低い階にネオンの看板（文字のない色の帯）
      for (let i = 0; i < 7; i++) {
        const w = rr(r, 5, 8);
        const h = rr(r, 20, 42);
        const x = sx0 - 12 + i * 7;
        b.box(M.tower(i), w, h, 6, { x, y: h / 2 - 0.15, z: zFront - 3 });
        windows(b, x, w, h, zFront + 0.03, r, 0.45);
        const neon = ['#ff3d6e', '#3dd6ff', '#ffd23d', '#8cff5a', '#c45bff'][i % 5]!;
        b.box(glow(neon, 1.4), w * 0.8, 0.6, 0.12, { x, y: 4 + (i % 3) * 1.2, z: zFront + 0.12 });
        b.box(glow(neon, 1.2), 0.5, 3.2, 0.5, { x: x + w * 0.38, y: 7.5, z: zFront + 0.4 });
      }
      // 奥にもっと高いビル（霞む）
      for (let i = 0; i < 5; i++) {
        const h = rr(r, 35, 60);
        b.box(M.glass(), rr(r, 8, 12), h, 8, { x: sx0 - 8 + i * 11, y: h / 2, z: -40 });
      }
      break;
    }
    case 'station': {
      // 高架の線路（柱・桁・電車）と、その奥の中くらいのビル
      const len = sx1 - sx0 + 40;
      const cx = (sx0 + sx1) / 2;
      const deckY = 6;
      const vz = -24;
      // 手前に低い駅前の店（2階建て）
      for (let i = 0; i < 6; i++) {
        const w = rr(r, 4.5, 6.5);
        const h = rr(r, 5.5, 7.5);
        const x = sx0 - 10 + i * 6.5;
        b.box(M.building(i + 2), w, h, 4, { x, y: h / 2 - 0.15, z: -16 });
        windows(b, x, w, h, -13.97, r, 0.15);
      }
      for (let x = sx0 - 18; x <= sx1 + 18; x += 7) b.box(M.concrete(), 1.2, deckY, 1.6, { x, y: deckY / 2 - 0.15, z: vz });
      b.box(M.concrete(), len, 1.2, 8, { x: cx, y: deckY + 0.45, z: vz });
      b.box(M.concrete(), len, 1.0, 0.25, { x: cx, y: deckY + 1.5, z: vz + 3.9 });
      b.box(M.rail(), len, 0.15, 0.15, { x: cx, y: deckY + 1.1, z: vz + 1 });
      b.box(M.rail(), len, 0.15, 0.15, { x: cx, y: deckY + 1.1, z: vz - 1 });
      // 電車（3両）
      for (let k = 0; k < 3; k++) {
        const tx = sx0 + 2 + k * 20.5;
        b.box(M.train(), 20, 3.2, 2.9, { x: tx, y: deckY + 2.8, z: vz });
        b.box(M.trainBand(), 20.05, 0.35, 2.95, { x: tx, y: deckY + 2.0, z: vz });
        for (let wnd = 0; wnd < 6; wnd++) b.box(M.window(), 1.6, 1.0, 0.05, { x: tx - 8 + wnd * 3.2, y: deckY + 3.2, z: vz + 1.48 });
      }
      for (let i = 0; i < 6; i++) {
        const w = rr(r, 6, 9);
        const h = rr(r, 14, 26);
        const x = sx0 - 10 + i * 8;
        b.box(M.tower(i), w, h, 6, { x, y: h / 2 - 0.15, z: -36 });
        windows(b, x, w, h, -32.97, r, 0.2);
      }
      break;
    }
    case 'residential': {
      // 低いブロック塀と、切妻屋根の家・庭木
      b.box(M.block(), sx1 - sx0 + 20, 1.2, 0.15, { x: (sx0 + sx1) / 2, y: 0.45, z: zFront });
      for (let i = 0; i < 6; i++) {
        const w = rr(r, 6, 7.5);
        const d = rr(r, 6, 8);
        const h = rr(r, 5.2, 6.2);
        const x = sx0 - 8 + i * 8.5;
        const z = zFront - 2 - d / 2;
        b.box(i % 2 ? M.wall() : M.wall2(), w, h, d, { x, y: h / 2 - 0.15, z });
        gableRoof(b, i % 3 ? M.roof() : M.roof2(), x, h - 0.15, z, w + 0.6, d + 0.6, 1.8);
        for (let k = 0; k < 2; k++) b.box(M.window(), 1.2, 1.0, 0.05, { x: x - w / 4 + k * (w / 2), y: h * 0.62, z: z + d / 2 + 0.03 });
        if (r() < 0.7) tree(b, x + w / 2 + 0.8, zFront - 1.2, rr(r, 0.8, 1.1));
      }
      break;
    }
    case 'suburb': {
      // 広い駐車場と、奥の大きな平屋の店（看板の柱は文字なし）
      const cx = (sx0 + sx1) / 2;
      b.box(M.lot(), sx1 - sx0 + 30, 0.04, 16, { x: cx, y: -0.17, z: -22 });
      for (let x = sx0 - 12; x < sx1 + 12; x += 2.6) b.box(M.lotLine(), 0.08, 0.01, 4.5, { x, y: -0.14, z: -18.5 });
      for (let x = sx0 - 12; x < sx1 + 12; x += 2.6) b.box(M.lotLine(), 0.08, 0.01, 4.5, { x, y: -0.14, z: -25 });
      b.box(M.building(5), 34, 5.5, 14, { x: cx + 4, y: 2.6, z: -37 });
      b.box(glow('#ffb43d', 1.2), 20, 1.0, 0.2, { x: cx + 4, y: 4.4, z: -29.9 });
      b.box(M.pole(), 0.5, 9, 0.5, { x: sx0 - 4, y: 4.35, z: -15.5 });
      b.box(glow('#ff5a3d', 1.4), 3.2, 2.0, 0.4, { x: sx0 - 4, y: 9.6, z: -15.5 });
      for (let i = 0; i < 5; i++) tree(b, sx0 - 14 + i * 9, -30, rr(r, 0.9, 1.3));
      break;
    }
    case 'rural': {
      // 田畑（畝の線）・農家・遠くの山
      const cx = (sx0 + sx1) / 2;
      b.box(M.paddy(), sx1 - sx0 + 60, 0.04, 30, { x: cx, y: -0.2, z: -30 });
      for (let z = -16; z > -44; z -= 1.8) b.box(M.furrow(), sx1 - sx0 + 60, 0.03, 0.25, { x: cx, y: -0.16, z });
      b.box(M.field(), 18, 0.05, 12, { x: sx0 - 6, y: -0.15, z: -22 });
      for (let i = 0; i < 3; i++) {
        const x = sx0 + 4 + i * 16;
        const z = -36 - (i % 2) * 6;
        b.box(M.wall2(), 7, 4.5, 6, { x, y: 2.1, z });
        gableRoof(b, M.roof2(), x, 4.35, z, 7.6, 6.6, 2.2);
      }
      for (let i = 0; i < 7; i++) {
        const h = rr(r, 14, 26);
        const g = new THREE.ConeGeometry(rr(r, 14, 22), h, 7);
        b.add(i % 2 ? M.mountain() : M.mountain2(), g, { x: sx0 - 30 + i * 14, y: h / 2 - 0.2, z: rr(r, -58, -66) });
      }
      for (let x = sx0 - 10; x < sx1 + 20; x += 12) b.cyl(M.pole(), 0.12, 0.15, 8, 8, { x, y: 0, z: -14.5 });
      break;
    }
    default: {
      // 街（今までの通り）: 中くらいの建物と窓
      for (let i = 0; i < 6; i++) {
        const w = rr(r, 4, 7);
        const h = rr(r, 6, 14);
        const x = sx0 - 10 + i * 6.5;
        b.box(M.building(i + 2), w, h, 4, { x, y: h / 2 - 0.15, z: -16 });
        for (let k = 0; k < Math.floor(h / 3); k++) b.box(M.window(), w * 0.7, 1.0, 0.05, { x, y: 2 + k * 3, z: -13.97 });
      }
    }
  }
}

// ───────────────── 区画の周り（オーナーの指示 2026-11-12: 区画を裏通りも含めて1周歩ける・地域ごとの物） ─────────────────

export interface BlockDims {
  /** 区画（建物で埋まっている所） */
  x0: number;
  x1: number;
  z1: number;
  /** 歩道の幅 */
  walk: number;
  /** 歩道に置く物の場所（core の outdoorBays） */
  bays: { side: 'left' | 'right' | 'back'; x0: number; z0: number; x1: number; z1: number }[];
}

type Prop = 'vending' | 'bench' | 'bikes' | 'planter' | 'mailbox' | 'busstop' | 'trash' | 'garbage' | 'ac';

/** 地域ごとに、歩道の場所（左1・右1・左2・右2・裏1・裏2・裏3）に置く物 */
const BAY_PROPS: Record<Surroundings, Prop[]> = {
  metro: ['vending', 'bikes', 'vending', 'ac', 'trash', 'ac', 'bikes'],
  station: ['bikes', 'vending', 'bikes', 'bikes', 'trash', 'vending', 'planter'],
  town: ['vending', 'planter', 'mailbox', 'bikes', 'trash', 'ac', 'planter'],
  residential: ['planter', 'bikes', 'mailbox', 'planter', 'garbage', 'bench', 'planter'],
  suburb: ['vending', 'bench', 'planter', 'bikes', 'garbage', 'planter', 'bench'],
  rural: ['busstop', 'vending', 'bench', 'planter', 'garbage', 'planter', 'bench'],
};

const P = {
  vend: () => std('vend', { color: '#d8dde2', roughness: 0.5, metalness: 0.2 }),
  vendRed: () => std('vendRed', { color: '#b8322a', roughness: 0.5 }),
  vendPanel: () => std('vendPanel', { color: '#1c2a38', emissive: '#7fb6ff', emissiveIntensity: 0.35, roughness: 0.3 }),
  wood: () => std('benchWood', { color: '#8a6440', roughness: 0.8 }),
  metal: () => std('metal', { color: '#5c6166', roughness: 0.5, metalness: 0.5 }),
  tire: () => std('tire', { color: '#1a1a1a', roughness: 0.9 }),
  pot: () => std('planterPot', { color: '#7a5a46', roughness: 0.9 }),
  red: () => std('postRed', { color: '#c4302b', roughness: 0.5 }),
  bin: () => std('bin', { color: '#3b6e4a', roughness: 0.6 }),
  net: () => std('garbageNet', { color: '#2f5fa0', roughness: 0.9 }),
  bag: () => std('garbageBag', { color: '#d7dce0', roughness: 0.7 }),
  ac: () => std('acUnit', { color: '#e3e3dc', roughness: 0.6 }),
  acFan: () => std('acFan', { color: '#45484a', roughness: 0.6 }),
  sign: () => std('busSign', { color: '#2f6fb0', roughness: 0.5 }),
  pipe: () => std('pipe', { color: '#8e8d86', roughness: 0.7, metalness: 0.3 }),
  door: () => std('backDoor', { color: '#5d5a55', roughness: 0.6, metalness: 0.2 }),
};

/** 歩道の場所の向き: 建物の壁から歩道の方（out）と、壁に沿った方（along） */
function bayFrame(bay: BlockDims['bays'][number]): { cx: number; cz: number; out: [number, number]; along: [number, number]; ry: number; len: number; dep: number } {
  const cx = (bay.x0 + bay.x1) / 2;
  const cz = (bay.z0 + bay.z1) / 2;
  if (bay.side === 'left') return { cx, cz, out: [-1, 0], along: [0, 1], ry: -Math.PI / 2, len: bay.z1 - bay.z0, dep: bay.x1 - bay.x0 };
  if (bay.side === 'right') return { cx, cz, out: [1, 0], along: [0, -1], ry: Math.PI / 2, len: bay.z1 - bay.z0, dep: bay.x1 - bay.x0 };
  return { cx, cz, out: [0, 1], along: [1, 0], ry: 0, len: bay.x1 - bay.x0, dep: bay.z1 - bay.z0 };
}

/** 歩道の物を1つ置く（a: 壁に沿った位置、o: 壁から外へ。どちらも場所の中心から） */
function buildProp(b: GeoBuilder, kind: Prop, bay: BlockDims['bays'][number], r: () => number): void {
  const f = bayFrame(bay);
  const at = (a: number, o: number) => ({ x: f.cx + f.along[0] * a + f.out[0] * o, z: f.cz + f.along[1] * a + f.out[1] * o });
  const box = (m: THREE.Material, w: number, h: number, d: number, a: number, y: number, o: number) => b.box(m, w, h, d, { ...at(a, o), y, ry: f.ry });
  switch (kind) {
    case 'vending':
      for (const [a, m] of [[-0.33, P.vend()], [0.33, P.vendRed()]] as const) {
        box(m, 0.62, 1.8, 0.7, a, 0.9, 0);
        box(P.vendPanel(), 0.48, 0.9, 0.02, a, 1.2, 0.36);
      }
      break;
    case 'bench':
      box(P.wood(), 1.2, 0.06, 0.4, 0, 0.45, 0.1);
      box(P.wood(), 1.2, 0.3, 0.05, 0, 0.7, -0.12);
      for (const a of [-0.5, 0.5]) box(P.metal(), 0.06, 0.45, 0.4, a, 0.22, 0.05);
      break;
    case 'bikes':
      for (const a of [-0.35, 0.1, 0.5]) {
        for (const o of [-0.3, 0.3]) b.add(P.tire(), new THREE.TorusGeometry(0.28, 0.03, 6, 14), { ...at(a, o), y: 0.3, ry: f.ry + Math.PI / 2 });
        box(P.metal(), 0.04, 0.04, 0.62, a, 0.5, 0);
        box(P.metal(), 0.04, 0.5, 0.04, a, 0.55, -0.1);
      }
      break;
    case 'planter':
      for (const a of [-0.4, 0.4]) {
        box(P.pot(), 0.45, 0.4, 0.45, a, 0.2, 0);
        b.add(std('leaf2', { color: '#4f7a3a', roughness: 0.9 }), new THREE.SphereGeometry(0.32 + r() * 0.08, 8, 6), { ...at(a, 0), y: 0.6 });
      }
      break;
    case 'mailbox':
      b.cyl(P.red(), 0.22, 0.22, 1.1, 12, { ...at(0, 0.1), y: 0 });
      box(P.red(), 0.5, 0.08, 0.5, 0, 1.12, 0.1);
      box(P.pot(), 0.45, 0.35, 0.45, 0.45, 0.17, 0);
      break;
    case 'busstop':
      b.cyl(P.metal(), 0.04, 0.04, 2.2, 8, { ...at(-0.45, 0.25), y: 0 });
      b.cyl(P.sign(), 0.28, 0.28, 0.05, 16, { ...at(-0.45, 0.25), y: 2.1, rx: Math.PI / 2, ry: f.ry });
      box(P.wood(), 0.8, 0.06, 0.35, 0.25, 0.45, 0);
      for (const a of [-0.05, 0.55]) box(P.metal(), 0.05, 0.45, 0.35, a, 0.22, 0);
      break;
    case 'trash':
      for (const a of [-0.3, 0.3]) b.cyl(P.bin(), 0.22, 0.2, 0.75, 12, { ...at(a, 0), y: 0 });
      break;
    case 'garbage':
      box(P.net(), 1.2, 0.05, 0.75, 0, 0.5, 0);
      for (const [a, o] of [[-0.35, -0.1], [0.05, 0.1], [0.38, -0.12]] as const) b.add(P.bag(), new THREE.SphereGeometry(0.22, 8, 6), { ...at(a, o), y: 0.22 });
      break;
    case 'ac':
      for (const a of [-0.32, 0.32]) {
        box(P.ac(), 0.58, 0.55, 0.3, a, 0.28, -0.2);
        b.cyl(P.acFan(), 0.17, 0.17, 0.02, 14, { ...at(a, -0.04), y: 0.3, rx: Math.PI / 2, ry: f.ry });
      }
      break;
  }
}

/**
 * 区画の周り: 左右と裏の歩道・縁石・車道、区画の建物の横と裏の壁（窓・勝手口・配管）、通りの向こうの建物、歩道の物。
 * nbH: 区画の建物の高さ
 */
export function buildBlockAround(b: GeoBuilder, kind: Surroundings, r: () => number, d: BlockDims, nbH: number, sidewalk: THREE.Material, asphalt: THREE.Material, curb: THREE.Material): void {
  const { x0, x1, z1, walk } = d;
  const L = x0 - walk;
  const Rr = x1 + walk;
  const Z = z1 + walk;
  // 歩道（前の歩道は shop.ts）と縁石
  b.box(sidewalk, walk, 0.05, Z, { x: (L + x0) / 2, y: -0.025, z: Z / 2, uv: 1.0 });
  b.box(sidewalk, walk, 0.05, Z, { x: (x1 + Rr) / 2, y: -0.025, z: Z / 2, uv: 1.0 });
  b.box(sidewalk, x1 - x0, 0.05, walk, { x: (x0 + x1) / 2, y: -0.025, z: (z1 + Z) / 2, uv: 1.0 });
  b.box(curb, 0.18, 0.18, Z + 4.5, { x: L, y: -0.06, z: (Z - 4.5) / 2 });
  b.box(curb, 0.18, 0.18, Z + 4.5, { x: Rr, y: -0.06, z: (Z - 4.5) / 2 });
  b.box(curb, Rr - L, 0.18, 0.18, { x: (L + Rr) / 2, y: -0.06, z: Z });
  // 左右と裏の車道（裏は細い裏通り）
  const side = kind === 'suburb' || kind === 'rural' ? 8 : 6.5;
  b.box(asphalt, side, 0.05, Z + 4.5 + side + 9, { x: L - side / 2, y: -0.178, z: (Z + side - 13.5) / 2, uv: 2.0 });
  b.box(asphalt, side, 0.05, Z + 4.5 + side + 9, { x: Rr + side / 2, y: -0.178, z: (Z + side - 13.5) / 2, uv: 2.0 });
  b.box(asphalt, Rr - L, 0.05, 4.5, { x: (L + Rr) / 2, y: -0.179, z: Z + 2.25, uv: 2.0 });
  // 区画の建物の横・裏の壁: 窓・裏口・配管・室外機の跡（区画の建物の箱は shop.ts）
  const winMat = M.window();
  const wallDecor = (x: number, z: number, along: 'x' | 'z', len: number, nx: number, nz: number) => {
    const n = Math.max(1, Math.floor(len / 3.2));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      const px = along === 'x' ? x + t : x + nx * 0.03;
      const pz = along === 'z' ? z + t : z + nz * 0.03;
      for (let k = 0; k < Math.max(1, Math.floor((nbH - 1) / 3)); k++) {
        b.box(k === 0 && i % 2 === 1 ? P.door() : winMat, along === 'x' ? 1.1 : 0.05, k === 0 && i % 2 === 1 ? 2.0 : 1.0, along === 'z' ? 1.1 : 0.05, { x: px, y: k === 0 && i % 2 === 1 ? 1.0 : 1.9 + k * 3, z: pz });
      }
      if (i % 3 === 0) b.cyl(P.pipe(), 0.05, 0.05, nbH, 8, { x: px + (along === 'x' ? 0.8 : nx * 0.08), y: 0, z: pz + (along === 'z' ? 0.8 : nz * 0.08) });
    }
  };
  wallDecor(x0, z1 / 2, 'z', z1, -1, 0);
  wallDecor(x1, z1 / 2, 'z', z1, 1, 0);
  wallDecor((x0 + x1) / 2, z1, 'x', x1 - x0, 0, 1);
  // 都会・駅前: 横の壁に縦長の光る看板（文字なし）
  if (kind === 'metro' || kind === 'station') {
    for (const [x, nx] of [[x0, -1], [x1, 1]] as const) {
      const neon = kind === 'metro' ? ['#ff3d6e', '#3dd6ff'][nx > 0 ? 1 : 0]! : '#ffd23d';
      b.box(glow(neon, 1.3), 0.2, 2.6, 0.7, { x: x + nx * 0.15, y: 4.2, z: 1.6 });
    }
  }
  // 通りの向こう（左・右・裏）
  const far = (cx: number, cz: number, along: 'x' | 'z', len: number, face: number) => {
    const n = Math.max(2, Math.floor(len / 7));
    for (let i = 0; i < n; i++) {
      const t = -len / 2 + (i + 0.5) * (len / n);
      const px = along === 'x' ? cx + t : cx;
      const pz = along === 'z' ? cz + t : cz;
      const w = (len / n) * 0.85;
      switch (kind) {
        case 'metro': {
          const h = rr(r, 18, 34);
          b.box(M.tower(i), along === 'x' ? w : 6, h, along === 'z' ? w : 6, { x: px, y: h / 2 - 0.15, z: pz });
          break;
        }
        case 'station':
        case 'town': {
          const h = rr(r, 6, 13);
          b.box(M.building(i + 1), along === 'x' ? w : 5, h, along === 'z' ? w : 5, { x: px, y: h / 2 - 0.15, z: pz });
          break;
        }
        case 'residential': {
          const h = rr(r, 5, 6);
          b.box(i % 2 ? M.wall() : M.wall2(), along === 'x' ? w * 0.8 : 6, h, along === 'z' ? w * 0.8 : 6, { x: px, y: h / 2 - 0.15, z: pz });
          gableRoof(b, i % 3 ? M.roof() : M.roof2(), px, h - 0.15, pz, along === 'x' ? w * 0.8 + 0.6 : 6.6, along === 'z' ? w * 0.8 + 0.6 : 6.6, 1.6);
          if (r() < 0.6) tree(b, px + (along === 'x' ? w * 0.45 : 0), pz + (along === 'z' ? w * 0.45 : 0), 0.9);
          break;
        }
        case 'suburb': {
          if (i % 2 === 0) b.box(M.lot(), along === 'x' ? w : 9, 0.04, along === 'z' ? w : 9, { x: px, y: -0.17, z: pz });
          else {
            b.box(M.building(5), along === 'x' ? w : 7, 4.5, along === 'z' ? w : 7, { x: px, y: 2.1, z: pz });
          }
          break;
        }
        case 'rural': {
          b.box(i % 2 ? M.paddy() : M.field(), along === 'x' ? w : 10, 0.04, along === 'z' ? w : 10, { x: px, y: -0.18, z: pz });
          if (i % 3 === 1) {
            b.box(M.wall2(), 5, 4, 5, { x: px, y: 1.85, z: pz });
            gableRoof(b, M.roof2(), px, 3.85, pz, 5.6, 5.6, 2);
          }
          break;
        }
      }
      void face;
    }
  };
  const zMid = (Z - 4.5) / 2;
  far(L - side - 4, zMid, 'z', Z + 4.5, 1);
  far(Rr + side + 4, zMid, 'z', Z + 4.5, -1);
  far((L + Rr) / 2, Z + 4.5 + 3.5, 'x', Rr - L + 2 * side, -1);
  // 交番（駅前）: 左の角の向こうに小さな建物と赤い灯り（文字なし）
  if (kind === 'station') {
    b.box(M.building(3), 3.2, 3.2, 3.2, { x: L - side - 2, y: 1.45, z: -2.5 });
    b.cyl(glow('#ff3030', 1.4), 0.18, 0.18, 0.3, 10, { x: L - side - 0.35, y: 2.6, z: -2.5 });
  }
  // 歩道の物
  const props = BAY_PROPS[kind];
  d.bays.forEach((bay, i) => buildProp(b, props[i % props.length]!, bay, r));
}
