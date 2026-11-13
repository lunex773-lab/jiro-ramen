// 芸能人のサイン（色紙）の見た目（第2版 12-5）。名前は架空の芸能人。
// 人ごとに書き方が違う（オーナーの指示 2026-11-13「サインももっと色んなパターン」）: 色紙の色と縁・字の色と太さ・
// 縦書き / 横書き / 斜め / くずし字・飾り（下線の流れ・星・ハート・丸囲み・ラーメンの絵・音符・王冠・ぐるぐる）・ひとこと。
// 書き方は出演者の id から決まる（同じ人のサインはいつも同じ見た目）。

import * as THREE from 'three';
import type { CelebritySign } from '@jiro/core';
import { JP_FONT } from './models/textures';
import { SIGN_H, SIGN_W, type SignSlot } from './sign-slots';

const SERIF = "'Hiragino Mincho ProN','Yu Mincho','Noto Serif JP','IPAMincho',serif";

/** id から決まる乱数（同じ人はいつも同じサイン） */
function rngOf(id: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length]!;

/** 色紙の地と縁 */
const BOARDS = [
  { bg: '#fbf7ec', edge: '#c9a227', kind: 'gold' },
  { bg: '#ffffff', edge: '#b8b8b8', kind: 'silver' },
  { bg: '#fdf1f4', edge: '#d98ca5', kind: 'pink' },
  { bg: '#eef5fb', edge: '#7fa7c9', kind: 'blue' },
  { bg: '#f6f0e1', edge: '#8a5a2b', kind: 'wood' },
  { bg: '#fffbe6', edge: '#c0392b', kind: 'red' },
] as const;

/** 字の色（墨・紺・朱・金茶・深緑・紫） */
const INKS = ['#141414', '#1d2b5a', '#a3201b', '#7a5a12', '#1f4d3a', '#4b2a6b'] as const;

const MESSAGES = ['ご来店記念', 'ごちそうさま！', 'また来ます！', 'マシマシ最高！', '応援してます', '感謝！', 'ありがとう♪', '最高の一杯！', '麺に感謝', 'うまかった！'] as const;

type Layout = 'vertical' | 'horizontal' | 'diagonal' | 'cursive';
type Flourish = 'swoosh' | 'stars' | 'heart' | 'circle' | 'ramen' | 'notes' | 'crown' | 'spiral' | 'underline2';

function drawBoard(g: CanvasRenderingContext2D, b: (typeof BOARDS)[number], r: () => number): void {
  g.fillStyle = b.bg;
  g.fillRect(0, 0, 256, 288);
  // 地の模様（金砂子・和紙の繊維・何もなし）
  const pattern = Math.floor(r() * 3);
  if (pattern === 0) {
    g.fillStyle = 'rgba(201,162,39,0.35)';
    for (let i = 0; i < 70; i++) g.fillRect(r() * 256, r() * 288, 1.5 + r() * 2, 1.5 + r() * 2);
  } else if (pattern === 1) {
    g.strokeStyle = 'rgba(120,100,70,0.12)';
    g.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const x = r() * 256;
      const y = r() * 288;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + 8 - r() * 16, y + 6, x + 14 - r() * 28, y + 10 - r() * 4);
      g.stroke();
    }
  }
  // 縁（太い金縁・二重線・角の丸い線）
  const frame = Math.floor(r() * 3);
  g.strokeStyle = b.edge;
  if (frame === 0) {
    g.lineWidth = 10;
    g.strokeRect(5, 5, 246, 278);
  } else if (frame === 1) {
    g.lineWidth = 4;
    g.strokeRect(6, 6, 244, 276);
    g.lineWidth = 1.5;
    g.strokeRect(13, 13, 230, 262);
  } else {
    g.lineWidth = 6;
    const rr = 18;
    g.beginPath();
    g.moveTo(8 + rr, 8);
    g.arcTo(248, 8, 248, 280, rr);
    g.arcTo(248, 280, 8, 280, rr);
    g.arcTo(8, 280, 8, 8, rr);
    g.arcTo(8, 8, 248, 8, rr);
    g.closePath();
    g.stroke();
  }
}

