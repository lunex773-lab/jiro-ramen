// 設備モデルの共通部品: ステンレスの台・キャビネット・ガス台・釜の開口・寸胴・泡など。
// 形の定義は「正面（作業者側）= -Z、床 = y0、中心 = 原点」。

import * as THREE from 'three';
import type { Equipment, GameState } from '@jiro/core';
import { cached, clamp, GeoBuilder, makeRng, rr, tmp, type Disposable } from './common';
import { MAT, plastic, glow } from './materials';
import { canvasTexture, sharedTexture, JP_FONT, texSoup, texEnv } from './textures';
import { createIndicator, IND_COLORS, type Indicator } from './fx';

export type Parts = { geo: THREE.BufferGeometry; mat: THREE.Material }[];
export type Updater = (e: Equipment, s: GameState, t: number, dt: number) => void;

/** 設備1台分の組み立て文脈 */
export interface EqCtx {
  type: string;
  W: number;
  D: number;
  H: number;
  group: THREE.Group;
  owned: Disposable[];
  updaters: Updater[];
  bowlAnchors: THREE.Vector3[];
  topY: number;
  /** 状態ランプの位置（既定: 天板の右手前） */
  lampPos: THREE.Vector3;
}

/** 種類ごとに静的な部品を1度だけ結合してキャッシュし、インスタンスには Mesh だけ追加する */
export function addStatic(c: EqCtx, key: string, make: (b: GeoBuilder) => void, cast = true): void {
  const parts = cached('eqs:' + key, () => {
    const b = new GeoBuilder();
    make(b);
    return b.merged();
  });
  for (const { geo, mat } of parts) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    c.group.add(m);
  }
}

export function partsMesh(parts: Parts, cast = true): THREE.Group {
  const g = new THREE.Group();
  for (const { geo, mat } of parts) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

export function cachedParts(key: string, make: (b: GeoBuilder) => void): Parts {
  return cached('eqp:' + key, () => {
    const b = new GeoBuilder();
    make(b);
    return b.merged();
  });
}

// ───────────────────────── 形の部品 ─────────────────────────

/** 調整脚 */
export function feet(b: GeoBuilder, W: number, D: number, h = 0.1): void {
  const dx = W / 2 - 0.05;
  const dz = D / 2 - 0.05;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.cyl(MAT.steelDark(), 0.018, 0.018, h, 8, { x: sx * dx, z: sz * dz });
    b.cyl(MAT.rubber(), 0.024, 0.024, 0.012, 8, { x: sx * dx, z: sz * dz });
  }
}

/** ステンレスの扉付きキャビネット（天板込み）。doors=扉の枚数 */
export function cabinet(b: GeoBuilder, W: number, D: number, H: number, o: { doors?: number; backsplash?: boolean; top?: boolean; handleY?: number; hollow?: boolean } = {}): void {
  const kick = 0.1;
  const topT = 0.035;
  feet(b, W, D, kick);
  const bh = H - kick - topT;
  if (o.hollow) {
    // 上に開口がある設備用: 天面のない箱（側板・前板・背板・底板）
    b.box(MAT.steel(), W - 0.02, bh, 0.012, { y: kick + bh / 2, z: -D / 2 + 0.021 });
    b.box(MAT.steel(), W - 0.02, bh, 0.012, { y: kick + bh / 2, z: D / 2 - 0.021 });
    b.box(MAT.steel(), 0.012, bh, D - 0.03, { x: -W / 2 + 0.016, y: kick + bh / 2 });
    b.box(MAT.steel(), 0.012, bh, D - 0.03, { x: W / 2 - 0.016, y: kick + bh / 2 });
    b.box(MAT.steelDark(), W - 0.02, 0.012, D - 0.03, { y: kick + 0.006 });
  } else {
    b.box(MAT.steel(), W - 0.02, bh, D - 0.03, { y: kick + bh / 2 });
  }
  if (o.top !== false) {
    b.box(MAT.steel(), W, topT, D, { y: H - topT / 2 });
    // 天板の前縁（折り返し）
    b.box(MAT.steelDark(), W, 0.04, 0.012, { y: H - 0.02, z: -D / 2 - 0.004 });
  }
  if (o.backsplash) b.box(MAT.steel(), W, 0.12, 0.02, { y: H + 0.06, z: D / 2 - 0.01 });
  const n = o.doors ?? 2;
  if (n > 0) {
    const dw = (W - 0.06) / n;
    const dh = H - kick - topT - 0.07;
    for (let i = 0; i < n; i++) {
      const x = -W / 2 + 0.03 + dw * (i + 0.5);
      b.box(MAT.steel(), dw - 0.012, dh, 0.012, { x, y: kick + 0.03 + dh / 2, z: -D / 2 + 0.006 });
      // 取っ手（扉の内側寄り）
      const hx = x + (i % 2 === 0 ? dw / 2 - 0.05 : -dw / 2 + 0.05);
      b.box(MAT.steelDark(), 0.018, Math.min(0.25, dh * 0.5), 0.022, { x: hx, y: o.handleY ?? kick + 0.03 + dh * 0.62, z: -D / 2 - 0.006 });
    }
  }
}

