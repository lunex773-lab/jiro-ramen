// 記念品の棚（じろ7 Phase 7・オーナーの判断 Q9）: 店の伝説をランクの高い順に6つまで飾る。
// 飾る物はランクと種類で変わる: 通常 = 写真立て、希少・激レア = 記念プレート（銀・金）、伝説 = 金のトロフィー、神話級 = 光る大きなトロフィー、
// 動画の伝説 = 小さなモニター（再生マーク）、テレビ取材 = サイン色紙。伝説が変わったときだけ作り直す（毎フレームは作らない）。
// 規約（equipment.ts）: 正面 = -Z、中心 = 原点、床 = y0。

import * as THREE from 'three';
import { shelfLegends, type Legend } from '@jiro/core';
import { cached } from './common';
import { addStatic, plastic, type EqCtx } from './equip-common';

/** 伝説の種類ごとの色（写真・プレートの絵の色） */
const KIND_COLOR: Record<string, string> = {
  ufo: '#5fe3c0',
  golden: '#ffd23a',
  bear: '#8b5a2b',
  bounce: '#ff7ab8',
  viral: '#ff4d4d',
  hit: '#ff9a3c',
  flame: '#c0392b',
  sns: '#3c8dff',
  tv: '#f2c200',
  chain: '#b07cff',
};

const mat = (key: string, make: () => THREE.Material) => cached(`legend:${key}`, make);
const geo = <T extends THREE.BufferGeometry>(key: string, make: () => T) => cached(`legendg:${key}`, make);

function trophy(scale: number, color: string, glowing: boolean): THREE.Group {
  const g = new THREE.Group();
  const metal = mat(`trophy:${color}:${glowing}`, () => new THREE.MeshStandardMaterial({ color, metalness: 0.8, roughness: 0.25, emissive: glowing ? color : '#000000', emissiveIntensity: glowing ? 0.5 : 0 }));
  const base = mat('base', () => new THREE.MeshStandardMaterial({ color: '#2a1d14', roughness: 0.6 }));
  const cup = geo('cup', () => {
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 8; i++) {
      const v = i / 8;
      pts.push(new THREE.Vector2(0.02 + Math.sin(v * Math.PI * 0.55) * 0.06 + v * v * 0.02, v * 0.12));
    }
    return new THREE.LatheGeometry(pts, 14);
  });
  const stem = geo('stem', () => new THREE.CylinderGeometry(0.012, 0.02, 0.07, 10));
  const plinth = geo('plinth', () => new THREE.BoxGeometry(0.1, 0.04, 0.1));
  const handle = geo('handle', () => new THREE.TorusGeometry(0.035, 0.007, 5, 10, Math.PI));
  const b = new THREE.Mesh(plinth, base);
  b.position.y = 0.02;
  const st = new THREE.Mesh(stem, metal);
  st.position.y = 0.075;
  const c = new THREE.Mesh(cup, metal);
  c.position.y = 0.11;
  g.add(b, st, c);
  for (const sx of [1, -1]) {
    const hd = new THREE.Mesh(handle, metal);
    hd.position.set(sx * 0.075, 0.19, 0);
    hd.rotation.z = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
    g.add(hd);
  }
  g.scale.setScalar(scale);
  return g;
}

function framed(w: number, h: number, frameColor: string, picture: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const frame = mat(`frame:${frameColor}`, () => new THREE.MeshStandardMaterial({ color: frameColor, roughness: 0.45, metalness: frameColor === '#d9b44a' || frameColor === '#c9d1d9' ? 0.7 : 0.1 }));
  const back = new THREE.Mesh(geo(`frame:${w}x${h}`, () => new THREE.BoxGeometry(w, h, 0.02)), frame);
  const pic = new THREE.Mesh(geo(`pic:${w}x${h}`, () => new THREE.PlaneGeometry(w * 0.8, h * 0.8)), picture);
  pic.position.z = -0.011;
  pic.rotation.y = Math.PI;
  g.add(back, pic);
  // 少し後ろへ傾けて立てる
  g.rotation.x = 0.12;
  g.position.y = h / 2;
  return g;
}

