// 丼（次郎系ラーメン）のモデル。
// 原点=丼の底の中心。外径 0.24m・高さ約 0.096m。
// 見る人（客・盛り付け担当）は -z 側から見る想定で、手前(-z)左寄りに豚、手前右にニンニク、奥に野菜の山を置く。
// もやし・ニンニク・背脂・唐辛子は InstancedMesh で描き、draw call と三角形数を抑える。

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BowlContents } from '@jiro/core';
import { cached, clamp, makeRng, rnorm, rr, tmp, type Disposable, type Rng } from './common';
import { MAT } from './materials';
import { PORK_UV, texBowlStain, texChiliPowder, texEnv, texPork, texSoup, texSprouts } from './textures';
import { createSteam } from './fx';

export type BowlDetail = 'high' | 'low';

export interface BowlModel extends Disposable {
  group: THREE.Group;
  /** 具を作り直す。contents=null → 空のきれいな丼。dirty=true → 食べ終えた汚れ（具なし） */
  setContents(c: BowlContents | null, opts?: { dirty?: boolean }): void;
  /** high=近く（一人称）, low=遠く */
  setDetail(level: BowlDetail): void;
  /** 毎フレーム（任意）。湯気は tickModels() の共有時間で動くので中身は軽い */
  tick(t: number): void;
}

/** 丼の寸法（配置用） */
export const BOWL_DIMS = {
  radius: 0.1205,
  height: 0.0958,
  innerBottom: 0.013,
  /** 丼を重ねたときの1段の高さ */
  stackStep: 0.032,
};

// ───────────────────────── 器 ─────────────────────────

// 断面（外側の底 → 高台 → 胴 → 厚い口縁 → 内側 → 内底の中心）
const PROFILE: [number, number][] = [
  [0.0, 0.0045],
  [0.041, 0.0045],
  [0.0445, 0.0],
  [0.0505, 0.0],
  [0.0525, 0.0075],
  [0.058, 0.0095],
  [0.068, 0.0135],
  [0.08, 0.021],
  [0.092, 0.0315],
  [0.1025, 0.045],
  [0.1105, 0.06],
  [0.1158, 0.0745],
  [0.1188, 0.086],
  [0.1203, 0.0925],
  [0.1201, 0.0948],
  [0.1188, 0.0958],
  [0.1168, 0.0958],
  [0.1148, 0.0945],
  [0.1136, 0.0908],
  [0.1112, 0.081],
  [0.1062, 0.066],
  [0.0978, 0.051],
  [0.0858, 0.0375],
  [0.069, 0.026],
  [0.048, 0.0175],
  [0.024, 0.0138],
  [0.0, 0.013],
];

const PROFILE_LOW: [number, number][] = [
  [0.0, 0.0045],
  [0.0445, 0.0],
  [0.0525, 0.0075],
  [0.08, 0.021],
  [0.1025, 0.045],
  [0.1158, 0.0745],
  [0.1203, 0.0925],
  [0.1188, 0.0958],
  [0.1148, 0.0945],
  [0.1112, 0.081],
  [0.0978, 0.051],
  [0.069, 0.026],
  [0.0, 0.013],
];

/** 内側の断面（y 昇順） */
const INNER: [number, number][] = PROFILE.slice(17).reverse().map(([r, y]) => [r, y]);

const RIM_TOP = 0.0958;

/** 高さ y における内壁の半径 */
export function innerRadiusAt(y: number): number {
  const first = INNER[0]!;
  if (y <= first[1]) return first[0];
  for (let i = 1; i < INNER.length; i++) {
    const a = INNER[i - 1]!;
    const b = INNER[i]!;
    if (y <= b[1]) {
      const t = (y - a[1]) / (b[1] - a[1]);
      return a[0] + (b[0] - a[0]) * t;
    }
  }
  return INNER[INNER.length - 1]![0];
}

function bowlGeometry(detail: BowlDetail): THREE.BufferGeometry {
  return cached('bowlgeo:' + detail, () => {
    const pts = (detail === 'high' ? PROFILE : PROFILE_LOW).map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(pts, detail === 'high' ? 56 : 18);
    const uv = g.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 5, uv.getY(i) * 1.2);
    g.computeBoundingSphere();
    return g;
  });
}

/** 内壁だけの断面（汚れの重ね貼り用） */
function stainGeometry(): THREE.BufferGeometry {
  return cached('bowlstaingeo', () => {
    const src = PROFILE.slice(16);
    const pts = src.map(([r, y]) => new THREE.Vector2(Math.max(0, r - 0.0004), y + 0.0003));
    const g = new THREE.LatheGeometry(pts, 40);
    // v=0 を丼の底、v=1 を口縁にする
    const uv = g.attributes.uv!;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 3, 1 - uv.getY(i));
    return g;
  });
}

// ───────────────────────── 共有マテリアル ─────────────────────────