/** 脚付きの作業台（下棚あり） */
export function workTable(b: GeoBuilder, W: number, D: number, H: number, o: { backsplash?: boolean; shelf?: boolean } = {}): void {
  const topT = 0.035;
  b.box(MAT.steel(), W, topT, D, { y: H - topT / 2 });
  b.box(MAT.steelDark(), W, 0.04, 0.012, { y: H - 0.02, z: -D / 2 - 0.004 });
  if (o.backsplash !== false) b.box(MAT.steel(), W, 0.1, 0.02, { y: H + 0.05, z: D / 2 - 0.01 });
  const dx = W / 2 - 0.04;
  const dz = D / 2 - 0.04;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.cyl(MAT.steelDark(), 0.02, 0.02, H - topT, 8, { x: sx * dx, z: sz * dz });
    b.cyl(MAT.rubber(), 0.024, 0.024, 0.015, 8, { x: sx * dx, z: sz * dz });
  }
  if (o.shelf !== false) {
    b.box(MAT.steel(), W - 0.06, 0.02, D - 0.06, { y: 0.18 });
    // 横桟
    b.box(MAT.steelDark(), W - 0.08, 0.025, 0.025, { y: 0.17, z: -dz });
    b.box(MAT.steelDark(), W - 0.08, 0.025, 0.025, { y: 0.17, z: dz });
  }
}

/** 低いガス台（五徳とバーナー）。上面の高さ h */
export function gasStand(b: GeoBuilder, W: number, D: number, h: number, burnerR: number): void {
  feet(b, W, D, 0.1);
  b.box(MAT.steel(), W - 0.02, h - 0.14, D - 0.04, { y: 0.1 + (h - 0.14) / 2 });
  b.box(MAT.steelDark(), W, 0.04, D, { y: h - 0.04 + 0.02 - 0.02 });
  // 前面のつまみとパイロット窓
  for (const x of [-0.12, 0.12]) {
    b.cyl(MAT.black(), 0.03, 0.03, 0.03, 12, { x, y: h * 0.62, z: -D / 2 + 0.01, rx: -Math.PI / 2 });
    b.box(MAT.steelPolished(), 0.012, 0.035, 0.012, { x, y: h * 0.62, z: -D / 2 - 0.022 });
  }
  b.box(MAT.darkPanel(), 0.08, 0.04, 0.01, { y: h * 0.4, z: -D / 2 + 0.005 });
  // 五徳
  const ring = new THREE.TorusGeometry(burnerR, 0.012, 5, 20);
  ring.rotateX(Math.PI / 2);
  b.add(MAT.castIron(), ring, { y: h + 0.02 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    b.box(MAT.castIron(), burnerR * 0.9, 0.025, 0.02, { x: Math.cos(a) * burnerR * 0.55, y: h + 0.025, z: Math.sin(a) * burnerR * 0.55, ry: -a });
  }
  b.cyl(MAT.castIron(), burnerR * 0.35, burnerR * 0.4, 0.04, 14, { y: h - 0.01 });
}

/** 角の丸い開口（w=d なら円） */
export function basinShape(w: number, d: number): THREE.Shape {
  const s = new THREE.Shape();
  const r = Math.min(w, d) / 2;
  if (Math.abs(w - d) < 1e-6) {
    s.absarc(0, 0, r, 0, Math.PI * 2, false);
    return s;
  }
  const hx = w / 2 - r;
  s.moveTo(-hx, -r);
  s.lineTo(hx, -r);
  s.absarc(hx, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(-hx, r);
  s.absarc(-hx, 0, r, Math.PI / 2, (Math.PI * 3) / 2, false);
  return s;
}

/** 開口のある天板（XZ 平面, 上面 y） */
export function plateWithHole(b: GeoBuilder, mat: THREE.Material, W: number, D: number, y: number, thick: number, hole: THREE.Shape, holeOffZ = 0): void {
  const s = new THREE.Shape();
  s.moveTo(-W / 2, -D / 2);
  s.lineTo(W / 2, -D / 2);
  s.lineTo(W / 2, D / 2);
  s.lineTo(-W / 2, D / 2);
  s.lineTo(-W / 2, -D / 2);
  const hp = new THREE.Path(hole.getPoints(24).map((p) => new THREE.Vector2(p.x, p.y + holeOffZ)));
  s.holes.push(hp);
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 16 });
  // Shape の y を +Z に、押し出しを +Y に
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  b.add(mat, g, { uv: 0.6 });
}

