// 客席側の設備: 券売機（売切ランプ）・高速券売機・給水器・観葉植物・荷物フック。

import * as THREE from 'three';
import { MENU, MENU_IDS, soldOut } from '@jiro/core';
import { cached, makeRng, rr, GeoBuilder } from './common';
import { canvasTexture, JP_FONT, texEnv } from './textures';
import { addStatic, feet, MAT, plastic, glow, type EqCtx } from './equip-common';

// ───────────────────────── 券売機 ─────────────────────────

/** ボタンの並び（2列×4段） */
const BTN = { cols: 2, rows: 4, w: 0.4, h: 0.44 };

function menuLabel(id: string): string {
  const m = MENU[id];
  return m ? m.name.replace('ラーメン', 'らーめん') : id;
}

function buttonPanelTexture(fast: boolean): THREE.CanvasTexture {
  return cached('tex:ticketpanel:' + fast, () =>
    canvasTexture(512, 560, (c, w, h) => {
      c.fillStyle = fast ? '#0f1720' : '#3a3a3c';
      c.fillRect(0, 0, w, h);
      const cw = w / BTN.cols;
      const ch = h / BTN.rows;
      const colors = fast ? ['#1e3a5c', '#23476e', '#2a3a2a', '#3a2a2a'] : ['#f7f4ea', '#fdf3c4', '#f4e2c4', '#e4eef8'];
      MENU_IDS.forEach((id, i) => {
        const col = i % BTN.cols;
        const row = Math.floor(i / BTN.cols);
        const x = col * cw + 8;
        const y = row * ch + 8;
        const bw = cw - 16;
        const bh = ch - 16;
        // 売切ランプの窓（消灯）
        c.fillStyle = fast ? '#0b0f14' : '#1c1414';
        c.fillRect(x + bw * 0.3, y, bw * 0.4, bh * 0.22);
        c.fillStyle = '#4a1c1c';
        c.font = `bold ${Math.round(bh * 0.15)}px ${JP_FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText('売切', x + bw / 2, y + bh * 0.11);
        // ボタン本体
        const by = y + bh * 0.27;
        const bhh = bh * 0.73;
        c.fillStyle = colors[(MENU[id]?.size === 'large' ? 1 : 0) + ((MENU[id]?.buta ?? 0) >= 5 ? 2 : 0)] ?? colors[0]!;
        c.fillRect(x, by, bw, bhh);
        c.strokeStyle = fast ? '#4a90d9' : '#9a958a';
        c.lineWidth = 3;
        c.strokeRect(x + 1.5, by + 1.5, bw - 3, bhh - 3);
        if (fast) {
          // 丼のアイコン
          c.fillStyle = '#f2f2f2';
          c.beginPath();
          c.ellipse(x + bw * 0.2, by + bhh * 0.5, bw * 0.11, bhh * 0.22, 0, 0, Math.PI);
          c.fill();
          c.fillStyle = '#e8c070';
          c.beginPath();
          c.ellipse(x + bw * 0.2, by + bhh * 0.48, bw * 0.1, bhh * 0.08, 0, 0, Math.PI * 2);
          c.fill();
        }
        c.fillStyle = fast ? '#ffffff' : '#1a1a1a';
        const label = menuLabel(id);
        const fs = Math.round(bhh * (label.length > 7 ? 0.2 : 0.26));
        c.font = `bold ${fs}px ${JP_FONT}`;
        c.fillText(label, x + bw * (fast ? 0.6 : 0.5), by + bhh * 0.5, bw * (fast ? 0.72 : 0.92));
      });
      // 空き枠
      for (let i = MENU_IDS.length; i < BTN.cols * BTN.rows; i++) {
        const col = i % BTN.cols;
        const row = Math.floor(i / BTN.cols);
        c.fillStyle = fast ? '#162230' : '#d8d4c8';
        c.fillRect(col * cw + 8, row * ch + 8 + (ch - 16) * 0.27, cw - 16, (ch - 16) * 0.73);
        c.fillStyle = fast ? '#5a6a7a' : '#7a766a';
        c.font = `bold 28px ${JP_FONT}`;
        c.textAlign = 'center';
        c.fillText(fast ? '水はセルフ' : 'お水はセルフ', col * cw + cw / 2, row * ch + ch * 0.62);
      }
    }),
  );
}

function soldLampMat(): THREE.MeshStandardMaterial {
  return cached('eqm:soldlamp', () => {
    const tex = canvasTexture(128, 48, (c, w, h) => {
      c.fillStyle = '#ff2a1a';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#ffffff';
      c.font = `bold 34px ${JP_FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText('売切', w / 2, h / 2 + 2);
    });
    return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 1.6, roughness: 0.4 });
  });
}