const M = {
  soup: (tare: number) => {
    const lv = clamp(Math.round(tare), 1, 3);
    const tint = ['#ffffff', '#d2b8a0', '#ae8c70'][lv - 1]!;
    return cached('m:soup' + lv, () =>
      new THREE.MeshStandardMaterial({ map: texSoup(), color: tint, roughness: 0.12, metalness: 0, envMap: texEnv(), envMapIntensity: 0.55 }),
    );
  },
  tare: () =>
    cached('m:tare', () => new THREE.MeshStandardMaterial({ color: '#3c200e', roughness: 0.08, metalness: 0, envMap: texEnv(), envMapIntensity: 0.6 })),
  dirtyPool: () =>
    cached('m:dirtypool', () =>
      new THREE.MeshStandardMaterial({ map: texSoup(), color: '#c0a284', roughness: 0.1, transparent: true, opacity: 0.9, envMap: texEnv(), envMapIntensity: 0.5 }),
    ),
  stain: () =>
    cached('m:stain', () =>
      new THREE.MeshStandardMaterial({
        map: texBowlStain(),
        transparent: true,
        roughness: 0.2,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    ),
  noodle: () => cached('m:noodle', () => new THREE.MeshStandardMaterial({ color: '#dcbd7e', roughness: 0.38, metalness: 0, emissive: '#3a2a10', emissiveIntensity: 0.25 })),
  dome: () =>
    cached('m:dome', () =>
      new THREE.MeshStandardMaterial({ map: texSprouts(), vertexColors: true, roughness: 0.4, metalness: 0, emissive: '#4e4a3c', emissiveIntensity: 0.6 }),
    ),
  sprout: () =>
    cached('m:sprout', () =>
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.28,
        metalness: 0,
        emissive: '#4c4838',
        emissiveIntensity: 0.55,
        envMap: texEnv(),
        envMapIntensity: 0.35,
      }),
    ),
  cabbage: () =>
    cached('m:cabbage', () =>
      new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0, side: THREE.DoubleSide, emissive: '#2a3418', emissiveIntensity: 0.45 }),
    ),
  pork: () =>
    cached('m:pork', () => new THREE.MeshStandardMaterial({ map: texPork(), roughness: 0.44, metalness: 0, envMap: texEnv(), envMapIntensity: 0.35 })),
  garlic: () =>
    cached('m:garlic', () =>
      new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0, emissive: '#4a4020', emissiveIntensity: 0.45, envMap: texEnv(), envMapIntensity: 0.3 }),
    ),
  abura: () =>
    cached('m:abura', () =>
      new THREE.MeshStandardMaterial({ roughness: 0.32, metalness: 0, emissive: '#5a4426', emissiveIntensity: 0.5, envMap: texEnv(), envMapIntensity: 0.35 }),
    ),
  chili: () => cached('m:chili', () => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide })),
  powder: () =>
    cached('m:powder', () =>
      new THREE.MeshStandardMaterial({
        map: texChiliPowder(),
        alphaTest: 0.5,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    ),
};

// ───────────────────────── 共有ジオメトリ ─────────────────────────

/** 円盤（スープ面）。半径1、XZ 平面 */
function discGeometry(seg: number): THREE.BufferGeometry {
  return cached('disc' + seg, () => {
    const g = new THREE.CircleGeometry(1, seg);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

/** もやし1本: 長さ約6cmの弓なりの棒。片方の端（豆）は黄色っぽく太い */
function sproutGeometry(detail: BowlDetail): THREE.BufferGeometry {
  return cached('sprout:' + detail, () => {
    const segs = detail === 'high' ? 5 : 3;
    const rad = detail === 'high' ? 4 : 3;
    const L = 0.06;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = (t - 0.5) * L;
      const yb = 0.01 * (1 - (2 * t - 1) ** 2);
      const zb = 0.004 * Math.sin(t * Math.PI * 2);
      const r = t > 0.95 ? 0.003 : t < 0.05 ? 0.0011 : 0.0023;
      for (let k = 0; k < rad; k++) {
        const a = (k / rad) * Math.PI * 2;
        pos.push(x, yb + Math.cos(a) * r, zb + Math.sin(a) * r);
        if (t > 0.95) col.push(0.95, 0.86, 0.5);
        else if (t < 0.05) col.push(0.9, 0.87, 0.78);
        else col.push(1.0, 0.99, 0.95);
      }
    }
    for (let i = 0; i < segs; i++) {
      for (let k = 0; k < rad; k++) {
        const a = i * rad + k;
        const b = i * rad + ((k + 1) % rad);
        const c = (i + 1) * rad + k;
        const d = (i + 1) * rad + ((k + 1) % rad);
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  });
}

function cabbageGeometry(): THREE.BufferGeometry {
  return cached('cabbage', () => {
    const g = new THREE.PlaneGeometry(0.028, 0.022, 2, 2);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      p.setY(i, (x * x + z * z) * 8 + Math.sin(x * 300) * 0.0015);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** 角の丸い不定形の粒（背脂・ニンニク共用） */
function lumpGeometry(detail: 0 | 1, seed: number, squash: number): THREE.BufferGeometry {
  return cached(`lump:${detail}:${seed}:${squash}`, () => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position!;
    const r = makeRng(seed);
    for (let i = 0; i < p.count; i++) {
      tmp.v.set(p.getX(i), p.getY(i), p.getZ(i));
      // 角の丸い立方体寄りに
      const sx = Math.sign(tmp.v.x) * Math.pow(Math.abs(tmp.v.x), 0.6);
      const sy = Math.sign(tmp.v.y) * Math.pow(Math.abs(tmp.v.y), 0.6);
      const sz = Math.sign(tmp.v.z) * Math.pow(Math.abs(tmp.v.z), 0.6);
      const k = rr(r, 0.82, 1.12);
      p.setXYZ(i, sx * k, sy * k * squash, sz * k);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** 刻みニンニクの粒（少し丸めた八面体） */
function garlicGeometry(): THREE.BufferGeometry {
  return cached('garlicgeo', () => {
    let g: THREE.BufferGeometry = new THREE.OctahedronGeometry(1, 0);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    g.computeVertexNormals();
    return g;
  });
}

/** 唐辛子の粉1粒（小さな三角形） */
function chiliGeometry(): THREE.BufferGeometry {
  return cached('chili', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.6, -0.55, 0, 0.4, 0.55, 0, 0.4], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2]);
    return g;
  });
}

/** 平たい極太麺1本（断面は横長の四角） */
function ribbon(pts: THREE.Vector3[], segs: number, w: number, h: number, out: { pos: number[]; idx: number[] }): void {
  const curve = new THREE.CatmullRomCurve3(pts);
  const base = out.pos.length / 3;
  const p = new THREE.Vector3();
  const t = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  for (let i = 0; i <= segs; i++) {
    const u = i / segs;
    curve.getPointAt(u, p);
    curve.getTangentAt(u, t);
    side.crossVectors(t, tmp.up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(side, t).normalize();
    const hw = w / 2;
    const hh = h / 2;
    for (const [a, b] of [
      [hw, hh],
      [-hw, hh],
      [-hw, -hh],
      [hw, -hh],
    ] as const) {
      out.pos.push(p.x + side.x * a + up.x * b, p.y + side.y * a + up.y * b, p.z + side.z * a + up.z * b);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let k = 0; k < 4; k++) {
      const a = base + i * 4 + k;
      const b = base + i * 4 + ((k + 1) % 4);
      const c = base + (i + 1) * 4 + k;
      const d = base + (i + 1) * 4 + ((k + 1) % 4);
      out.idx.push(a, b, c, b, d, c);
    }
  }
}

/** 麺: 縁に沿って波打つ極太麺（rim）と、中央に絡む麺（nest）。半径 0.108 基準・y=0 がスープ面 */
function noodleGeometry(kind: 'rim' | 'nest', amount: 1 | 2, detail: BowlDetail): THREE.BufferGeometry {
  return cached(`noodle:${kind}:${amount}:${detail}`, () => {
    const r = makeRng((kind === 'rim' ? 101 : 211) + amount * 13 + (detail === 'high' ? 0 : 7));
    const hi = detail === 'high';
    const n = kind === 'rim' ? (hi ? (amount === 2 ? 20 : 14) : amount === 2 ? 8 : 6) : hi ? (amount === 2 ? 12 : 9) : 4;
    const segs = hi ? 18 : 7;
    const out = { pos: [] as number[], idx: [] as number[] };
    for (let i = 0; i < n; i++) {
      const pts: THREE.Vector3[] = [];
      const steps = 10;
      if (kind === 'rim') {
        const a0 = r() * Math.PI * 2;
        const span = rr(r, 0.8, 1.8) * (r() < 0.5 ? 1 : -1);
        const rad0 = rr(r, 0.08, 0.101);
        const ph = r() * 6;
        const k = rr(r, 9, 14);
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const a = a0 + span * t;
          // ゴワゴワと波打つ
          const rad = Math.min(0.103, rad0 + 0.004 * Math.sin(t * k + ph));
          const y = 0.0045 * Math.sin(t * Math.PI * rr(r, 1.5, 2.5) + ph) + 0.0012 * Math.sin(t * k * 1.7) - 0.0008;
          pts.push(new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad));
        }
      } else {
        const a = r() * Math.PI * 2;
        const d = rr(r, 0.0, 0.035);
        const ox = Math.cos(a + 1.57) * d;
        const oz = Math.sin(a + 1.57) * d;
        const len = rr(r, 0.07, 0.092);
        const ph = r() * 6;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps - 0.5;
          const wig = 0.005 * Math.sin(t * 22 + ph);
          pts.push(
            new THREE.Vector3(
              ox + Math.cos(a) * t * 2 * len + Math.cos(a + 1.57) * wig,
              0.004 * Math.sin(t * 9 + ph) + 0.0015,
              oz + Math.sin(a) * t * 2 * len + Math.sin(a + 1.57) * wig,
            ),
          );
        }
      }
      ribbon(pts, segs, 0.0064, 0.0036, out);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    g.setIndex(out.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  });
}

// ───────────────────────── 豚（チャーシュー） ─────────────────────────

/**
 * 厚切りの豚1枚。上下面は断面テクスチャ（中心ピンク灰色・縁が煮汁色）、側面は煮汁の染みた繊維。
 * ローカル: 長辺=X, 幅=Z, 厚み=Y（中心が原点）
 */
function porkGeometry(kind: 'slab' | 'roll', variant: number, detail: BowlDetail): THREE.BufferGeometry {
  return cached(`pork:${kind}:${variant}:${detail}`, () => {
    const r = makeRng(300 + variant * 17 + (kind === 'roll' ? 51 : 0));
    const N = detail === 'high' ? 16 : 8;
    const slab = kind === 'slab';
    const L = slab ? rr(r, 0.08, 0.094) : 0.074;
    const W = slab ? rr(r, 0.054, 0.064) : 0.07;
    const T = slab ? rr(r, 0.015, 0.019) : 0.018;
    const p1 = r() * 6;
    const p2 = r() * 6;
    const outline: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const k = slab
        ? 1 + 0.07 * Math.sin(a * 3 + p1) + 0.05 * Math.sin(a * 5 + p2) + rr(r, -0.03, 0.03)
        : 1 + 0.03 * Math.sin(a * 3 + p1) + rr(r, -0.015, 0.015);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // 平切りは少し角ばった形（ブロックから切り出した形）
      const ex = slab ? Math.sign(ca) * Math.pow(Math.abs(ca), 0.72) : ca;
      const ez = slab ? Math.sign(sa) * Math.pow(Math.abs(sa), 0.72) : sa;
      outline.push([ex * (L / 2) * k, ez * (W / 2) * k]);
    }
    const uvc = slab ? PORK_UV.slab : PORK_UV.roll;
    const cr = PORK_UV.crust;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const bulge = T * 0.14;
    const bend = slab ? rr(r, 2, 5) : 1;
    const push = (x: number, y: number, z: number, u: number, v: number) => {
      pos.push(x, y + bend * x * x, z);
      uv.push(u, v);
      return pos.length / 3 - 1;
    };
    const ring = (rho: number, y: number, tex: 'cap' | 'side', texRho: number, flipV: boolean, sideV: number, jitter: number) => {
      const ids: number[] = [];
      for (let i = 0; i < N; i++) {
        const [ox, oz] = outline[i]!;
        const a = (i / N) * Math.PI * 2;
        const yy = y + (jitter > 0 ? rr(r, -jitter, jitter) : 0);
        if (tex === 'cap') {
          const vv = Math.sin(a) * texRho * uvc.r;
          ids.push(push(ox * rho, yy, oz * rho, uvc.u + Math.cos(a) * texRho * uvc.r, uvc.v + (flipV ? -vv : vv)));
        } else {
          ids.push(push(ox * rho, yy, oz * rho, cr.u0 + (i / N) * (cr.u1 - cr.u0), sideV));
        }
      }
      return ids;
    };
    const capStrip = (inner: number[], outer: number[], up: boolean) => {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        if (up) idx.push(inner[i]!, outer[j]!, outer[i]!, inner[i]!, inner[j]!, outer[j]!);
        else idx.push(inner[i]!, outer[i]!, outer[j]!, inner[i]!, outer[j]!, inner[j]!);
      }
    };
    const sideStrip = (a: number[], b: number[]) => {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        idx.push(a[i]!, b[j]!, b[i]!, a[i]!, a[j]!, b[j]!);
      }
    };
    const fan = (c: number, ringIds: number[], up: boolean) => {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        if (up) idx.push(c, ringIds[j]!, ringIds[i]!);
        else idx.push(c, ringIds[i]!, ringIds[j]!);
      }
    };
    const top = T / 2;
    // 上面
    const cTop = push(0, top + bulge, 0, uvc.u, uvc.v);
    const tIn = ring(0.55, top + bulge * 0.7, 'cap', 0.55, false, 0, T * 0.06);
    const tOut = ring(0.93, top - T * 0.1, 'cap', 0.97, false, 0, 0);
    fan(cTop, tIn, true);
    capStrip(tIn, tOut, true);
    // 側面
    const sTop = ring(0.93, top - T * 0.1, 'side', 0, false, cr.v1, 0);
    const sMid = ring(1.0, 0, 'side', 0, false, (cr.v0 + cr.v1) / 2, 0);
    const sBot = ring(0.93, -top + T * 0.1, 'side', 0, false, cr.v0, 0);
    sideStrip(sTop, sMid);
    sideStrip(sMid, sBot);
    // 下面
    const bOut = ring(0.93, -top + T * 0.1, 'cap', 0.97, true, 0, 0);
    const cBot = push(0, -top, 0, uvc.u, uvc.v);
    fan(cBot, bOut, false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.userData = { L, W, T };
    return g;
  });
}

/** ニンニクの山の芯（粒の隙間を埋めるドーム）。豚と同じアトラスの右下を使う */
function garlicCoreGeometry(): THREE.BufferGeometry {
  return cached('garliccore', () => {
    const g = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    const uv = g.attributes.uv!;
    const q = PORK_UV.garlic;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, q.u0 + uv.getX(i) * (q.u1 - q.u0), q.v0 + uv.getY(i) * (q.v1 - q.v0));
    return g;
  });
}

// ───────────────────────── 高さ場（具を積み上げるため） ─────────────────────────

class HeightField {
  readonly n = 48;
  readonly min = -0.125;
  readonly cell = 0.25 / 48;
  readonly data: Float32Array;
  constructor(base: number) {
    this.data = new Float32Array(this.n * this.n).fill(base);
  }
  private ij(x: number, z: number): [number, number] {
    const i = clamp(Math.floor((x - this.min) / this.cell), 0, this.n - 1);
    const j = clamp(Math.floor((z - this.min) / this.cell), 0, this.n - 1);
    return [i, j];
  }
  get(x: number, z: number): number {
    const [i, j] = this.ij(x, z);
    return this.data[j * this.n + i]!;
  }
  stamp(x: number, z: number, y: number, rad: number): void {
    const k = Math.max(0, Math.ceil(rad / this.cell));
    const [ci, cj] = this.ij(x, z);
    for (let dj = -k; dj <= k; dj++) {
      for (let di = -k; di <= k; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= this.n || j >= this.n) continue;
        const id = j * this.n + i;
        if (this.data[id]! < y) this.data[id] = y;
      }
    }
  }
}

// ───────────────────────── 野菜の山 ─────────────────────────

interface Mound {
  cx: number;
  cz: number;
  R: number;
  H: number;
  baseY: number;
  p: number;
  ph1: number;
  ph2: number;
}

function interp(level: number, table: [number, number][]): number {
  if (level <= table[0]![0]) return table[0]![1];
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1]!;
    const b = table[i]!;
    if (level <= b[0]) return a[1] + ((b[1] - a[1]) * (level - a[0])) / (b[0] - a[0]);
  }
  return table[table.length - 1]![1];
}

