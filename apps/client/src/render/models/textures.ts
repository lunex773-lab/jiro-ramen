// 手続きテクスチャ（CanvasTexture）。外部画像は一切使わず、すべてコードで描く。
// 共有テクスチャは cached() で1枚だけ作る。

import * as THREE from 'three';
import { cached, makeRng, rr, type Rng } from './common';

export const JP_FONT = "'Hiragino Sans','Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','IPAGothic','IPAPGothic',sans-serif";

export type Draw = (c: CanvasRenderingContext2D, w: number, h: number) => void;

export interface TexOpts {
  /** 色テクスチャか（sRGB）。ラフネス等のデータは false */
  srgb?: boolean;
  repeat?: boolean;
  aniso?: number;
  mipmaps?: boolean;
}

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return cv;
}

/** 個別（キャッシュしない）キャンバステクスチャ。看板や名札など可変のもの */
export function canvasTexture(w: number, h: number, draw: Draw, o: TexOpts = {}): THREE.CanvasTexture {
  const cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d');
  if (ctx) draw(ctx, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (o.repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = o.aniso ?? 4;
  t.generateMipmaps = o.mipmaps ?? true;
  if (!t.generateMipmaps) t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function sharedTexture(key: string, w: number, h: number, draw: Draw, o: TexOpts = {}): THREE.CanvasTexture {
  return cached('tex:' + key, () => canvasTexture(w, h, draw, o));
}

// ───────────────────────── 描画ヘルパー ─────────────────────────

function rgba(r: number, g: number, b: number, a: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a.toFixed(3)})`;
}

/** タイル可能なように端をまたいで円を描く */
function blob(c: CanvasRenderingContext2D, w: number, h: number, x: number, y: number, r: number, style: string): void {
  c.fillStyle = style;
  for (const dx of [-w, 0, w]) {
    for (const dy of [-h, 0, h]) {
      if (x + dx + r < 0 || x + dx - r > w || y + dy + r < 0 || y + dy - r > h) continue;
      c.beginPath();
      c.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      c.fill();
    }
  }
}

/** ぼかした斑点で低周波のムラを付ける */
function mottle(c: CanvasRenderingContext2D, w: number, h: number, r: Rng, n: number, rad: [number, number], col: [number, number, number], alpha: [number, number]): void {
  for (let i = 0; i < n; i++) {
    const x = r() * w;
    const y = r() * h;
    const rd = rr(r, rad[0], rad[1]);
    const al = rr(r, alpha[0], alpha[1]);
    for (const dx of [-w, 0, w]) {
      for (const dy of [-h, 0, h]) {
        const px = x + dx;
        const py = y + dy;
        if (px + rd < 0 || px - rd > w || py + rd < 0 || py - rd > h) continue;
        const g = c.createRadialGradient(px, py, 0, px, py, rd);
        g.addColorStop(0, rgba(col[0], col[1], col[2], al));
        g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
        c.fillStyle = g;
        c.beginPath();
        c.arc(px, py, rd, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}

function speckle(c: CanvasRenderingContext2D, w: number, h: number, r: Rng, n: number, rad: [number, number], color: (r: Rng) => string): void {
  for (let i = 0; i < n; i++) blob(c, w, h, r() * w, r() * h, rr(r, rad[0], rad[1]), color(r));
}

// ───────────────────────── 素材 ─────────────────────────

/** ヘアライン仕上げのステンレス */
export function texSteel(): THREE.CanvasTexture {
  return sharedTexture('steel', 256, 256, (c, w, h) => {
    c.fillStyle = '#d4d7da';
    c.fillRect(0, 0, w, h);
    const r = makeRng(11);
    for (let i = 0; i < 1400; i++) {
      const y = r() * h;
      const x = r() * w;
      const l = rr(r, 30, 256);
      const v = rr(r, 150, 255);
      c.strokeStyle = rgba(v, v, v + 3, rr(r, 0.05, 0.28));
      c.lineWidth = rr(r, 0.4, 1.4);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + l, y);
      c.moveTo(x - w, y);
      c.lineTo(x - w + l, y);
      c.stroke();
    }
    mottle(c, w, h, r, 10, [40, 90], [120, 124, 128], [0.04, 0.08]);
  }, { repeat: true });
}

/** 白い陶器（うっすら灰色の斑点） */
export function texCeramic(): THREE.CanvasTexture {
  return sharedTexture('ceramic', 512, 256, (c, w, h) => {
    c.fillStyle = '#f4f2ec';
    c.fillRect(0, 0, w, h);
    const r = makeRng(5);
    mottle(c, w, h, r, 30, [20, 60], [225, 222, 212], [0.25, 0.5]);
    speckle(c, w, h, r, 900, [0.35, 0.9], (r2) => rgba(90, 90, 92, rr(r2, 0.25, 0.6)));
    speckle(c, w, h, r, 80, [0.8, 1.5], (r2) => rgba(110, 100, 90, rr(r2, 0.25, 0.5)));
  }, { repeat: true });
}

/** 白タイル（10cm角, テクスチャ1枚=0.4m） */
export function texWallTile(): THREE.CanvasTexture {
  return sharedTexture('walltile', 256, 256, (c, w, h) => {
    c.fillStyle = '#c8c8c2';
    c.fillRect(0, 0, w, h);
    const r = makeRng(7);
    const n = 4;
    const s = w / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const v = rr(r, 236, 248);
        const g = c.createLinearGradient(i * s, j * s, i * s + s, j * s + s);
        g.addColorStop(0, rgba(v + 4, v + 4, v + 2, 1));
        g.addColorStop(1, rgba(v - 8, v - 8, v - 10, 1));
        c.fillStyle = g;
        c.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
      }
    }
  }, { repeat: true });
}

/** 厨房の床: 灰色の防滑タイル（30cm角, 1枚=0.6m） */
export function texKitchenFloor(): THREE.CanvasTexture {
  return sharedTexture('kfloor', 256, 256, (c, w, h) => {
    c.fillStyle = '#4e5256';
    c.fillRect(0, 0, w, h);
    const r = makeRng(9);
    const s = w / 2;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const v = rr(r, 118, 132);
        c.fillStyle = rgba(v, v + 3, v + 6, 1);
        c.fillRect(i * s + 2, j * s + 2, s - 4, s - 4);
        // 防滑の粒
        for (let a = 0; a < 10; a++) {
          for (let b = 0; b < 10; b++) {
            const x = i * s + 8 + a * ((s - 16) / 9);
            const y = j * s + 8 + b * ((s - 16) / 9);
            c.fillStyle = rgba(v - 25, v - 23, v - 20, 0.6);
            c.beginPath();
            c.arc(x, y, 1.6, 0, Math.PI * 2);
            c.fill();
            c.fillStyle = rgba(v + 25, v + 27, v + 30, 0.35);
            c.beginPath();
            c.arc(x - 0.6, y - 0.6, 0.8, 0, Math.PI * 2);
            c.fill();
          }
        }
      }
    }
    mottle(c, w, h, r, 14, [20, 60], [70, 66, 60], [0.06, 0.16]);
  }, { repeat: true });
}

/** 客席の床: 濃い木のフローリング（1枚=2m） */
export function texWoodFloor(): THREE.CanvasTexture {
  return sharedTexture('wfloor', 512, 512, (c, w, h) => {
    const r = makeRng(13);
    const rows = 8;
    const ph = h / rows;
    for (let j = 0; j < rows; j++) {
      let x = -rr(r, 0, w * 0.5);
      while (x < w) {
        const len = rr(r, w * 0.35, w * 0.7);
        const base = rr(r, 62, 84);
        c.fillStyle = rgba(base, base * 0.68, base * 0.46, 1);
        c.fillRect(x, j * ph, len, ph);
        for (let k = 0; k < 14; k++) {
          const yy = j * ph + rr(r, 2, ph - 2);
          c.strokeStyle = rgba(base * 0.6, base * 0.4, base * 0.25, rr(r, 0.25, 0.55));
          c.lineWidth = rr(r, 0.5, 1.6);
          c.beginPath();
          c.moveTo(x, yy);
          c.bezierCurveTo(x + len * 0.3, yy + rr(r, -3, 3), x + len * 0.6, yy + rr(r, -3, 3), x + len, yy + rr(r, -2, 2));
          c.stroke();
        }
        c.fillStyle = 'rgba(20,12,8,0.85)';
        c.fillRect(x, j * ph, 1.5, ph);
        x += len;
      }
      c.fillStyle = 'rgba(20,12,8,0.9)';
      c.fillRect(0, j * ph, w, 1.5);
    }
  }, { repeat: true });
}

/** カウンター天板: 赤茶色の木目（1枚=1.2m） */
export function texCounterWood(): THREE.CanvasTexture {
  return sharedTexture('cwood', 512, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#9e5c34');
    g.addColorStop(0.5, '#a8653a');
    g.addColorStop(1, '#985631');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    const r = makeRng(17);
    for (let i = 0; i < 160; i++) {
      const y = r() * h;
      c.strokeStyle = r() < 0.5 ? rgba(120, 62, 32, rr(r, 0.2, 0.5)) : rgba(190, 120, 75, rr(r, 0.12, 0.3));
      c.lineWidth = rr(r, 0.5, 2.2);
      c.beginPath();
      c.moveTo(0, y);
      const a = rr(r, -4, 4);
      c.bezierCurveTo(w * 0.33, y + a, w * 0.66, y - a, w, y);
      c.stroke();
    }
    mottle(c, w, h, r, 12, [30, 90], [90, 45, 22], [0.08, 0.18]);
  }, { repeat: true });
}

/** 明るい白木（カウンターの縁） */
export function texLightWood(): THREE.CanvasTexture {
  return sharedTexture('lwood', 256, 128, (c, w, h) => {
    c.fillStyle = '#d8bb8c';
    c.fillRect(0, 0, w, h);
    const r = makeRng(19);
    for (let i = 0; i < 70; i++) {
      const y = r() * h;
      c.strokeStyle = r() < 0.6 ? rgba(176, 140, 92, rr(r, 0.2, 0.45)) : rgba(236, 214, 176, rr(r, 0.2, 0.4));
      c.lineWidth = rr(r, 0.5, 1.8);
      c.beginPath();
      c.moveTo(0, y);
      const a = rr(r, -3, 3);
      c.bezierCurveTo(w * 0.3, y + a, w * 0.7, y - a, w, y);
      c.stroke();
    }
    speckle(c, w, h, r, 40, [0.5, 1.2], () => 'rgba(120,90,60,0.35)');
  }, { repeat: true });
}

/** 歩道（インターロッキング, 1枚=1m） */
export function texSidewalk(): THREE.CanvasTexture {
  return sharedTexture('sidewalk', 256, 256, (c, w, h) => {
    c.fillStyle = '#6f6c66';
    c.fillRect(0, 0, w, h);
    const r = makeRng(23);
    const n = 4;
    const s = w / n;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const v = rr(r, 140, 168);
        c.fillStyle = rgba(v, v - 4, v - 10, 1);
        const off = j % 2 === 0 ? 0 : s / 2;
        c.fillRect(i * s + off + 1.5, j * s + 1.5, s - 3, s - 3);
        if (off > 0 && i === n - 1) c.fillRect(-s / 2 + 1.5, j * s + 1.5, s - 3, s - 3);
      }
    }
    speckle(c, w, h, r, 1200, [0.3, 0.9], (r2) => rgba(80, 78, 74, rr(r2, 0.15, 0.4)));
    mottle(c, w, h, r, 8, [30, 80], [60, 56, 50], [0.06, 0.12]);
  }, { repeat: true });
}

/** アスファルト（1枚=2m） */
export function texAsphalt(): THREE.CanvasTexture {
  return sharedTexture('asphalt', 256, 256, (c, w, h) => {
    c.fillStyle = '#3c3e41';
    c.fillRect(0, 0, w, h);
    const r = makeRng(29);
    speckle(c, w, h, r, 2500, [0.3, 1.0], (r2) => {
      const v = rr(r2, 30, 110);
      return rgba(v, v, v + 2, rr(r2, 0.3, 0.7));
    });
    mottle(c, w, h, r, 8, [40, 100], [20, 20, 22], [0.1, 0.2]);
  }, { repeat: true });
}

/** 店内の壁（クリーム色のしっくい） */
export function texPlaster(): THREE.CanvasTexture {
  return sharedTexture('plaster', 256, 256, (c, w, h) => {
    c.fillStyle = '#ebe3d2';
    c.fillRect(0, 0, w, h);
    const r = makeRng(31);
    mottle(c, w, h, r, 30, [20, 70], [210, 198, 176], [0.15, 0.35]);
    speckle(c, w, h, r, 500, [0.3, 0.8], (r2) => rgba(160, 150, 130, rr(r2, 0.1, 0.3)));
  }, { repeat: true });
}

// ───────────────────────── 料理 ─────────────────────────

/** 乳化スープの表面（背脂の粒・油の輪）。円盤の UV 0..1 に貼る */
export function texSoup(): THREE.CanvasTexture {
  return sharedTexture('soup', 512, 512, (c, w, h) => {
    const r = makeRng(41);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#b48c5c');
    g.addColorStop(0.75, '#ad8455');
    g.addColorStop(1, '#8e6640');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    mottle(c, w, h, r, 40, [12, 50], [205, 172, 128], [0.15, 0.35]);
    mottle(c, w, h, r, 30, [10, 40], [120, 82, 46], [0.12, 0.3]);
    // 背脂の細かい粒
    for (let i = 0; i < 2600; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = rr(r, 0.6, 2.4) * (r() < 0.08 ? 2 : 1);
      c.fillStyle = rgba(rr(r, 206, 232), rr(r, 180, 204), rr(r, 138, 160), rr(r, 0.4, 0.8));
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
      if (rad > 1.6) {
        c.fillStyle = 'rgba(255,248,230,0.55)';
        c.beginPath();
        c.arc(x - rad * 0.3, y - rad * 0.3, rad * 0.35, 0, Math.PI * 2);
        c.fill();
      }
    }
    // 油の輪
    for (let i = 0; i < 90; i++) {
      const x = r() * w;
      const y = r() * h;
      const rad = rr(r, 2, 9);
      c.strokeStyle = rgba(250, 226, 170, rr(r, 0.12, 0.3));
      c.lineWidth = rr(r, 0.8, 1.4);
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.stroke();
    }
  });
}

/** 豚（チャーシュー）のアトラス。左上=平切りの断面, 右上=巻き豚の断面, 左下=煮汁の染みた外側, 右下=刻みニンニク */
export const PORK_UV = {
  slab: { u: 0.25, v: 0.75, r: 0.235 },
  roll: { u: 0.75, v: 0.75, r: 0.235 },
  crust: { u0: 0.02, v0: 0.02, u1: 0.48, v1: 0.48 },
  garlic: { u0: 0.52, v0: 0.02, u1: 0.98, v1: 0.48 },
};

export function texPork(): THREE.CanvasTexture {
  return sharedTexture('pork', 1024, 1024, (c) => {
    const S = 512;
    const r = makeRng(53);
    // ── 平切り断面（中心 256,256） ──
    drawSlabFace(c, r, 256, 256, 248);
    // ── 巻き豚断面（中心 768,256） ──
    drawRollFace(c, r, 768, 256, 248);
    // ── 外側（煮汁の染みた繊維） ──
    c.save();
    c.beginPath();
    c.rect(0, S, S, S);
    c.clip();
    c.fillStyle = '#5a321d';
    c.fillRect(0, S, S, S);
    for (let i = 0; i < 700; i++) {
      const x = r() * S;
      const y = S + r() * S;
      const len = rr(r, 10, 60);
      c.strokeStyle = r() < 0.5 ? rgba(132, 80, 46, rr(r, 0.3, 0.7)) : rgba(52, 26, 12, rr(r, 0.3, 0.7));
      c.lineWidth = rr(r, 1, 3.5);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + rr(r, -6, 6), y + len);
      c.stroke();
    }
    mottle(c, S, S * 2, r, 30, [10, 40], [180, 120, 80], [0.1, 0.25]);
    c.restore();
    // ── 刻みニンニク（粒状） ──
    c.save();
    c.beginPath();
    c.rect(S, S, S, S);
    c.clip();
    c.fillStyle = '#e8d6a0';
    c.fillRect(S, S, S, S);
    for (let i = 0; i < 1500; i++) {
      const x = S + r() * S;
      const y = S + r() * S;
      const s = rr(r, 3, 10);
      c.fillStyle = r() < 0.5 ? rgba(rr(r, 238, 252), rr(r, 228, 242), rr(r, 180, 205), 0.9) : rgba(rr(r, 205, 225), rr(r, 180, 200), rr(r, 120, 150), 0.7);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + s, y + rr(r, -2, 3));
      c.lineTo(x + rr(r, 0, s), y + s);
      c.closePath();
      c.fill();
    }
    c.restore();
  });
}

function noisyCircle(c: CanvasRenderingContext2D, r: Rng, cx: number, cy: number, rad: number, amp: number, n = 48): void {
  const ph = r() * 10;
  const ph2 = r() * 10;
  c.beginPath();
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + amp * (0.6 * Math.sin(a * 3 + ph) + 0.4 * Math.sin(a * 7 + ph2)) + amp * 0.5 * (r() - 0.5);
    const x = cx + Math.cos(a) * rad * k;
    const y = cy + Math.sin(a) * rad * k;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.closePath();
}

function drawSlabFace(c: CanvasRenderingContext2D, r: Rng, cx: number, cy: number, R: number): void {
  c.save();
  // 外周の濃い煮汁色
  c.fillStyle = '#5e341d';
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.fill();
  // 染み込み帯
  const g1 = c.createRadialGradient(cx, cy, R * 0.55, cx, cy, R * 0.97);
  g1.addColorStop(0, '#9c7262');
  g1.addColorStop(0.75, '#8a5a40');
  g1.addColorStop(1, '#6a3c22');
  c.fillStyle = g1;
  noisyCircle(c, r, cx, cy, R * 0.93, 0.03);
  c.fill();
  // 中身: ピンクがかった灰色
  const g2 = c.createRadialGradient(cx - R * 0.1, cy - R * 0.1, 0, cx, cy, R * 0.85);
  g2.addColorStop(0, '#c9a79a');
  g2.addColorStop(0.6, '#bc9586');
  g2.addColorStop(1, '#a57a68');
  c.fillStyle = g2;
  noisyCircle(c, r, cx, cy, R * 0.8, 0.06);
  c.fill();
  c.clip();
  // 繊維（斜めの細い筋）
  const ang = -0.5;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (let i = 0; i < 260; i++) {
    const t = rr(r, -R, R);
    const ox = cx + -sa * t;
    const oy = cy + ca * t;
    const len = rr(r, R * 0.2, R * 0.9);
    const s0 = rr(r, -R, R - len);
    c.strokeStyle = r() < 0.55 ? rgba(150, 108, 94, rr(r, 0.2, 0.5)) : rgba(222, 196, 186, rr(r, 0.15, 0.4));
    c.lineWidth = rr(r, 0.8, 2.6);
    c.beginPath();
    let px = ox + ca * s0;
    let py = oy + sa * s0;
    c.moveTo(px, py);
    const steps = 6;
    for (let k = 1; k <= steps; k++) {
      const s = s0 + (len * k) / steps;
      px = ox + ca * s + -sa * rr(r, -2.5, 2.5);
      py = oy + sa * s + ca * rr(r, -2.5, 2.5);
      c.lineTo(px, py);
    }
    c.stroke();
  }
  // 細かい亀裂（ほろほろ感）
  for (let i = 0; i < 70; i++) {
    const x = cx + rr(r, -R * 0.7, R * 0.7);
    const y = cy + rr(r, -R * 0.7, R * 0.7);
    c.strokeStyle = rgba(110, 72, 58, rr(r, 0.35, 0.7));
    c.lineWidth = rr(r, 1, 2.2);
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + ca * rr(r, 6, 22), y + sa * rr(r, 6, 22) + rr(r, -4, 4));
    c.stroke();
  }
  // 脂の白い筋
  for (let i = 0; i < 4; i++) {
    const t = rr(r, -R * 0.6, R * 0.6);
    c.strokeStyle = rgba(232, 214, 196, rr(r, 0.35, 0.6));
    c.lineWidth = rr(r, 3, 9);
    c.beginPath();
    c.moveTo(cx - sa * t - ca * R, cy + ca * t - sa * R);
    c.quadraticCurveTo(cx - sa * t + rr(r, -20, 20), cy + ca * t + rr(r, -20, 20), cx - sa * t + ca * R, cy + ca * t + sa * R);
    c.stroke();
  }
  // 煮汁のつや斑
  mottleLocal(c, r, cx, cy, R * 0.8, 16, [10, 40], [120, 70, 44], [0.15, 0.35]);
  c.restore();
}

function drawRollFace(c: CanvasRenderingContext2D, r: Rng, cx: number, cy: number, R: number): void {
  c.save();
  c.fillStyle = '#6e4026';
  c.beginPath();
  c.arc(cx, cy, R, 0, Math.PI * 2);
  c.fill();
  const gm = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
  gm.addColorStop(0, '#c7a093');
  gm.addColorStop(1, '#b68a78');
  c.fillStyle = gm;
  noisyCircle(c, r, cx, cy, R * 0.9, 0.025);
  c.fill();
  c.clip();
  // 渦巻きの脂層
  c.strokeStyle = '#ecdcc4';
  c.lineCap = 'round';
  const turns = 2.2;
  for (let pass = 0; pass < 2; pass++) {
    c.beginPath();
    for (let i = 0; i <= 260; i++) {
      const a = (i / 260) * turns * Math.PI * 2;
      const rad = R * (0.16 + (0.7 * a) / (turns * Math.PI * 2));
      const x = cx + Math.cos(a) * rad;
      const y = cy + Math.sin(a) * rad;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.lineWidth = pass === 0 ? R * 0.08 : R * 0.028;
    c.strokeStyle = pass === 0 ? 'rgba(214,188,166,0.7)' : 'rgba(236,220,200,0.45)';
    c.stroke();
  }
  // 渦の芯（煮崩れた濃い部分）
  c.fillStyle = '#8e5e40';
  noisyCircle(c, r, cx + R * 0.05, cy, R * 0.13, 0.2);
  c.fill();
  for (let i = 0; i < 160; i++) {
    const a = r() * Math.PI * 2;
    const rad = rr(r, R * 0.2, R * 0.85);
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    c.strokeStyle = rgba(150, 110, 96, rr(r, 0.2, 0.45));
    c.lineWidth = rr(r, 0.8, 2);
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(a + 1.57) * rr(r, 5, 18), y + Math.sin(a + 1.57) * rr(r, 5, 18));
    c.stroke();
  }
  mottleLocal(c, r, cx, cy, R * 0.85, 10, [10, 30], [140, 84, 52], [0.1, 0.3]);
  c.restore();
}

function mottleLocal(c: CanvasRenderingContext2D, r: Rng, cx: number, cy: number, R: number, n: number, rad: [number, number], col: [number, number, number], alpha: [number, number]): void {
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2;
    const d = Math.sqrt(r()) * R;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const rd = rr(r, rad[0], rad[1]);
    const g = c.createRadialGradient(x, y, 0, x, y, rd);
    g.addColorStop(0, rgba(col[0], col[1], col[2], rr(r, alpha[0], alpha[1])));
    g.addColorStop(1, rgba(col[0], col[1], col[2], 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, rd, 0, Math.PI * 2);
    c.fill();
  }
}

/** もやしの絡み（ヤサイの山の芯に貼る） */
export function texSprouts(): THREE.CanvasTexture {
  return sharedTexture('sprouts', 512, 512, (c, w, h) => {
    c.fillStyle = '#e2dac2';
    c.fillRect(0, 0, w, h);
    const r = makeRng(61);
    for (let i = 0; i < 520; i++) {
      const x = r() * w;
      const y = r() * h;
      const a = r() * Math.PI * 2;
      const len = rr(r, 40, 90);
      const bend = rr(r, -20, 20);
      const x2 = x + Math.cos(a) * len;
      const y2 = y + Math.sin(a) * len;
      const mx = (x + x2) / 2 - Math.sin(a) * bend;
      const my = (y + y2) / 2 + Math.cos(a) * bend;
      for (const dx of [-w, 0, w]) {
        for (const dy of [-h, 0, h]) {
          if (Math.max(x, x2) + dx < -10 || Math.min(x, x2) + dx > w + 10 || Math.max(y, y2) + dy < -10 || Math.min(y, y2) + dy > h + 10) continue;
          c.lineCap = 'round';
          c.strokeStyle = 'rgba(184,172,140,0.7)';
          c.lineWidth = 7;
          c.beginPath();
          c.moveTo(x + dx, y + dy);
          c.quadraticCurveTo(mx + dx, my + dy, x2 + dx, y2 + dy);
          c.stroke();
          c.strokeStyle = r() < 0.15 ? 'rgba(236,230,206,1)' : 'rgba(250,248,238,1)';
          c.lineWidth = 5.2;
          c.stroke();
          c.strokeStyle = 'rgba(255,255,255,0.7)';
          c.lineWidth = 1.2;
          c.stroke();
          c.fillStyle = 'rgba(226,206,120,0.95)';
          c.beginPath();
          c.ellipse(x + dx, y + dy, 4, 3, a, 0, Math.PI * 2);
          c.fill();
        }
      }
    }
  }, { repeat: true });
}

/** 湯気のふわっとした斑（アルファ） */
export function texWisp(): THREE.CanvasTexture {
  return sharedTexture('wisp', 128, 128, (c, w, h) => {
    const r = makeRng(71);
    c.clearRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) {
      const a = r() * Math.PI * 2;
      const d = rr(r, 0, w * 0.18);
      const x = w / 2 + Math.cos(a) * d;
      const y = h / 2 + Math.sin(a) * d;
      const rad = rr(r, w * 0.14, w * 0.3);
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(255,255,255,0.28)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    }
  }, { mipmaps: true });
}

/** 食べ終えた丼の内側の汚れ（垂れたスープ・唐辛子の粒）。透明 */
export function texBowlStain(): THREE.CanvasTexture {
  return sharedTexture('bowlstain', 512, 128, (c, w, h) => {
    const r = makeRng(83);
    c.clearRect(0, 0, w, h);
    // 下部（v 小=丼の底側）ほど濃い
    const g = c.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(120,80,40,0.55)');
    g.addColorStop(0.35, 'rgba(140,96,52,0.25)');
    g.addColorStop(0.7, 'rgba(150,104,60,0.06)');
    g.addColorStop(1, 'rgba(150,104,60,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    // 垂れたスープの筋
    for (let i = 0; i < 22; i++) {
      const x = r() * w;
      const y0 = rr(r, h * 0.05, h * 0.4);
      const len = rr(r, h * 0.1, h * 0.4);
      c.strokeStyle = rgba(130, 86, 42, rr(r, 0.06, 0.16));
      c.lineWidth = rr(r, 1.5, 5);
      c.beginPath();
      c.moveTo(x, y0);
      c.lineTo(x + rr(r, -3, 3), y0 + len);
      c.stroke();
    }
    // 唐辛子の粒
    speckle(c, w, h, r, 160, [0.6, 1.4], (r2) => rgba(rr(r2, 180, 220), rr(r2, 50, 90), 30, rr(r2, 0.5, 0.9)));
    // 背脂の粒
    speckle(c, w, h, r, 120, [0.8, 2], (r2) => rgba(230, 210, 170, rr(r2, 0.4, 0.8)));
  }, { repeat: true });
}

/** 床の汚れ（油汚れ）: アルファ付き */
export function texGrime(): THREE.CanvasTexture {
  return sharedTexture('grime', 256, 256, (c, w, h) => {
    const r = makeRng(91);
    c.clearRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 0.7) * w * 0.32;
      const x = w / 2 + Math.cos(a) * d;
      const y = h / 2 + Math.sin(a) * d;
      const rad = rr(r, 10, 40);
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, rgba(58, 44, 30, rr(r, 0.25, 0.5)));
      g.addColorStop(1, 'rgba(58,44,30,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    }
    speckle(c, w, h, r, 120, [0.8, 2.5], (r2) => rgba(40, 30, 20, rr(r2, 0.2, 0.5)));
    // 靴跡っぽいかすれ
    for (let i = 0; i < 8; i++) {
      c.strokeStyle = 'rgba(45,35,25,0.18)';
      c.lineWidth = rr(r, 6, 14);
      c.beginPath();
      const x = rr(r, w * 0.25, w * 0.75);
      const y = rr(r, h * 0.25, h * 0.75);
      c.moveTo(x, y);
      c.lineTo(x + rr(r, -40, 40), y + rr(r, -40, 40));
      c.stroke();
    }
  }, { mipmaps: true });
}

/** こぼれたスープ（アルファ付き） */
export function texSpill(): THREE.CanvasTexture {
  return sharedTexture('spill', 256, 256, (c, w, h) => {
    const r = makeRng(97);
    c.clearRect(0, 0, w, h);
    c.fillStyle = 'rgba(132,90,50,0.92)';
    noisyCircle(c, r, w / 2, h / 2, w * 0.3, 0.16, 40);
    c.fill();
    for (let i = 0; i < 6; i++) {
      const a = r() * Math.PI * 2;
      const d = rr(r, w * 0.3, w * 0.42);
      noisyCircle(c, r, w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, rr(r, 6, 16), 0.2, 16);
      c.fill();
    }
    c.globalCompositeOperation = 'source-atop';
    // 背脂の粒
    for (let i = 0; i < 160; i++) {
      c.fillStyle = rgba(226, 204, 160, rr(r, 0.5, 0.9));
      c.beginPath();
      c.arc(rr(r, w * 0.15, w * 0.85), rr(r, h * 0.15, h * 0.85), rr(r, 0.8, 2.2), 0, Math.PI * 2);
      c.fill();
    }
    const g = c.createRadialGradient(w * 0.42, h * 0.4, 0, w / 2, h / 2, w * 0.4);
    g.addColorStop(0, 'rgba(200,160,110,0.5)');
    g.addColorStop(1, 'rgba(90,58,30,0.3)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  }, { mipmaps: true });
}

/**
 * 反射用の簡易環境（正距円筒）。厨房の天井照明・壁・床をぼんやり描いたもの。
 * 金属や陶器の material.envMap に直接設定するので、シーン側で environment を用意しなくても金属が黒く沈まない。
 */
export function texEnv(): THREE.CanvasTexture {
  return cached('tex:env', () => {
    const t = canvasTexture(512, 256, (c, w, h) => {
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#d9d4cb');
      g.addColorStop(0.32, '#cfc8bc');
      g.addColorStop(0.5, '#9a948a');
      g.addColorStop(0.62, '#6e6862');
      g.addColorStop(1, '#3c3936');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      // 天井の照明パネル
      for (let i = 0; i < 6; i++) {
        const x = (i / 6) * w + 20;
        c.fillStyle = 'rgba(255,252,240,1)';
        c.fillRect(x, h * 0.08, 46, 14);
        c.fillRect(x + 10, h * 0.2, 30, 10);
      }
      // 壁の明るい面（白タイル・窓）と暗い面（機器）
      const r = makeRng(5);
      for (let i = 0; i < 14; i++) {
        const x = r() * w;
        const ww = rr(r, 20, 70);
        const v = r() < 0.5 ? rr(r, 190, 235) : rr(r, 60, 110);
        c.fillStyle = rgba(v, v, v - 4, 0.8);
        c.fillRect(x, h * rr(r, 0.36, 0.44), ww, h * rr(r, 0.1, 0.2));
      }
    }, { mipmaps: false });
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  });
}

/** 一味唐辛子の粉の層（アルファテスト用）。中心ほど密で、縁は粒がまばら */
export function texChiliPowder(): THREE.CanvasTexture {
  return sharedTexture('chilipowder', 512, 512, (c, w, h) => {
    const r = makeRng(131);
    c.clearRect(0, 0, w, h);
    const cols: [number, number, number][] = [
      [214, 78, 34],
      [228, 104, 48],
      [236, 128, 62],
      [198, 58, 26],
      [242, 146, 78],
      [220, 90, 38],
      [176, 44, 20],
    ];
    // 中心は粉が厚く積もって地が見えない
    c.fillStyle = 'rgb(218,88,40)';
    noisyCircle(c, r, w / 2, h / 2, w * 0.17, 0.25, 40);
    c.fill();
    const blobs: [number, number, number][] = [[0.5, 0.5, 0.2]];
    for (let i = 0; i < 4; i++) blobs.push([rr(r, 0.3, 0.7), rr(r, 0.3, 0.7), rr(r, 0.08, 0.14)]);
    for (let i = 0; i < 26000; i++) {
      const b = blobs[i % blobs.length]!;
      const u = Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * Math.cos(2 * Math.PI * r());
      const v = Math.sqrt(-2 * Math.log(Math.max(1e-6, r()))) * Math.cos(2 * Math.PI * r());
      const x = (b[0] + u * b[2]) * w;
      const y = (b[1] + v * b[2]) * h;
      const d = Math.hypot(x / w - 0.5, y / h - 0.5);
      if (d > 0.48) continue;
      const k = cols[Math.floor(r() * cols.length)]!;
      const br = rr(r, 0.85, 1.1);
      c.fillStyle = rgba(k[0] * br, k[1] * br, k[2] * br, 1);
      const s = rr(r, 1.2, 3.2);
      c.fillRect(x - s / 2, y - s / 2, s, s * rr(r, 0.6, 1.2));
    }
  }, { mipmaps: true });
}
