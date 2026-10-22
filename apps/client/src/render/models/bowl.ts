// 丼（次郎系ラーメン）のモデル。
// 原点=丼の底の中心。外径 0.24m・高さ約 0.096m。
// 見る人（客・盛り付け担当）は -z 側から見る想定で、手前(-z)左寄りに豚、手前右にニンニク、奥に野菜の山を置く。
// もやし・ニンニク・背脂・唐辛子は InstancedMesh で描き、draw call と三角形数を抑える。

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { BowlContents } from '@jiro/core';
import { cached, clamp, makeRng, rnorm, rr, tmp, type Disposable, type Rng } from './common';
import { MAT } from './materials';
import { PORK_UV, texBowlStain, texEnv, texPork, texSoup, texSprouts } from './textures';
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
    const tint = ['#ffffff', '#d6bea8', '#b39276'][lv - 1]!;
    return cached('m:soup' + lv, () => new THREE.MeshStandardMaterial({ map: texSoup(), color: tint, roughness: 0.12, metalness: 0, envMap: texEnv(), envMapIntensity: 0.55 }));
  },
  tare: () => cached('m:tare', () => new THREE.MeshStandardMaterial({ color: '#3c200e', roughness: 0.08, metalness: 0, envMap: texEnv(), envMapIntensity: 0.6 })),
  dirtyPool: () =>
    cached('m:dirtypool', () => new THREE.MeshStandardMaterial({ map: texSoup(), color: '#b89878', roughness: 0.1, transparent: true, opacity: 0.92 })),
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
  noodle: () => cached('m:noodle', () => new THREE.MeshStandardMaterial({ color: '#dcc187', roughness: 0.42, metalness: 0 })),
  dome: () =>
    cached('m:dome', () => new THREE.MeshStandardMaterial({ map: texSprouts(), vertexColors: true, roughness: 0.5, metalness: 0 })),
  sprout: () =>
    cached('m:sprout', () =>
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0, emissive: '#2a2618', emissiveIntensity: 0.6 }),
    ),
  cabbage: () =>
    cached('m:cabbage', () => new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0, side: THREE.DoubleSide, emissive: '#1a2410', emissiveIntensity: 0.4 })),
  pork: () => cached('m:pork', () => new THREE.MeshStandardMaterial({ map: texPork(), roughness: 0.46, metalness: 0, envMap: texEnv(), envMapIntensity: 0.3 })),
  garlic: () =>
    cached('m:garlic', () => new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0, emissive: '#3a3218', emissiveIntensity: 0.35 })),
  abura: () =>
    cached('m:abura', () => new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0, emissive: '#3c2814', emissiveIntensity: 0.4 })),
  chili: () => cached('m:chili', () => new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, side: THREE.DoubleSide })),
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

/** もやし1本: 長さ約6cmの曲がった細い棒。片方の端（豆）は黄色っぽく太い */
function sproutGeometry(detail: BowlDetail): THREE.BufferGeometry {
  return cached('sprout:' + detail, () => {
    const segs = detail === 'high' ? 4 : 3;
    const rad = 3;
    const L = 0.06;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = (t - 0.5) * L;
      const yb = 0.0045 * (1 - (2 * t - 1) ** 2);
      const zb = 0.002 * Math.sin(t * Math.PI * 2);
      const r = t > 0.9 ? 0.0019 : t < 0.1 ? 0.0008 : 0.00135;
      for (let k = 0; k < rad; k++) {
        const a = (k / rad) * Math.PI * 2;
        pos.push(x, yb + Math.cos(a) * r, zb + Math.sin(a) * r);
        if (t > 0.9) col.push(0.93, 0.85, 0.52);
        else if (t < 0.1) col.push(0.86, 0.82, 0.72);
        else col.push(0.97, 0.96, 0.9);
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
    const g = new THREE.PlaneGeometry(0.034, 0.026, 2, 2);
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      p.setY(i, (x * x + z * z) * 9 + Math.sin(x * 300) * 0.0015);
    }
    g.computeVertexNormals();
    return g;
  });
}

/** 刻みニンニクの粒（角ばった八面体） */
function garlicGeometry(): THREE.BufferGeometry {
  return cached('garlic', () => new THREE.OctahedronGeometry(1, 0));
}