function moundY(m: Mound, x: number, z: number): number {
  const dx = x - m.cx;
  const dz = z - m.cz;
  const q = (dx * dx + dz * dz) / (m.R * m.R);
  if (q >= 1) return -1;
  const a = Math.atan2(dz, dx);
  const s = Math.sqrt(q);
  const lump = 1 + s * (0.08 * Math.sin(a * 3 + m.ph1) + 0.05 * Math.sin(a * 5 + m.ph2));
  return m.baseY + m.H * Math.pow(1 - q, m.p) * lump;
}

function moundNormal(m: Mound, x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.002;
  const hx = moundY(m, x + e, z) - moundY(m, x - e, z);
  const hz = moundY(m, x, z + e) - moundY(m, x, z - e);
  return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
}

// ───────────────────────── 中身の組み立て ─────────────────────────

interface Built {
  group: THREE.Group;
  owned: Disposable[];
  steamY: number;
}

const CHILI_COLORS = ['#d24a1e', '#de6228', '#e87a36', '#c03a16', '#ec9048', '#d65420'].map((c) => new THREE.Color(c));
const SPROUT_BASE = new THREE.Color(1, 1, 1);
const SOUP_STAIN = new THREE.Color(0.8, 0.64, 0.44);
const CHILI_TINT = new THREE.Color(0.85, 0.3, 0.1);
const GARLIC_COLORS = ['#f2e4b0', '#ecd690', '#f6edcc', '#e6cf7c', '#efdc9e'].map((c) => new THREE.Color(c));
const ABURA_LIGHT = new THREE.Color('#eadcc0');
const ABURA_BROWN = new THREE.Color('#a8763e');
const CABBAGE_COLORS = ['#e2edc4', '#ecf2d6', '#d4e4aa', '#f2f4e2'].map((c) => new THREE.Color(c));

function makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, owned: Disposable[]): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  im.count = count;
  im.castShadow = false;
  im.receiveShadow = true;
  owned.push(im);
  return im;
}

/** 基底ベクトルから行列を作って書き込む（X=向き, Y=法線） */
function setBasis(im: THREE.InstancedMesh, i: number, pos: THREE.Vector3, dir: THREE.Vector3, nrm: THREE.Vector3, s: number): void {
  const x = tmp.v2.copy(dir).normalize();
  const z = tmp.v3.crossVectors(x, nrm).normalize();
  const y = tmp.v.crossVectors(z, x).normalize();
  tmp.m.makeBasis(x, y, z);
  tmp.m.scale(tmp.s.set(s, s, s));
  tmp.m.setPosition(pos);
  im.setMatrixAt(i, tmp.m);
}

function finishInstanced(im: THREE.InstancedMesh): void {
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  im.computeBoundingBox();
}

function buildContents(c: BowlContents, detail: BowlDetail, seed: number): Built {
  const group = new THREE.Group();
  const owned: Disposable[] = [];
  const r = makeRng(seed);
  const hi = detail === 'high';
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const dir = new THREE.Vector3();

  // ── スープ / タレ ──
  const soupFrac = clamp(c.soupL / 0.4, 0, 1);
  const topLimit = 0.0885;
  let liquidY = BOWL_DIMS.innerBottom;
  if (c.soupL > 0.005) {
    liquidY = BOWL_DIMS.innerBottom + 0.012 + (topLimit - BOWL_DIMS.innerBottom - 0.012) * soupFrac;
    const soup = new THREE.Mesh(discGeometry(hi ? 48 : 20), M.soup(Math.max(1, c.tare)));
    const rad = innerRadiusAt(liquidY) - 0.0004;
    soup.scale.set(rad, 1, rad);
    soup.position.y = liquidY;
    soup.receiveShadow = true;
    group.add(soup);
  } else if (c.tare > 0) {
    liquidY = BOWL_DIMS.innerBottom + 0.003 + 0.001 * c.tare;
    const t = new THREE.Mesh(discGeometry(hi ? 32 : 16), M.tare());
    const rad = innerRadiusAt(liquidY) - 0.0003;
    t.scale.set(rad, 1, rad);
    t.position.y = liquidY;
    group.add(t);
  }

  const field = new HeightField(liquidY);
  const yasai = Math.max(0, c.toppings.yasai);

  // ── 麺 ──
  let noodleTop = liquidY;
  if (c.noodleG > 0) {
    const amount: 1 | 2 = c.noodleG >= 400 ? 2 : 1;
    // スープが少ないときは麺が見える位置まで持ち上げる
    const nestTop = BOWL_DIMS.innerBottom + (amount === 2 ? 0.05 : 0.04);
    const ny = Math.max(liquidY + (amount === 2 ? 0.0015 : 0), nestTop);
    const k = (innerRadiusAt(ny) - 0.002) / 0.105;
    const rim = new THREE.Mesh(noodleGeometry('rim', amount, detail), M.noodle());
    rim.position.y = ny;
    rim.scale.set(k, 1, k);
    rim.rotation.y = r() * Math.PI * 2;
    rim.receiveShadow = true;
    group.add(rim);
    if (yasai < 1.5) {
      const nest = new THREE.Mesh(noodleGeometry('nest', amount, detail), M.noodle());
      nest.position.y = ny;
      nest.scale.set(k, 1, k);
      nest.rotation.y = r() * Math.PI * 2;
      nest.receiveShadow = true;
      group.add(nest);
    }
    noodleTop = ny + 0.003;
    field.stamp(0, 0, noodleTop, 0.09);
  }
  const baseY = Math.max(liquidY, noodleTop) - 0.004;

  // ── ヤサイの山の形（具の配置に使うので先に決める） ──
  let mound: Mound | null = null;
  if (yasai > 0) {
    const H = interp(yasai, [[0.5, 0.03], [1, 0.056], [2, 0.094], [3, 0.15]]);
    const R0 = interp(yasai, [[0.5, 0.06], [1, 0.078], [2, 0.088], [3, 0.094]]);
    const cz = interp(yasai, [[0.5, 0.03], [1, 0.026], [2, 0.018], [3, 0.012]]);
    const R = Math.min(innerRadiusAt(baseY + 0.004) - 0.006 - cz, R0);
    mound = { cx: -0.004, cz, R, H, baseY, p: interp(yasai, [[0.5, 0.95], [1, 0.82], [2, 0.7], [3, 0.58]]), ph1: r() * 6, ph2: r() * 6 };
  }
  const ichimi = Math.max(0, c.toppings.ichimi);
  // 唐辛子を集中させる位置（山の頂上から見る人の右奥へ）
  const patch = mound
    ? { x: mound.cx - 0.014, z: mound.cz + 0.004, s: 0.024 + 0.007 * Math.min(ichimi, 3) }
    : { x: -0.02, z: 0.02, s: 0.012 + 0.004 * Math.min(ichimi, 3) };
  const patchW = (x: number, z: number) => (ichimi <= 0 ? 0 : Math.exp(-((x - patch.x) ** 2 + (z - patch.z) ** 2) / (2 * patch.s * patch.s)));
  const heightAt = (x: number, z: number) => Math.max(field.get(x, z), mound ? moundY(mound, x, z) + 0.003 : -1);

  // ── 豚（山の手前に立てかける） ──
  const nButa = Math.min(8, Math.max(0, Math.round(c.buta)));
  const porkParts: THREE.BufferGeometry[] = [];
  if (nButa > 0) {
    const twoLayers = nButa > 4;
    const perLayer = twoLayers ? Math.ceil(nButa / 2) : nButa;
    const span = nButa >= 3 ? 1.75 : 1.0;
    const a0 = Math.PI - 1.3;
    const hasMound = mound !== null && mound.H > 0.025;
    for (let i = 0; i < nButa; i++) {
      const layer = twoLayers && i >= perLayer ? 1 : 0;
      const li = layer === 0 ? i : i - perLayer;
      const cnt = layer === 0 ? perLayer : nButa - perLayer;
      const t = cnt <= 1 ? 0.3 : li / (cnt - 1);
      const theta = a0 + span * t + (layer === 1 ? 0.2 : 0) + rr(r, -0.05, 0.05);
      const roll = i % 3 === 2;
      const geo = porkGeometry(roll ? 'roll' : 'slab', (i * 7 + seed) % 4, detail);
      const W = (geo.userData as { W: number }).W;
      const tilt = hasMound ? rr(r, 0.7, 0.95) - layer * 0.2 : rr(r, 0.15, 0.32);
      const rp = (hasMound ? 0.066 : 0.05) - layer * 0.02 + rr(r, -0.003, 0.003);
      const px = Math.sin(theta) * rp;
      const pz = Math.cos(theta) * rp;
      const py = baseY + 0.004 + (W / 2) * Math.sin(tilt) * 0.8 + layer * 0.016;
      tmp.e.set(-tilt, theta + Math.PI + rr(r, -0.15, 0.15), rr(r, -0.12, 0.12), 'YXZ');
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(px, py, pz), tmp.q, tmp.s.set(1, 1, 1));
      const g = geo.clone();
      g.applyMatrix4(tmp.m);
      porkParts.push(g);
      const p = g.attributes.position!;
      for (let k = 0; k < p.count; k++) field.stamp(p.getX(k), p.getZ(k), p.getY(k), 0.003);
    }
  }

  // ── ニンニク（手前右の縁寄りに山盛り） ──
  const ninniku = Math.max(0, c.toppings.ninniku);
  if (ninniku > 0) {
    const gTheta = Math.PI + (nButa >= 3 ? 0.95 : 0.75);
    const gr = 0.062;
    const gx = Math.sin(gTheta) * gr;
    const gz = Math.cos(gTheta) * gr;
    const lv = Math.min(ninniku, 3);
    const Rg = 0.016 + 0.0075 * lv;
    const Hg = 0.014 + 0.009 * lv;
    let base = heightAt(gx, gz);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      base = Math.max(base, heightAt(gx + Math.cos(a) * Rg * 0.4, gz + Math.sin(a) * Rg * 0.4) - 0.006);
    }
    base -= 0.003;
    // 芯のドーム（豚と同じマテリアルにまとめる）
    const core = garlicCoreGeometry().clone();
    core.scale(Rg * 0.84, Hg * 0.86, Rg * 0.84);
    core.translate(gx, base, gz);
    porkParts.push(core);
    const n = Math.round(interp(ninniku, [[0.5, 110], [1, 200], [2, 310], [3, 420]]) * (hi ? 1 : 0.25));
    const gm = makeInstanced(garlicGeometry(), M.garlic(), n, owned);
    for (let i = 0; i < n; i++) {
      const spill = r() < 0.08;
      const rho = (spill ? rr(r, 0.9, 1.5) : Math.pow(r(), 0.6)) * Rg;
      const a = r() * Math.PI * 2;
      const x = gx + Math.cos(a) * rho;
      const z = gz + Math.sin(a) * rho;
      const hh = spill ? 0 : Hg * Math.pow(Math.max(0, 1 - (rho / Rg) ** 2), 0.7) * rr(r, 0.82, 1.02);
      const y = spill ? heightAt(x, z) + 0.001 : base + hh + 0.0005;
      const s = rr(r, 0.0021, 0.0038);
      tmp.e.set(r() * 6, r() * 6, r() * 6);
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(x, y, z), tmp.q, tmp.s.set(s * rr(r, 0.8, 1.4), s * rr(r, 0.6, 1), s * rr(r, 0.8, 1.3)));
      gm.setMatrixAt(i, tmp.m);
      tmp.c.copy(GARLIC_COLORS[Math.floor(r() * GARLIC_COLORS.length)]!).multiplyScalar(rr(r, 0.92, 1.04));
      gm.setColorAt(i, tmp.c);
    }
    finishInstanced(gm);
    group.add(gm);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      for (const f of [0, 0.5, 0.9]) {
        const rho = f * Rg;
        field.stamp(gx + Math.cos(a) * rho, gz + Math.sin(a) * rho, base + Hg * Math.pow(1 - f * f, 0.7), 0.002);
      }
    }
  }

  if (porkParts.length > 0) {
    const merged = mergeGeometries(porkParts, false);
    if (merged) {
      merged.computeBoundingSphere();
      const pm = new THREE.Mesh(merged, M.pork());
      pm.castShadow = true;
      pm.receiveShadow = true;
      owned.push(merged);
      group.add(pm);
    }
  }

  // ── ヤサイ（もやし・キャベツ） ──
  if (mound) {
    group.add(buildDome(mound, hi, patchW, owned));
    const nSprout = Math.round(interp(yasai, [[0.5, 90], [1, 190], [2, 260], [3, 310]]) * (hi ? 1 : 0.16));
    const drape = 0;
    const sp = makeInstanced(sproutGeometry(detail), M.sprout(), nSprout + drape, owned);
    let used = 0;
    for (let i = 0; i < nSprout; i++) {
      const rad = mound.R * Math.sqrt(r()) * 0.98;
      const a = r() * Math.PI * 2;
      const x = mound.cx + Math.cos(a) * rad;
      const z = mound.cz + Math.sin(a) * rad;
      const y = moundY(mound, x, z);
      // 豚やニンニクの下に隠れるものは省く
      if (field.get(x, z) > y + 0.006) continue;
      moundNormal(mound, x, z, nrm);
      // 接平面内の向き: 山を巻くような横向きを優先しつつランダムに
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      dir.set(-sa + rr(r, -1.1, 1.1), rr(r, -0.25, 0.25), ca + rr(r, -1.1, 1.1));
      if (r() < 0.5) dir.negate();
      dir.addScaledVector(nrm, -dir.dot(nrm)).normalize();
      dir.addScaledVector(nrm, r() < 0.12 ? rr(r, 0.1, 0.35) : rr(r, -0.12, 0.08)).normalize();
      // 軸周りのねじれ（曲がる向き）をランダムに
      const roll = rr(r, -1.2, 1.2);
      nn.copy(nrm).multiplyScalar(Math.cos(roll)).add(v1.crossVectors(dir, nrm).multiplyScalar(Math.sin(roll)));
      v2.set(x, y, z).addScaledVector(nrm, 0.0014 + r() * r() * 0.006);
      setBasis(sp, used, v2, dir, nn, rr(r, 0.85, 1.15));
      const h01 = (y - mound.baseY) / mound.H;
      tmp.c.copy(SPROUT_BASE).multiplyScalar(rr(r, 0.92, 1.03));
      if (h01 < 0.28) tmp.c.lerp(SOUP_STAIN, (0.28 - h01) * 2.4 * rr(r, 0.4, 1));
      else if (r() < 0.12) tmp.c.lerp(SOUP_STAIN, rr(r, 0.2, 0.5));
      const w = patchW(x, z);
      if (w > 0.04 && r() < 0.55 + 0.4 * w) tmp.c.lerp(CHILI_TINT, Math.min(0.85, w * rr(r, 0.7, 1.3)));
      sp.setColorAt(used, tmp.c);
      used++;
    }
    // 縁にかかるもやし（縁に沿って垂れる）
    for (let i = 0; i < drape; i++) {
      const a = rr(r, 0, Math.PI * 2);
      const out = v1.set(Math.cos(a), 0, Math.sin(a));
      dir.set(-out.z, 0, out.x).multiplyScalar(r() < 0.5 ? 1 : -1).addScaledVector(out, rr(r, 0.05, 0.2));
      dir.y -= rr(r, 0.02, 0.12);
      dir.normalize();
      v2.set(Math.cos(a) * 0.1135, RIM_TOP + 0.0015, Math.sin(a) * 0.1135);
      setBasis(sp, used, v2, dir, tmp.up, rr(r, 0.85, 1.0));
      tmp.c.copy(SPROUT_BASE).multiplyScalar(rr(r, 0.9, 1));
      sp.setColorAt(used, tmp.c);
      used++;
    }
    sp.count = used;
    finishInstanced(sp);
    group.add(sp);
    // キャベツ
    const nCab = Math.round(yasai * (hi ? 4 : 1.5));
    if (nCab > 0) {
      const cb = makeInstanced(cabbageGeometry(), M.cabbage(), nCab, owned);
      let cu = 0;
      for (let i = 0; i < nCab; i++) {
        const rad = mound.R * Math.sqrt(rr(r, 0.05, 0.85));
        const a = r() * Math.PI * 2;
        const x = mound.cx + Math.cos(a) * rad;
        const z = mound.cz + Math.sin(a) * rad;
        const y = moundY(mound, x, z);
        if (field.get(x, z) > y + 0.004) continue;
        moundNormal(mound, x, z, nrm);
        dir.set(rr(r, -1, 1), 0, rr(r, -1, 1));
        dir.addScaledVector(nrm, -dir.dot(nrm)).normalize();
        v2.set(x, y + 0.002, z);
        setBasis(cb, cu, v2, dir, nrm, rr(r, 0.7, 1.15));
        tmp.c.copy(CABBAGE_COLORS[i % CABBAGE_COLORS.length]!);
        cb.setColorAt(cu, tmp.c);
        cu++;
      }
      cb.count = cu;
      finishInstanced(cb);
      group.add(cb);
    }
    // 山の表面を高さ場へ
    for (let k = 0; k < 200; k++) {
      const a = r() * Math.PI * 2;
      const rad = mound.R * Math.sqrt(r());
      const x = mound.cx + Math.cos(a) * rad;
      const z = mound.cz + Math.sin(a) * rad;
      field.stamp(x, z, moundY(mound, x, z) + 0.004, 0.003);
    }
  }

  // ── 唐辛子の粉の層（背脂より先に敷き、背脂はその上に乗せる） ──
  if (ichimi > 0 && mound) group.add(buildPowder(heightAt, patch.x, patch.z, patch.s * 1.9, hi ? 20 : 8, owned));

  // ── アブラ（背脂）: 山の頂上に盛る ──
  const abura = Math.max(0, c.toppings.abura);
  if (abura > 0) {
    const cx = mound ? mound.cx + 0.012 : 0.012;
    const cz = mound ? mound.cz - 0.02 : -0.004;
    const lv = Math.min(abura, 3);
    const Ra = 0.016 + 0.007 * lv;
    const nBig = Math.round(interp(abura, [[1, 7], [2, 13], [3, 20]]) * (hi ? 1 : 0.5));
    const nSmall = Math.round(interp(abura, [[1, 55], [2, 100], [3, 140]]) * (hi ? 1 : 0.25));
    const big = makeInstanced(lumpGeometry(1, 7, 0.62), M.abura(), nBig, owned);
    const small = makeInstanced(lumpGeometry(0, 8, 0.85), M.abura(), nSmall, owned);
    // 盛る前の表面の高さ（ここから少しだけ積み上げる。高さ場に書き戻すと塔になるので戻さない）
    const baseH = (x: number, z: number) => heightAt(x, z);
    const pile = 0.004 + 0.003 * lv;
    const stamps: [number, number, number, number][] = [];
    const place = (im: THREE.InstancedMesh, i: number, sMin: number, sMax: number, brown: [number, number]) => {
      const rho = Math.sqrt(r()) * Ra;
      const a = r() * Math.PI * 2;
      const x = cx + Math.cos(a) * rho;
      const z = cz + Math.sin(a) * rho;
      const s = rr(r, sMin, sMax);
      const y = baseH(x, z) + 0.0035 + s * 0.25 + pile * (1 - (rho / Ra) ** 2) * r();
      tmp.e.set(rr(r, -0.6, 0.6), r() * 6, rr(r, -0.6, 0.6));
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(x, y, z), tmp.q, tmp.s.set(s * rr(r, 0.85, 1.25), s * rr(r, 0.7, 1.0), s * rr(r, 0.85, 1.25)));
      im.setMatrixAt(i, tmp.m);
      tmp.c.copy(ABURA_LIGHT).lerp(ABURA_BROWN, rr(r, brown[0], brown[1]));
      im.setColorAt(i, tmp.c);
      stamps.push([x, z, y + s * 0.6, s * 0.7]);
    };
    for (let i = 0; i < nBig; i++) place(big, i, 0.005, 0.009, [0.15, 0.7]);
    for (let i = 0; i < nSmall; i++) place(small, i, 0.0022, 0.0042, [0.3, 0.95]);
    for (const [x, z, y, rad] of stamps) field.stamp(x, z, y, rad);
    finishInstanced(big);
    finishInstanced(small);
    group.add(big, small);
  }

  // ── 唐辛子（一味）: 粉の層＋粒 ──
  if (ichimi > 0) {
    const lv = Math.min(ichimi, 3);
    const rimA = Math.atan2(patch.z, patch.x) + 0.25;
    group.add(buildRimPowder(rimA, 0.7 + 0.35 * lv, hi ? 24 : 10, owned));
    const n = Math.round(interp(ichimi, [[0.5, 300], [1, 520], [2, 900], [3, 1250]]) * (hi ? 1 : 0.3));
    const cm = makeInstanced(chiliGeometry(), M.chili(), n, owned);
    for (let i = 0; i < n; i++) {
      const b = r();
      let x: number;
      let z: number;
      let y: number;
      if (b < 0.6) {
        x = patch.x + rnorm(r) * patch.s * 1.15;
        z = patch.z + rnorm(r) * patch.s * 1.15;
        const d = Math.hypot(x, z);
        if (d > 0.106) {
          x *= 0.106 / d;
          z *= 0.106 / d;
        }
        y = heightAt(x, z) + (mound && moundY(mound, x, z) > 0 ? 0.0035 + r() * 0.003 : 0.0012);
      } else if (b < 0.8) {
        const a = rimA + rnorm(r) * 0.9;
        const rad = rr(r, 0.1148, 0.1196);
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
        y = RIM_TOP - 40 * (rad - 0.1172) ** 2 + 0.0004;
      } else {
        const a = r() * Math.PI * 2;
        const rad = Math.sqrt(r()) * 0.105;
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
        y = heightAt(x, z) + 0.0016;
      }
      const s = rr(r, 0.0013, 0.0028);
      tmp.e.set(rr(r, -0.35, 0.35), r() * 6, rr(r, -0.35, 0.35));
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(x, y, z), tmp.q, tmp.s.set(s, s, s));
      cm.setMatrixAt(i, tmp.m);
      tmp.c.copy(CHILI_COLORS[Math.floor(r() * CHILI_COLORS.length)]!).multiplyScalar(rr(r, 0.85, 1.08));
      cm.setColorAt(i, tmp.c);
    }
    finishInstanced(cm);
    group.add(cm);
  }

  const steamY = Math.max(RIM_TOP, mound ? mound.baseY + mound.H * 0.6 : liquidY);
  return { group, owned, steamY };
}

