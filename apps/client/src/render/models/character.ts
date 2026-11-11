// 人物モデル（客・従業員・プレイヤー）。
// 体は1つの SkinnedMesh（頂点カラー＋剛体スキニング）にまとめ、1人あたり draw call を1つに抑える。
// 原点=足元、rotation.y=0 で正面が +z（yaw = atan2(dx, dz) の規約）。座る高さは丸椅子の座面 0.62m。

import * as THREE from 'three';
import { cached, clamp, makeRng, pickOf, rr, xformMatrix, type Disposable, type Rng, type XForm } from './common';
import { canvasTexture, JP_FONT } from './textures';
import { createHeldItem, type HeldKind } from './props';
import type { EatMotion } from '../eat-motion';
import { staffLook, type StaffBeard, type StaffHeadwear } from '../staff-look';

/** down = 床に倒れて動かない（爆発事故のあと）、chat = 座って話している（団体の食後・居座り） */
export type CharacterPose = 'stand' | 'walk' | 'sit' | 'eat' | 'work' | 'carry' | 'down' | 'chat';
export type { HeldKind };

export interface CharacterModel extends Disposable {
  group: THREE.Group;
  /** pose と時刻 t（秒）で姿勢を更新する。speed（0..1, 省略時1）は歩行の振り幅 */
  update(pose: CharacterPose, t: number, dt: number, speed?: number): void;
  /** 手に持つ物。'bowl' は腕の構えだけ（丼本体は呼び出し側が BowlModel を置く） */
  setHeld(kind: HeldKind | null): void;
  /** 頭上の名札（null で消す） */
  setLabel(text: string | null): void;
  /** 食事の動き（eat の姿勢で使う。null なら単純な繰り返し） */
  setEat(m: EatMotion | null): void;
  /** 手に持つ物を自前で付けたいとき用の取り付け点（胸の前, 高さ約1.0m） */
  heldAnchor: THREE.Object3D;
}

export interface CharacterOpts {
  kind: 'customer' | 'employee' | 'player';
  seed: number;
  color?: string;
  /** 見た目の指定（珍しい客）。なければ seed から決まる */
  look?: 'blonde_woman' | 'boyfriend' | 'police' | null;
}
// 従業員（kind 'employee'）の制服・小物は seed から staffLook で決まる（経営メニューの説明と同じ）

// ───────────────────────── 骨格 ─────────────────────────

const B = {
  root: 0,
  hips: 1,
  spine: 2,
  head: 3,
  armL: 4,
  foreL: 5,
  armR: 6,
  foreR: 7,
  thighL: 8,
  shinL: 9,
  thighR: 10,
  shinR: 11,
} as const;
const BONE_COUNT = 12;

/** 体型パラメータ（s=身長倍率, w=横幅倍率） */
interface Body {
  s: number;
  w: number;
  female: boolean;
}

/** 静止姿勢での関節位置（足元原点・身長1.7m基準） */
function joints(b: Body) {
  const s = b.s;
  const w = b.w * (b.female ? 0.9 : 1);
  return {
    hipsY: 0.95 * s,
    spineUp: 0.08 * s,
    neckUp: 0.43 * s,
    shoulderX: 0.185 * w,
    shoulderUp: 0.37 * s,
    upperArm: 0.28 * s,
    forearm: 0.25 * s,
    hipX: 0.09 * w,
    hipDown: 0.07 * s,
    thigh: 0.42 * s,
    shin: 0.38 * s,
    w,
  };
}

// ───────────────────────── 頂点カラー付きスキン用ビルダー ─────────────────────────

class SkinBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  idx: number[] = [];

  add(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, bone: number, xf?: XForm): void {
    let g = geo;
    if (xf) {
      g = geo.clone();
      g.applyMatrix4(xformMatrix(xf));
    }
    if (!g.attributes.normal) g.computeVertexNormals();
    const c = new THREE.Color(color);
    const p = g.attributes.position!;
    const n = g.attributes.normal!;
    const base = this.pos.length / 3;
    for (let i = 0; i < p.count; i++) {
      this.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      this.nor.push(n.getX(i), n.getY(i), n.getZ(i));
      this.col.push(c.r, c.g, c.b);
      this.si.push(bone, 0, 0, 0);
      this.sw.push(1, 0, 0, 0);
    }
    if (g.index) {
      const ix = g.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// 基本形状（共有。add() 内で複製して変形する）
const G = {
  cyl: (seg: number) => cached('ch:cyl' + seg, () => new THREE.CylinderGeometry(1, 1, 1, seg, 1)),
  sphere: (w: number, h: number) => cached(`ch:sph${w}x${h}`, () => new THREE.SphereGeometry(1, w, h)),
  cap: (w: number, h: number, theta: number) => cached(`ch:cap${w}x${h}x${theta}`, () => new THREE.SphereGeometry(1, w, h, 0, Math.PI * 2, 0, theta)),
  box: () => cached('ch:box', () => new THREE.BoxGeometry(1, 1, 1)),
  torus: () => cached('ch:torus', () => new THREE.TorusGeometry(1, 0.17, 5, 14)),
};

/** a→b を結ぶテーパー付き円柱（rA: a側半径, rB: b側半径） */
function limb(sb: SkinBuilder, color: THREE.ColorRepresentation, bone: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, rA: number, rB: number, flatZ = 1): void {
  const g = new THREE.CylinderGeometry(rB, rA, 1, 8, 1);
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  g.scale(1, len, flatZ);
  g.translate(0, len / 2, 0);
  const dir = new THREE.Vector3(bx - ax, by - ay, bz - az).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  g.translate(ax, ay, az);
  sb.add(g, color, bone);
}

// ───────────────────────── 見た目の選択 ─────────────────────────

const SKIN = ['#f3d6bd', '#eecaa8', '#e6bc98', '#ddb08a', '#cf9f78', '#b98660', '#94653f'];
const SKIN_W = [0.18, 0.24, 0.22, 0.16, 0.1, 0.06, 0.04];
const HAIR = ['#16120f', '#1e1814', '#2c2019', '#433024', '#6b4a2e', '#9a6c3e', '#8c8884', '#c49a5a'];
const HAIR_W = [0.36, 0.2, 0.14, 0.1, 0.07, 0.05, 0.05, 0.03];

function weighted<T>(r: Rng, arr: readonly T[], w: readonly number[]): T {
  let x = r() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < arr.length; i++) {
    x -= w[i]!;
    if (x <= 0) return arr[i]!;
  }
  return arr[arr.length - 1]!;
}

type Outfit = 'hoodie' | 'suit' | 'work' | 'tshirt' | 'jacket' | 'staff';
type Hair = 'short' | 'buzz' | 'side' | 'long' | 'bob' | 'bald' | 'cap' | 'spiky';

interface Look {
  body: Body;
  skin: string;
  hairColor: string;
  hair: Hair;
  outfit: Outfit;
  top: string;
  top2: string;
  pants: string;
  shoes: string;
  tie: string;
  apron: string | null;
  /** 頭に付ける物（店員）。客は 'none' */
  headwear: StaffHeadwear;
  headColor: string;
  glasses: boolean;
  glassesColor: string;
  beard: StaffBeard;
  neckTowel: boolean;
  wristband: string | null;
  /** 背中の店の文字の色 */
  print: string | null;
  ponytail: boolean;
  backpack: string | null;
  capColor: string;
  longSleeve: boolean;
}

function chooseLook(o: CharacterOpts): Look {
  const r = makeRng(o.seed * 7 + 13 + (o.kind === 'customer' ? 0 : 1000));
  const sl = o.kind === 'employee' ? staffLook(o.seed) : null;
  const female0 = o.kind === 'customer' ? r() < 0.2 : r() < 0.25;
  const female = sl ? sl.female : female0;
  const s = female ? rr(r, 0.9, 0.98) : rr(r, 0.95, 1.07);
  const w = rr(r, 0.88, 1.22);
  const skin = weighted(r, SKIN, SKIN_W);
  const hairColor = weighted(r, HAIR, HAIR_W);
  const hair: Hair = female ? pickOf(r, ['long', 'bob', 'long', 'short'] as const) : pickOf(r, ['short', 'buzz', 'side', 'short', 'bald', 'cap', 'spiky', 'side'] as const);
  const look: Look = {
    body: { s, w, female },
    skin,
    hairColor,
    hair,
    outfit: 'tshirt',
    top: '#333333',
    top2: '#eeeeee',
    pants: pickOf(r, ['#2c3e5c', '#1e1e22', '#8a7a58', '#55585e', '#33415a'] as const),
    shoes: pickOf(r, ['#202020', '#ececec', '#5a3a22', '#3a3a3a', '#7a2a2a'] as const),
    tie: pickOf(r, ['#8c1c24', '#1c3c8c', '#3c6c3c', '#5a3c7a'] as const),
    apron: null,
    headwear: 'none',
    headColor: '#f4f4f0',
    glasses: r() < 0.28,
    glassesColor: '#1c1c1c',
    beard: 'none',
    neckTowel: false,
    wristband: null,
    print: null,
    ponytail: false,
    backpack: null,
    capColor: pickOf(r, ['#1a1a1a', '#203a6a', '#7a1f1f', '#e0e0e0', '#3a5a30'] as const),
    longSleeve: true,
  };
  if (o.kind === 'customer') {
    const k = r();
    if (k < 0.3) {
      look.outfit = 'hoodie';
      look.top = pickOf(r, ['#3d4450', '#1f2a44', '#5b6b3a', '#7a2630', '#9a9a9a', '#2b2b2b', '#c96a2b', '#d8d4cc'] as const);
    } else if (k < 0.52) {
      look.outfit = 'suit';
      look.top = pickOf(r, ['#23283a', '#2e2e30', '#4a4a50', '#2a3340'] as const);
      look.pants = look.top;
      look.top2 = '#f4f4f2';
      look.shoes = pickOf(r, ['#1a1a1a', '#3a2416'] as const);
    } else if (k < 0.7) {
      look.outfit = 'work';
      look.top = pickOf(r, ['#2e3f5c', '#7a6a48', '#5a6470', '#4a5a3a', '#c8c0a8'] as const);
      look.pants = look.top;
      look.top2 = '#d8d070';
    } else if (k < 0.86) {
      look.outfit = 'tshirt';
      look.top = pickOf(r, ['#d8d8d8', '#c23b3b', '#2f6db0', '#e2c044', '#222222', '#3a8a5a', '#f0f0ee'] as const);
      look.longSleeve = false;
    } else {
      look.outfit = 'jacket';
      look.top = pickOf(r, ['#4a3a2a', '#2a2a2a', '#5a6a7a', '#7a4a2a', '#30404a'] as const);
      look.top2 = pickOf(r, ['#e8e8e8', '#c23b3b', '#333333', '#d8c89a'] as const);
    }
    if (r() < 0.18) look.backpack = pickOf(r, ['#222222', '#3a4a6a', '#6a3a2a', '#556b2f'] as const);
    if (o.look === 'blonde_woman') {
      // 金髪の成人女性（彼氏と来店）
      look.body = { s: rr(r, 0.93, 0.98), w: rr(r, 0.9, 1.0), female: true };
      look.hairColor = '#e8c872';
      look.hair = 'long';
      look.outfit = 'jacket';
      look.top = '#f2ece2';
      look.top2 = '#d04a6a';
      look.pants = '#2a2f3e';
      look.glasses = false;
      look.backpack = null;
    } else if (o.look === 'police') {
      // 警察官（紺の制服・水色のシャツ・制帽）
      look.body = { s: rr(r, 1.0, 1.06), w: rr(r, 1.0, 1.12), female: false };
      look.outfit = 'suit';
      look.top = '#1f2a44';
      look.top2 = '#a9c4e0';
      look.tie = '#1a2238';
      look.pants = '#1a2236';
      look.shoes = '#111111';
      look.hair = 'cap';
      look.capColor = '#18223a';
      look.glasses = false;
      look.backpack = null;
      look.longSleeve = true;
    } else if (o.look === 'boyfriend') {
      look.body = { s: rr(r, 1.0, 1.06), w: rr(r, 0.95, 1.1), female: false };
      look.hair = 'side';
      look.hairColor = '#2c2019';
      look.outfit = 'hoodie';
      look.top = '#3d4450';
      look.backpack = null;
    }
  } else {
    // 次郎系の店員: 黒Tシャツ・白タオルの鉢巻・前掛け
    look.outfit = 'staff';
    look.top = o.kind === 'player' ? '#2a2a2c' : '#151515';
    look.longSleeve = false;
    look.pants = o.kind === 'player' ? '#2d3036' : '#1f2124';
    look.shoes = o.kind === 'employee' ? '#f0f0f0' : '#2a2a2a';
    look.apron = o.kind === 'player' ? (o.color ?? '#e74c3c') : '#232a36';
    look.headwear = 'towel';
    look.glasses = look.glasses && r() < 0.5;
    if (look.hair === 'long') look.hair = 'bob';
    if (look.hair === 'cap') look.hair = 'short';
    if (sl) {
      // 従業員ごとの個性（制服の色・頭・メガネ・ひげ・小物）
      look.top = sl.shirt;
      look.longSleeve = sl.longSleeve;
      look.apron = sl.apron;
      look.headwear = sl.headwear;
      look.headColor = sl.headColor;
      look.glasses = sl.glasses !== null;
      look.glassesColor = sl.glasses ?? '#1c1c1c';
      look.beard = sl.beard;
      look.neckTowel = sl.neckTowel;
      look.wristband = sl.wristband;
      look.print = sl.print;
      look.ponytail = sl.ponytail;
      look.pants = pickOf(r, ['#1f2124', '#23262d', '#2c3e5c', '#4a4438', '#1f2124'] as const);
      look.shoes = pickOf(r, ['#f0f0f0', '#f0f0f0', '#1c1c1c', '#2a3a2a'] as const);
      if (sl.headwear === 'cap') {
        look.hair = 'cap';
        look.capColor = sl.headColor;
      } else if ((look.hair === 'spiky' && sl.headwear !== 'none') || (look.hair === 'bob' && (sl.headwear === 'bandana' || sl.headwear === 'wrap' || sl.headwear === 'cookcap'))) look.hair = 'short';
      if (sl.ponytail && (look.hair === 'bob' || look.hair === 'bald' || look.hair === 'buzz')) look.hair = 'short';
    }
  }
  return look;
}

// ───────────────────────── 体の組み立て ─────────────────────────

function buildBody(look: Look): { geo: THREE.BufferGeometry; J: ReturnType<typeof joints> } {
  const J = joints(look.body);
  const s = look.body.s;
  const w = J.w;
  const sb = new SkinBuilder();
  const hipsY = J.hipsY;
  const waistY = hipsY + J.spineUp;
  const shoulderY = waistY + J.shoulderUp;
  const neckY = waistY + J.neckUp;
  const headY = neckY + 0.13 * s;
  const skin = look.skin;
  const top = look.top;
  const female = look.body.female;

  // ── 頭 ──
  const hr = 0.108 * s;
  sb.add(G.sphere(12, 9), skin, B.head, { y: headY, sx: hr * 0.94, sy: hr * 1.08, sz: hr });
  // 耳
  sb.add(G.sphere(5, 4), skin, B.head, { x: hr * 0.93, y: headY, z: -0.005, sx: 0.016 * s, sy: 0.026 * s, sz: 0.014 * s });
  sb.add(G.sphere(5, 4), skin, B.head, { x: -hr * 0.93, y: headY, z: -0.005, sx: 0.016 * s, sy: 0.026 * s, sz: 0.014 * s });
  // 鼻・目・眉・口
  sb.add(G.box(), new THREE.Color(skin).multiplyScalar(0.9), B.head, { y: headY - 0.008 * s, z: hr * 0.98, sx: 0.022 * s, sy: 0.034 * s, sz: 0.02 * s, rx: -0.2 });
  for (const sx of [1, -1]) {
    sb.add(G.sphere(6, 4), '#1a1410', B.head, { x: sx * 0.037 * s, y: headY + 0.012 * s, z: hr * 0.9, sx: 0.011 * s, sy: 0.014 * s, sz: 0.008 * s });
    sb.add(G.box(), look.hairColor, B.head, { x: sx * 0.038 * s, y: headY + 0.04 * s, z: hr * 0.9, sx: 0.034 * s, sy: 0.007 * s, sz: 0.01 * s, rz: sx * -0.12 });
  }
  sb.add(G.box(), '#9a5048', B.head, { y: headY - 0.045 * s, z: hr * 0.9, sx: 0.034 * s, sy: 0.007 * s, sz: 0.01 * s });
  if (look.glasses) {
    for (const sx of [1, -1]) sb.add(G.torus(), look.glassesColor, B.head, { x: sx * 0.038 * s, y: headY + 0.012 * s, z: hr * 0.98, sx: 0.022 * s, sy: 0.02 * s, sz: 0.02 * s });
    sb.add(G.box(), look.glassesColor, B.head, { y: headY + 0.016 * s, z: hr * 0.99, sx: 0.03 * s, sy: 0.004 * s, sz: 0.004 * s });
  }
  // 髪
  const hc = look.hairColor;
  switch (look.hair) {
    case 'short':
      sb.add(G.cap(12, 6, 1.75), hc, B.head, { y: headY + 0.006 * s, sx: hr * 1.02, sy: hr * 1.12, sz: hr * 1.06, rx: -0.25 });
      break;
    case 'buzz':
      sb.add(G.cap(12, 6, 1.65), hc, B.head, { y: headY + 0.002 * s, sx: hr * 0.99, sy: hr * 1.1, sz: hr * 1.02, rx: -0.3 });
      break;
    case 'side':
      sb.add(G.cap(12, 6, 1.8), hc, B.head, { y: headY + 0.01 * s, sx: hr * 1.04, sy: hr * 1.14, sz: hr * 1.08, rx: -0.25 });
      sb.add(G.box(), hc, B.head, { x: 0.02 * s, y: headY + 0.085 * s, z: 0.05 * s, sx: 0.15 * s, sy: 0.035 * s, sz: 0.08 * s, rz: -0.15 });
      break;
    case 'spiky':
      sb.add(G.cap(12, 6, 1.7), hc, B.head, { y: headY + 0.006 * s, sx: hr * 1.02, sy: hr * 1.1, sz: hr * 1.05, rx: -0.25 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const cone = new THREE.ConeGeometry(0.03 * s, 0.07 * s, 4);
        sb.add(cone, hc, B.head, { x: Math.cos(a) * 0.05 * s, y: headY + 0.11 * s, z: Math.sin(a) * 0.05 * s, rx: Math.sin(a) * 0.5, rz: -Math.cos(a) * 0.5 });
      }
      break;
    case 'long':
      sb.add(G.cap(12, 6, 1.9), hc, B.head, { y: headY + 0.008 * s, sx: hr * 1.06, sy: hr * 1.12, sz: hr * 1.08, rx: -0.2 });
      sb.add(G.box(), hc, B.head, { y: headY - 0.1 * s, z: -0.05 * s, sx: 0.21 * s, sy: 0.26 * s, sz: 0.07 * s, rx: 0.08 });
      break;
    case 'bob':
      sb.add(G.cap(12, 6, 2.0), hc, B.head, { y: headY + 0.004 * s, sx: hr * 1.1, sy: hr * 1.12, sz: hr * 1.1, rx: -0.15 });
      break;
    case 'cap':
      sb.add(G.cap(12, 5, 1.55), look.capColor, B.head, { y: headY + 0.02 * s, sx: hr * 1.06, sy: hr * 1.05, sz: hr * 1.06, rx: -0.15 });
      sb.add(G.box(), look.capColor, B.head, { y: headY + 0.045 * s, z: hr * 1.1, sx: 0.17 * s, sy: 0.012 * s, sz: 0.09 * s, rx: 0.12 });
      sb.add(G.cap(10, 4, 1.7), hc, B.head, { y: headY - 0.01 * s, sx: hr * 1.02, sy: hr * 1.0, sz: hr * 1.04, rx: -0.9 });
      break;
    case 'bald':
      break;
  }
  if (look.ponytail && look.hair !== 'cap') {
    // 後ろで結んだ髪
    sb.add(G.sphere(7, 5), hc, B.head, { y: headY + 0.02 * s, z: -hr * 1.02, sx: 0.035 * s, sy: 0.035 * s, sz: 0.03 * s });
    sb.add(G.sphere(7, 5), hc, B.head, { y: headY - 0.06 * s, z: -hr * 1.08, sx: 0.032 * s, sy: 0.08 * s, sz: 0.03 * s, rx: 0.15 });
  }
  if (look.ponytail && look.hair === 'cap') {
    sb.add(G.sphere(7, 5), hc, B.head, { y: headY - 0.03 * s, z: -hr * 1.06, sx: 0.03 * s, sy: 0.07 * s, sz: 0.028 * s, rx: 0.2 });
  }
  // ひげ（髪の色）
  if (look.beard === 'stubble' || look.beard === 'full') {
    const c = look.beard === 'full' ? new THREE.Color(hc) : new THREE.Color(skin).lerp(new THREE.Color(hc), 0.45);
    sb.add(G.sphere(10, 6), c, B.head, { y: headY - 0.07 * s, z: hr * 0.35, sx: hr * 0.8, sy: hr * 0.4, sz: hr * 0.52 });
  }
  if (look.beard === 'goatee') sb.add(G.box(), hc, B.head, { y: headY - 0.083 * s, z: hr * 0.8, sx: 0.04 * s, sy: 0.035 * s, sz: 0.03 * s, rx: -0.3 });
  if (look.beard === 'mustache' || look.beard === 'full') sb.add(G.box(), hc, B.head, { y: headY - 0.031 * s, z: hr * 0.93, sx: 0.052 * s, sy: 0.011 * s, sz: 0.012 * s });
  // 頭に付ける物
  const hw = look.headColor;
  switch (look.headwear) {
    case 'towel':
      // タオルの鉢巻と後ろの結び目
      sb.add(G.torus(), hw, B.head, { y: headY + 0.045 * s, sx: hr * 1.04, sy: hr * 1.06, sz: hr * 0.5, rx: Math.PI / 2 + 0.12 });
      sb.add(G.box(), new THREE.Color(hw).multiplyScalar(0.96), B.head, { y: headY + 0.05 * s, z: -hr * 1.1, sx: 0.05 * s, sy: 0.045 * s, sz: 0.03 * s, rz: 0.4 });
      break;
    case 'bandana':
      // 頭を包むバンダナと後ろに垂れる結び目
      sb.add(G.cap(12, 6, 1.45), hw, B.head, { y: headY + 0.012 * s, sx: hr * 1.08, sy: hr * 1.12, sz: hr * 1.1, rx: -0.22 });
      sb.add(G.box(), new THREE.Color(hw).multiplyScalar(0.85), B.head, { x: 0.012 * s, y: headY - 0.005 * s, z: -hr * 1.1, sx: 0.03 * s, sy: 0.07 * s, sz: 0.012 * s, rz: 0.25 });
      sb.add(G.box(), new THREE.Color(hw).multiplyScalar(0.85), B.head, { x: -0.012 * s, y: headY - 0.01 * s, z: -hr * 1.1, sx: 0.03 * s, sy: 0.06 * s, sz: 0.012 * s, rz: -0.3 });
      break;
    case 'wrap':
      // 頭全体に巻いたタオルと前の結び目
      sb.add(G.cap(12, 6, 1.6), hw, B.head, { y: headY + 0.016 * s, sx: hr * 1.12, sy: hr * 1.2, sz: hr * 1.14, rx: -0.12 });
      sb.add(G.torus(), new THREE.Color(hw).multiplyScalar(0.94), B.head, { y: headY + 0.035 * s, sx: hr * 1.12, sy: hr * 1.14, sz: hr * 0.45, rx: Math.PI / 2 + 0.05 });
      sb.add(G.sphere(6, 4), new THREE.Color(hw).multiplyScalar(0.92), B.head, { y: headY + 0.11 * s, z: hr * 0.72, sx: 0.035 * s, sy: 0.03 * s, sz: 0.03 * s });
      break;
    case 'cookcap':
      // 白い調理帽（和帽子）
      sb.add(G.cyl(12), hw, B.head, { y: headY + 0.075 * s, sx: hr * 1.04, sy: 0.085 * s, sz: hr * 1.06 });
      sb.add(G.cap(12, 4, 0.7), hw, B.head, { y: headY + 0.112 * s, sx: hr * 1.04, sy: 0.02 * s, sz: hr * 1.06 });
      break;
    case 'cap':
    case 'none':
      break;
  }
  // 首
  sb.add(G.cyl(7), skin, B.head, { y: neckY + 0.02 * s, sx: 0.05 * s, sy: 0.09 * s, sz: 0.05 * s });

  // ── 胴 ──
  const chestR = 0.17 * w;
  const waistR = (female ? 0.13 : 0.15) * w;
  const torso = new THREE.CylinderGeometry(chestR, waistR, shoulderY - waistY + 0.04 * s, 9, 2);
  torso.scale(1, 1, 0.62);
  sb.add(torso, top, B.spine, { y: (shoulderY + waistY) / 2 - 0.01 * s });
  // 肩の丸み
  sb.add(G.sphere(8, 5), top, B.spine, { y: shoulderY - 0.005 * s, sx: chestR * 1.02, sy: 0.06 * s, sz: chestR * 0.62 });
  // 腰（ズボン）
  const pelvis = new THREE.CylinderGeometry(waistR, waistR * 1.05, 0.17 * s, 9, 1);
  pelvis.scale(1, 1, 0.68);
  sb.add(pelvis, look.pants, B.hips, { y: hipsY - 0.02 * s });

  // 服ごとの装飾
  const front = chestR * 0.62;
  switch (look.outfit) {
    case 'hoodie':
      sb.add(G.torus(), top, B.spine, { y: shoulderY + 0.01 * s, z: -0.03 * s, sx: 0.1 * s, sy: 0.09 * s, sz: 0.12 * s, rx: 1.3 });
      sb.add(G.box(), new THREE.Color(top).multiplyScalar(0.8), B.spine, { y: waistY + 0.08 * s, z: front * 0.92, sx: 0.2 * w, sy: 0.08 * s, sz: 0.02 * s });
      sb.add(G.box(), '#e8e8e8', B.spine, { x: 0.03 * s, y: shoulderY - 0.08 * s, z: front * 0.98, sx: 0.006 * s, sy: 0.08 * s, sz: 0.006 * s });
      sb.add(G.box(), '#e8e8e8', B.spine, { x: -0.03 * s, y: shoulderY - 0.08 * s, z: front * 0.98, sx: 0.006 * s, sy: 0.08 * s, sz: 0.006 * s });
      break;
    case 'suit':
      // シャツの V とネクタイ
      sb.add(G.box(), look.top2, B.spine, { y: shoulderY - 0.09 * s, z: front * 0.96, sx: 0.09 * w, sy: 0.16 * s, sz: 0.02 * s });
      sb.add(G.box(), look.tie, B.spine, { y: shoulderY - 0.13 * s, z: front * 1.0, sx: 0.035 * s, sy: 0.22 * s, sz: 0.012 * s });
      sb.add(G.box(), new THREE.Color(top).multiplyScalar(0.85), B.spine, { x: 0.05 * w, y: shoulderY - 0.1 * s, z: front * 1.0, sx: 0.025 * s, sy: 0.2 * s, sz: 0.01 * s, rz: 0.35 });
      sb.add(G.box(), new THREE.Color(top).multiplyScalar(0.85), B.spine, { x: -0.05 * w, y: shoulderY - 0.1 * s, z: front * 1.0, sx: 0.025 * s, sy: 0.2 * s, sz: 0.01 * s, rz: -0.35 });
      break;
    case 'work':
      sb.add(G.box(), new THREE.Color(top).multiplyScalar(0.82), B.spine, { x: 0.08 * w, y: shoulderY - 0.1 * s, z: front * 0.98, sx: 0.07 * s, sy: 0.06 * s, sz: 0.015 * s });
      sb.add(G.box(), new THREE.Color(top).multiplyScalar(0.82), B.spine, { x: -0.08 * w, y: shoulderY - 0.1 * s, z: front * 0.98, sx: 0.07 * s, sy: 0.06 * s, sz: 0.015 * s });
      sb.add(G.box(), look.top2, B.spine, { y: waistY + 0.04 * s, z: 0, sx: chestR * 2.02, sy: 0.02 * s, sz: chestR * 1.28 });
      break;
    case 'jacket':
      sb.add(G.box(), look.top2, B.spine, { y: (shoulderY + waistY) / 2, z: front * 0.95, sx: 0.12 * w, sy: shoulderY - waistY - 0.05 * s, sz: 0.02 * s });
      break;
    case 'staff':
      break;
    case 'tshirt':
      break;
  }
  if (look.apron) {
    // 前掛け（胸当て＋腰から膝上まで）。下側は腰の骨に付けて脚の動きと分ける
    sb.add(G.box(), look.apron, B.spine, { y: shoulderY - 0.17 * s, z: front * 0.98, sx: 0.24 * w, sy: 0.24 * s, sz: 0.02 * s });
    sb.add(G.box(), look.apron, B.hips, { y: hipsY - 0.17 * s, z: waistR * 0.72, sx: 0.36 * w, sy: 0.42 * s, sz: 0.02 * s, rx: -0.06 });
    sb.add(G.box(), '#f0f0f0', B.spine, { y: waistY + 0.01 * s, sx: waistR * 2.05, sy: 0.025 * s, sz: waistR * 1.42 });
    // 首ひも
    sb.add(G.box(), look.apron, B.spine, { x: 0.07 * w, y: shoulderY - 0.02 * s, z: front * 0.6, sx: 0.015 * s, sy: 0.1 * s, sz: 0.012 * s, rx: 0.5 });
    sb.add(G.box(), look.apron, B.spine, { x: -0.07 * w, y: shoulderY - 0.02 * s, z: front * 0.6, sx: 0.015 * s, sy: 0.1 * s, sz: 0.012 * s, rx: 0.5 });
  }
  if (look.print) {
    // 背中の店の文字（大きな一文字を線で描く）
    for (const dy of [0.07, 0.13, 0.19]) sb.add(G.box(), look.print, B.spine, { y: shoulderY - dy * s, z: -front * 1.0, sx: (dy === 0.13 ? 0.1 : 0.14) * w, sy: 0.016 * s, sz: 0.01 * s });
    sb.add(G.box(), look.print, B.spine, { y: shoulderY - 0.13 * s, z: -front * 1.0, sx: 0.016 * s, sy: 0.13 * s, sz: 0.01 * s });
  }
  if (look.neckTowel) {
    // 首にかけたタオル（前に垂らす）
    sb.add(G.torus(), '#f4f4f0', B.spine, { y: shoulderY + 0.02 * s, sx: 0.085 * s, sy: 0.075 * s, sz: 0.25 * s, rx: Math.PI / 2 - 0.25 });
    for (const sx of [1, -1]) sb.add(G.box(), '#f0f0ec', B.spine, { x: sx * 0.055 * s, y: shoulderY - 0.07 * s, z: front * 1.02, sx: 0.045 * s, sy: 0.15 * s, sz: 0.014 * s });
  }
  if (look.backpack) {
    sb.add(G.box(), look.backpack, B.spine, { y: shoulderY - 0.17 * s, z: -front - 0.07 * s, sx: 0.28 * w, sy: 0.34 * s, sz: 0.14 * s });
    sb.add(G.box(), new THREE.Color(look.backpack).multiplyScalar(0.7), B.spine, { y: shoulderY - 0.25 * s, z: -front - 0.15 * s, sx: 0.2 * w, sy: 0.12 * s, sz: 0.03 * s });
  }

  // ── 腕 ──
  const sleeve = look.longSleeve ? top : skin;
  for (const side of [1, -1] as const) {
    const armBone = side === 1 ? B.armL : B.armR;
    const foreBone = side === 1 ? B.foreL : B.foreR;
    const sx = side * J.shoulderX;
    const elbowY = shoulderY - J.upperArm;
    const wristY = elbowY - J.forearm;
    const ar = (female ? 0.042 : 0.05) * Math.sqrt(w);
    // 上腕（半袖は袖口だけ服の色）
    if (look.longSleeve) {
      limb(sb, top, armBone, sx, shoulderY, 0, sx, elbowY, 0, ar * 1.05, ar * 0.9);
    } else {
      limb(sb, top, armBone, sx, shoulderY, 0, sx, shoulderY - J.upperArm * 0.45, 0, ar * 1.25, ar * 1.15);
      limb(sb, skin, armBone, sx, shoulderY - J.upperArm * 0.45, 0, sx, elbowY, 0, ar * 0.9, ar * 0.82);
    }
    limb(sb, sleeve, foreBone, sx, elbowY, 0, sx, wristY + 0.01 * s, 0, ar * 0.85, ar * 0.7);
    // 手
    sb.add(G.sphere(7, 5), skin, foreBone, { x: sx, y: wristY - 0.035 * s, sx: 0.034 * s, sy: 0.05 * s, sz: 0.026 * s });
    if (look.wristband && side === 1) sb.add(G.cyl(8), look.wristband, foreBone, { x: sx, y: wristY + 0.035 * s, sx: ar * 0.8, sy: 0.035 * s, sz: ar * 0.8 });
  }

  // ── 脚 ──
  for (const side of [1, -1] as const) {
    const thighBone = side === 1 ? B.thighL : B.thighR;
    const shinBone = side === 1 ? B.shinL : B.shinR;
    const lx = side * J.hipX;
    const hipY = hipsY - J.hipDown;
    const kneeY = hipY - J.thigh;
    const ankleY = kneeY - J.shin;
    const lr = (female ? 0.068 : 0.075) * Math.sqrt(w);
    limb(sb, look.pants, thighBone, lx, hipY + 0.03 * s, 0, lx, kneeY, 0, lr, lr * 0.8);
    limb(sb, look.pants, shinBone, lx, kneeY, 0, lx, ankleY + 0.02 * s, 0, lr * 0.78, lr * 0.62);
    // 靴
    sb.add(G.box(), look.shoes, shinBone, { x: lx, y: 0.035 * s, z: 0.035 * s, sx: 0.095 * s, sy: 0.07 * s, sz: 0.25 * s });
  }
  return { geo: sb.build(), J };
}

// ───────────────────────── マテリアル・名札 ─────────────────────────

function bodyMaterial(): THREE.MeshStandardMaterial {
  return cached('ch:mat', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }));
}

