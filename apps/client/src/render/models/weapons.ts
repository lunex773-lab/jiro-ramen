// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり）。
// 武器の形（手に持つ・棚に並べる）と、店の右の横の壁の外の物置（壁と同じ見た目の隠し扉・中の武器の棚）
import * as THREE from 'three';
import { armoryRect, CELL, WEAPON_IDS, type StageDef } from '@jiro/core';
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
  facade: () => std('facade', { color: '#3b3330', roughness: 0.8 }),
  seam: () => std('seam', { color: '#2c2624', roughness: 0.85 }),
  dark: () => std('closet', { color: '#141110', roughness: 1 }),
  board: () => std('board', { color: '#4d4237', roughness: 0.85 }),
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
 * 店の右の横の壁の外の物置。外から見ると建物の外壁と同じ色・同じ継ぎ目で、扉の形はわからない（隠し扉）。
 * 開くと中に武器の棚がある
 */
export function createArmory(stage: StageDef): ArmoryModel {
  const r = armoryRect(stage);
  const H = 2.3;
  const group = new THREE.Group();
  group.name = 'armory';
  const b = new GeoBuilder();
  const w = r.x1 - r.x0;
  const d = r.z1 - r.z0;
  // 物置の外壁（店の外壁と同じ色）。路地側の面は扉の幅だけ開けておく
  b.box(WM.facade(), w, 0.25, d, { x: r.x0 + w / 2, y: H + 0.125 - 0.25, z: r.z0 + d / 2 });
  b.box(WM.facade(), w, H, 0.06, { x: r.x0 + w / 2, y: H / 2, z: r.z0 + 0.03 });
  b.box(WM.facade(), w, H, 0.06, { x: r.x0 + w / 2, y: H / 2, z: r.z1 - 0.03 });
  const doorZ0 = r.z0 + 0.2;
  const doorZ1 = r.z1 - 0.2;
  b.box(WM.facade(), 0.06, H, doorZ0 - r.z0, { x: r.x1 - 0.03, y: H / 2, z: (r.z0 + doorZ0) / 2 });
  b.box(WM.facade(), 0.06, H, r.z1 - doorZ1, { x: r.x1 - 0.03, y: H / 2, z: (doorZ1 + r.z1) / 2 });
  b.box(WM.facade(), 0.06, H - 2.0, doorZ1 - doorZ0, { x: r.x1 - 0.03, y: 2.0 + (H - 2.0) / 2, z: (doorZ0 + doorZ1) / 2 });
  // 外壁の継ぎ目（扉の縁と同じ間隔で横の線を入れ、扉の形をわからなくする）
  for (let y = 0.5; y < H; y += 0.5) b.box(WM.seam(), 0.065, 0.012, d, { x: r.x1 - 0.03, y, z: r.z0 + d / 2 });
  // 中（暗い）と武器の棚
  b.box(WM.dark(), 0.02, 2.0, doorZ1 - doorZ0, { x: r.x0 + 0.03, y: 1.0, z: (doorZ0 + doorZ1) / 2 });
  b.box(WM.board(), 0.03, 1.4, doorZ1 - doorZ0 - 0.06, { x: r.x0 + 0.06, y: 1.05, z: (doorZ0 + doorZ1) / 2 });
  const shell = meshesFromMerged(b.merged());
  group.add(shell);
  // 棚の武器（壁に掛ける。先を上に）
  const n = WEAPON_IDS.length;
  WEAPON_IDS.forEach((id, i) => {
    const m = createWeapon(id);
    const z = doorZ0 + 0.06 + ((doorZ1 - doorZ0 - 0.12) * (i + 0.5)) / n;
    // 先を上にして壁に掛ける（爆弾は下の段に置く）。刃・銃の横の面が路地から見えるように
    m.position.set(r.x0 + 0.1, id === 'bomb' ? 0.45 : 0.75, z);
    m.rotation.order = 'YXZ';
    m.rotation.set(id === 'bomb' ? 0 : Math.PI / 2, Math.PI / 2, 0);
    group.add(m);
  });
  // 隠し扉（蝶番は手前の縁。開くと路地側へ開く）
  const hinge = new THREE.Group();
  hinge.position.set(r.x1 - 0.03, 0, doorZ0);
  const db = new GeoBuilder();
  db.box(WM.facade(), 0.05, 2.0, doorZ1 - doorZ0, { y: 1.0, z: (doorZ1 - doorZ0) / 2 });
  for (let y = 0.5; y < 2.0; y += 0.5) db.box(WM.seam(), 0.056, 0.012, doorZ1 - doorZ0, { y, z: (doorZ1 - doorZ0) / 2 });
  hinge.add(meshesFromMerged(db.merged()));
  group.add(hinge);
  let angle = 0;
  void CELL;
  void MAT;
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
