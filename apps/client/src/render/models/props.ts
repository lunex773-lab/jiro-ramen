// 小物: 手に持つ物（一人称の手元・人物の手）、忘れ物、床の汚れ。
// ジオメトリとマテリアルは共有し、呼び出しごとに軽い Mesh/Group だけ作る（dispose 不要）。

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cached, GeoBuilder, makeRng, meshesFromMerged, rr } from './common';
import { MAT, plastic } from './materials';
import { BOWL_DIMS, bowlDirtyPool, bowlShellGeometry, bowlStainGeometry, bowlStainMaterial } from './bowl';
import { canvasTexture, JP_FONT, texGrime, texSpill } from './textures';

export type HeldKind = 'bowl' | 'clean' | 'dirty' | 'mop' | 'lostItem' | 'trash';

type Parts = { geo: THREE.BufferGeometry; mat: THREE.Material }[];

function instantiate(parts: Parts, cast = true): THREE.Group {
  const g = new THREE.Group();
  for (const { geo, mat } of parts) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

/** 丼を n 個重ねたジオメトリ（共有） */
export function bowlStackGeometry(n: number): THREE.BufferGeometry {
  return cached('bowlstack' + n, () => {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const g = bowlShellGeometry('low').clone();
      g.translate(0, i * BOWL_DIMS.stackStep, 0);
      parts.push(g);
    }
    return mergeGeometries(parts, false)!;
  });
}

function dirtyStackParts(n: number): Parts {
  return cached('dirtystack' + n, () => {
    const stains: THREE.BufferGeometry[] = [];
    for (let i = 0; i < n; i++) {
      const g = bowlStainGeometry().clone();
      g.translate(0, i * BOWL_DIMS.stackStep, 0);
      stains.push(g);
    }
    const pool = bowlDirtyPool();
    const pg = pool.geo.clone();
    pg.scale(pool.r, 1, pool.r);
    pg.translate(0, pool.y + (n - 1) * BOWL_DIMS.stackStep, 0);
    // 箸とレンゲを一番上の丼に
    const b = new GeoBuilder();
    const top = (n - 1) * BOWL_DIMS.stackStep;
    b.box(plastic('#d8b880', 0.6), 0.006, 0.006, 0.23, { x: 0.02, y: top + 0.07, z: 0.0, ry: 0.3, rx: -0.25 });
    b.box(plastic('#d8b880', 0.6), 0.006, 0.006, 0.23, { x: 0.035, y: top + 0.07, z: 0.0, ry: 0.36, rx: -0.25 });
    const extra = b.merged();
    return [
      { geo: bowlStackGeometry(n), mat: MAT.ceramic() },
      { geo: mergeGeometries(stains, false)!, mat: bowlStainMaterial() },
      { geo: pg, mat: pool.mat },
      ...extra,
    ];
  });
}

function mopParts(): Parts {
  return cached('mop', () => {
    const b = new GeoBuilder();
    const handle = plastic('#2f7fd0', 0.4);
    // 原点=握る位置。柄は -Y 方向へ
    b.cyl(MAT.steelPolished(), 0.012, 0.012, 1.3, 8, { y: -1.05 });
    b.cyl(handle, 0.016, 0.016, 0.22, 8, { y: -0.1 });
    b.cyl(handle, 0.016, 0.016, 0.16, 8, { y: -0.75 });
    // ヘッドと房
    b.box(plastic('#3a3a3a', 0.5), 0.32, 0.03, 0.06, { y: -1.07 });
    const r = makeRng(5);
    const fr = plastic('#e8e4d8', 0.95);
    for (let i = 0; i < 14; i++) {
      const x = -0.15 + (i / 13) * 0.3;
      b.box(fr, 0.022, 0.1, 0.022, { x, y: -1.13, z: rr(r, -0.025, 0.025), rx: rr(r, -0.4, 0.4), rz: rr(r, -0.3, 0.3) });
    }
    return b.merged();
  });
}

function trashParts(): Parts {
  return cached('trashbag', () => {
    let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    g = mergeVertices(g);
    const p = g.attributes.position!;
    const r = makeRng(9);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const k = rr(r, 0.9, 1.08);
      // 上ほど細く（結び目に向かってすぼまる）
      const taper = y > 0.3 ? 1 - (y - 0.3) * 0.9 : 1;
      p.setXYZ(i, x * 0.2 * k * taper, y * 0.24 - 0.27, z * 0.18 * k * taper);
    }
    g.computeVertexNormals();
    const bag = std('trashbag', { color: '#e9ece6', roughness: 0.35, metalness: 0, transparent: true, opacity: 0.94 });
    const b = new GeoBuilder();
    b.add(bag, g);
    b.add(bag, new THREE.SphereGeometry(0.03, 8, 6), { y: -0.02 });
    b.add(bag, new THREE.ConeGeometry(0.03, 0.06, 6), { x: 0.025, y: 0.01, rz: -0.6 });
    b.add(bag, new THREE.ConeGeometry(0.03, 0.06, 6), { x: -0.025, y: 0.01, rz: 0.6 });
    return b.merged();
  });
}