/** 開口の内壁（内向きの法線） */
export function innerWall(b: GeoBuilder, mat: THREE.Material, hole: THREE.Shape, y0: number, y1: number, offZ = 0, bottom = true): void {
  const pts = hole.getPoints(24);
  const pos: number[] = [];
  const idx: number[] = [];
  const n = pts.length;
  for (const p of pts) {
    pos.push(p.x, y1, p.y + offZ, p.x, y0, p.y + offZ);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const c = (i + 1) * 2;
    idx.push(a, a + 1, c, c, a + 1, c + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 法線が外向きなら反転（開口の中心から見て内側を向かせる）
  const nor = g.attributes.normal!;
  const p0 = pts[0]!;
  if (nor.getX(0) * p0.x + nor.getZ(0) * p0.y > 0) {
    const ix = g.index!;
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, t);
    }
    g.computeVertexNormals();
  }
  b.add(mat, g, { uv: 0.5 });
  if (bottom) {
    const sg = new THREE.ShapeGeometry(hole, 16);
    sg.rotateX(-Math.PI / 2);
    // ShapeGeometry の y → -z になるので反転
    sg.scale(1, 1, -1);
    const ix = sg.index!;
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, t);
    }
    sg.computeVertexNormals();
    sg.translate(0, y0, offZ);
    b.add(MAT.steelDark(), sg);
  }
}

/** 面を裏返す（内側から見る円筒など）。巻き順と法線を反転する */
export function insideOut(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const ix = g.index;
  if (ix) {
    for (let i = 0; i < ix.count; i += 3) {
      const t = ix.getX(i + 1);
      ix.setX(i + 1, ix.getX(i + 2));
      ix.setX(i + 2, t);
    }
  }
  const n = g.attributes.normal;
  if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  return g;
}

