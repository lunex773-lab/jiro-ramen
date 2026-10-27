// 店舗の外殻（床・壁・天井・カウンター・店先・看板・歩道と道路）と丸椅子。
// StageDef（CELL=0.5m）から作る。店内 x∈[0,w*CELL], z∈[0,d*CELL]、z=0 が正面の壁（通り側）、z<0 が歩道。

import * as THREE from 'three';
import { CELL, MENU, MENU_IDS, type StageDef } from '@jiro/core';
import { cached, GeoBuilder, makeRng, rr, type Disposable } from './common';
import { MAT, plastic, glow } from './materials';
import { canvasTexture, JP_FONT } from './textures';

export interface ShopShell extends Disposable {
  group: THREE.Group;
  setShopName(name: string): void;
  /** 照明を置くとよい位置（天井の照明パネルの少し下） */
  lightSpots: THREE.Vector3[];
}

/** カウンター天板の高さ / 上げ台（丼を返す棚）の高さ */
export const COUNTER_TOP_Y = 1.0;
export const COUNTER_SHELF_Y = 1.16;
export const CEILING_Y = 2.6;

const WALL_T = 0.12;

function std(key: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return cached('shopmat:' + key, () => new THREE.MeshStandardMaterial(p));
}

const SM = {
  facade: () => std('facade', { color: '#3b3330', roughness: 0.8 }),
  facadeTrim: () => std('facadeTrim', { color: '#1d1a19', roughness: 0.6 }),
  alu: () => std('alu', { color: '#b8bcc0', metalness: 0.6, roughness: 0.35 }),
  wainscot: () => std('wainscot', { color: '#6a4a30', roughness: 0.6 }),
  ceiling: () => std('ceiling', { color: '#f1eee6', roughness: 0.95 }),
  curb: () => std('curb', { color: '#a9a69e', roughness: 0.9 }),
  roadLine: () => std('roadline', { color: '#f2f2ea', roughness: 0.8 }),
  shutter: () =>
    cached('shopmat:shutter', () =>
      new THREE.MeshStandardMaterial({
        map: canvasTexture(
          128,
          128,
          (c, w, h) => {
            c.fillStyle = '#8f9396';
            c.fillRect(0, 0, w, h);
            for (let y = 0; y < h; y += 8) {
              c.fillStyle = 'rgba(40,44,48,0.5)';
              c.fillRect(0, y, w, 2);
              c.fillStyle = 'rgba(255,255,255,0.15)';
              c.fillRect(0, y + 2, w, 1);
            }
          },
          { repeat: true },
        ),
        roughness: 0.6,
        metalness: 0.4,
      }),
    ),
  building: (i: number) => std('bld' + i, { color: ['#8a8076', '#6e6a66', '#9a8e7e', '#5e6064'][i % 4]!, roughness: 0.9 }),
  window: () => std('bldwin', { color: '#2a3440', roughness: 0.2, metalness: 0.3 }),
};

// ───────────────────────── 看板・のれん・ポスター ─────────────────────────

function displayName(name: string): string {
  const n = name.trim().replace(/^(ラーメン|らーめん|拉麺)\s*/, '');
  return n.length > 0 ? n : 'まし屋';
}

function drawSign(c: CanvasRenderingContext2D, w: number, h: number, name: string): void {
  // 黄色地に黒の「ラーメン」と赤の店名（次郎系の定番の看板）
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#ffd21a');
  g.addColorStop(1, '#f2be00');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.strokeStyle = '#1a1a1a';
  c.lineWidth = 10;
  c.strokeRect(5, 5, w - 10, h - 10);
  c.textBaseline = 'middle';
  c.fillStyle = '#111111';
  c.font = `900 ${Math.round(h * 0.72)}px ${JP_FONT}`;
  c.textAlign = 'left';
  const left = 'ラーメン';
  const lw = Math.min(c.measureText(left).width, w * 0.5);
  c.fillText(left, w * 0.04, h * 0.54, w * 0.5);
  c.fillStyle = '#d0141a';
  c.font = `900 ${Math.round(h * 0.62)}px ${JP_FONT}`;
  c.textAlign = 'center';
  const right0 = w * 0.04 + lw + w * 0.03;
  c.fillText(displayName(name), (right0 + w * 0.97) / 2, h * 0.54, w * 0.97 - right0);
}

