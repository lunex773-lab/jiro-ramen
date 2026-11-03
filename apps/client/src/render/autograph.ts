// 芸能人のサイン（色紙）の見た目（第2版 12-5）。名前は架空の芸能人。

import * as THREE from 'three';
import type { CelebritySign } from '@jiro/core';
import { JP_FONT } from './models/textures';
import { SIGN_H, SIGN_W, type SignSlot } from './sign-slots';

function signTexture(sign: CelebritySign): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 288;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf7ec';
  g.fillRect(0, 0, 256, 288);
  g.strokeStyle = '#c9a227';
  g.lineWidth = 10;
  g.strokeRect(5, 5, 246, 278);
  g.fillStyle = '#1a1a1a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // 名前を縦書きの崩し字ふうに（少し傾ける）
  const chars = [...sign.name.replace(/\s/g, '')];
  const size = Math.min(44, 200 / Math.max(1, chars.length));
  g.save();
  g.translate(150, 40);
  g.rotate(-0.08);
  g.font = `900 ${size}px ${JP_FONT}`;
  chars.forEach((ch, i) => g.fillText(ch, 0, i * size * 1.05));
  g.restore();
  g.font = `bold 15px ${JP_FONT}`;
  g.fillStyle = '#7a1c1c';
  g.fillText('ご来店記念', 64, 60);
  g.fillStyle = '#444';
  g.font = `13px ${JP_FONT}`;
  g.fillText(`「${sign.show}」`, 128, 246);
  g.fillText(`${sign.day}日目${sign.visits > 1 ? `・${sign.visits}回来店` : ''}`, 128, 266);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 壁に飾ったサインの組（作り直すときは dispose で片付ける） */
export function createAutographs(signs: CelebritySign[], slots: SignSlot[]): { group: THREE.Group; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'autographs';
  const owned: { dispose(): void }[] = [];
  const geo = new THREE.PlaneGeometry(SIGN_W, SIGN_H);
  owned.push(geo);
  signs.forEach((sign, i) => {
    const slot = slots[i];
    if (!slot) return;
    const tex = signTexture(sign);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
    owned.push(tex, mat);
    const m = new THREE.Mesh(geo, mat);
    m.name = `autograph-${sign.celebId}`;
    m.position.set(slot.x, slot.y, slot.z);
    m.rotation.y = slot.ry;
    group.add(m);
  });
  return {
    group,
    dispose() {
      group.removeFromParent();
      for (const o of owned) o.dispose();
    },
  };
}