function makeLabel(text: string): THREE.Sprite {
  const tex = canvasTexture(
    256,
    64,
    (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.fillStyle = 'rgba(20,20,24,0.72)';
      const rr2 = 18;
      c.beginPath();
      c.moveTo(rr2, 4);
      c.lineTo(w - rr2, 4);
      c.quadraticCurveTo(w - 4, 4, w - 4, h / 2);
      c.quadraticCurveTo(w - 4, h - 4, w - rr2, h - 4);
      c.lineTo(rr2, h - 4);
      c.quadraticCurveTo(4, h - 4, 4, h / 2);
      c.quadraticCurveTo(4, 4, rr2, 4);
      c.fill();
      c.fillStyle = '#ffffff';
      c.font = `bold 34px ${JP_FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text.slice(0, 10), w / 2, h / 2 + 2, w - 24);
    },
    { mipmaps: false },
  );
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.56, 0.14, 1);
  sp.renderOrder = 30;
  return sp;
}

// ───────────────────────── 姿勢 ─────────────────────────

/** 骨ごとの回転目標（x,y,z）と腰の位置 */
interface PoseBuf {
  rot: Float32Array;
  hipsY: number;
  hipsZ: number;
}

function newPose(): PoseBuf {
  return { rot: new Float32Array(BONE_COUNT * 3), hipsY: 0, hipsZ: 0 };
}

function setRot(p: PoseBuf, bone: number, x: number, y: number, z: number): void {
  p.rot[bone * 3] = x;
  p.rot[bone * 3 + 1] = y;
  p.rot[bone * 3 + 2] = z;
}

// ───────────────────────── 公開 API ─────────────────────────

export function createCharacter(opts: CharacterOpts): CharacterModel {
  const look = chooseLook(opts);
  const { geo, J } = buildBody(look);
  const s = look.body.s;

  // 骨
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < BONE_COUNT; i++) bones.push(new THREE.Bone());
  const hipsY = J.hipsY;
  const waistY = hipsY + J.spineUp;
  const shoulderY = waistY + J.shoulderUp;
  const neckY = waistY + J.neckUp;
  const hipJointY = hipsY - J.hipDown;
  const kneeY = hipJointY - J.thigh;
  bones[B.hips]!.position.set(0, hipsY, 0);
  bones[B.spine]!.position.set(0, J.spineUp, 0);
  bones[B.head]!.position.set(0, neckY - waistY, 0);
  bones[B.armL]!.position.set(J.shoulderX, shoulderY - waistY, 0);
  bones[B.foreL]!.position.set(0, -J.upperArm, 0);
  bones[B.armR]!.position.set(-J.shoulderX, shoulderY - waistY, 0);
  bones[B.foreR]!.position.set(0, -J.upperArm, 0);
  bones[B.thighL]!.position.set(J.hipX, -J.hipDown, 0);
  bones[B.shinL]!.position.set(0, -J.thigh, 0);
  bones[B.thighR]!.position.set(-J.hipX, -J.hipDown, 0);
  bones[B.shinR]!.position.set(0, -J.thigh, 0);
  const link = (parent: number, child: number) => bones[parent]!.add(bones[child]!);
  link(B.root, B.hips);
  link(B.hips, B.spine);
  link(B.spine, B.head);
  link(B.spine, B.armL);
  link(B.armL, B.foreL);
  link(B.spine, B.armR);
  link(B.armR, B.foreR);
  link(B.hips, B.thighL);
  link(B.thighL, B.shinL);
  link(B.hips, B.thighR);
  link(B.thighR, B.shinR);
  void kneeY;

  const mesh = new THREE.SkinnedMesh(geo, bodyMaterial());
  mesh.add(bones[B.root]!);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // 座ると骨が動くので境界球を少し大きめに
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9 * s, 0.1), 1.25 * s);
  mesh.frustumCulled = true;

  const group = new THREE.Group();
  group.name = 'character';
  group.add(mesh);

  // 持ち物
  const heldAnchor = new THREE.Object3D();
  heldAnchor.position.set(0, 0.98 * s, 0.3);
  group.add(heldAnchor);
  const handR = new THREE.Object3D();
  handR.position.set(0, -J.forearm - 0.04 * s, 0);
  bones[B.foreR]!.add(handR);
  let heldKind: HeldKind | null = null;
  let heldObj: THREE.Object3D | null = null;
  // 食事中の箸
  const chopsticks = new THREE.Mesh(
    cached('ch:chop', () => {
      const g = new THREE.BoxGeometry(0.006, 0.006, 0.23);
      g.translate(0, 0, 0.08);
      return g;
    }),
    cached('ch:chopmat', () => new THREE.MeshStandardMaterial({ color: '#d8b880', roughness: 0.6 })),
  );
  chopsticks.rotation.x = 0.9;
  chopsticks.visible = false;
  handR.add(chopsticks);

  // 名札
  let label: THREE.Sprite | null = null;
  let labelText: string | null = null;

  const target = newPose();
  const cur = newPose();
  cur.hipsY = hipsY;
  target.hipsY = hipsY;
  let first = true;

  const seatHipsY = 0.62 + 0.075 * s + J.hipDown + 0.005;
  let eatM: EatMotion | null = null;

  function computePose(pose: CharacterPose, t: number, speed: number): void {
    target.rot.fill(0);
    target.hipsY = hipsY;
    target.hipsZ = 0;
    const ph = t * Math.PI * 2 * 1.7 + opts.seed;
    const breathe = Math.sin(t * 1.6 + opts.seed) * 0.015;
    const walking = pose === 'walk' || pose === 'carry';
    const amp = walking ? clamp(speed, 0, 1) : 0;
    // 脚
    if (pose === 'sit' || pose === 'eat' || pose === 'chat') {
      target.hipsY = seatHipsY;
      target.hipsZ = -0.06 * s;
      setRot(target, B.thighL, -1.5, 0, -0.05);
      setRot(target, B.thighR, -1.5, 0, 0.05);
      setRot(target, B.shinL, 1.85, 0, 0);
      setRot(target, B.shinR, 1.75, 0, 0);
    } else if (amp > 0) {
      const sw = Math.sin(ph) * 0.5 * amp;
      setRot(target, B.thighL, -sw, 0, 0);
      setRot(target, B.thighR, sw, 0, 0);
      setRot(target, B.shinL, Math.max(0, Math.sin(ph - 1.2)) * 0.8 * amp + 0.05, 0, 0);
      setRot(target, B.shinR, Math.max(0, -Math.sin(ph - 1.2)) * 0.8 * amp + 0.05, 0, 0);
      target.hipsY = hipsY - Math.abs(Math.cos(ph)) * 0.025 * amp;
    }
    // 上半身
    let spineX = breathe * 0.4;
    let headX = 0;
    if (pose === 'eat' && eatM) {
      // 丼に顔を近づける・麺を持ち上げる・すする・スープ・具（eat-motion.ts）
      spineX = eatM.lean;
      headX = eatM.head;
    } else if (pose === 'eat') {
      spineX = 0.32;
      headX = 0.32 + Math.max(0, Math.sin(t * 2.2 + opts.seed)) * 0.12;
    } else if (pose === 'chat') {
      // 背を起こし、隣の人の方を向いて話す
      spineX = 0.02;
      headX = 0.02 + Math.sin(t * 0.9 + opts.seed) * 0.05;
    } else if (pose === 'sit') {
      spineX = 0.08;
      headX = 0.05 + Math.sin(t * 0.4 + opts.seed) * 0.08;
    } else if (pose === 'work') {
      spineX = 0.16;
      headX = 0.28;
    } else if (amp > 0) {
      spineX = 0.05;
    }
    setRot(target, B.spine, spineX, amp > 0 ? Math.sin(ph) * 0.06 * amp : 0, 0);
    const headYaw = pose === 'chat' ? Math.sin(t * 0.35 + opts.seed * 5) * 0.7 : Math.sin(t * 0.5 + opts.seed * 3) * (pose === 'stand' ? 0.25 : 0.05);
    setRot(target, B.head, headX, headYaw, 0);
    // 腕
    const holding = heldKind === 'bowl' || heldKind === 'clean' || heldKind === 'dirty';
    if (pose === 'eat' && eatM) {
      // 右手（箸）の高さと、左手で丼を持ち上げる量。食べ終わったら箸を置いて手を膝へ
      const r = eatM.handR;
      const bl = eatM.bowlLift;
      setRot(target, B.armL, -0.95 - bl * 0.55, 0, -0.3 + bl * 0.15);
      setRot(target, B.foreL, -0.75 - bl * 0.6, 0, 0);
      if (eatM.phase === 'done') {
        setRot(target, B.armR, -0.55, 0, 0.18);
        setRot(target, B.foreR, -0.95, 0, 0);
      } else {
        setRot(target, B.armR, -0.7 - r * 0.55, 0, 0.25);
        setRot(target, B.foreR, -1.1 - r * 0.75, 0, 0);
      }
    } else if (pose === 'chat') {
      // 身ぶりを交えて話す
      const g = Math.max(0, Math.sin(t * 1.3 + opts.seed * 2));
      setRot(target, B.armL, -0.55, 0, -0.18);
      setRot(target, B.foreL, -0.95, 0, 0);
      setRot(target, B.armR, -0.55 - g * 0.35, 0, 0.18 + g * 0.2);
      setRot(target, B.foreR, -0.95 - g * 0.4, 0, 0);
    } else if (pose === 'eat') {
      // 左手は丼に添え、右手は箸を口元へ
      const lift = Math.max(0, Math.sin(t * 2.2 + opts.seed));
      setRot(target, B.armL, -0.95, 0, -0.3);
      setRot(target, B.foreL, -0.75, 0, 0);
      setRot(target, B.armR, -0.75 - lift * 0.35, 0, 0.25);
      setRot(target, B.foreR, -1.25 - lift * 0.55, 0, 0);
    } else if (pose === 'sit') {
      setRot(target, B.armL, -0.55, 0, -0.18);
      setRot(target, B.foreL, -0.95, 0, 0);
      setRot(target, B.armR, -0.55, 0, 0.18);
      setRot(target, B.foreR, -0.95, 0, 0);
    } else if (pose === 'work' && !holding) {
      const a = Math.sin(t * 6 + opts.seed);
      const b = Math.sin(t * 4.3 + opts.seed * 2);
      setRot(target, B.armL, -0.62 + b * 0.08, 0, -0.22);
      setRot(target, B.foreL, -1.0 + b * 0.15, 0, 0);
      setRot(target, B.armR, -0.7 + a * 0.18, 0, 0.22);
      setRot(target, B.foreR, -0.95 + a * 0.3, 0, 0);
    } else if (holding) {
      setRot(target, B.armL, -0.42, 0, -0.2);
      setRot(target, B.foreL, -1.05, 0, -0.35);
      setRot(target, B.armR, -0.42, 0, 0.2);
      setRot(target, B.foreR, -1.05, 0, 0.35);
    } else if (heldKind === 'mop') {
      setRot(target, B.armR, -0.45, 0, 0.12);
      setRot(target, B.foreR, -0.7, 0, 0);
      setRot(target, B.armL, -0.75, 0, -0.32);
      setRot(target, B.foreL, -0.9, 0, -0.2);
    } else if (heldKind === 'trash') {
      setRot(target, B.armR, Math.sin(ph) * 0.15 * amp, 0, -0.18);
      setRot(target, B.foreR, -0.1, 0, 0);
      setRot(target, B.armL, -Math.sin(ph) * 0.4 * amp, 0, 0.06);
      setRot(target, B.foreL, -0.15, 0, 0);
    } else if (heldKind === 'phone') {
      // スマホを胸の前で見る
      setRot(target, B.armR, -0.35, 0, 0.18);
      setRot(target, B.foreR, -1.35, 0, 0);
      setRot(target, B.armL, -Math.sin(ph) * 0.3 * amp, 0, 0.06);
      setRot(target, B.foreL, -0.15, 0, 0);
      headX = Math.max(headX, 0.3);
      setRot(target, B.head, headX, 0, 0);
    } else if (heldKind === 'tvcamera') {
      // 右手でカメラを肩に支え、左手でレンズに手を添える
      setRot(target, B.armR, -2.5, 0, 0.35);
      setRot(target, B.foreR, -1.3, 0, 0);
      setRot(target, B.armL, -1.25, 0, -0.35);
      setRot(target, B.foreL, -1.0, 0, 0);
      setRot(target, B.head, 0.05, 0.15, 0);
    } else if (heldKind === 'cigarette') {
      // ときどき口元へ運んで吸う
      const puff = Math.max(0, Math.sin(t * 0.8 + opts.seed)) ** 3;
      setRot(target, B.armR, -0.35 - puff * 0.55, 0, 0.12 + puff * 0.1);
      setRot(target, B.foreR, -1.0 - puff * 1.0, 0, 0);
      setRot(target, B.armL, 0.05, 0, 0.06);
      setRot(target, B.foreL, -0.1, 0, 0);
    } else if (heldKind === 'lostItem') {
      setRot(target, B.armR, -0.3, 0, 0.12);
      setRot(target, B.foreR, -1.1, 0, 0);
      setRot(target, B.armL, -Math.sin(ph) * 0.4 * amp, 0, 0.06);
      setRot(target, B.foreL, -0.15, 0, 0);
    } else {
      // 歩行の腕振り／立ち
      const sw = Math.sin(ph) * 0.45 * amp;
      setRot(target, B.armL, sw + breathe, 0, 0.07);
      setRot(target, B.armR, -sw - breathe, 0, -0.07);
      setRot(target, B.foreL, -0.12 - Math.max(0, sw) * 0.4, 0, 0);
      setRot(target, B.foreR, -0.12 - Math.max(0, -sw) * 0.4, 0, 0);
    }
    if (pose === 'down') {
      // 床に倒れて動かない（体ごと倒すのは update で行う）
      target.rot.fill(0);
      target.hipsY = hipsY;
      target.hipsZ = 0;
      setRot(target, B.armL, 0.2, 0, 0.9);
      setRot(target, B.armR, -0.3, 0, -1.1);
      setRot(target, B.foreL, -0.5, 0, 0);
      setRot(target, B.foreR, -0.2, 0, 0);
      setRot(target, B.thighL, 0.15, 0, -0.12);
      setRot(target, B.thighR, -0.25, 0, 0.1);
      setRot(target, B.shinR, 0.6, 0, 0);
      setRot(target, B.head, 0, 0.5, 0.3);
    }
    chopsticks.visible = pose === 'eat' && (eatM?.chopsticks ?? true);
  }

  function apply(k: number): void {
    for (let i = 0; i < cur.rot.length; i++) cur.rot[i]! += (target.rot[i]! - cur.rot[i]!) * k;
    cur.hipsY += (target.hipsY - cur.hipsY) * k;
    cur.hipsZ += (target.hipsZ - cur.hipsZ) * k;
    for (let b = 1; b < BONE_COUNT; b++) bones[b]!.rotation.set(cur.rot[b * 3]!, cur.rot[b * 3 + 1]!, cur.rot[b * 3 + 2]!);
    bones[B.hips]!.position.set(0, cur.hipsY, cur.hipsZ);
    // 手に持つ物は腰の上下に合わせる
    heldAnchor.position.y = 0.98 * s + (cur.hipsY - hipsY);
  }

  const model: CharacterModel = {
    group,
    heldAnchor,
    update(pose, t, dt, speed = 1) {
      computePose(pose, t, speed);
      apply(first || pose === 'down' ? 1 : clamp(dt * 12, 0, 1));
      first = false;
      // 倒れた人は体ごと床に寝かせる（位置は呼び出し側が毎フレーム足元に置き直す）
      if (pose === 'down') {
        group.rotation.order = 'YXZ';
        group.rotation.x = -1.48;
        group.position.y += 0.13 * s;
      } else if (group.rotation.x !== 0) group.rotation.x = 0;
    },
    setHeld(kind) {
      if (kind === heldKind) return;
      heldKind = kind;
      if (heldObj) {
        heldObj.removeFromParent();
        heldObj = null;
      }
      if (!kind || kind === 'bowl') return;
      const obj = createHeldItem(kind);
      if (kind === 'clean' || kind === 'dirty') {
        obj.position.set(0, 0, 0);
        heldAnchor.add(obj);
      } else if (kind === 'handcuffs') {
        // 手錠は胸の前（両手を前に出した姿勢で使う）
        obj.position.set(0, -0.08 * s, 0.06);
        heldAnchor.add(obj);
      } else if (kind === 'tvcamera') {
        // 右肩にかつぐ
        obj.position.set(0.17 * s, 0.55 * s, -0.22);
        heldAnchor.add(obj);
      } else if (kind === 'mop') {
        // 柄を右手で握り、モップ先は前方の床へ
        obj.rotation.set(-0.35, 0, 0.25);
        handR.add(obj);
      } else if (kind === 'trash') {
        obj.position.set(0, 0.02, 0);
        handR.add(obj);
      } else {
        obj.position.set(0, -0.02, 0.02);
        handR.add(obj);
      }
      heldObj = obj;
    },
    setEat(m) {
      eatM = m;
    },
    setLabel(text) {
      if (text === labelText) return;
      labelText = text;
      if (label) {
        label.removeFromParent();
        label.material.map?.dispose();
        label.material.dispose();
        label = null;
      }
      if (text) {
        label = makeLabel(text);
        label.position.set(0, 1.78 * s + 0.22, 0);
        group.add(label);
      }
    },
    dispose() {
      geo.dispose();
      skeleton.dispose();
      if (label) {
        label.material.map?.dispose();
        label.material.dispose();
      }
      group.removeFromParent();
    },
  };
  return model;
}