function norenTexture(): THREE.CanvasTexture {
  return cached('tex:noren', () =>
    canvasTexture(512, 160, (c, w, h) => {
      c.fillStyle = '#1e2740';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#f4f1e8';
      c.font = `900 ${Math.round(h * 0.5)}px ${JP_FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      const txt = ['ら', 'ー', 'め', 'ん'];
      txt.forEach((t, i) => c.fillText(t, (w / 4) * (i + 0.5), h * 0.55));
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.fillRect(0, 0, w, h * 0.12);
    }),
  );
}

function menuBoardTexture(): THREE.CanvasTexture {
  return cached('tex:menuboard', () =>
    canvasTexture(512, 640, (c, w, h) => {
      c.fillStyle = '#5a3a20';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#f5ecd6';
      c.fillRect(16, 16, w - 32, h - 32);
      c.fillStyle = '#b3261e';
      c.font = `900 56px ${JP_FONT}`;
      c.textAlign = 'center';
      c.fillText('お品書き', w / 2, 86);
      c.fillStyle = '#1a1a1a';
      c.font = `bold 34px ${JP_FONT}`;
      c.textAlign = 'left';
      MENU_IDS.forEach((id, i) => {
        const m = MENU[id];
        if (!m) return;
        const y = 150 + i * 56;
        c.fillText(m.name, 40, y, 300);
        c.textAlign = 'right';
        c.fillText(`${m.defaultPrice.toLocaleString('ja-JP')}円`, w - 40, y);
        c.textAlign = 'left';
      });
      c.fillStyle = '#b3261e';
      c.font = `bold 26px ${JP_FONT}`;
      c.fillText('無料トッピング', 40, h - 92);
      c.fillStyle = '#1a1a1a';
      c.fillText('ヤサイ・ニンニク・アブラ・カラメ', 40, h - 54, w - 80);
    }),
  );
}

function callPosterTexture(): THREE.CanvasTexture {
  return cached('tex:callposter', () =>
    canvasTexture(512, 256, (c, w, h) => {
      c.fillStyle = '#fff8e0';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = '#d0141a';
      c.lineWidth = 8;
      c.strokeRect(6, 6, w - 12, h - 12);
      c.fillStyle = '#d0141a';
      c.font = `900 52px ${JP_FONT}`;
      c.textAlign = 'center';
      c.fillText('ニンニク入れますか？', w / 2, 82, w - 40);
      c.fillStyle = '#1a1a1a';
      c.font = `bold 30px ${JP_FONT}`;
      c.fillText('ご希望の方は「ヤサイ」「ニンニク」', w / 2, 146, w - 40);
      c.fillText('「アブラ」「カラメ」とお伝えください', w / 2, 190, w - 40);
    }),
  );
}

function clockTexture(): THREE.CanvasTexture {
  return cached('tex:clock', () =>
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#fbfbf6';
      c.beginPath();
      c.arc(w / 2, h / 2, w / 2 - 4, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = '#222';
      c.lineWidth = 10;
      c.stroke();
      c.fillStyle = '#222';
      c.font = `bold 26px ${JP_FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.fillText(String(i), w / 2 + Math.sin(a) * 92, h / 2 - Math.cos(a) * 92);
      }
      const hand = (a: number, len: number, wd: number) => {
        c.lineWidth = wd;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(w / 2, h / 2);
        c.lineTo(w / 2 + Math.sin(a) * len, h / 2 - Math.cos(a) * len);
        c.stroke();
      };
      hand(((12 + 10 / 60) / 12) * Math.PI * 2, 56, 9);
      hand((10 / 60) * Math.PI * 2, 84, 6);
    }),
  );
}