function pictureMat(color: string, kind: 'photo' | 'plaque' | 'video' | 'sign'): THREE.Material {
  return mat(`pic:${kind}:${color}`, () => {
    if (kind === 'video') return new THREE.MeshBasicMaterial({ color: '#141820' });
    if (kind === 'sign') return new THREE.MeshStandardMaterial({ color: '#f4efe2', roughness: 0.9 });
    if (kind === 'plaque') return new THREE.MeshStandardMaterial({ color: '#d9b44a', metalness: 0.75, roughness: 0.3 });
    return new THREE.MeshStandardMaterial({ color, roughness: 0.7, emissive: color, emissiveIntensity: 0.15 });
  });
}

/** 伝説1つの飾り */
function itemFor(l: Legend): THREE.Object3D {
  const color = KIND_COLOR[l.kind] ?? '#c0c0c0';
  if (l.display === 'video') {
    const g = framed(0.2, 0.14, '#222222', pictureMat(color, 'video'));
    // 再生マーク
    const play = new THREE.Mesh(
      geo('play', () => {
        const s = new THREE.Shape();
        s.moveTo(-0.02, -0.025);
        s.lineTo(0.03, 0);
        s.lineTo(-0.02, 0.025);
        s.closePath();
        return new THREE.ShapeGeometry(s);
      }),
      mat(`play:${color}`, () => new THREE.MeshBasicMaterial({ color })),
    );
    play.position.z = -0.012;
    play.rotation.y = Math.PI;
    g.add(play);
    return g;
  }
  if (l.display === 'sign') {
    const g = framed(0.16, 0.2, '#b08850', pictureMat(color, 'sign'));
    const ink = new THREE.Mesh(geo('ink', () => new THREE.TorusGeometry(0.035, 0.004, 4, 16, Math.PI * 1.6)), mat('ink', () => new THREE.MeshBasicMaterial({ color: '#202020' })));
    ink.position.set(0, 0.0, -0.013);
    g.add(ink);
    return g;
  }
  if (l.rank === 'myth') return trophy(1.5, '#ffd23a', true);
  if (l.rank === 'legend') return trophy(1.15, '#e8b923', false);
  if (l.rank === 'epic') return framed(0.18, 0.13, '#d9b44a', pictureMat(color, 'plaque'));
  if (l.rank === 'rare') return framed(0.18, 0.13, '#c9d1d9', pictureMat(color, 'plaque'));
  return framed(0.14, 0.18, '#5a3a22', pictureMat(color, 'photo'));
}

export function buildLegendShelf(c: EqCtx): void {
  const { W, D, H } = c;
  const levels = [0.55, 1.05, 1.55];
  addStatic(c, `${c.type}:${W}x${D}x${H}`, (b) => {
    const wood = plastic('#6b4a2e', 0.6);
    const dark = plastic('#4a3220', 0.7);
    // 側板・背板・天板・棚板
    b.box(wood, 0.04, H, D, { x: -W / 2 + 0.02, y: H / 2 });
    b.box(wood, 0.04, H, D, { x: W / 2 - 0.02, y: H / 2 });
    b.box(dark, W, H, 0.02, { y: H / 2, z: D / 2 - 0.01 });
    b.box(wood, W, 0.04, D, { y: H - 0.02 });
    b.box(wood, W, 0.08, D, { y: 0.04 });
    for (const y of levels) b.box(wood, W - 0.06, 0.03, D - 0.04, { y: y - 0.015, z: 0.01 });
    // 見出しの札（金色の帯）
    b.box(plastic('#d9b44a', 0.35), W * 0.5, 0.06, 0.01, { y: H - 0.1, z: -D / 2 + 0.005 });
  });
  const items = new THREE.Group();
  items.name = 'legend-items';
  c.group.add(items);
  let key = '';
  c.updaters.push((_e, s) => {
    const list = shelfLegends(s, 6);
    const k = list.map((l) => `${l.id}:${l.rank}`).join('|');
    if (k === key) return;
    key = k;
    items.clear();
    list.forEach((l, i) => {
      const o = itemFor(l);
      const lv = levels[Math.floor(i / 2)]!;
      const col = i % 2;
      o.position.x = (col === 0 ? -1 : 1) * W * 0.22;
      o.position.y += lv;
      o.position.z = 0.02;
      // 正面（-Z）を向ける
      o.rotation.y += Math.PI;
      items.add(o);
    });
  });
}