/** 唐辛子の粉の層: 具の表面（高さ場）に沿わせた格子にアルファテストのテクスチャを貼る */
function buildPowder(heightAt: (x: number, z: number) => number, cx: number, cz: number, half: number, n: number, owned: Disposable[]): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const v = j / n;
      let x = cx + (u - 0.5) * 2 * half;
      let z = cz + (v - 0.5) * 2 * half;
      const d = Math.hypot(x, z);
      if (d > 0.108) {
        x *= 0.108 / d;
        z *= 0.108 / d;
      }
      // 周囲の最大値をとって、もやしの上に乗るように。急斜面は粉が積もらないので表面の下へ沈める
      const y0 = heightAt(x, z);
      const hx1 = heightAt(x + 0.003, z);
      const hx0 = heightAt(x - 0.003, z);
      const hz1 = heightAt(x, z + 0.003);
      const hz0 = heightAt(x, z - 0.003);
      const y = Math.max(y0, hx1, hx0, hz1, hz0);
      const slope = Math.hypot(hx1 - hx0, hz1 - hz0) / 0.006;
      pos.push(x, y + 0.0022 - Math.max(0, slope - 1.4) * 0.01, z);
      uv.push(u, v);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  owned.push(g);
  const m = new THREE.Mesh(g, M.powder());
  m.receiveShadow = true;
  return m;
}