/** 名前を書く。書いた範囲（飾りの位置に使う）を返す */
function drawName(g: CanvasRenderingContext2D, name: string, layout: Layout, ink: string, r: () => number): { x: number; y: number; w: number; h: number } {
  const chars = [...name.replace(/\s/g, '')];
  const weight = pick(r, ['900', '700', '500'] as const);
  const family = r() < 0.5 ? SERIF : JP_FONT;
  g.fillStyle = ink;
  g.strokeStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (layout === 'vertical') {
    const size = Math.min(46, 200 / Math.max(1, chars.length));
    const x = 150 + r() * 22;
    g.save();
    g.translate(x, 40);
    g.rotate(-0.1 + r() * 0.12);
    g.font = `${weight} ${size}px ${family}`;
    // 1字ずつ少し揺らす（筆の勢い）
    chars.forEach((ch, i) => {
      g.save();
      g.translate((r() - 0.5) * 6, i * size * 1.02);
      g.rotate((r() - 0.5) * 0.18);
      g.fillText(ch, 0, 0);
      g.restore();
    });
    g.restore();
    return { x: x - size / 2, y: 30, w: size, h: chars.length * size * 1.02 };
  }
  if (layout === 'horizontal' || layout === 'cursive') {
    const size = Math.min(44, 220 / Math.max(1, chars.length));
    const y = 120 + r() * 30;
    g.save();
    g.translate(128, y);
    g.rotate(-0.08 + r() * 0.06);
    g.font = `${layout === 'cursive' ? 'italic ' : ''}${weight} ${size}px ${family}`;
    if (layout === 'cursive') g.transform(1, 0, -0.25, 1, 0, 0);
    const total = chars.length * size * 0.92;
    chars.forEach((ch, i) => {
      g.save();
      g.translate(-total / 2 + (i + 0.5) * size * 0.92, (r() - 0.5) * 8);
      g.rotate((r() - 0.5) * 0.2);
      g.fillText(ch, 0, 0);
      g.restore();
    });
    // くずし字: 字をつなぐ細い線
    if (layout === 'cursive') {
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-total / 2, size * 0.35);
      for (let i = 1; i <= chars.length; i++) g.quadraticCurveTo(-total / 2 + (i - 0.5) * size * 0.92, size * (0.1 + r() * 0.5), -total / 2 + i * size * 0.92, size * 0.35);
      g.stroke();
    }
    g.restore();
    return { x: 128 - total / 2, y: y - size / 2, w: total, h: size };
  }
  // 斜め（左下から右上へ）
  const size = Math.min(40, 230 / Math.max(1, chars.length));
  g.save();
  g.translate(128, 140);
  g.rotate(-0.55 + r() * 0.15);
  g.font = `${weight} ${size}px ${family}`;
  const total = chars.length * size;
  chars.forEach((ch, i) => g.fillText(ch, -total / 2 + (i + 0.5) * size, (r() - 0.5) * 6));
  g.restore();
  return { x: 128 - total / 2, y: 140 - total / 3, w: total, h: (total * 2) / 3 };
}