function headerMat(text: string, bg: string, fg: string): THREE.MeshStandardMaterial {
  return cached(`eqm:header:${text}:${bg}`, () => {
    const tex = canvasTexture(256, 64, (c, w, h) => {
      c.fillStyle = bg;
      c.fillRect(0, 0, w, h);
      c.fillStyle = fg;
      c.font = `900 44px ${JP_FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(text, w / 2, h / 2 + 2);
    });
    return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.35, roughness: 0.5 });
  });
}

export function buildTicketMachine(c: EqCtx): void {
  const { W, D, H } = c;
  const fast = c.type === 'ticket_machine_fast';
  const body = fast ? plastic('#2c3036', 0.4) : plastic('#e7e1cf', 0.45);
  const trim = fast ? MAT.steelDark() : plastic('#b8b09a', 0.5);
  const bw = W - 0.04;
  const bd = D - 0.1;
  const panelY = 1.14;
  const panelZ = -bd / 2 - 0.006;
  const panelMat = cached('eqm:ticketpanel:' + fast, () => {
    const tex = buttonPanelTexture(fast);
    return fast
      ? new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.85, roughness: 0.15, envMap: texEnv(), envMapIntensity: 0.4 })
      : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, envMap: texEnv(), envMapIntensity: 0.3 });
  });
  addStatic(c, c.type, (b) => {
    b.box(trim, bw, 0.05, bd, { y: 0.025 });
    b.box(body, bw - 0.02, 0.72, bd - 0.04, { y: 0.05 + 0.36 });
    b.box(body, bw, H - 0.86, bd, { y: 0.77 + (H - 0.86) / 2 });
    // 上部の表示
    b.box(fast ? MAT.darkPanel() : plastic('#c0392b', 0.5), bw, 0.09, bd, { y: H - 0.045 });
    b.add(headerMat(fast ? '食券' : '食 券', fast ? '#111418' : '#c0392b', fast ? '#f2c200' : '#ffffff'), new THREE.PlaneGeometry(bw * 0.8, 0.07), { y: H - 0.045, z: -bd / 2 - 0.001, ry: Math.PI });
    // ボタン盤（画面）
    b.box(trim, BTN.w + 0.03, BTN.h + 0.03, 0.01, { y: panelY + BTN.h / 2, z: -bd / 2 - 0.002 });
    b.add(panelMat, new THREE.PlaneGeometry(BTN.w, BTN.h), { y: panelY + BTN.h / 2, z: panelZ - 0.002, ry: Math.PI });
    // 硬貨・紙幣の投入口
    if (fast) {
      b.box(MAT.black(), 0.12, 0.08, 0.02, { x: -0.1, y: 1.0, z: -bd / 2 - 0.01 });
      b.box(glow('#30ff60', 0.8), 0.06, 0.006, 0.004, { x: -0.1, y: 0.975, z: -bd / 2 - 0.021 });
      b.box(MAT.black(), 0.1, 0.1, 0.03, { x: 0.1, y: 1.0, z: -bd / 2 - 0.015 });
      b.box(glow('#ff3030', 0.9), 0.05, 0.05, 0.004, { x: 0.1, y: 1.0, z: -bd / 2 - 0.031 });
    } else {
      b.box(MAT.black(), 0.13, 0.05, 0.02, { x: -0.1, y: 1.02, z: -bd / 2 - 0.01 });
      b.box(glow('#30ff60', 0.8), 0.07, 0.006, 0.004, { x: -0.1, y: 1.0, z: -bd / 2 - 0.021 });
      b.box(MAT.steelPolished(), 0.05, 0.08, 0.02, { x: 0.12, y: 1.03, z: -bd / 2 - 0.01 });
      b.box(MAT.black(), 0.006, 0.04, 0.004, { x: 0.12, y: 1.035, z: -bd / 2 - 0.021 });
      b.box(plastic('#c0392b', 0.5), 0.05, 0.025, 0.02, { x: 0.12, y: 0.96, z: -bd / 2 - 0.01 });
    }
    // 食券とおつりの取り出し口
    b.box(MAT.black(), 0.26, 0.08, 0.04, { y: 0.84, z: -bd / 2 - 0.0 });
    b.box(MAT.steelPolished(), 0.3, 0.012, 0.06, { y: 0.8, z: -bd / 2 - 0.02 });
    // 側面の通気口
    for (let i = 0; i < 5; i++) b.box(MAT.black(), 0.004, 0.012, 0.2, { x: bw / 2 + 0.001, y: 0.3 + i * 0.03 });
  });
  // 売切ランプ（メニューごと）
  const lamps: { id: string; mesh: THREE.Mesh }[] = [];
  const geo = cached('soldlampgeo', () => new THREE.PlaneGeometry(1, 1));
  MENU_IDS.forEach((id, i) => {
    const col = i % BTN.cols;
    const row = Math.floor(i / BTN.cols);
    const cw = BTN.w / BTN.cols;
    const ch = BTN.h / BTN.rows;
    const m = new THREE.Mesh(geo, soldLampMat());
    // パネル座標: 左上=(−w/2, top)。正面(-z)から見て左は +x
    const x = BTN.w / 2 - (col + 0.5) * cw;
    const yTop = panelY + BTN.h - row * ch;
    m.scale.set(cw * 0.38, ch * 0.18, 1);
    m.position.set(x, yTop - ch * 0.135, panelZ - 0.005);
    m.rotation.y = Math.PI;
    m.visible = false;
    c.group.add(m);
    lamps.push({ id, mesh: m });
  });
  let acc = 1;
  c.updaters.push((_e, s, _t, dt) => {
    acc += Math.max(0, dt);
    if (acc < 0.3) return;
    acc = 0;
    for (const l of lamps) l.mesh.visible = soldOut(s, l.id);
  });
  c.lampPos.set(W / 2 - 0.08, H + 0.06, -D / 2 + 0.1);
  void feet;
}

// ───────────────────────── 給水器 ─────────────────────────

export function buildWaterServer(c: EqCtx): void {
  const { W, D, H } = c;
  const label = cached('eqm:waterlabel', () => headerMat('冷水', '#2a6fb5', '#ffffff'));
  addStatic(c, c.type, (b) => {
    feet(b, W - 0.06, D - 0.08, 0.06);
    b.box(MAT.steel(), W - 0.06, 0.8, D - 0.1, { y: 0.06 + 0.4 });
    // 上部（蛇口のパネル）
    b.box(MAT.steel(), W - 0.04, H - 0.86, D - 0.08, { y: 0.86 + (H - 0.86) / 2, z: 0.03 });
    b.box(MAT.steelDark(), W - 0.06, 0.02, D - 0.14, { y: 0.87, z: -0.02 });
    // 水受けの網
    for (let i = 0; i < 6; i++) b.box(MAT.steelPolished(), W - 0.12, 0.006, 0.006, { y: 0.885, z: -D / 2 + 0.08 + i * 0.03 });
    // 蛇口2つ
    for (const x of [-0.09, 0.09]) {
      b.cyl(MAT.steelPolished(), 0.015, 0.012, 0.06, 8, { x, y: 1.0, z: -D / 2 + 0.06 });
      b.box(plastic('#2a6fb5', 0.4), 0.06, 0.03, 0.05, { x, y: 1.08, z: -D / 2 + 0.07 });
    }
    b.add(label, new THREE.PlaneGeometry(0.2, 0.05), { y: H - 0.06, z: -D / 2 + 0.039, ry: Math.PI });
    // 紙コップの筒とコップの山
    b.cyl(plastic('#e8eef2', 0.3), 0.04, 0.04, 0.3, 12, { x: W / 2 - 0.02, y: 0.62, z: -D / 2 + 0.06 });
    const cup = cached('eqm:cup', () => new THREE.MeshStandardMaterial({ color: '#dfeaf2', roughness: 0.15, transparent: true, opacity: 0.7, envMap: texEnv() }));
    for (let i = 0; i < 4; i++) b.cyl(cup, 0.035, 0.026, 0.08, 10, { x: -W / 2 + 0.1 + (i % 2) * 0.075, y: 0.9 + Math.floor(i / 2) * 0.0, z: -D / 2 + 0.1 + Math.floor(i / 2) * 0.08 });
  });
}

// ───────────────────────── 観葉植物 ─────────────────────────

function leafGeometry(): THREE.BufferGeometry {
  return cached('leafgeo', () => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.bezierCurveTo(0.09, 0.03, 0.1, 0.17, 0, 0.24);
    s.bezierCurveTo(-0.1, 0.17, -0.09, 0.03, 0, 0);
    const g = new THREE.ShapeGeometry(s, 6);
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const y = p.getY(i);
      // 中央の葉脈で少し折れ、先端が垂れる
      p.setZ(i, Math.abs(x) * 0.35 - y * y * 0.6);
    }
    g.computeVertexNormals();
    return g;
  });
}

export function buildPlant(c: EqCtx): void {
  const { H } = c;
  addStatic(c, c.type, (b) => {
    const pot = plastic('#3b3836', 0.6);
    b.cyl(pot, 0.17, 0.13, 0.36, 16, {});
    b.add(pot, new THREE.TorusGeometry(0.17, 0.015, 5, 18), { y: 0.36, rx: Math.PI / 2 });
    b.cyl(plastic('#3a2a1c', 0.95), 0.16, 0.16, 0.01, 14, { y: 0.33 });
    const stem = plastic('#5a6a2a', 0.7);
    const leafA = new THREE.MeshStandardMaterial({ color: '#3f7f3a', roughness: 0.55, side: THREE.DoubleSide });
    const leafB = new THREE.MeshStandardMaterial({ color: '#2f6a2e', roughness: 0.55, side: THREE.DoubleSide });
    const r = makeRng(23);
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rr(r, -0.2, 0.2);
      const tilt = rr(r, 0.15, 0.6);
      const len = rr(r, 0.45, H - 0.45);
      // 茎
      const sg = new THREE.CylinderGeometry(0.006, 0.009, len, 5);
      sg.translate(0, len / 2, 0);
      sg.rotateZ(tilt);
      sg.rotateY(a);
      sg.translate(0, 0.34, 0);
      b.add(stem, sg);
      // 茎の先の葉
      const tipX = -Math.sin(tilt) * len;
      const tipY = Math.cos(tilt) * len + 0.34;
      const lg = leafGeometry().clone();
      lg.scale(1.3, 1.3, 1.3);
      lg.rotateX(-0.6 - tilt * 0.5);
      lg.rotateZ(rr(r, -0.4, 0.4));
      lg.rotateY(a - Math.PI / 2);
      lg.translate(Math.cos(a) * tipX, tipY, -Math.sin(a) * tipX);
      b.add(i % 2 === 0 ? leafA : leafB, lg);
    }
  });
}

// ───────────────────────── 荷物フック ─────────────────────────

export function buildCoatRack(c: EqCtx): void {
  const { H } = c;
  addStatic(c, c.type, (b) => {
    const wood = cached('eqm:rackwood', () => new THREE.MeshStandardMaterial({ color: '#7a5c3e', roughness: 0.55 }));
    b.cyl(wood, 0.2, 0.22, 0.04, 18, {});
    b.cyl(wood, 0.025, 0.03, H - 0.04, 10, { y: 0.04 });
    b.add(wood, new THREE.SphereGeometry(0.04, 10, 6), { y: H });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const hook = new THREE.CylinderGeometry(0.01, 0.012, 0.18, 6);
      hook.translate(0, 0.09, 0);
      hook.rotateZ(-0.9);
      hook.rotateY(a);
      hook.translate(0, H - 0.18, 0);
      b.add(MAT.steelDark(), hook);
    }
    // 荷物かご
    const basket = plastic('#2b4f7a', 0.6);
    b.box(basket, 0.36, 0.015, 0.28, { y: 0.1, z: -0.02 });
    for (const [x, z, w, d] of [
      [0, -0.16, 0.36, 0.012],
      [0, 0.12, 0.36, 0.012],
      [-0.18, -0.02, 0.012, 0.28],
      [0.18, -0.02, 0.012, 0.28],
    ] as const) b.box(basket, w, 0.14, d, { x, y: 0.17, z });
    // 掛けたトートバッグ
    const tote = plastic('#d9cdb4', 0.9);
    const a = Math.PI / 4;
    b.box(tote, 0.24, 0.3, 0.05, { x: Math.cos(a) * 0.16, y: H - 0.42, z: -Math.sin(a) * 0.16, ry: -a });
    b.add(tote, new THREE.TorusGeometry(0.06, 0.008, 4, 10, Math.PI), { x: Math.cos(a) * 0.15, y: H - 0.27, z: -Math.sin(a) * 0.15, ry: -a });
  });
  void GeoBuilder;
}