/** 丼の縁にかかった唐辛子 */
function buildRimPowder(a0: number, span: number, seg: number, owned: Disposable[]): THREE.Mesh {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const radii = [0.1132, 0.1152, 0.1172, 0.1192, 0.1206];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const a = a0 + (t - 0.5) * span;
    radii.forEach((rad, k) => {
      const y = RIM_TOP - 40 * (rad - 0.1172) ** 2 - (k === 0 ? 0.0012 : 0) + 0.0005;
      pos.push(Math.cos(a) * rad, y, Math.sin(a) * rad);
      // 縁の帯にテクスチャの中央の横帯を貼る（両端はまばら）
      uv.push(t, 0.4 + (k / (radii.length - 1)) * 0.2);
    });
  }
  const nr = radii.length;
  for (let i = 0; i < seg; i++) {
    for (let k = 0; k < nr - 1; k++) {
      const a = i * nr + k;
      const b = a + 1;
      const c = a + nr;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  owned.push(g);
  return new THREE.Mesh(g, M.powder());
}

/** もやしの山の芯（テクスチャ付きのドーム）。表面のもやしの隙間を埋める */
function buildDome(m: Mound, hi: boolean, patchW: (x: number, z: number) => number, owned: Disposable[]): THREE.Mesh {
  const rings = hi ? 9 : 5;
  const sectors = hi ? 28 : 14;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const pale = new THREE.Color(1.0, 0.99, 0.93);
  const c = new THREE.Color();
  const add = (x: number, y: number, z: number) => {
    pos.push(x, y, z);
    uv.push(x / 0.07, z / 0.07);
    const h01 = (y - m.baseY) / Math.max(0.01, m.H);
    c.copy(pale);
    if (h01 < 0.3) c.lerp(SOUP_STAIN, (0.3 - h01) * 2);
    const w = patchW(x, z);
    if (w > 0) c.lerp(CHILI_TINT, Math.min(0.92, w * 1.1));
    col.push(c.r, c.g, c.b);
  };
  add(m.cx, moundY(m, m.cx, m.cz) - 0.002, m.cz);
  for (let i = 1; i <= rings; i++) {
    const f = i / rings;
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      const rad = m.R * (i === rings ? 1.02 : f);
      const x = m.cx + Math.cos(a) * rad;
      const z = m.cz + Math.sin(a) * rad;
      const y = i === rings ? m.baseY - 0.004 : moundY(m, x, z) - 0.002;
      add(x, y, z);
    }
  }
  for (let j = 0; j < sectors; j++) {
    const jn = (j + 1) % sectors;
    idx.push(0, 1 + jn, 1 + j);
  }
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * sectors;
    const b0 = 1 + i * sectors;
    for (let j = 0; j < sectors; j++) {
      const jn = (j + 1) % sectors;
      idx.push(a0 + j, b0 + jn, b0 + j, a0 + j, a0 + jn, b0 + jn);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  owned.push(g);
  const mesh = new THREE.Mesh(g, M.dome());
  mesh.receiveShadow = true;
  return mesh;
}

/** 食べ終えた丼の残り（底のスープ・もやしの切れ端） */
function buildDirty(detail: BowlDetail): Built {
  const group = new THREE.Group();
  const owned: Disposable[] = [];
  const stain = new THREE.Mesh(stainGeometry(), M.stain());
  stain.renderOrder = 1;
  group.add(stain);
  const y = BOWL_DIMS.innerBottom + 0.007;
  const pool = new THREE.Mesh(discGeometry(detail === 'high' ? 32 : 14), M.dirtyPool());
  const rad = innerRadiusAt(y) * 0.99;
  pool.scale.set(rad, 1, rad);
  pool.position.y = y;
  group.add(pool);
  const r = makeRng(77);
  const n = detail === 'high' ? 7 : 3;
  const sp = makeInstanced(sproutGeometry(detail), M.sprout(), n, owned);
  const p = new THREE.Vector3();
  const d = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const dd = rr(r, 0.01, 0.045);
    p.set(Math.cos(a) * dd, y + 0.0012, Math.sin(a) * dd);
    d.set(rr(r, -1, 1), 0, rr(r, -1, 1)).normalize();
    setBasis(sp, i, p, d, tmp.up, rr(r, 0.4, 0.7));
    sp.setColorAt(i, tmp.c.set(0.85, 0.74, 0.58));
  }
  finishInstanced(sp);
  group.add(sp);
  return { group, owned, steamY: 0 };
}