function star(g: CanvasRenderingContext2D, x: number, y: number, rad: number): void {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? rad : rad * 0.45;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

function drawFlourish(g: CanvasRenderingContext2D, f: Flourish, box: { x: number; y: number; w: number; h: number }, ink: string, r: () => number): void {
  g.save();
  g.strokeStyle = ink;
  g.fillStyle = ink;
  g.lineCap = 'round';
  g.lineWidth = 3;
  const bx = box.x + box.w / 2;
  const by = box.y + box.h;
  switch (f) {
    case 'swoosh': {
      // 名前の下を勢いよく払う
      g.beginPath();
      const y = Math.min(206, by + 12);
      g.moveTo(40, y);
      g.bezierCurveTo(90, y + 22, 170, y - 22, 222, y - 6);
      g.stroke();
      break;
    }
    case 'underline2': {
      for (const dy of [10, 18]) {
        g.beginPath();
        g.moveTo(Math.max(24, box.x - 6), Math.min(212, by + dy));
        g.lineTo(Math.min(232, box.x + box.w + 6), Math.min(212, by + dy - 4));
        g.stroke();
      }
      break;
    }
    case 'stars':
      // ひとことの文字（上の左右・下）にかからない、左右の余白
      for (let i = 0; i < 3; i++) star(g, i % 2 === 0 ? 28 + r() * 36 : 196 + r() * 32, 78 + r() * 24 + (i === 2 ? 90 : 0), 6 + r() * 6);
      break;
    case 'heart': {
      const x = 200 - r() * 30;
      const y = 200 - r() * 40;
      g.beginPath();
      g.moveTo(x, y + 8);
      g.bezierCurveTo(x - 18, y - 6, x - 6, y - 18, x, y - 6);
      g.bezierCurveTo(x + 6, y - 18, x + 18, y - 6, x, y + 8);
      g.fillStyle = '#d6336c';
      g.fill();
      break;
    }
    case 'circle': {
      // 名前を丸で囲む
      g.lineWidth = 2.5;
      const cy = box.y + box.h / 2;
      g.beginPath();
      g.ellipse(bx, cy, Math.min(118, box.w / 2 + 22), Math.min(cy - 16, 228 - cy, box.h / 2 + 18), -0.1, 0.3, Math.PI * 2 + 0.1);
      g.stroke();
      break;
    }
    case 'ramen': {
      // どんぶりと湯気の小さな絵
      const x = 38 + r() * 10;
      const y = 196;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(x, y, 18, 0, Math.PI);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(x - 12, y - 4);
      g.lineTo(x + 16, y - 22);
      g.moveTo(x - 6, y - 4);
      g.lineTo(x + 20, y - 18);
      g.stroke();
      for (const dx of [-8, 0, 8]) {
        g.beginPath();
        g.moveTo(x + dx, y - 26);
        g.quadraticCurveTo(x + dx + 5, y - 32, x + dx, y - 38);
        g.stroke();
      }
      break;
    }
    case 'notes': {
      g.font = `bold 26px ${JP_FONT}`;
      g.fillText('♪', 212, 96 + r() * 24);
      g.fillText('♫', 40, 150 + r() * 24);
      break;
    }
    case 'crown': {
      const x = bx;
      const y = Math.max(24, box.y - 18);
      g.fillStyle = '#c9a227';
      g.beginPath();
      g.moveTo(x - 18, y + 8);
      g.lineTo(x - 18, y - 6);
      g.lineTo(x - 9, y + 2);
      g.lineTo(x, y - 10);
      g.lineTo(x + 9, y + 2);
      g.lineTo(x + 18, y - 6);
      g.lineTo(x + 18, y + 8);
      g.closePath();
      g.fill();
      break;
    }
    case 'spiral': {
      // ぐるぐるの飾り
      g.lineWidth = 2;
      const x = 212 - r() * 14;
      const y = 186 - r() * 14;
      g.beginPath();
      for (let t = 0; t < Math.PI * 4; t += 0.2) g.lineTo(x + Math.cos(t) * t * 1.2, y + Math.sin(t) * t * 1.2);
      g.stroke();
      break;
    }
  }
  g.restore();
}

function signTexture(sign: CelebritySign): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 288;
  const g = c.getContext('2d')!;
  const r = rngOf(sign.celebId);
  const board = pick(r, BOARDS);
  const ink = pick(r, INKS);
  const layout = pick(r, ['vertical', 'horizontal', 'diagonal', 'cursive'] as const);
  // 縦書きは名前が右の列を通るので、左側の飾りだけ
  // 斜めは名前の上が左上のひとことに近いので王冠は付けない
  const allowed: readonly Flourish[] =
    layout === 'vertical'
      ? ['stars', 'circle', 'ramen', 'notes']
      : layout === 'diagonal'
        ? ['swoosh', 'stars', 'heart', 'circle', 'ramen', 'notes', 'spiral', 'underline2']
        : ['swoosh', 'stars', 'heart', 'circle', 'ramen', 'notes', 'crown', 'spiral', 'underline2'];
  const flourishes: Flourish[] = allowed.filter(() => r() < 0.32);
  if (flourishes.length === 0) flourishes.push(pick(r, allowed));
  // 丸囲みと下線は一緒にしない
  if (flourishes.includes('circle')) for (const f of ['swoosh', 'underline2'] as const) if (flourishes.includes(f)) flourishes.splice(flourishes.indexOf(f), 1);
  drawBoard(g, board, r);
  const box = drawName(g, sign.name, layout, ink, r);
  for (const f of flourishes.slice(0, 3)) drawFlourish(g, f, box, ink, r);
  // ひとこと（左上・右上・下のどこか）
  const msg = pick(r, MESSAGES);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 15px ${r() < 0.5 ? SERIF : JP_FONT}`;
  g.fillStyle = r() < 0.5 ? '#7a1c1c' : ink;
  const spot = layout === 'vertical' ? 0 : Math.floor(r() * 3);
  if (spot === 0) g.fillText(msg, 64, 56);
  else if (spot === 1) g.fillText(msg, 192, 56);
  else g.fillText(msg, 128, 222);
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