function shopTextMat(key: string, tex: THREE.Texture, emissive = 0): THREE.MeshStandardMaterial {
  return cached('shopmat:' + key, () =>
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, emissive: emissive > 0 ? '#ffffff' : '#000000', emissiveMap: emissive > 0 ? tex : null, emissiveIntensity: emissive }),
  );
}

// ───────────────────────── 丸椅子 ─────────────────────────

function stoolParts(): { geo: THREE.BufferGeometry; mat: THREE.Material }[] {
  return cached('stool', () => {
    const b = new GeoBuilder();
    const vinyl = std('stoolvinyl', { color: '#b3221f', roughness: 0.35 });
    // 座面（高さ 0.62）
    b.cyl(vinyl, 0.17, 0.165, 0.06, 20, { y: 0.56 });
    const top = new THREE.SphereGeometry(0.17, 20, 4, 0, Math.PI * 2, 0, Math.PI / 2);
    top.scale(1, 0.12, 1);
    b.add(vinyl, top, { y: 0.615 });
    b.cyl(MAT.steelPolished(), 0.13, 0.13, 0.02, 16, { y: 0.54 });
    // 支柱・足掛け・台座
    b.cyl(MAT.steelPolished(), 0.024, 0.024, 0.53, 10, { y: 0.02 });
    const ring = new THREE.TorusGeometry(0.19, 0.011, 6, 24);
    ring.rotateX(Math.PI / 2);
    b.add(MAT.steelPolished(), ring, { y: 0.24 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      b.box(MAT.steelPolished(), 0.19, 0.012, 0.012, { x: Math.cos(a) * 0.095, y: 0.24, z: Math.sin(a) * 0.095, ry: -a });
    }
    b.cyl(MAT.steelPolished(), 0.21, 0.22, 0.02, 20, {});
    return b.merged();
  });
}

/** カウンター用の丸椅子（座面の高さ 0.62m）。原点=床の中心 */
export function createStool(): THREE.Object3D {
  const g = new THREE.Group();
  g.name = 'stool';
  for (const { geo, mat } of stoolParts()) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

// ───────────────────────── 外殻 ─────────────────────────

export function createShopShell(stage: StageDef, shopName: string): ShopShell {
  const W = stage.w * CELL;
  const D = stage.d * CELL;
  const H = CEILING_Y;
  const zDiningEnd = stage.dining.z1 * CELL;
  const cx0 = stage.counter.x0 * CELL;
  const cx1 = stage.counter.x1 * CELL;
  const cz0 = stage.counter.z0 * CELL;
  const cz1 = stage.counter.z1 * CELL;
  const door = stage.door;
  const group = new THREE.Group();
  group.name = 'shopShell';
  const owned: Disposable[] = [];
  const b = new GeoBuilder();

  // ── 床 ──
  b.box(MAT.woodFloor(), W, 0.02, zDiningEnd, { x: W / 2, y: -0.01, z: zDiningEnd / 2, uv: 2.0 });
  b.box(MAT.kitchenFloor(), W, 0.02, D - zDiningEnd, { x: W / 2, y: -0.01, z: (zDiningEnd + D) / 2, uv: 0.6 });
  b.box(MAT.steelDark(), W, 0.006, 0.04, { x: W / 2, y: 0.003, z: zDiningEnd });

  // ── 壁 ──
  const tileH = 1.8;
  // 奥の壁（厨房）: 下はタイル、上はしっくい
  b.box(MAT.wallTile(), W + 2 * WALL_T, tileH, WALL_T, { x: W / 2, y: tileH / 2, z: D + WALL_T / 2, uv: 0.4 });
  b.box(MAT.plaster(), W + 2 * WALL_T, H - tileH, WALL_T, { x: W / 2, y: tileH + (H - tileH) / 2, z: D + WALL_T / 2, uv: 1.5 });
  for (const side of [0, 1]) {
    const x = side === 0 ? -WALL_T / 2 : W + WALL_T / 2;
    // 厨房側の壁
    b.box(MAT.wallTile(), WALL_T, tileH, D - zDiningEnd, { x, y: tileH / 2, z: (zDiningEnd + D) / 2, uv: 0.4 });
    b.box(MAT.plaster(), WALL_T, H - tileH, D - zDiningEnd, { x, y: tileH + (H - tileH) / 2, z: (zDiningEnd + D) / 2, uv: 1.5 });
    // 客席側の壁（腰板＋しっくい）
    b.box(SM.wainscot(), WALL_T + 0.02, 0.9, zDiningEnd, { x, y: 0.45, z: zDiningEnd / 2 });
    b.box(MAT.woodLight(), WALL_T + 0.04, 0.04, zDiningEnd, { x, y: 0.92, z: zDiningEnd / 2, uv: 0.8 });
    b.box(MAT.plaster(), WALL_T, H - 0.9, zDiningEnd, { x, y: 0.9 + (H - 0.9) / 2, z: zDiningEnd / 2, uv: 1.5 });
  }
  // 正面の壁: 入口とガラス張りの店先
  const glassX0 = door.x1 + 0.25;
  const glassX1 = W - 0.25;
  const glassY0 = 0.85;
  const glassY1 = 2.2;
  const doorTop = 2.1;
  const fz = -WALL_T / 2;
  const front = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return;
    b.box(SM.facade(), x1 - x0, y1 - y0, WALL_T * 0.5, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: -WALL_T * 0.75 });
    b.box(MAT.plaster(), x1 - x0, y1 - y0, WALL_T * 0.5, { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: -WALL_T * 0.25, uv: 1.5 });
  };
  front(-WALL_T, door.x0, 0, H);
  front(door.x0, door.x1, doorTop, H);
  front(door.x1, glassX0, 0, H);
  front(glassX0, glassX1, 0, glassY0);
  front(glassX0, glassX1, glassY1, H);
  front(glassX1, W + WALL_T, 0, H);
  // ガラスとサッシ
  b.box(MAT.glass(), glassX1 - glassX0, glassY1 - glassY0, 0.012, { x: (glassX0 + glassX1) / 2, y: (glassY0 + glassY1) / 2, z: fz });
  const mullions = Math.max(1, Math.round((glassX1 - glassX0) / 1.8));
  for (let i = 0; i <= mullions; i++) {
    const x = glassX0 + ((glassX1 - glassX0) * i) / mullions;
    b.box(SM.alu(), 0.05, glassY1 - glassY0, 0.07, { x, y: (glassY0 + glassY1) / 2, z: fz });
  }
  b.box(SM.alu(), glassX1 - glassX0, 0.05, 0.08, { x: (glassX0 + glassX1) / 2, y: glassY0, z: fz });
  b.box(SM.alu(), glassX1 - glassX0, 0.05, 0.08, { x: (glassX0 + glassX1) / 2, y: glassY1, z: fz });
  // 入口のサッシと開けた引き戸
  b.box(SM.alu(), 0.05, doorTop, 0.09, { x: door.x0, y: doorTop / 2, z: fz });
  b.box(SM.alu(), 0.05, doorTop, 0.09, { x: door.x1, y: doorTop / 2, z: fz });
  b.box(SM.alu(), door.x1 - door.x0, 0.05, 0.09, { x: (door.x0 + door.x1) / 2, y: doorTop, z: fz });
  b.box(MAT.steelDark(), door.x1 - door.x0, 0.01, WALL_T, { x: (door.x0 + door.x1) / 2, y: 0.005, z: fz });
  const dw = door.x1 - door.x0;
  b.box(SM.alu(), dw, doorTop - 0.04, 0.03, { x: door.x1 + dw / 2 - 0.05, y: doorTop / 2, z: -WALL_T - 0.03 });
  b.box(MAT.glass(), dw - 0.1, doorTop - 0.2, 0.01, { x: door.x1 + dw / 2 - 0.05, y: doorTop / 2, z: -WALL_T - 0.05 });

  // ── 天井と照明 ──
  const ceiling = new GeoBuilder();
  ceiling.box(SM.ceiling(), W + 2 * WALL_T, 0.06, D + WALL_T * 2, { x: W / 2, y: H + 0.03, z: D / 2 });
  const lightSpots: THREE.Vector3[] = [];
  const lightRow = (z: number, step: number) => {
    const n = Math.max(1, Math.round(W / step));
    for (let i = 0; i < n; i++) {
      const x = (W / n) * (i + 0.5);
      ceiling.box(MAT.lightPanel(), 1.0, 0.03, 0.22, { x, y: H - 0.015, z });
      ceiling.box(SM.alu(), 1.06, 0.02, 0.28, { x, y: H - 0.005, z });
      lightSpots.push(new THREE.Vector3(x, H - 0.15, z));
    }
  };
  lightRow(1.1, 2.6);
  for (let z = zDiningEnd + 1.2; z < D - 0.4; z += 2.0) lightRow(z, 2.4);
  // 換気扇（奥の壁）
  ceiling.box(SM.alu(), 0.5, 0.5, 0.06, { x: W * 0.35, y: 2.15, z: D - 0.03 });
  ceiling.add(MAT.black(), new THREE.CircleGeometry(0.2, 16), { x: W * 0.35, y: 2.15, z: D - 0.065, ry: Math.PI });
  for (let i = 0; i < 4; i++) ceiling.box(SM.alu(), 0.04, 0.17, 0.01, { x: W * 0.35, y: 2.15, z: D - 0.07, rz: (i / 4) * Math.PI * 2 + 0.3, ry: 0 });

  // ── カウンター ──
  const len = cx1 - cx0;
  const ccx = (cx0 + cx1) / 2;
  const topZ0 = cz0 - 0.14;
  const topZ1 = cz1 - 0.18;
  const shelfZ0 = topZ1;
  const shelfZ1 = cz1 + 0.06;
  // 下の箱（客側は膝が入るように引っ込める）
  b.box(SM.wainscot(), len, COUNTER_TOP_Y - 0.04, cz1 - (cz0 + 0.14), { x: ccx, y: (COUNTER_TOP_Y - 0.04) / 2, z: (cz0 + 0.14 + cz1) / 2 });
  b.box(SM.facadeTrim(), len, 0.08, 0.02, { x: ccx, y: 0.04, z: cz0 + 0.13 });
  // 天板（赤茶の木）と手前の白木の縁
  b.box(MAT.woodCounter(), len, 0.04, topZ1 - topZ0, { x: ccx, y: COUNTER_TOP_Y - 0.02, z: (topZ0 + topZ1) / 2, uv: 1.2 });
  b.box(MAT.woodLight(), len + 0.02, 0.055, 0.07, { x: ccx, y: COUNTER_TOP_Y - 0.0225, z: topZ0 - 0.03, uv: 0.8 });
  // 上げ台（食べ終えた丼を返す棚）
  b.box(MAT.woodCounter(), len, COUNTER_SHELF_Y - COUNTER_TOP_Y, 0.03, { x: ccx, y: (COUNTER_TOP_Y + COUNTER_SHELF_Y) / 2, z: shelfZ0 + 0.015, uv: 1.2 });
  b.box(MAT.woodCounter(), len, 0.035, shelfZ1 - shelfZ0, { x: ccx, y: COUNTER_SHELF_Y - 0.0175, z: (shelfZ0 + shelfZ1) / 2, uv: 1.2 });
  b.box(MAT.woodLight(), len + 0.02, 0.045, 0.04, { x: ccx, y: COUNTER_SHELF_Y - 0.018, z: shelfZ0 - 0.005, uv: 0.8 });
  // 厨房側はステンレス
  b.box(MAT.steel(), len, COUNTER_SHELF_Y - 0.035, 0.02, { x: ccx, y: (COUNTER_SHELF_Y - 0.035) / 2, z: cz1 + 0.01, uv: 0.6 });
  // 席ごとの卓上（箸箱・ティッシュ・コショウ）
  const r = makeRng(stage.id + 7);
  const chop = std('chopbox', { color: '#4a2a18', roughness: 0.5 });
  for (let i = 0; i + 1 < stage.seats.length; i++) {
    const s0 = stage.seats[i]!;
    const s1 = stage.seats[i + 1]!;
    if (i % 2 === 1) continue;
    const x = (s0.x + s1.x) / 2;
    const z = topZ1 - 0.07;
    b.box(chop, 0.07, 0.07, 0.2, { x: x - 0.06, y: COUNTER_TOP_Y + 0.035, z, ry: rr(r, -0.05, 0.05) });
    b.box(plastic('#f6f6f2', 0.8), 0.12, 0.06, 0.08, { x: x + 0.07, y: COUNTER_TOP_Y + 0.03, z: z + 0.02 });
    b.box(plastic('#fbfbfb', 0.9), 0.04, 0.03, 0.03, { x: x + 0.07, y: COUNTER_TOP_Y + 0.075, z: z + 0.02 });
    b.cyl(plastic('#1d1d1d', 0.4), 0.02, 0.02, 0.09, 10, { x: x + 0.01, y: COUNTER_TOP_Y, z: z + 0.07 });
    b.cyl(MAT.steelPolished(), 0.018, 0.02, 0.02, 10, { x: x + 0.01, y: COUNTER_TOP_Y + 0.09, z: z + 0.07 });
  }

  // ── 客席の壁まわり: お品書き・時計・水差しの棚・ポスター ──
  b.add(shopTextMat('menuboard', menuBoardTexture()), new THREE.PlaneGeometry(0.8, 1.0), { x: W - 0.005, y: 1.65, z: 1.15, ry: -Math.PI / 2 });
  b.box(SM.wainscot(), 0.03, 1.06, 0.86, { x: W - 0.012, y: 1.65, z: 1.15 });
  b.add(shopTextMat('clock', clockTexture()), new THREE.CircleGeometry(0.16, 24), { x: W * 0.62, y: 2.25, z: D - 0.03, ry: Math.PI });
  b.add(MAT.black(), new THREE.TorusGeometry(0.165, 0.015, 5, 24), { x: W * 0.62, y: 2.25, z: D - 0.035 });
  b.add(shopTextMat('callposter', callPosterTexture()), new THREE.PlaneGeometry(1.0, 0.5), { x: W * 0.45, y: 2.05, z: D - 0.01, ry: Math.PI });
  // 水差しの棚（客席の左の壁）
  const shelfX = 0.0;
  b.box(MAT.woodLight(), 0.22, 0.03, 0.7, { x: shelfX + 0.11, y: 1.05, z: 0.75, uv: 0.8 });
  b.box(MAT.steelDark(), 0.02, 0.15, 0.02, { x: shelfX + 0.02, y: 0.97, z: 0.5 });
  b.box(MAT.steelDark(), 0.02, 0.15, 0.02, { x: shelfX + 0.02, y: 0.97, z: 1.0 });
  for (let i = 0; i < 2; i++) {
    b.cyl(MAT.steelPolished(), 0.055, 0.06, 0.2, 14, { x: shelfX + 0.11, y: 1.065, z: 0.55 + i * 0.2 });
    b.box(MAT.steelPolished(), 0.016, 0.1, 0.03, { x: shelfX + 0.11, y: 1.18, z: 0.55 + i * 0.2 - 0.07 });
  }
  const cup = std('cup', { color: '#d9e6ee', roughness: 0.15, transparent: true, opacity: 0.7 });
  for (let i = 0; i < 3; i++) b.cyl(cup, 0.035, 0.028, 0.09 + i * 0.012, 10, { x: shelfX + 0.11, y: 1.065, z: 0.98 - i * 0.002 });

  // ── 外: 歩道・縁石・道路・隣の建物 ──
  const sx0 = -6;
  const sx1 = W + 8;
  b.box(MAT.sidewalk(), sx1 - sx0, 0.05, 4.5 - WALL_T, { x: (sx0 + sx1) / 2, y: -0.025, z: -(4.5 + WALL_T) / 2, uv: 1.0 });
  b.box(SM.curb(), sx1 - sx0, 0.18, 0.18, { x: (sx0 + sx1) / 2, y: -0.06, z: -4.5 });
  b.box(MAT.asphalt(), sx1 - sx0 + 30, 0.05, 9, { x: (sx0 + sx1) / 2, y: -0.175, z: -4.5 - 4.5, uv: 2.0 });
  for (let x = sx0 - 14; x < sx1 + 14; x += 3) b.box(SM.roadLine(), 1.5, 0.01, 0.12, { x, y: -0.145, z: -9 });
  // 隣の店（シャッター）
  const nbH = 3.8;
  b.box(SM.shutter(), -WALL_T - sx0, 2.4, 0.06, { x: (sx0 - WALL_T) / 2, y: 1.2, z: -WALL_T - 0.05, uv: 1.0 });
  b.box(SM.building(0), -WALL_T - sx0, nbH, 0.4, { x: (sx0 - WALL_T) / 2, y: nbH / 2, z: 0.2 });
  b.box(SM.shutter(), sx1 - W - WALL_T, 2.4, 0.06, { x: (W + WALL_T + sx1) / 2, y: 1.2, z: -WALL_T - 0.05, uv: 1.0 });
  b.box(SM.building(1), sx1 - W - WALL_T, nbH, 0.4, { x: (W + WALL_T + sx1) / 2, y: nbH / 2, z: 0.2 });
  // 向かいの建物
  for (let i = 0; i < 6; i++) {
    const w = rr(r, 4, 7);
    const h = rr(r, 6, 14);
    const x = sx0 - 10 + i * 6.5;
    b.box(SM.building(i + 2), w, h, 4, { x, y: h / 2 - 0.15, z: -16 });
    for (let k = 0; k < Math.floor(h / 3); k++) b.box(SM.window(), w * 0.7, 1.0, 0.05, { x, y: 2 + k * 3, z: -13.97 });
  }
  // 電柱
  b.cyl(SM.curb(), 0.14, 0.17, 9, 10, { x: W + 2.5, y: 0, z: -4.1 });
  b.box(SM.curb(), 1.4, 0.1, 0.1, { x: W + 2.5, y: 8.2, z: -4.1 });

  // ── 店先: 看板の下地・照明・のれん・立て看板 ──
  const signW = W - 0.4;
  const signY0 = H + 0.12;
  const signH = 0.82;
  b.box(SM.facade(), W + 2 * WALL_T, 1.4, WALL_T, { x: W / 2, y: H + 0.7, z: -WALL_T / 2 });
  b.box(SM.facadeTrim(), signW + 0.12, signH + 0.12, 0.24, { x: W / 2, y: signY0 + signH / 2, z: -WALL_T - 0.12 });
  for (let i = 0; i < 4; i++) {
    const x = W / 2 + (i - 1.5) * (signW / 4);
    b.box(MAT.steelDark(), 0.03, 0.03, 0.45, { x, y: signY0 + signH + 0.12, z: -WALL_T - 0.4, rx: 0.4 });
    b.cyl(MAT.black(), 0.06, 0.05, 0.12, 10, { x, y: signY0 + signH + 0.05, z: -WALL_T - 0.62, rx: 1.2 });
  }
  // 立て看板「営業中」
  const standTex = shopTextMat(
    'standsign',
    cached('tex:standsign', () =>
      canvasTexture(128, 256, (c, w, h) => {
        c.fillStyle = '#f2c200';
        c.fillRect(0, 0, w, h);
        c.fillStyle = '#111';
        c.font = `900 52px ${JP_FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        ['営', '業', '中'].forEach((t, i) => c.fillText(t, w / 2, 50 + i * 72));
      }),
    ),
    0.25,
  );
  const ax = door.x1 + 0.6;
  const az = -0.9;
  b.add(standTex, new THREE.PlaneGeometry(0.4, 0.8), { x: ax, y: 0.45, z: az - 0.12, rx: -0.25, ry: Math.PI });
  b.add(standTex, new THREE.PlaneGeometry(0.4, 0.8), { x: ax, y: 0.45, z: az + 0.12, rx: 0.25 });
  b.box(SM.facadeTrim(), 0.42, 0.04, 0.05, { x: ax, y: 0.85, z: az });

  const parts = b.merged();
  for (const { geo, mat } of parts) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = mat !== MAT.glass() && mat !== MAT.woodFloor() && mat !== MAT.kitchenFloor() && mat !== MAT.sidewalk() && mat !== MAT.asphalt();
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    owned.push(geo);
  }
  const ceilingGroup = new THREE.Group();
  ceilingGroup.name = 'ceiling';
  for (const { geo, mat } of ceiling.merged()) {
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    ceilingGroup.add(m);
    owned.push(geo);
  }
  group.add(ceilingGroup);

  // 看板（店名を書き換えられるように個別のテクスチャ）
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 2048;
  signCanvas.height = Math.round(2048 * (signH / signW));
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 8;
  const signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: '#ffffff', emissiveIntensity: 0.35, roughness: 0.4 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(signW, signH), signMat);
  sign.position.set(W / 2, signY0 + signH / 2, -WALL_T - 0.245);
  sign.rotation.y = Math.PI;
  group.add(sign);
  owned.push(signTex, signMat, sign.geometry);
  const redraw = (name: string) => {
    const ctx = signCanvas.getContext('2d');
    if (ctx) drawSign(ctx, signCanvas.width, signCanvas.height, name);
    signTex.needsUpdate = true;
  };
  redraw(shopName);

  // のれん（3枚に割れた短いのれん）
  const noren = new THREE.Group();
  const nTex = norenTexture();
  const nMat = std('noren', { map: nTex, roughness: 0.9, side: THREE.DoubleSide });
  const nW = (door.x1 - door.x0 + 0.1) / 4;
  for (let i = 0; i < 4; i++) {
    const g = new THREE.PlaneGeometry(nW - 0.015, 0.5, 1, 4);
    const uv = g.attributes.uv!;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / 4);
    // 布のふくらみ
    const p = g.attributes.position!;
    for (let k = 0; k < p.count; k++) p.setZ(k, Math.sin((p.getY(k) + 0.25) * 4) * 0.01);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, nMat);
    // 正面（-z）から見て左が +x
    m.position.set((door.x0 + door.x1) / 2 + (1.5 - i) * nW, doorTop - 0.27, -WALL_T - 0.08);
    m.rotation.y = Math.PI;
    m.castShadow = true;
    noren.add(m);
    owned.push(g);
  }
  const rod = new THREE.Mesh(cached('norenrod', () => new THREE.CylinderGeometry(0.012, 0.012, 1, 8).rotateZ(Math.PI / 2)), MAT.steelDark());
  rod.scale.set(door.x1 - door.x0 + 0.2, 1, 1);
  rod.position.set((door.x0 + door.x1) / 2, doorTop - 0.01, -WALL_T - 0.08);
  noren.add(rod);
  group.add(noren);

  return {
    group,
    lightSpots,
    setShopName(name) {
      redraw(name);
    },
    dispose() {
      for (const o of owned) o.dispose();
      owned.length = 0;
      group.removeFromParent();
    },
  };
}

export { glow };