// ───────────────────────── 公開 API ─────────────────────────

let bowlSeq = 0;

function signature(c: BowlContents | null, dirty: boolean, detail: BowlDetail): string {
  if (dirty) return 'dirty:' + detail;
  if (!c) return 'empty';
  const q = (v: number) => Math.round(v * 2) / 2;
  return [
    detail,
    Math.round(c.tare),
    Math.round(c.soupL * 40),
    c.noodleG > 0 ? (c.noodleG >= 400 ? 2 : 1) : 0,
    q(c.toppings.yasai),
    q(c.toppings.ninniku),
    q(c.toppings.abura),
    q(c.toppings.ichimi),
    Math.min(8, Math.round(c.buta)),
  ].join(',');
}

export function createBowl(): BowlModel {
  const seed = 1000 + bowlSeq++ * 7919;
  const group = new THREE.Group();
  group.name = 'bowl';
  let detail: BowlDetail = 'high';
  const body = new THREE.Mesh(bowlGeometry(detail), MAT.ceramic());
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);
  const steam = createSteam({ count: 6, radius: 0.05, rise: 0.28, size: 0.11, speed: 0.3, spread: 0.015, opacity: 0.32, seed: (seed % 13) + 3 });
  steam.visible = false;
  group.add(steam);

  let current: Built | null = null;
  let sig = 'empty';
  let lastContents: BowlContents | null = null;
  let lastDirty = false;

  const clear = () => {
    if (!current) return;
    group.remove(current.group);
    for (const o of current.owned) o.dispose();
    current = null;
  };

  const rebuild = () => {
    clear();
    if (lastDirty) current = buildDirty(detail);
    else if (lastContents) current = buildContents(lastContents, detail, seed);
    if (current) group.add(current.group);
  };

  const model: BowlModel = {
    group,
    setContents(c, opts) {
      const dirty = opts?.dirty ?? false;
      lastContents = c;
      lastDirty = dirty;
      const s = signature(c, dirty, detail);
      if (s !== sig) {
        sig = s;
        rebuild();
      }
      const hot = !dirty && c !== null && c.heat > 70 && (c.soupL > 0.01 || c.noodleG > 0);
      steam.visible = hot;
      if (hot && current) steam.position.y = current.steamY;
    },
    setDetail(level) {
      if (level === detail) return;
      detail = level;
      body.geometry = bowlGeometry(detail);
      const s = signature(lastContents, lastDirty, detail);
      if (s !== sig) {
        sig = s;
        rebuild();
      }
    },
    tick() {
      // 湯気は共有の時間 uniform（tickModels）で動くため、個別の処理は不要
    },
    dispose() {
      clear();
      group.removeFromParent();
    },
  };
  return model;
}

/** 重ねた丼などに使う、具のない器だけのジオメトリ（共有） */
export function bowlShellGeometry(detail: BowlDetail = 'low'): THREE.BufferGeometry {
  return bowlGeometry(detail);
}

export function bowlStainMaterial(): THREE.Material {
  return M.stain();
}

export function bowlStainGeometry(): THREE.BufferGeometry {
  return stainGeometry();
}

/** 洗い場などで重ねる汚れ丼の底のスープ */
export function bowlDirtyPool(): { geo: THREE.BufferGeometry; mat: THREE.Material; y: number; r: number } {
  const y = BOWL_DIMS.innerBottom + 0.007;
  return { geo: discGeometry(14), mat: M.dirtyPool(), y, r: innerRadiusAt(y) * 0.99 };
}

export type { Rng };
