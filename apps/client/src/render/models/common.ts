// 描画モデルの共通部品: 乱数・キャッシュ・ジオメトリ結合・共有マテリアル。
// iPhone Safari を想定し、マテリアル・テクスチャ・ジオメトリはモジュール単位でキャッシュして使い回す。
// 各モデルの dispose() は「そのインスタンス専用のリソース」だけを解放し、共有物は解放しない。

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Disposable {
  dispose(): void;
}

// ───────────────────────── 乱数 ─────────────────────────

/** mulberry32（見た目のばらつき専用。ゲーム状態の乱数とは独立させる） */
export function makeRng(seed: number): () => number {
  let a = (seed ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = () => number;

export function rr(r: Rng, a: number, b: number): number {
  return a + (b - a) * r();
}

/** 平均0・標準偏差1の正規乱数 */
export function rnorm(r: Rng): number {
  const u = Math.max(1e-9, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickOf<T>(r: Rng, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length) % arr.length] as T;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smooth01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

// ───────────────────────── キャッシュ ─────────────────────────

const cacheMap = new Map<string, unknown>();

/** モジュール単位の共有キャッシュ（マテリアル・テクスチャ・ジオメトリ） */
export function cached<T>(key: string, make: () => T): T {
  const hit = cacheMap.get(key);
  if (hit !== undefined) return hit as T;
  const v = make();
  cacheMap.set(key, v);
  return v;
}

// ───────────────────────── ジオメトリ ─────────────────────────

export interface XForm {
  x?: number;
  y?: number;
  z?: number;
  rx?: number;
  ry?: number;
  rz?: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export function xformMatrix(xf: XForm, out = _m4): THREE.Matrix4 {
  _p.set(xf.x ?? 0, xf.y ?? 0, xf.z ?? 0);
  _e.set(xf.rx ?? 0, xf.ry ?? 0, xf.rz ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _s.set(xf.sx ?? 1, xf.sy ?? 1, xf.sz ?? 1);
  return out.compose(_p, _q, _s);
}

/**
 * 結合できるように属性を揃える（position / normal / uv だけ残し、index を必ず持たせる）。
 * extraColor を渡すと頂点カラー属性を付ける。
 */
export function normalizeGeometry(g: THREE.BufferGeometry, color?: THREE.Color): THREE.BufferGeometry {
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
  }
  const n = g.attributes.position!.count;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  if (color) {
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      c[i * 3] = color.r;
      c[i * 3 + 1] = color.g;
      c[i * 3 + 2] = color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  g.clearGroups();
  return g;
}

/**
 * 箱投影でワールド単位の UV を付け直す（床・壁・カウンターなどタイル状テクスチャ用）。
 * unit = テクスチャ1枚が覆う長さ(m)。
 */
export function boxProjectUV(g: THREE.BufferGeometry, unit: number, offU = 0, offV = 0): void {
  const pos = g.attributes.position!;
  const nor = g.attributes.normal!;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (ny >= nx && ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else if (nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv[i * 2] = u / unit + offU;
    uv[i * 2 + 1] = v / unit + offV;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export interface AddOpts extends XForm {
  /** ワールド単位の箱投影 UV（テクスチャ1枚の長さ m） */
  uv?: number;
}

/**
 * マテリアルごとに部品をまとめて1メッシュに結合するビルダー。
 * 設備や店舗のような静的モデルの draw call を「使うマテリアル数」まで減らす。
 */
export class GeoBuilder {
  private parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(mat: THREE.Material, geo: THREE.BufferGeometry, o?: AddOpts): this {
    const g = normalizeGeometry(geo.index ? geo.clone() : geo.clone());
    if (o) {
      g.applyMatrix4(xformMatrix(o));
      if (o.uv) boxProjectUV(g, o.uv);
    }
    let list = this.parts.get(mat);
    if (!list) {
      list = [];
      this.parts.set(mat, list);
    }
    list.push(g);
    return this;
  }

  /** 中心指定の箱 */
  box(mat: THREE.Material, w: number, h: number, d: number, o?: AddOpts): this {
    return this.add(mat, boxGeo(w, h, d), o);
  }

  /** 底面中心指定の円柱（y は底面） */
  cyl(mat: THREE.Material, rTop: number, rBot: number, h: number, seg: number, o?: AddOpts & { open?: boolean }): this {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, o?.open ?? false);
    g.translate(0, h / 2, 0);
    return this.add(mat, g, o);
  }

  isEmpty(): boolean {
    return this.parts.size === 0;
  }

  /** マテリアルごとの結合ジオメトリ */
  merged(): { geo: THREE.BufferGeometry; mat: THREE.Material }[] {
    const out: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
    for (const [mat, list] of this.parts) {
      const geo = list.length === 1 ? list[0]! : mergeGeometries(list, false);
      if (!geo) continue;
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      out.push({ geo, mat });
    }
    this.parts.clear();
    return out;
  }

  build(opts: { cast?: boolean; receive?: boolean } = {}): THREE.Group {
    return meshesFromMerged(this.merged(), opts);
  }
}

export function meshesFromMerged(
  list: { geo: THREE.BufferGeometry; mat: THREE.Material }[],
  opts: { cast?: boolean; receive?: boolean } = {},
): THREE.Group {
  const g = new THREE.Group();
  for (const { geo, mat } of list) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = opts.cast ?? true;
    m.receiveShadow = opts.receive ?? true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    g.add(m);
  }
  return g;
}

/** 角を少し落とした箱は高価なので、通常の箱を使う */
export function boxGeo(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

/** 角丸の板（押し出し）。w×d の XZ 平面、厚み h を Y 方向に。底面 y=0 */
export function roundedSlab(w: number, d: number, h: number, r: number, seg = 3): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const x0 = -w / 2;
  const z0 = -d / 2;
  const rr2 = Math.min(r, w / 2, d / 2);
  s.moveTo(x0 + rr2, z0);
  s.lineTo(x0 + w - rr2, z0);
  s.quadraticCurveTo(x0 + w, z0, x0 + w, z0 + rr2);
  s.lineTo(x0 + w, z0 + d - rr2);
  s.quadraticCurveTo(x0 + w, z0 + d, x0 + w - rr2, z0 + d);
  s.lineTo(x0 + rr2, z0 + d);
  s.quadraticCurveTo(x0, z0 + d, x0, z0 + d - rr2);
  s.lineTo(x0, z0 + rr2);
  s.quadraticCurveTo(x0, z0, x0 + rr2, z0);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: seg });
  // Shape は XY 平面 → XZ 平面へ（押し出し方向を +Y に）
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

/** 共有インスタンス行列用の一時オブジェクト */
export const tmp = {
  m: new THREE.Matrix4(),
  m2: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  q2: new THREE.Quaternion(),
  e: new THREE.Euler(),
  v: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  v3: new THREE.Vector3(),
  s: new THREE.Vector3(),
  c: new THREE.Color(),
  up: new THREE.Vector3(0, 1, 0),
};

/** InstancedMesh の i 番目に位置・回転(YXZ)・スケールを書き込む */
export function setInstance(
  im: THREE.InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy: number,
  sz: number,
): void {
  tmp.e.set(rx, ry, rz, 'YXZ');
  tmp.q.setFromEuler(tmp.e);
  tmp.v.set(x, y, z);
  tmp.s.set(sx, sy, sz);
  tmp.m.compose(tmp.v, tmp.q, tmp.s);
  im.setMatrixAt(i, tmp.m);
}

/** グループ配下のインスタンス専用リソースを解放する（共有キャッシュ物は除外） */
export function disposeOwned(owned: { dispose(): void }[]): void {
  for (const o of owned) o.dispose();
  owned.length = 0;
}

export function hexColor(h: string | number): THREE.Color {
  return new THREE.Color(h);
}