function std(key: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return cached('pmat:' + key, () => new THREE.MeshStandardMaterial(p));
}

/** 預かった忘れ物（汎用）: 紙袋。原点=持ち手 */
function lostBagParts(): Parts {
  return cached('lostbag', () => {
    const b = new GeoBuilder();
    const paper = std('kraft', { color: '#b88a58', roughness: 0.9 });
    b.box(paper, 0.2, 0.22, 0.09, { y: -0.17 });
    b.box(std('tag', { color: '#f4e04a', roughness: 0.6 }), 0.05, 0.03, 0.002, { x: 0.05, y: -0.08, z: 0.046 });
    b.add(paper, new THREE.TorusGeometry(0.035, 0.005, 4, 10, Math.PI), { y: -0.06, z: 0.03 });
    b.add(paper, new THREE.TorusGeometry(0.035, 0.005, 4, 10, Math.PI), { y: -0.06, z: -0.03 });
    return b.merged();
  });
}

/**
 * 手に持つ物。一人称の手元表示と、人物の手（setHeld）で共用する。
 * 'bowl' は呼び出し側が本物の BowlModel を使うので空の Group を返す。
 * 原点: 丼の山=底の中心、モップ/ゴミ袋/忘れ物=握る位置。
 */
export function createHeldItem(kind: HeldKind): THREE.Object3D {
  switch (kind) {
    case 'bowl':
      return new THREE.Group();
    case 'clean': {
      const g = new THREE.Group();
      const m = new THREE.Mesh(bowlStackGeometry(4), MAT.ceramic());
      m.castShadow = true;
      g.add(m);
      return g;
    }
    case 'dirty':
      return instantiate(dirtyStackParts(3));
    case 'mop': {
      const outer = new THREE.Group();
      const inner = instantiate(mopParts());
      // 一人称で柄が前下へ伸びるように少し倒す
      inner.rotation.x = 0.5;
      outer.add(inner);
      return outer;
    }
    case 'trash':
      return instantiate(trashParts());
    case 'lostItem':
      return instantiate(lostBagParts());
  }
}

// ───────────────────────── 忘れ物 ─────────────────────────

function bookCover(): THREE.Texture {
  return cached('tex:bookcover', () =>
    canvasTexture(128, 192, (c, w, h) => {
      c.fillStyle = '#3d5f8a';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#f2ead8';
      c.fillRect(10, 10, w - 20, 70);
      c.fillStyle = '#222';
      c.font = `bold 22px ${JP_FONT}`;
      c.textAlign = 'center';
      c.fillText('麺の道', w / 2, 52);
      c.font = `14px ${JP_FONT}`;
      c.fillText('文庫', w / 2, 72);
      c.fillStyle = '#e8c35a';
      c.fillRect(0, h - 30, w, 8);
    }),
  );
}

