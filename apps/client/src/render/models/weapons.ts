// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり）。
// 武器の形（手に持つ・棚に並べる）と、店の右の横の壁の外の物置（壁と同じ見た目の隠し扉・中の武器の棚）
import * as THREE from 'three';
import { armoryRect, CELL, STORE_WALL_T, WEAPON_IDS, type StageDef } from '@jiro/core';
import { CEILING_Y } from './shop';
import { cached, GeoBuilder, meshesFromMerged, type Disposable } from './common';
import { MAT, plastic } from './materials';

type Parts = { geo: THREE.BufferGeometry; mat: THREE.Material }[];

function std(key: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return cached('weaponmat:' + key, () => new THREE.MeshStandardMaterial(p));
}

const WM = {
  blade: () => std('blade', { color: '#d8dde2', metalness: 0.9, roughness: 0.18 }),
  gunMetal: () => std('gunMetal', { color: '#2b2d31', metalness: 0.7, roughness: 0.35 }),
  wood: () => std('wood', { color: '#6b4426', roughness: 0.6 }),
  grip: () => plastic('#151515', 0.8),
  wrap: () => std('wrap', { color: '#2a2440', roughness: 0.9 }),
  alu: () => std('bat', { color: '#c9ccd2', metalness: 0.75, roughness: 0.3 }),
  rust: () => std('pipe', { color: '#6d6a66', metalness: 0.55, roughness: 0.6 }),
  bomb: () => std('bomb', { color: '#1c1c1e', metalness: 0.2, roughness: 0.55 }),
  fuse: () => std('fuse', { color: '#c8b48a', roughness: 0.9 }),
  // 店の横の壁と同じ色（shop.ts の腰板・しっくい・見切り）
  wainscot: () => std('wainscot', { color: '#6a4a30', roughness: 0.6 }),
  plaster: () => MAT.plaster(),
  trim: () => MAT.woodLight(),
  seam: () => std('seam', { color: '#4b3a2c', roughness: 0.85 }),
  dark: () => std('closet', { color: '#141110', roughness: 1 }),
  board: () => std('board', { color: '#4d4237', roughness: 0.85 }),
  // 通りに面した端は店の正面と同じ色（shop.ts の facade）
  facade: () => std('facade', { color: '#3b3330', roughness: 0.8 }),
};

/** 武器の形（握る位置が原点。先は -z 方向） */
export function weaponParts(id: string): Parts {
  return cached('weapon:' + id, () => {
    const b = new GeoBuilder();
    switch (id) {
      case 'katana':
        b.box(WM.wrap(), 0.035, 0.035, 0.26, { z: 0.02 });
        b.cyl(WM.gunMetal(), 0.045, 0.045, 0.012, 12, { z: -0.115, rx: Math.PI / 2 });
        b.box(WM.blade(), 0.008, 0.03, 0.7, { z: -0.47 });
        break;
      case 'knife':
        b.box(WM.wood(), 0.025, 0.03, 0.12, { z: 0.02 });
        b.box(WM.blade(), 0.005, 0.04, 0.2, { z: -0.14, y: 0.005 });
        break;
      case 'bat':
        b.cyl(WM.grip(), 0.018, 0.018, 0.2, 10, { z: 0.08, rx: -Math.PI / 2 });
        b.cyl(WM.alu(), 0.034, 0.02, 0.55, 12, { z: -0.02, rx: -Math.PI / 2 });
        break;
      case 'pipe':
        b.cyl(WM.rust(), 0.022, 0.022, 0.75, 10, { z: 0.15, rx: -Math.PI / 2 });
        break;
      case 'pistol':
        b.box(WM.grip(), 0.03, 0.1, 0.045, { y: -0.04, rx: 0.25 });
        b.box(WM.gunMetal(), 0.032, 0.04, 0.19, { y: 0.02, z: -0.06 });
        break;
      case 'shotgun':
        b.box(WM.wood(), 0.04, 0.07, 0.28, { y: -0.02, z: 0.12 });
        b.box(WM.gunMetal(), 0.04, 0.05, 0.16, { y: 0.01, z: -0.08 });
        b.cyl(WM.gunMetal(), 0.014, 0.014, 0.55, 10, { y: 0.02, z: -0.15, rx: -Math.PI / 2 });
        b.box(WM.wood(), 0.04, 0.035, 0.18, { y: -0.015, z: -0.28 });
        break;
      case 'bomb':
      default:
        b.add(WM.bomb(), new THREE.SphereGeometry(0.07, 14, 10), { y: 0.0 });
        b.cyl(WM.gunMetal(), 0.022, 0.022, 0.03, 10, { y: 0.06 });
        b.cyl(WM.fuse(), 0.004, 0.004, 0.06, 6, { y: 0.09, rz: 0.3 });
        break;
    }
    return b.merged();
  });
}

/** 手に持つ武器（一人称の手元・人物の手で共用） */
export function createWeapon(id: string): THREE.Object3D {
  const g = meshesFromMerged(weaponParts(id));
  return g;
}

export interface ArmoryModel extends Disposable {
  group: THREE.Group;
  setOpen(open: boolean, dt: number): void;
}

/**
 * 店の右の横の壁の外の「ふかし壁」と、その中の物置（オーナーの指示: 武器庫をわかりにくく）。
 * 横の壁ぜんぶを同じ厚み・同じ見た目（下は腰板、上はしっくい、0.8m ごとの縦の継ぎ目）にして、その一部を扉にする。
 * 扉の縁は継ぎ目と同じ位置なので、外から見ても扉の形はわからない。開くと中に武器の棚がある
 */