/** 背脂の塊（角の丸い不定形） */
function aburaGeometry(big: boolean): THREE.BufferGeometry {
  return cached('abura:' + big, () => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, big ? 1 : 0);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position!;
    const r = makeRng(big ? 7 : 8);
    for (let i = 0; i < p.count; i++) {
      tmp.v.set(p.getX(i), p.getY(i), p.getZ(i));
      // 角の丸い立方体寄りに
      const sx = Math.sign(tmp.v.x) * Math.pow(Math.abs(tmp.v.x), 0.65);
      const sy = Math.sign(tmp.v.y) * Math.pow(Math.abs(tmp.v.y), 0.65);
      const sz = Math.sign(tmp.v.z) * Math.pow(Math.abs(tmp.v.z), 0.65);
      const k = rr(r, 0.85, 1.12);
      p.setXYZ(i, sx * k, sy * k * 0.8, sz * k);
    }
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

/** 麺: 縁に沿って波打つ極太麺（rim）と、中央に絡む麺（nest）。半径 0.112 基準・y=0 がスープ面 */
function noodleGeometry(kind: 'rim' | 'nest', amount: 1 | 2, detail: BowlDetail): THREE.BufferGeometry {
  return cached(`noodle:${kind}:${amount}:${detail}`, () => {
    const r = makeRng((kind === 'rim' ? 101 : 211) + amount * 13 + (detail === 'high' ? 0 : 7));
    const n = kind === 'rim' ? (detail === 'high' ? (amount === 2 ? 22 : 15) : amount === 2 ? 8 : 6) : detail === 'high' ? (amount === 2 ? 14 : 10) : 5;
    const tubSeg = detail === 'high' ? 16 : 6;
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const pts: THREE.Vector3[] = [];
      const steps = 9;
      if (kind === 'rim') {
        const a0 = r() * Math.PI * 2;
        const span = rr(r, 0.7, 1.7) * (r() < 0.5 ? 1 : -1);
        const rad0 = rr(r, 0.078, 0.104);
        const ph = r() * 6;
        const k = rr(r, 5, 8);
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const a = a0 + span * t;
          const rad = Math.min(0.106, rad0 + 0.005 * Math.sin(t * k + ph) + rr(r, -0.002, 0.002));
          const y = 0.0055 * Math.sin(t * Math.PI * rr(r, 1.5, 2.5) + ph) - 0.0015 + rr(r, -0.001, 0.001);
          pts.push(new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad));
        }
      } else {
        const a = r() * Math.PI * 2;
        const d = rr(r, 0.0, 0.03);
        const ox = Math.cos(a + 1.57) * d;
        const oz = Math.sin(a + 1.57) * d;
        const len = rr(r, 0.07, 0.095);
        const ph = r() * 6;
        for (let s = 0; s <= steps; s++) {
          const t = s / steps - 0.5;
          const wig = 0.006 * Math.sin(t * 14 + ph);
          pts.push(
            new THREE.Vector3(
              ox + Math.cos(a) * t * 2 * len + Math.cos(a + 1.57) * wig,
              0.004 * Math.sin(t * 9 + ph) + 0.001,
              oz + Math.sin(a) * t * 2 * len + Math.sin(a + 1.57) * wig,
            ),
          );
        }
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const tube = new THREE.TubeGeometry(curve, tubSeg, 0.0026, 4, false);
      tube.deleteAttribute('uv');
      parts.push(tube);
    }
    const g = mergeGeometries(parts, false)!;
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
    const L = slab ? rr(r, 0.074, 0.088) : 0.07;
    const W = slab ? rr(r, 0.05, 0.06) : 0.066;
    const T = slab ? rr(r, 0.012, 0.016) : 0.016;
    const p1 = r() * 6;
    const p2 = r() * 6;
    const outline: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const k = slab ? 1 + 0.07 * Math.sin(a * 3 + p1) + 0.05 * Math.sin(a * 5 + p2) + rr(r, -0.03, 0.03) : 1 + 0.03 * Math.sin(a * 3 + p1) + rr(r, -0.015, 0.015);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // 平切りは少し角ばった形（ブロックから切り出した形）
      const ex = slab ? Math.sign(ca) * Math.pow(Math.abs(ca), 0.75) : ca;
      const ez = slab ? Math.sign(sa) * Math.pow(Math.abs(sa), 0.75) : sa;
      outline.push([ex * (L / 2) * k, ez * (W / 2) * k]);
    }
    const uvc = slab ? PORK_UV.slab : PORK_UV.roll;
    const cr = PORK_UV.crust;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const bulge = T * 0.12;
    const bend = slab ? rr(r, 1.5, 4) : 1;
    const yOf = (x: number, y: number) => y + bend * x * x;
    const push = (x: number, y: number, z: number, u: number, v: number) => {
      pos.push(x, yOf(x, y), z);
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

/** ニンニクの山の芯（粒の隙間を埋める円錐）。豚と同じアトラスの右下を使う */
function garlicConeGeometry(): THREE.BufferGeometry {
  return cached('garliccone', () => {
    const g = new THREE.ConeGeometry(1, 1, 10, 1, true);
    g.translate(0, 0.5, 0);
    const uv = g.attributes.uv!;
    const q = PORK_UV.garlic;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, q.u0 + uv.getX(i) * (q.u1 - q.u0), q.v0 + uv.getY(i) * (q.v1 - q.v0));
    g.deleteAttribute('normal');
    g.computeVertexNormals();
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
  const lump = 1 + s * (0.09 * Math.sin(a * 3 + m.ph1) + 0.05 * Math.sin(a * 5 + m.ph2));
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

const CHILI_COLORS = ['#c83818', '#d9501e', '#e26a2a', '#b52812', '#e8843a', '#cf4a1a'].map((c) => new THREE.Color(c));
const SPROUT_BASE = new THREE.Color(1, 1, 1);
const SOUP_STAIN = new THREE.Color(0.78, 0.62, 0.42);
const CHILI_TINT = new THREE.Color(0.86, 0.32, 0.12);
const GARLIC_COLORS = ['#f4e7b8', '#efdc9a', '#f8f0d4', '#e9d48a', '#f2e2a8'].map((c) => new THREE.Color(c));
const ABURA_LIGHT = new THREE.Color('#f0e4c8');
const ABURA_BROWN = new THREE.Color('#a9773f');
const CABBAGE_COLORS = ['#cfe2a2', '#dfeab8', '#bcd68a', '#e8eed0'].map((c) => new THREE.Color(c));

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
  if (c.noodleG > 0) {
    const amount: 1 | 2 = c.noodleG >= 400 ? 2 : 1;
    // スープが少ないときは麺が見える位置まで持ち上げる
    const nestTop = BOWL_DIMS.innerBottom + (amount === 2 ? 0.05 : 0.04);
    const ny = Math.max(liquidY + (amount === 2 ? 0.0015 : 0), nestTop);
    const k = (innerRadiusAt(ny) - 0.002) / 0.108;
    const rim = new THREE.Mesh(noodleGeometry('rim', amount, detail), M.noodle());
    rim.position.y = ny;
    rim.scale.set(k, 1, k);
    rim.receiveShadow = true;
    group.add(rim);
    if (yasai < 1.5) {
      const nest = new THREE.Mesh(noodleGeometry('nest', amount, detail), M.noodle());
      nest.position.y = ny;
      nest.scale.set(k, 1, k);
      nest.rotation.y = r() * Math.PI * 2;
      group.add(nest);
    }
    field.stamp(0, 0, ny + 0.003, 0.09);
  }

  const baseY = Math.max(liquidY, field.get(0, 0)) - 0.004;

  // ── ヤサイ（もやし・キャベツの山） ──
  let mound: Mound | null = null;
  const ichimi = Math.max(0, c.toppings.ichimi);
  // 唐辛子を集中させる位置（山の頂上付近、見る人から見て右奥）
  const patch = { x: -0.012, z: 0.012, s: 0.03 + 0.008 * ichimi };
  const patchW = (x: number, z: number) => (ichimi <= 0 ? 0 : Math.exp(-((x - patch.x) ** 2 + (z - patch.z) ** 2) / (2 * patch.s * patch.s)));
  if (yasai > 0) {
    const H = interp(yasai, [[0.5, 0.032], [1, 0.058], [2, 0.098], [3, 0.158]]);
    const R = Math.min(innerRadiusAt(baseY + 0.004) - 0.01, interp(yasai, [[0.5, 0.066], [1, 0.084], [2, 0.094], [3, 0.1]]));
    mound = { cx: -0.004, cz: 0.014, R, H, baseY, p: interp(yasai, [[0.5, 0.95], [1, 0.85], [2, 0.72], [3, 0.6]]), ph1: r() * 6, ph2: r() * 6 };
    patch.x = mound.cx - 0.012;
    patch.z = mound.cz + 0.006;
    group.add(buildDome(mound, hi, patchW, owned));
    // もやし（表面）
    const nSprout = Math.round(interp(yasai, [[0.5, 90], [1, 190], [2, 270], [3, 300]]) * (hi ? 1 : 0.16));
    const drape = yasai >= 2 ? Math.round(nSprout * 0.06) : 0;
    const sp = makeInstanced(sproutGeometry(detail), M.sprout(), nSprout + drape, owned);
    for (let i = 0; i < nSprout; i++) {
      const rad = mound.R * Math.sqrt(r()) * 0.97;
      const a = r() * Math.PI * 2;
      const x = mound.cx + Math.cos(a) * rad;
      const z = mound.cz + Math.sin(a) * rad;
      const y = moundY(mound, x, z);
      moundNormal(mound, x, z, nrm);
      // 接平面内のランダムな向き。一部は先を持ち上げる
      v1.set(rr(r, -1, 1), 0, rr(r, -1, 1));
      v1.addScaledVector(nrm, -v1.dot(nrm)).normalize();
      v1.addScaledVector(nrm, r() < 0.25 ? rr(r, 0.2, 0.7) : rr(r, -0.1, 0.15)).normalize();
      v2.set(x, y + 0.0012, z).addScaledVector(nrm, 0.0012);
      // 自分の軸周りのランダムな回転は法線を少し傾けて表現
      nn.set(rr(r, -0.4, 0.4), 0, rr(r, -0.4, 0.4)).add(nrm).normalize();
      setBasis(sp, i, v2, v1, nn, rr(r, 0.8, 1.15));
      const h01 = (y - mound.baseY) / mound.H;
      tmp.c.copy(SPROUT_BASE).multiplyScalar(rr(r, 0.9, 1.04));
      if (h01 < 0.3) tmp.c.lerp(SOUP_STAIN, (0.3 - h01) * 2.2 * rr(r, 0.4, 1));
      const w = patchW(x, z);
      if (w > 0.05 && r() < 0.35 + 0.5 * w) tmp.c.lerp(CHILI_TINT, Math.min(0.85, w * rr(r, 0.4, 1.1)));
      sp.setColorAt(i, tmp.c);
    }
    // 縁から垂れるもやし
    for (let i = 0; i < drape; i++) {
      const a = rr(r, 0, Math.PI * 2);
      const out = v1.set(Math.cos(a), 0, Math.sin(a));
      const tang = tmp.v3.set(-out.z, 0, out.x);
      dir.copy(out).multiplyScalar(0.8).addScaledVector(tang, rr(r, -0.6, 0.6));
      dir.y -= rr(r, 0.15, 0.45);
      dir.normalize();
      v2.set(Math.cos(a) * 0.112, RIM_TOP + 0.003, Math.sin(a) * 0.112);
      setBasis(sp, nSprout + i, v2, dir, tmp.up, rr(r, 0.9, 1.1));
      tmp.c.copy(SPROUT_BASE).multiplyScalar(rr(r, 0.88, 1));
      sp.setColorAt(nSprout + i, tmp.c);
    }
    finishInstanced(sp);
    group.add(sp);
    // キャベツ
    const nCab = Math.round(yasai * (hi ? 6 : 2));
    if (nCab > 0) {
      const cb = makeInstanced(cabbageGeometry(), M.cabbage(), nCab, owned);
      for (let i = 0; i < nCab; i++) {
        const rad = mound.R * Math.sqrt(rr(r, 0.05, 0.85));
        const a = r() * Math.PI * 2;
        const x = mound.cx + Math.cos(a) * rad;
        const z = mound.cz + Math.sin(a) * rad;
        moundNormal(mound, x, z, nrm);
        v1.set(rr(r, -1, 1), 0, rr(r, -1, 1));
        v1.addScaledVector(nrm, -v1.dot(nrm)).normalize();
        v2.set(x, moundY(mound, x, z) + 0.001, z);
        setBasis(cb, i, v2, v1, nrm, rr(r, 0.7, 1.15));
        tmp.c.copy(CABBAGE_COLORS[i % CABBAGE_COLORS.length]!);
        cb.setColorAt(i, tmp.c);
      }
      finishInstanced(cb);
      group.add(cb);
    }
  }
  const heightAt = (x: number, z: number) => Math.max(field.get(x, z), mound ? moundY(mound, x, z) + 0.002 : -1);

  // ── 豚 ──
  const nButa = Math.min(8, Math.max(0, Math.round(c.buta)));
  const porkParts: THREE.BufferGeometry[] = [];
  if (nButa > 0) {
    const twoLayers = nButa > 4;
    const perLayer = twoLayers ? Math.ceil(nButa / 2) : nButa;
    const a0 = Math.PI - 1.25;
    const a1 = Math.PI + (nButa >= 3 ? 0.35 : 0.0);
    for (let i = 0; i < nButa; i++) {
      const layer = twoLayers && i >= perLayer ? 1 : 0;
      const li = layer === 0 ? i : i - perLayer;
      const cnt = layer === 0 ? perLayer : nButa - perLayer;
      const t = cnt <= 1 ? 0.5 : li / (cnt - 1);
      const theta = a0 + (a1 - a0) * t + (layer === 1 ? 0.18 : 0) + rr(r, -0.06, 0.06);
      const roll = i % 3 === 2;
      const geo = porkGeometry(roll ? 'roll' : 'slab', (i * 7 + seed) % 4, detail);
      const W = (geo.userData as { W: number }).W;
      const hasMound = mound !== null && mound.H > 0.03;
      const tilt = hasMound ? rr(r, 0.75, 1.0) - layer * 0.15 : rr(r, 0.12, 0.3);
      const rp = (hasMound ? 0.068 : 0.05) - layer * 0.016 + rr(r, -0.004, 0.004);
      const px = Math.sin(theta) * rp;
      const pz = Math.cos(theta) * rp;
      const py = Math.max(liquidY, field.get(px, pz) - 0.004) + (W / 2) * Math.sin(tilt) * 0.85 + layer * 0.012 + 0.002;
      tmp.e.set(-tilt, theta + Math.PI + rr(r, -0.15, 0.15), rr(r, -0.12, 0.12), 'YXZ');
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(px, py, pz), tmp.q, tmp.s.set(1, 1, 1));
      const g = geo.clone();
      g.applyMatrix4(tmp.m);
      porkParts.push(g);
      // 高さ場に上面を記録
      const p = g.attributes.position!;
      for (let k = 0; k < p.count; k++) field.stamp(p.getX(k), p.getZ(k), p.getY(k), 0.003);
    }
  }

  // ── ニンニク ──
  const ninniku = Math.max(0, c.toppings.ninniku);
  if (ninniku > 0) {
    const gTheta = Math.PI + (nButa >= 3 ? 0.95 : 0.8);
    const gr = 0.064;
    const gx = Math.sin(gTheta) * gr;
    const gz = Math.cos(gTheta) * gr;
    const Rg = 0.015 + 0.0075 * Math.min(ninniku, 3);
    const Hg = 0.009 + 0.007 * Math.min(ninniku, 3);
    let base = heightAt(gx, gz);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      base = Math.max(base, heightAt(gx + Math.cos(a) * Rg * 0.4, gz + Math.sin(a) * Rg * 0.4) - 0.004);
    }
    base -= 0.002;
    // 芯の円錐（豚と同じマテリアルにまとめる）
    const cone = garlicConeGeometry().clone();
    cone.scale(Rg * 0.82, Hg * 0.9, Rg * 0.82);
    cone.translate(gx, base, gz);
    porkParts.push(cone);
    const n = Math.round(interp(ninniku, [[0.5, 40], [1, 85], [2, 150], [3, 220]]) * (hi ? 1 : 0.3));
    const gm = makeInstanced(garlicGeometry(), M.garlic(), n, owned);
    for (let i = 0; i < n; i++) {
      const spill = r() < 0.1;
      const rho = (spill ? rr(r, 0.9, 1.5) : Math.sqrt(r())) * Rg;
      const a = r() * Math.PI * 2;
      const x = gx + Math.cos(a) * rho;
      const z = gz + Math.sin(a) * rho;
      const hh = spill ? 0 : Hg * Math.pow(Math.max(0, 1 - (rho / Rg) ** 2), 0.8) * rr(r, 0.65, 1.0);
      const y = spill ? heightAt(x, z) + 0.001 : base + hh + 0.001;
      const s = rr(r, 0.0026, 0.0048);
      tmp.e.set(r() * 6, r() * 6, r() * 6);
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(x, y, z), tmp.q, tmp.s.set(s * rr(r, 0.8, 1.4), s * rr(r, 0.55, 0.9), s * rr(r, 0.8, 1.3)));
      gm.setMatrixAt(i, tmp.m);
      tmp.c.copy(GARLIC_COLORS[Math.floor(r() * GARLIC_COLORS.length)]!).multiplyScalar(rr(r, 0.9, 1.04));
      gm.setColorAt(i, tmp.c);
    }
    finishInstanced(gm);
    group.add(gm);
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      for (const f of [0, 0.5, 0.9]) {
        const rho = f * Rg;
        field.stamp(gx + Math.cos(a) * rho, gz + Math.sin(a) * rho, base + Hg * Math.pow(1 - f * f, 0.8), 0.002);
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

  // ── アブラ（背脂） ──
  const abura = Math.max(0, c.toppings.abura);
  if (abura > 0) {
    const cx = mound ? mound.cx + 0.006 : 0.01;
    const cz = mound ? mound.cz - 0.014 : -0.005;
    const Ra = 0.016 + 0.008 * Math.min(abura, 3);
    const nBig = Math.round(interp(abura, [[1, 8], [2, 14], [3, 22]]) * (hi ? 1 : 0.5));
    const nSmall = Math.round(interp(abura, [[1, 30], [2, 60], [3, 90]]) * (hi ? 1 : 0.25));
    const big = makeInstanced(aburaGeometry(true), M.abura(), nBig, owned);
    const small = makeInstanced(aburaGeometry(false), M.abura(), nSmall, owned);
    const place = (im: THREE.InstancedMesh, i: number, sMin: number, sMax: number, brown: [number, number]) => {
      const rho = Math.sqrt(r()) * Ra;
      const a = r() * Math.PI * 2;
      const x = cx + Math.cos(a) * rho;
      const z = cz + Math.sin(a) * rho;
      const s = rr(r, sMin, sMax);
      const y = heightAt(x, z) + s * 0.3;
      tmp.e.set(rr(r, -0.6, 0.6), r() * 6, rr(r, -0.6, 0.6));
      tmp.q.setFromEuler(tmp.e);
      tmp.m.compose(v1.set(x, y, z), tmp.q, tmp.s.set(s * rr(r, 0.8, 1.2), s * rr(r, 0.7, 1.0), s * rr(r, 0.8, 1.2)));
      im.setMatrixAt(i, tmp.m);
      tmp.c.copy(ABURA_LIGHT).lerp(ABURA_BROWN, rr(r, brown[0], brown[1]));
      im.setColorAt(i, tmp.c);
      field.stamp(x, z, y + s * 0.55, s * 0.6);
    };
    for (let i = 0; i < nBig; i++) place(big, i, 0.0045, 0.0085, [0.05, 0.75]);
    for (let i = 0; i < nSmall; i++) place(small, i, 0.002, 0.0038, [0.3, 1.0]);
    finishInstanced(big);
    finishInstanced(small);
    group.add(big, small);
  }

  // ── 唐辛子（一味） ──
  if (ichimi > 0) {
    const n = Math.round(interp(ichimi, [[0.5, 300], [1, 520], [2, 950], [3, 1350]]) * (hi ? 1 : 0.25));
    const cm = makeInstanced(chiliGeometry(), M.chili(), n, owned);
    const rimA = Math.atan2(patch.z, patch.x) + 0.3;
    for (let i = 0; i < n; i++) {
      const b = r();
      let x: number;
      let z: number;
      let y: number;
      if (b < 0.72) {
        x = patch.x + rnorm(r) * patch.s;
        z = patch.z + rnorm(r) * patch.s;
        const d = Math.hypot(x, z);
        if (d > 0.106) {
          x *= 0.106 / d;
          z *= 0.106 / d;
        }
        y = heightAt(x, z) + (mound && moundY(mound, x, z) > 0 ? 0.0028 : 0.0008);
      } else if (b < 0.87) {
        const a = rimA + rnorm(r) * 0.8;
        const rad = rr(r, 0.1148, 0.1196);
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
        y = RIM_TOP - 40 * (rad - 0.1172) ** 2 + 0.0003;
      } else {
        const a = r() * Math.PI * 2;
        const rad = Math.sqrt(r()) * 0.105;
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
        y = heightAt(x, z) + 0.0012;
      }
      const s = rr(r, 0.0012, 0.0026);
      tmp.e.set(rr(r, -0.5, 0.5), r() * 6, rr(r, -0.5, 0.5));
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

/** もやしの山の芯（テクスチャ付きのドーム）。表面のもやしの隙間を埋める */
function buildDome(m: Mound, hi: boolean, patchW: (x: number, z: number) => number, owned: Disposable[]): THREE.Mesh {
  const rings = hi ? 9 : 5;
  const sectors = hi ? 28 : 14;
  const pos: number[] = [];
  const col: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const pale = new THREE.Color(0.95, 0.93, 0.85);
  const c = new THREE.Color();
  const add = (x: number, y: number, z: number) => {
    pos.push(x, y, z);
    uv.push(x / 0.07, z / 0.07);
    const h01 = (y - m.baseY) / Math.max(0.01, m.H);
    c.copy(pale);
    if (h01 < 0.35) c.lerp(SOUP_STAIN, (0.35 - h01) * 2);
    const w = patchW(x, z);
    if (w > 0) c.lerp(CHILI_TINT, Math.min(0.75, w * 0.8));
    col.push(c.r, c.g, c.b);
  };
  add(m.cx, moundY(m, m.cx, m.cz) - 0.003, m.cz);
  for (let i = 1; i <= rings; i++) {
    const f = i / rings;
    for (let j = 0; j < sectors; j++) {
      const a = (j / sectors) * Math.PI * 2;
      const rad = m.R * (i === rings ? 1.02 : f);
      const x = m.cx + Math.cos(a) * rad;
      const z = m.cz + Math.sin(a) * rad;
      const y = i === rings ? m.baseY - 0.004 : moundY(m, x, z) - 0.003;
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
  const y = BOWL_DIMS.innerBottom + 0.006;
  const pool = new THREE.Mesh(discGeometry(detail === 'high' ? 32 : 14), M.dirtyPool());
  const rad = innerRadiusAt(y) * 0.98;
  pool.scale.set(rad, 1, rad);
  pool.position.y = y;
  group.add(pool);
  const r = makeRng(77);
  const n = detail === 'high' ? 7 : 3;
  const sp = makeInstanced(sproutGeometry(detail), M.sprout(), n, owned);
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = rr(r, 0.01, 0.045);
    tmp.v.set(Math.cos(a) * d, y + 0.0015, Math.sin(a) * d);
    tmp.v2.set(rr(r, -1, 1), 0, rr(r, -1, 1)).normalize();
    setBasis(sp, i, tmp.v.clone(), tmp.v2.clone(), tmp.up, rr(r, 0.4, 0.7));
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
  const steam = createSteam({ count: 7, radius: 0.055, rise: 0.3, size: 0.13, speed: 0.32, spread: 0.015, opacity: 0.5, seed: (seed % 13) + 3 });
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

/** 重ねた丼などに使う、具のない器だけのジオメトリ（共有）とマテリアル */
export function bowlShellGeometry(detail: BowlDetail = 'low'): THREE.BufferGeometry {
  return bowlGeometry(detail);
}

export function bowlStainMaterial(): THREE.Material {
  return M.stain();
}

export function bowlStainGeometry(): THREE.BufferGeometry {
  return stainGeometry();
}

/** 盛り付け台などに置く「標準的な一杯」の中身（ギャラリーや見本用） */
export function sampleRng(seed: number): Rng {
  return makeRng(seed);
}