/** 円形の水面などに使う円盤ジオメトリ（半径1） */
export function disc(seg = 32): THREE.BufferGeometry {
  return cached('eqdisc' + seg, () => {
    const g = new THREE.CircleGeometry(1, seg);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

/** 寸胴・鍋（外側・内壁・縁・取っ手）。y0=底, r=半径, h=高さ */
export function potBody(b: GeoBuilder, x: number, y0: number, z: number, r: number, h: number, handles = true): void {
  b.cyl(MAT.steelPolished(), r, r * 0.98, h, 24, { x, y: y0, z, open: true });
  const inner = insideOut(new THREE.CylinderGeometry(r - 0.006, r - 0.006, h - 0.01, 24, 1, true));
  inner.translate(x, y0 + 0.01 + (h - 0.01) / 2, z);
  b.add(MAT.steel(), inner);
  const bottom = new THREE.CircleGeometry(r - 0.006, 24);
  bottom.rotateX(-Math.PI / 2);
  bottom.translate(x, y0 + 0.012, z);
  b.add(MAT.steelDark(), bottom);
  const rim = new THREE.TorusGeometry(r, 0.008, 5, 28);
  rim.rotateX(Math.PI / 2);
  rim.translate(x, y0 + h, z);
  b.add(MAT.steelPolished(), rim);
  if (handles) {
    for (const sx of [-1, 1]) {
      const hdl = new THREE.TorusGeometry(0.045, 0.01, 5, 10, Math.PI);
      hdl.rotateY(sx > 0 ? -Math.PI / 2 : Math.PI / 2);
      hdl.translate(x + sx * r, y0 + h - 0.06, z);
      b.add(MAT.steelPolished(), hdl);
    }
  }
}

/** 正面の銘板（設備名の小さなプレート） */
export function namePlate(text: string): THREE.Material {
  return cached('plate:' + text, () =>
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 64, (c, w, h) => {
        c.fillStyle = '#1d2229';
        c.fillRect(0, 0, w, h);
        c.strokeStyle = '#9aa3ab';
        c.lineWidth = 3;
        c.strokeRect(3, 3, w - 6, h - 6);
        c.fillStyle = '#e8edf2';
        c.font = `bold 30px ${JP_FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(text, w / 2, h / 2 + 1, w - 20);
      }),
      roughness: 0.4,
      metalness: 0.3,
    }),
  );
}

// ───────────────────────── 液面・泡 ─────────────────────────

/** 沸いた湯の表面（泡と白濁）。tickEquipmentFx でスクロールさせる */
export function texBoil(): THREE.CanvasTexture {
  return sharedTexture(
    'boil',
    256,
    256,
    (c, w, h) => {
      c.fillStyle = '#8fa2a3';
      c.fillRect(0, 0, w, h);
      const r = makeRng(201);
      for (let i = 0; i < 300; i++) {
        const x = r() * w;
        const y = r() * h;
        const rad = rr(r, 2, 12);
        for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
          c.strokeStyle = `rgba(255,255,255,${rr(r, 0.5, 0.95).toFixed(2)})`;
          c.lineWidth = rr(r, 1.5, 3);
          c.beginPath();
          c.arc(x + dx, y + dy, rad, 0, Math.PI * 2);
          c.stroke();
        }
      }
      for (let i = 0; i < 40; i++) {
        const x = r() * w;
        const y = r() * h;
        const g = c.createRadialGradient(x, y, 0, x, y, rr(r, 10, 30));
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, w, h);
      }
    },
    { repeat: true },
  );
}

export const EQ_MAT = {
  boilWater: () =>
    cached('eqm:boil', () =>
      new THREE.MeshStandardMaterial({ map: texBoil(), color: '#ffffff', roughness: 0.1, metalness: 0, envMap: texEnv(), envMapIntensity: 0.7, transparent: true, opacity: 0.93 }),
    ),
  soup: () =>
    cached('eqm:soup', () => new THREE.MeshStandardMaterial({ map: texSoup(), color: '#d6cbbb', roughness: 0.15, metalness: 0, envMap: texEnv(), envMapIntensity: 0.5 })),
  braise: () => cached('eqm:braise', () => new THREE.MeshStandardMaterial({ color: '#3a1e0c', roughness: 0.1, metalness: 0, envMap: texEnv(), envMapIntensity: 0.6 })),
  bubble: () =>
    cached('eqm:bubble', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.05, transparent: true, opacity: 0.6, envMap: texEnv(), envMapIntensity: 0.8 })),
  flame: () => glow('#4a8cff', 2.4),
  porkBlock: () => cached('eqm:porkblock', () => new THREE.MeshStandardMaterial({ color: '#5c3018', roughness: 0.35, metalness: 0, envMap: texEnv(), envMapIntensity: 0.4 })),
};

/** 液面で弾ける泡（InstancedMesh, 毎フレーム行列を書き換える。確保なし） */
export interface Bubbles {
  mesh: THREE.InstancedMesh;
  update(t: number, intensity: number, y: number): void;
}

export function createBubbles(count: number, rx: number, rz: number, seed: number, owned: Disposable[], round = true): Bubbles {
  const geo = cached('bubblegeo', () => new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2));
  const mesh = new THREE.InstancedMesh(geo, EQ_MAT.bubble(), count);
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  owned.push(mesh);
  const r = makeRng(seed);
  const px = new Float32Array(count);
  const pz = new Float32Array(count);
  const ph = new Float32Array(count);
  const sz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * 0.85;
    px[i] = round ? Math.cos(a) * d * rx : (r() * 2 - 1) * rx * 0.9;
    pz[i] = round ? Math.sin(a) * d * rz : (r() * 2 - 1) * rz * 0.85;
    ph[i] = r();
    sz[i] = rr(r, 0.6, 1.4);
  }
  return {
    mesh,
    update(t, intensity, y) {
      mesh.visible = intensity > 0.01;
      if (!mesh.visible) return;
      for (let i = 0; i < count; i++) {
        const life = (t * (0.8 + intensity * 1.6) + ph[i]!) % 1;
        const s = Math.sin(life * Math.PI) * 0.018 * sz[i]! * clamp(intensity, 0.2, 1.5);
        tmp.m.makeScale(s + 1e-5, s * 0.8 + 1e-5, s + 1e-5);
        tmp.m.setPosition(px[i]!, y, pz[i]!);
        mesh.setMatrixAt(i, tmp.m);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}

// ───────────────────────── 進捗表示 ─────────────────────────

export function addIndicator(c: EqCtx, mode: 'ring' | 'bar', size: number, pos: THREE.Vector3): Indicator {
  const ind = createIndicator(mode, size);
  ind.mesh.position.copy(pos);
  ind.mesh.visible = false;
  c.group.add(ind.mesh);
  c.owned.push(ind);
  return ind;
}

/** 鍋の工程（e.process）の進捗バー */
export function processBar(c: EqCtx, y: number): Updater {
  const bar = addIndicator(c, 'bar', 0.42, new THREE.Vector3(0, y, 0));
  return (e) => {
    const p = e.process;
    bar.mesh.visible = !!p;
    if (p) bar.set(clamp(p.elapsed / Math.max(0.01, p.duration), 0, 1), p.elapsed >= p.duration ? IND_COLORS.green : IND_COLORS.orange);
  };
}

export { MAT, plastic, glow };