function lostParts(kind: string): Parts {
  return cached('lost:' + kind, () => {
    const b = new GeoBuilder();
    switch (kind) {
      case '傘': {
        const cloth = plastic('#1f2d4a', 0.6);
        // 閉じた傘を横置き（X 方向）
        b.add(cloth, new THREE.ConeGeometry(0.035, 0.55, 8), { x: 0.0, y: 0.035, rz: Math.PI / 2 });
        b.cyl(MAT.steelDark(), 0.005, 0.005, 0.12, 6, { x: -0.27, y: 0.035, rz: Math.PI / 2 });
        b.add(plastic('#4a3020', 0.5), new THREE.TorusGeometry(0.04, 0.009, 6, 10, Math.PI), { x: 0.3, y: 0.045, rz: Math.PI / 2, rx: Math.PI / 2 });
        b.cyl(plastic('#4a3020', 0.5), 0.011, 0.011, 0.08, 6, { x: 0.22, y: 0.035, rz: Math.PI / 2 });
        break;
      }
      case '手袋': {
        const knit = plastic('#5a5e66', 0.95);
        for (const [x, ry] of [[-0.05, 0.3], [0.05, -0.2]] as const) {
          b.box(knit, 0.085, 0.022, 0.1, { x, y: 0.011 + (x > 0 ? 0.02 : 0), ry });
          for (let i = 0; i < 4; i++) b.box(knit, 0.018, 0.018, 0.06, { x: x - 0.03 + i * 0.02, y: 0.011 + (x > 0 ? 0.02 : 0), z: 0.075, ry });
          b.box(knit, 0.02, 0.018, 0.05, { x: x + 0.05, y: 0.011 + (x > 0 ? 0.02 : 0), z: 0.02, ry: ry - 0.6 });
        }
        break;
      }
      case 'マフラー': {
        const a = plastic('#9c2a2a', 0.95);
        const c2 = plastic('#d8cfc0', 0.95);
        for (let i = 0; i < 3; i++) {
          b.box(i % 2 === 0 ? a : c2, 0.22, 0.016, 0.16, { y: 0.008 + i * 0.016, ry: i * 0.05 });
        }
        for (let i = 0; i < 8; i++) b.box(a, 0.006, 0.004, 0.03, { x: -0.1 + i * 0.028, y: 0.004, z: 0.095 });
        break;
      }
      case 'キーケース': {
        b.add(plastic('#6a3a1e', 0.5), new THREE.CapsuleGeometry(0.025, 0.06, 4, 8), { y: 0.012, rz: Math.PI / 2, sy: 1, sz: 0.4 });
        b.add(MAT.steelPolished(), new THREE.TorusGeometry(0.018, 0.0025, 5, 14), { x: 0.07, y: 0.003, rx: Math.PI / 2 });
        b.box(MAT.steelPolished(), 0.05, 0.003, 0.012, { x: 0.105, y: 0.003, z: 0.01, ry: 0.4 });
        break;
      }
      case '帽子': {
        const cap = plastic('#26365a', 0.8);
        b.add(cap, new THREE.SphereGeometry(0.09, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), { sy: 0.7 });
        b.box(cap, 0.15, 0.008, 0.09, { z: 0.11, y: 0.004 });
        b.cyl(plastic('#f0f0f0', 0.6), 0.012, 0.012, 0.01, 8, { y: 0.06 });
        break;
      }
      case 'イヤホンケース': {
        b.add(plastic('#f4f4f2', 0.25), new THREE.CapsuleGeometry(0.022, 0.03, 4, 10), { y: 0.022, rz: Math.PI / 2, sz: 0.55 });
        b.box(plastic('#cfcfcf', 0.3), 0.074, 0.002, 0.026, { y: 0.03 });
        break;
      }
      case '文庫本': {
        const cover = std('bookcover', { map: bookCover(), roughness: 0.7 });
        b.box(plastic('#f2eee2', 0.9), 0.104, 0.014, 0.146, { y: 0.008 });
        b.add(cover, new THREE.PlaneGeometry(0.106, 0.148), { y: 0.0152, rx: -Math.PI / 2 });
        b.box(plastic('#3d5f8a', 0.7), 0.106, 0.0015, 0.148, { y: 0.0008 });
        break;
      }
      case '水筒': {
        b.cyl(MAT.steelPolished(), 0.034, 0.034, 0.2, 14, {});
        b.cyl(plastic('#2a7a5a', 0.4), 0.034, 0.034, 0.12, 14, { y: 0.04 });
        b.cyl(plastic('#222222', 0.4), 0.03, 0.033, 0.04, 14, { y: 0.2 });
        break;
      }
      default: {
        b.box(plastic('#8a6a4a', 0.7), 0.1, 0.05, 0.07, { y: 0.025 });
      }
    }
    return b.merged();
  });
}

/** 忘れ物（core LOST_ITEM_KINDS）。原点=底面中心（カウンターに置く） */
export function createLostItem(kind: string): THREE.Object3D {
  const g = instantiate(lostParts(kind));
  g.name = 'lost:' + kind;
  return g;
}

// ───────────────────────── 床の汚れ ─────────────────────────

function decalGeometry(size: number): THREE.BufferGeometry {
  return cached('decal' + size, () => {
    const g = new THREE.PlaneGeometry(size, size);
    g.rotateX(-Math.PI / 2);
    g.translate(0, 0.001, 0);
    return g;
  });
}

const DIRT_MAT = {
  grime: () =>
    cached('mat:grime', () =>
      new THREE.MeshStandardMaterial({
        map: texGrime(),
        transparent: true,
        depthWrite: false,
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    ),
  spill: () =>
    cached('mat:spill', () =>
      new THREE.MeshStandardMaterial({
        map: texSpill(),
        transparent: true,
        depthWrite: false,
        roughness: 0.06,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      }),
    ),
};

/** 床の汚れ（油汚れ / こぼれたスープ）。原点=床 */
export function createDirt(kind: 'grime' | 'spill'): THREE.Object3D {
  const m = new THREE.Mesh(decalGeometry(kind === 'grime' ? 0.7 : 0.55), kind === 'grime' ? DIRT_MAT.grime() : DIRT_MAT.spill());
  m.receiveShadow = true;
  m.renderOrder = 1;
  m.rotation.y = Math.random() * Math.PI * 2;
  return m;
}

export { meshesFromMerged };