export function createArmory(stage: StageDef): ArmoryModel {
  const r = armoryRect(stage);
  const H = CEILING_Y;
  const LOW = 0.9;
  const group = new THREE.Group();
  group.name = 'armory';
  const b = new GeoBuilder();
  const w = r.x1 - r.x0;
  const zFront = -STORE_WALL_T;
  const zBack = stage.d * CELL + STORE_WALL_T;
  const doorZ0 = r.z0 + 0.2;
  const doorZ1 = r.z1 - 0.2;
  const doorH = 2.0;
  const cx = r.x0 + w / 2;
  // ふかし壁の塊（物置の前と後ろ）。下は腰板、上はしっくい（店の横の壁と同じ）
  const block = (z0: number, z1: number) => {
    if (z1 - z0 < 1e-3) return;
    b.box(WM.wainscot(), w, LOW, z1 - z0, { x: cx, y: LOW / 2, z: (z0 + z1) / 2 });
    b.box(WM.plaster(), w, H - LOW, z1 - z0, { x: cx, y: LOW + (H - LOW) / 2, z: (z0 + z1) / 2, uv: 1.5 });
  };
  block(zFront, r.z0);
  block(r.z1, zBack);
  // 通りから見える端は店の正面の続きに見せる
  b.box(WM.facade(), w + 0.01, H + 0.02, 0.02, { x: cx, y: (H + 0.02) / 2, z: zFront - 0.01 });
  // 物置の上（扉の高さより上）と、路地側の面の扉の左右
  b.box(WM.plaster(), w, H - doorH, r.z1 - r.z0, { x: cx, y: doorH + (H - doorH) / 2, z: (r.z0 + r.z1) / 2, uv: 1.5 });
  const face = (z0: number, z1: number) => {
    b.box(WM.wainscot(), 0.06, LOW, z1 - z0, { x: r.x1 - 0.03, y: LOW / 2, z: (z0 + z1) / 2 });
    b.box(WM.plaster(), 0.06, doorH - LOW, z1 - z0, { x: r.x1 - 0.03, y: LOW + (doorH - LOW) / 2, z: (z0 + z1) / 2, uv: 1.5 });
  };
  face(r.z0, doorZ0);
  face(doorZ1, r.z1);
  // 腰板の上の見切り（横の壁ぜんぶ）と、縦の継ぎ目（0.8m ごと。扉の縁と同じ位置）
  b.box(WM.trim(), 0.04, 0.04, zBack - zFront, { x: r.x1 + 0.005, y: LOW + 0.02, z: (zFront + zBack) / 2 });
  for (let z = 0; z < zBack - 0.05; z += 0.8) b.box(WM.seam(), 0.012, H - 0.02, 0.012, { x: r.x1 + 0.004, y: H / 2, z });
  // 中（暗い）と武器の棚
  b.box(WM.dark(), 0.02, doorH, doorZ1 - doorZ0, { x: r.x0 + 0.02, y: doorH / 2, z: (doorZ0 + doorZ1) / 2 });
  b.box(WM.board(), 0.03, 1.4, doorZ1 - doorZ0 - 0.06, { x: r.x0 + 0.05, y: 1.05, z: (doorZ0 + doorZ1) / 2 });
  const shell = meshesFromMerged(b.merged());
  group.add(shell);
  // 棚の武器（壁に掛ける。先を上に）
  const n = WEAPON_IDS.length;
  WEAPON_IDS.forEach((id, i) => {
    const m = createWeapon(id);
    const z = doorZ0 + 0.06 + ((doorZ1 - doorZ0 - 0.12) * (i + 0.5)) / n;
    // 先を上にして壁に掛ける（爆弾は下の段に置く）。刃・銃の横の面が路地から見えるように
    m.position.set(r.x0 + 0.12, id === 'bomb' ? 0.45 : 0.75, z);
    m.rotation.order = 'YXZ';
    m.rotation.set(id === 'bomb' ? 0 : Math.PI / 2, Math.PI / 2, 0);
    group.add(m);
  });
  // 隠し扉（蝶番は手前の縁。開くと路地側へ開く）。ふかし壁と同じ腰板・しっくい・見切り
  const hinge = new THREE.Group();
  hinge.position.set(r.x1 - 0.03, 0, doorZ0);
  const db = new GeoBuilder();
  const dw = doorZ1 - doorZ0;
  db.box(WM.wainscot(), 0.05, LOW, dw, { y: LOW / 2, z: dw / 2 });
  db.box(WM.plaster(), 0.05, doorH - LOW, dw, { y: LOW + (doorH - LOW) / 2, z: dw / 2, uv: 1.5 });
  db.box(WM.trim(), 0.04, 0.04, dw, { x: 0.035, y: LOW + 0.02, z: dw / 2 });
  hinge.add(meshesFromMerged(db.merged()));
  group.add(hinge);
  let angle = 0;
  return {
    group,
    setOpen(open: boolean, dt: number) {
      const target = open ? -Math.PI * 0.55 : 0;
      angle += (target - angle) * Math.min(1, dt * 6);
      hinge.rotation.y = angle;
    },
    dispose() {
      // 形と素材は共有（cached）なので捨てない
    },
  };
}
