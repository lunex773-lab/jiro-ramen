// 厨房設備の形と動き（麺釜・寸胴・鍋・作業台・盛り付け台・トッピング台・丼棚・洗い場・食洗機・冷蔵庫など）。

import * as THREE from 'three';
import { BALANCE, EQUIPMENT, stockOf, type Equipment, type GameState } from '@jiro/core';
import { cached, clamp, makeRng, rr, tmp, GeoBuilder } from './common';
import { canvasTexture, JP_FONT, PORK_UV, texPork, texSprouts, texEnv, texChiliPowder } from './textures';
import { createSteam, IND_COLORS } from './fx';
import { BOWL_DIMS, bowlShellGeometry, bowlStainGeometry, bowlStainMaterial } from './bowl';
import {
  addIndicator,
  addStatic,
  basinShape,
  cabinet,
  createBubbles,
  disc,
  EQ_MAT,
  feet,
  gasStand,
  innerWall,
  insideOut,
  MAT,
  namePlate,
  plastic,
  potBody,
  processBar,
  workTable,
  glow,
  type EqCtx,
} from './equip-common';

// ───────────────────────── 共有の小物 ─────────────────────────

/** 穴あきステンレス（てぼ・ザル）のアルファマップ */
function perforatedMat(): THREE.MeshStandardMaterial {
  return cached('eqm:perf', () => {
    const alpha = canvasTexture(
      64,
      64,
      (c, w, h) => {
        c.fillStyle = '#ffffff';
        c.fillRect(0, 0, w, h);
        c.fillStyle = '#000000';
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          c.beginPath();
          c.arc(x * 8 + 4 + (y % 2) * 4, y * 8 + 4, 2.6, 0, Math.PI * 2);
          c.fill();
        }
      },
      { srgb: false, repeat: true },
    );
    alpha.repeat.set(10, 3);
    return new THREE.MeshStandardMaterial({
      color: '#c9ced2',
      metalness: 0.75,
      roughness: 0.35,
      alphaMap: alpha,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      envMap: texEnv(),
    });
  });
}

/** てぼ（麺のゆでかご）: 開いた円筒の網＋底＋長い柄。原点=かごの上端中心、柄は -Z（手前）へ */
function teboParts(): { geo: THREE.BufferGeometry; mat: THREE.Material }[] {
  return cached('tebo', () => {
    const b = new GeoBuilder();
    b.cyl(perforatedMat(), 0.068, 0.06, 0.2, 14, { y: -0.2, open: true });
    const bottom = new THREE.CircleGeometry(0.06, 14);
    bottom.rotateX(-Math.PI / 2);
    b.add(perforatedMat(), bottom, { y: -0.2 });
    const rim = new THREE.TorusGeometry(0.068, 0.005, 4, 16);
    rim.rotateX(Math.PI / 2);
    b.add(MAT.steelPolished(), rim, {});
    // 柄（手前上へ）
    const len = 0.36;
    const handle = new THREE.CylinderGeometry(0.008, 0.008, len, 6);
    handle.translate(0, len / 2, 0);
    handle.rotateX(-1.15);
    handle.translate(0, 0, -0.066);
    b.add(MAT.steelPolished(), handle);
    const grip = new THREE.CylinderGeometry(0.014, 0.014, 0.12, 8);
    grip.translate(0, len - 0.06, 0);
    grip.rotateX(-1.15);
    grip.translate(0, 0, -0.066);
    b.add(plastic('#1d1d1d', 0.6), grip);
    return b.merged();
  });
}

/** てぼの中の麺の塊 */
function noodleBundleGeometry(): THREE.BufferGeometry {
  return cached('noodlebundle', () => {
    const parts: THREE.BufferGeometry[] = [];
    const r = makeRng(17);
    for (let i = 0; i < 4; i++) {
      const t = new THREE.TorusGeometry(rr(r, 0.028, 0.045), 0.009, 4, 12);
      t.rotateX(Math.PI / 2 + rr(r, -0.4, 0.4));
      t.rotateZ(rr(r, -0.4, 0.4));
      t.translate(rr(r, -0.01, 0.01), -i * 0.014, rr(r, -0.01, 0.01));
      t.deleteAttribute('uv');
      parts.push(t);
    }
    const g = new THREE.BufferGeometry();
    // 結合（属性は position/normal のみ）
    const pos: number[] = [];
    const nor: number[] = [];
    const idx: number[] = [];
    for (const p of parts) {
      const base = pos.length / 3;
      const pa = p.attributes.position!;
      const na = p.attributes.normal!;
      for (let k = 0; k < pa.count; k++) {
        pos.push(pa.getX(k), pa.getY(k), pa.getZ(k));
        nor.push(na.getX(k), na.getY(k), na.getZ(k));
      }
      const ix = p.index!;
      for (let k = 0; k < ix.count; k++) idx.push(base + ix.getX(k));
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  });
}

const DONENESS = { blue: IND_COLORS.blue, green: IND_COLORS.green, yellow: IND_COLORS.yellow, red: IND_COLORS.red };

/** ゆで加減の色（elapsed/ideal: 青<0.6, 緑 0.84〜1.16, 黄=その他, 赤=理想+悪化幅超え） */
function donenessColor(elapsed: number, ideal: number): THREE.Color {
  if (elapsed > ideal + BALANCE.cooking.noodleBadWindow) return DONENESS.red;
  const r = elapsed / Math.max(0.01, ideal);
  if (r < 0.6) return DONENESS.blue;
  if (r >= 0.84 && r <= 1.16) return DONENESS.green;
  return DONENESS.yellow;
}

function broken(e: Equipment): boolean {
  return e.status === 'broken' || e.status === 'repairing';
}

// ───────────────────────── 麺釜 ─────────────────────────

export function buildBoiler(c: EqCtx): void {
  const { W, D, H } = c;
  const cap = EQUIPMENT[c.type]?.capacity ?? 4;
  const large = cap > 4;
  const holeW = large ? W - 0.24 : 0.74;
  const holeD = large ? 0.6 : 0.74;
  const hz = 0.03;
  const hole = basinShape(holeW, holeD);
  const waterY = H - 0.1;
  addStatic(c, c.type, (b) => {
    cabinet(b, W, D, H - 0.03, { doors: large ? 3 : 2, top: false, hollow: true });
    plateWithHoleLocal(b, W, D, H, hole, 0, hz);
    innerWall(b, MAT.steel(), hole, H - 0.5, H - 0.03, hz, true);
    // 縁の丸い返し
    const pts = hole.getPoints(32);
    const lip = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, H + 0.004, p.y + hz)), true), 48, 0.012, 5, true);
    b.add(MAT.steelPolished(), lip);
    // 手前のてぼ掛けレール
    b.cyl(MAT.steelPolished(), 0.012, 0.012, W - 0.12, 8, { y: H + 0.03, z: -D / 2 + 0.07, rz: Math.PI / 2, x: (W - 0.12) / 2 });
    for (const sx of [-1, 1]) b.cyl(MAT.steelPolished(), 0.01, 0.01, 0.05, 6, { x: sx * (W / 2 - 0.08), y: H, z: -D / 2 + 0.07 });
    // 前面: 温度計とガスのつまみ
    b.cyl(MAT.black(), 0.05, 0.05, 0.02, 20, { x: -W / 2 + 0.15, y: H - 0.16, z: -D / 2 + 0.005, rx: -Math.PI / 2 });
    b.cyl(plastic('#f4f4f0', 0.4), 0.042, 0.042, 0.01, 20, { x: -W / 2 + 0.15, y: H - 0.16, z: -D / 2 - 0.012, rx: -Math.PI / 2 });
    b.box(plastic('#c62828', 0.5), 0.004, 0.034, 0.004, { x: -W / 2 + 0.15, y: H - 0.15, z: -D / 2 - 0.019, rz: 0.6 });
    for (const x of [W / 2 - 0.15, W / 2 - 0.27]) {
      b.cyl(MAT.black(), 0.028, 0.028, 0.035, 12, { x, y: H - 0.16, z: -D / 2 + 0.005, rx: -Math.PI / 2 });
    }
    b.box(namePlate(large ? '大型ゆで麺機' : 'ゆで麺機'), 0.2, 0.05, 0.004, { y: H - 0.16, z: -D / 2 - 0.004 });
  });
  // 水面
  const water = new THREE.Mesh(
    cached('boilwater:' + c.type, () => {
      const g = new THREE.ShapeGeometry(hole, 24);
      g.rotateX(-Math.PI / 2);
      g.scale(1, 1, -1);
      const ix = g.index!;
      for (let i = 0; i < ix.count; i += 3) {
        const t = ix.getX(i + 1);
        ix.setX(i + 1, ix.getX(i + 2));
        ix.setX(i + 2, t);
      }
      g.computeVertexNormals();
      const uv = g.attributes.uv!;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.5, uv.getY(i) * 1.5);
      return g;
    }),
    EQ_MAT.boilWater(),
  );
  water.position.set(0, waterY, hz);
  c.group.add(water);
  const bubbles = createBubbles(22, holeW / 2, holeD / 2, 3, c.owned, !large);
  bubbles.mesh.position.z = hz;
  c.group.add(bubbles.mesh);
  const steam = createSteam({ count: 10, radius: Math.min(holeW, holeD) * 0.4, rise: 1.0, size: 0.38, speed: 0.28, spread: 0.06, opacity: 0.42, seed: 11 });
  steam.position.set(0, H, hz);
  c.group.add(steam);
  // てぼ（スロットごと）: かごは静的部品に結合し、麺だけ InstancedMesh で出し入れする
  const slotX: number[] = [];
  const slotZ = hz - (large ? 0.1 : 0.13);
  for (let i = 0; i < cap; i++) slotX.push(large ? (i - (cap - 1) / 2) * 0.2 : (i - (cap - 1) / 2) * 0.16);
  addStatic(c, c.type + ':tebo', (b) => {
    for (let i = 0; i < cap; i++) for (const { geo, mat } of teboParts()) b.add(mat, geo, { x: slotX[i]!, y: H + 0.025, z: slotZ });
  });
  const noodles = new THREE.InstancedMesh(noodleBundleGeometry(), MAT.noodle(), cap);
  noodles.castShadow = false;
  noodles.frustumCulled = false;
  c.owned.push(noodles);
  c.group.add(noodles);
  const rings: ReturnType<typeof addIndicator>[] = [];
  for (let i = 0; i < cap; i++) rings.push(addIndicator(c, 'ring', 0.13, new THREE.Vector3(slotX[i]!, H + 0.3, slotZ)));
  c.updaters.push((e, _s, t) => {
    const off = broken(e);
    bubbles.update(t, off ? 0 : 1, waterY + 0.002);
    steam.visible = !off;
    for (let i = 0; i < cap; i++) {
      const sl = e.slots[i] ?? null;
      const ring = rings[i]!;
      ring.mesh.visible = !!sl;
      // 麺は湯の中で少し揺れる（空のスロットは大きさ0）
      const sc = sl ? 1 : 0;
      tmp.m.makeScale(sc, sc, sc);
      tmp.m.setPosition(slotX[i]!, waterY + 0.012 + (sl ? Math.sin(t * 3 + i) * 0.004 : 0), slotZ);
      noodles.setMatrixAt(i, tmp.m);
      if (sl) ring.set(clamp(sl.elapsed / Math.max(0.01, sl.ideal), 0, 1), donenessColor(sl.elapsed, sl.ideal));
    }
    noodles.instanceMatrix.needsUpdate = true;
  });
}

/** 単一の開口を持つ天板（common の plateWithHole の薄いラッパ） */
function plateWithHoleLocal(b: GeoBuilder, W: number, D: number, y: number, hole: THREE.Shape, offX: number, offZ: number): void {
  plateWithHoles(b, MAT.steel(), W, D, y, 0.03, [{ shape: hole, x: offX, z: offZ }]);
}

/** 複数の開口を持つ天板 */
function plateWithHoles(b: GeoBuilder, mat: THREE.Material, W: number, D: number, y: number, thick: number, holes: { shape: THREE.Shape; x: number; z: number }[]): void {
  const s = new THREE.Shape();
  s.moveTo(-W / 2, -D / 2);
  s.lineTo(W / 2, -D / 2);
  s.lineTo(W / 2, D / 2);
  s.lineTo(-W / 2, D / 2);
  s.lineTo(-W / 2, -D / 2);
  for (const h of holes) s.holes.push(new THREE.Path(h.shape.getPoints(24).map((p) => new THREE.Vector2(p.x + h.x, p.y + h.z))));
  const g = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false, curveSegments: 16 });
  g.rotateX(Math.PI / 2);
  g.translate(0, y, 0);
  b.add(mat, g, { uv: 0.6 });
}

// ───────────────────────── 寸胴（スープ） ─────────────────────────

function boneGeometry(): THREE.BufferGeometry {
  return cached('bone', () => {
    const b = new GeoBuilder();
    const m = MAT.black();
    b.cyl(m, 0.018, 0.022, 0.16, 8, { y: -0.08 });
    b.add(m, new THREE.SphereGeometry(0.035, 8, 6), { y: 0.085, sx: 1.2, sz: 0.9 });
    b.add(m, new THREE.SphereGeometry(0.03, 8, 6), { y: -0.085, x: 0.012 });
    return b.merged()[0]!.geo;
  });
}

export function buildSoupPot(c: EqCtx): void {
  const { W, D, H } = c;
  const large = c.type === 'soup_pot_l';
  const hs = 0.42;
  const r = large ? 0.3 : 0.26;
  const potH = H - hs - 0.03;
  const pz = 0.02;
  const cap = EQUIPMENT[c.type]?.capacity ?? 30;
  addStatic(c, c.type, (b) => {
    gasStand(b, W, D, hs, r * 0.75);
    potBody(b, 0, hs + 0.03, pz, r, potH);
    // 縁に掛けたお玉
    const handle = new THREE.CylinderGeometry(0.009, 0.009, 0.42, 6);
    handle.translate(0, 0.21, 0);
    handle.rotateX(0.5);
    handle.translate(r * 0.55, hs + 0.03 + potH - 0.25, pz - r * 0.55);
    b.add(MAT.steelPolished(), handle);
    b.add(MAT.steelPolished(), new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), { x: r * 0.55, y: hs + potH * 0.55, z: pz - r * 0.6 + 0.02 });
    b.box(namePlate(large ? '大寸胴' : '寸胴'), 0.16, 0.04, 0.004, { y: hs * 0.82, z: -D / 2 + 0.018 });
  });
  const bottomY = hs + 0.03 + 0.014;
  const maxY = hs + 0.03 + potH - 0.05;
  const level = new THREE.Group();
  c.group.add(level);
  const surf = new THREE.Mesh(disc(28), EQ_MAT.soup());
  surf.scale.set(r - 0.007, 1, r - 0.007);
  surf.position.z = pz;
  level.add(surf);
  // 豚骨（ゲンコツ）: 5本を1つのジオメトリに
  const boneMat = cached('eqm:bone', () => new THREE.MeshStandardMaterial({ color: '#d9c7a4', roughness: 0.55 }));
  const bones = new THREE.Mesh(
    cached('bones:' + r, () => {
      const b = new GeoBuilder();
      const rb = makeRng(5);
      for (let i = 0; i < 5; i++) {
        const a = rr(rb, 0, Math.PI * 2);
        const d = rr(rb, 0.05, r * 0.65);
        b.add(boneMat, boneGeometry(), { x: Math.cos(a) * d, y: -0.05, z: pz + Math.sin(a) * d, rx: rr(rb, 0.6, 1.2), ry: rr(rb, 0, 6), rz: rr(rb, -0.5, 0.5) });
      }
      return b.merged()[0]!.geo;
    }),
    boneMat,
  );
  level.add(bones);
  const bubbles = createBubbles(12, r * 0.85, r * 0.85, 7, c.owned);
  bubbles.mesh.position.z = pz;
  level.add(bubbles.mesh);
  // 炎
  const flame = new THREE.Mesh(
    cached('flamegeo', () => {
      const g = new THREE.TorusGeometry(1, 0.08, 4, 20);
      g.rotateX(Math.PI / 2);
      return g;
    }),
    EQ_MAT.flame(),
  );
  flame.scale.setScalar(r * 0.35);
  flame.position.set(0, hs + 0.005, 0);
  c.group.add(flame);
  const steam = createSteam({ count: 8, radius: r * 0.7, rise: 0.9, size: 0.32, speed: 0.25, spread: 0.05, opacity: 0.38, seed: 21 });
  steam.position.set(0, maxY, pz);
  c.group.add(steam);
  const bar = processBar(c, H + 0.35);
  c.updaters.push((e, s, t, dt) => {
    // 少量でも見えるよう、表示上の液面は 35% の高さから始める
    const frac = clamp(e.soupL / cap, 0, 1);
    const y = bottomY + (maxY - bottomY) * (0.35 + 0.65 * frac);
    level.position.y = y;
    level.visible = e.soupL > 0.05;
    bones.visible = frac > 0.15;
    const off = broken(e);
    const lit = !off && (e.soupL > 0 || !!e.process);
    flame.visible = lit;
    bubbles.update(t, lit ? (e.process ? 1.3 : 0.45) : 0, 0.001);
    steam.visible = lit && e.soupL > 0.05;
    steam.position.y = y;
    bar(e, s, t, dt);
  });
}

// ───────────────────────── 煮込み鍋・野菜ゆで釜 ─────────────────────────

export function buildBraisePot(c: EqCtx): void {
  const { W, D, H } = c;
  const hs = 0.45;
  const r = 0.3;
  const potH = 0.3;
  const y0 = hs + 0.03;
  addStatic(c, c.type, (b) => {
    gasStand(b, W, D, hs, r * 0.7);
    potBody(b, 0, y0, 0, r, potH);
    b.box(namePlate('煮込み鍋'), 0.16, 0.04, 0.004, { y: hs * 0.82, z: -D / 2 + 0.018 });
  });
  // 煮汁と豚（蓋を開けたときに見える）
  const liquid = new THREE.Mesh(disc(24), EQ_MAT.braise());
  liquid.scale.set(r - 0.008, 1, r - 0.008);
  liquid.position.y = y0 + potH * 0.7;
  c.group.add(liquid);
  // 蓋
  const lid = new THREE.Group();
  const lidParts = cached('braiselid', () => {
    const b = new GeoBuilder();
    b.add(MAT.steelPolished(), new THREE.SphereGeometry(r + 0.012, 24, 6, 0, Math.PI * 2, 0, Math.PI / 2), { sy: 0.25 });
    b.cyl(plastic('#1d1d1d', 0.5), 0.03, 0.035, 0.035, 10, { y: (r + 0.012) * 0.25 });
    return b.merged();
  });
  for (const { geo, mat } of lidParts) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    lid.add(m);
  }
  lid.position.y = y0 + potH;
  c.group.add(lid);
  const flame = new THREE.Mesh(cached('flamegeo', () => new THREE.TorusGeometry(1, 0.08, 4, 20).rotateX(Math.PI / 2)), EQ_MAT.flame());
  flame.scale.setScalar(r * 0.35);
  flame.position.set(0, hs + 0.005, 0);
  c.group.add(flame);
  const steam = createSteam({ count: 7, radius: r * 0.9, rise: 0.8, size: 0.3, speed: 0.3, spread: 0.05, opacity: 0.4, seed: 31 });
  steam.position.y = y0 + potH + 0.02;
  c.group.add(steam);
  const bar = processBar(c, H + 0.35);
  c.updaters.push((e, s, t, dt) => {
    const on = !!e.process && !broken(e);
    flame.visible = on;
    steam.visible = on;
    // 煮込み中は蓋がカタカタ鳴る
    lid.position.y = y0 + potH + (on ? 0.012 + Math.abs(Math.sin(t * 13)) * 0.006 : 0);
    lid.rotation.z = on ? Math.sin(t * 11) * 0.02 : 0;
    bar(e, s, t, dt);
  });
}

export function buildVegBoiler(c: EqCtx): void {
  const { W, D, H } = c;
  const hs = 0.45;
  const r = 0.31;
  const potH = 0.32;
  const y0 = hs + 0.03;
  addStatic(c, c.type, (b) => {
    gasStand(b, W, D, hs, r * 0.7);
    potBody(b, 0, y0, 0, r, potH);
    // 大きなザル
    b.add(perforatedMat(), new THREE.SphereGeometry(r - 0.03, 20, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), { y: y0 + potH - 0.02, sy: 0.75 });
    const rim = new THREE.TorusGeometry(r - 0.03, 0.007, 4, 24);
    rim.rotateX(Math.PI / 2);
    b.add(MAT.steelPolished(), rim, { y: y0 + potH - 0.02 });
    b.box(namePlate('野菜ゆで釜'), 0.18, 0.04, 0.004, { y: hs * 0.82, z: -D / 2 + 0.018 });
  });
  const waterY = y0 + potH * 0.72;
  const water = new THREE.Mesh(disc(24), EQ_MAT.boilWater());
  water.scale.set(r - 0.008, 1, r - 0.008);
  water.position.y = waterY;
  c.group.add(water);
  // ゆでているもやし
  const sprouts = new THREE.Mesh(
    cached('vegmound', () => new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2)),
    cached('eqm:sproutmound', () => new THREE.MeshStandardMaterial({ map: texSprouts(), color: '#f6f2e6', roughness: 0.45, emissive: '#3a362a', emissiveIntensity: 0.5 })),
  );
  sprouts.scale.set(r * 0.8, 0.09, r * 0.8);
  sprouts.position.y = waterY - 0.02;
  c.group.add(sprouts);
  const bubbles = createBubbles(14, r * 0.85, r * 0.85, 9, c.owned);
  c.group.add(bubbles.mesh);
  const flame = new THREE.Mesh(cached('flamegeo', () => new THREE.TorusGeometry(1, 0.08, 4, 20).rotateX(Math.PI / 2)), EQ_MAT.flame());
  flame.scale.setScalar(r * 0.35);
  flame.position.set(0, hs + 0.005, 0);
  c.group.add(flame);
  const steam = createSteam({ count: 9, radius: r * 0.8, rise: 0.9, size: 0.34, speed: 0.3, spread: 0.06, opacity: 0.42, seed: 41 });
  steam.position.y = waterY;
  c.group.add(steam);
  const bar = processBar(c, H + 0.35);
  c.updaters.push((e, s, t, dt) => {
    const on = !!e.process && !broken(e);
    flame.visible = on;
    steam.visible = on;
    sprouts.visible = !!e.process;
    bubbles.update(t, on ? 1 : 0, waterY + 0.002);
    bar(e, s, t, dt);
  });
}

// ───────────────────────── 仕込み台 ─────────────────────────

function porkMat(): THREE.MeshStandardMaterial {
  return cached('eqm:pork', () => new THREE.MeshStandardMaterial({ map: texPork(), roughness: 0.45, envMap: texEnv(), envMapIntensity: 0.3 }));
}

/** チャーシューのスライス（円柱の上面に断面、側面に外側のテクスチャ） */
function porkSliceGeometry(): THREE.BufferGeometry {
  return cached('porkslice', () => {
    const g = new THREE.CylinderGeometry(0.04, 0.04, 0.014, 12, 1);
    g.scale(1.3, 1, 1);
    const uv = g.attributes.uv!;
    const sl = PORK_UV.slab;
    const cr = PORK_UV.crust;
    for (const grp of g.groups) {
      for (let k = grp.start; k < grp.start + grp.count; k++) {
        const vi = g.index!.getX(k);
        const u = uv.getX(vi);
        const v = uv.getY(vi);
        if (grp.materialIndex === 0) uv.setXY(vi, cr.u0 + u * (cr.u1 - cr.u0), cr.v0 + v * (cr.v1 - cr.v0));
        else uv.setXY(vi, sl.u + (u - 0.5) * sl.r * 2, sl.v + (v - 0.5) * sl.r * 2);
      }
    }
    g.clearGroups();
    return g;
  });
}

function garlicPileMat(): THREE.MeshStandardMaterial {
  return porkMat();
}

/** ニンニクの山（豚アトラスの右下を貼った半球） */
function garlicDomeGeometry(): THREE.BufferGeometry {
  return cached('garlicdome', () => {
    const g = new THREE.SphereGeometry(1, 14, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    const uv = g.attributes.uv!;
    const q = PORK_UV.garlic;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, q.u0 + uv.getX(i) * (q.u1 - q.u0), q.v0 + uv.getY(i) * (q.v1 - q.v0));
    return g;
  });
}

export function buildPrepTable(c: EqCtx): void {
  const { W, D, H } = c;
  const large = c.type === 'prep_table_l';
  addStatic(c, c.type, (b) => {
    workTable(b, W, D, H);
    const boardMat = plastic('#f2f2ee', 0.55);
    const boards = large ? [-0.45, 0.4] : [-0.2];
    for (const bx of boards) {
      b.box(boardMat, 0.5, 0.02, 0.32, { x: bx, y: H + 0.01, z: -0.08 });
      // 包丁
      b.box(MAT.steelPolished(), 0.2, 0.002, 0.045, { x: bx + 0.12, y: H + 0.022, z: -0.2 + 0.02, ry: 0.15 });
      b.box(plastic('#2a1a10', 0.5), 0.11, 0.018, 0.022, { x: bx + 0.28, y: H + 0.03, z: -0.2 + 0.0, ry: 0.15 });
    }
    // 刻みニンニクの山（まな板の上）
    b.add(garlicPileMat(), garlicDomeGeometry(), { x: boards[0]! - 0.1, y: H + 0.02, z: -0.08, sx: 0.07, sy: 0.035, sz: 0.06 });
    // 煮豚のブロックとスライス
    b.add(EQ_MAT.porkBlock(), new THREE.CylinderGeometry(0.065, 0.07, 0.2, 14), { x: boards[0]! + 0.08, y: H + 0.085, z: -0.06, rz: Math.PI / 2 });
    for (let i = 0; i < 3; i++) b.add(porkMat(), porkSliceGeometry(), { x: boards[0]! + 0.2 + i * 0.012, y: H + 0.025 + i * 0.012, z: -0.02 - i * 0.02, rz: 0.2 + i * 0.05 });
    // ボウルに入ったにんにく
    b.add(MAT.steelPolished(), new THREE.SphereGeometry(0.11, 16, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), { x: W / 2 - 0.22, y: H + 0.11, z: 0.18 });
    const clove = cached('eqm:clove', () => new THREE.MeshStandardMaterial({ color: '#efe6cf', roughness: 0.5 }));
    const r = makeRng(3);
    for (let i = 0; i < 9; i++) b.add(clove, new THREE.SphereGeometry(0.022, 8, 6), { x: W / 2 - 0.22 + rr(r, -0.06, 0.06), y: H + 0.04 + rr(r, 0, 0.02), z: 0.18 + rr(r, -0.06, 0.06), sx: 1, sy: 0.8, sz: 1.3, ry: r() * 6 });
    // 保存容器とふきん
    b.box(plastic('#f8f8f8', 0.3), 0.2, 0.12, 0.14, { x: W / 2 - 0.45, y: H + 0.06, z: 0.25 });
    b.box(plastic('#3a6fb0', 0.4), 0.205, 0.015, 0.145, { x: W / 2 - 0.45, y: H + 0.125, z: 0.25 });
    b.box(plastic('#fbfbf6', 0.95), 0.18, 0.02, 0.12, { x: -W / 2 + 0.15, y: H + 0.01, z: 0.25, ry: 0.2 });
    // 下棚の寸胴と箱
    b.cyl(MAT.steel(), 0.16, 0.16, 0.3, 18, { x: -W / 2 + 0.25, y: 0.19 });
    b.box(plastic('#c9a86a', 0.85), 0.3, 0.2, 0.3, { x: W / 2 - 0.3, y: 0.29 });
  });
}

// ───────────────────────── 盛り付け台 ─────────────────────────

export function buildAssembly(c: EqCtx): void {
  const { W, D, H } = c;
  const cap = EQUIPMENT[c.type]?.capacity ?? 4;
  addStatic(c, c.type, (b) => {
    cabinet(b, W, D, H, { doors: cap > 4 ? 4 : 3 });
    // 奥の調味料棚
    const sy = H + 0.22;
    b.box(MAT.steel(), W, 0.02, 0.2, { y: sy, z: D / 2 - 0.1 });
    for (const sx of [-1, 1]) b.box(MAT.steelDark(), 0.02, 0.22, 0.02, { x: sx * (W / 2 - 0.02), y: H + 0.11, z: D / 2 - 0.03 });
    // タレの小鍋とレードル
    b.cyl(MAT.steelPolished(), 0.09, 0.09, 0.12, 18, { x: -W / 2 + 0.2, y: H, z: D / 2 - 0.16 });
    b.add(EQ_MAT.braise(), disc(18), { x: -W / 2 + 0.2, y: H + 0.105, z: D / 2 - 0.16, sx: 0.085, sz: 0.085 });
    b.cyl(MAT.steelPolished(), 0.006, 0.006, 0.3, 6, { x: -W / 2 + 0.24, y: H + 0.08, z: D / 2 - 0.16, rz: -0.4 });
    // 調味料の容器（白い粉・コショウ・背脂用の網）
    b.cyl(plastic('#f6f6f2', 0.3), 0.05, 0.05, 0.12, 14, { x: -W / 2 + 0.42, y: H, z: D / 2 - 0.14 });
    b.cyl(plastic('#d23a2a', 0.4), 0.05, 0.05, 0.02, 14, { x: -W / 2 + 0.42, y: H + 0.12, z: D / 2 - 0.14 });
    b.cyl(plastic('#3a2a1a', 0.4), 0.03, 0.03, 0.1, 10, { x: -W / 2 + 0.56, y: H, z: D / 2 - 0.14 });
    b.cyl(MAT.steelPolished(), 0.028, 0.03, 0.03, 10, { x: -W / 2 + 0.56, y: H + 0.1, z: D / 2 - 0.14 });
    b.add(perforatedMat(), new THREE.SphereGeometry(0.07, 14, 5, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), { x: W / 2 - 0.2, y: sy + 0.08, z: D / 2 - 0.1 });
    b.cyl(MAT.steelPolished(), 0.006, 0.006, 0.18, 6, { x: W / 2 - 0.1, y: sy + 0.08, z: D / 2 - 0.1, rz: Math.PI / 2 });
    // 丼を置く位置の印（濡れ布巾）
    for (let i = 0; i < cap; i++) {
      const x = (i - (cap - 1) / 2) * 0.3;
      b.box(plastic('#9fa9ab', 0.9), 0.25, 0.003, 0.25, { x, y: H + 0.0015, z: -0.12 });
    }
  });
  for (let i = 0; i < cap; i++) c.bowlAnchors.push(new THREE.Vector3((i - (cap - 1) / 2) * 0.3, H + 0.004, -0.12));
  c.topY = H + 0.004;
}

// ───────────────────────── トッピング台 ─────────────────────────

export function buildTopping(c: EqCtx): void {
  const { W, D, H } = c;
  // バット（ガストロノーム）の配置
  const trays = {
    yasai: { x: -0.12, z: 0.18, w: 0.62, d: 0.34 },
    garlic: { x: -0.34, z: -0.2, w: 0.2, d: 0.2 },
    abura: { x: -0.1, z: -0.2, w: 0.2, d: 0.2 },
    buta: { x: 0.16, z: -0.2, w: 0.26, d: 0.22 },
    ichimi: { x: 0.38, z: -0.2, w: 0.1, d: 0.1 },
  };
  addStatic(c, c.type, (b) => {
    cabinet(b, W, D, H, { doors: 2 });
    for (const [k, t] of Object.entries(trays)) {
      if (k === 'ichimi') {
        b.cyl(MAT.steelPolished(), 0.05, 0.045, 0.1, 16, { x: t.x, y: H, z: t.z, open: true });
        b.add(MAT.steelDark(), disc(16), { x: t.x, y: H + 0.003, z: t.z, sx: 0.045, sz: 0.045 });
        continue;
      }
      // 縁と底
      b.box(MAT.steelPolished(), t.w, 0.008, t.d, { x: t.x, y: H + 0.004, z: t.z });
      b.box(MAT.steelPolished(), t.w + 0.016, 0.06, 0.008, { x: t.x, y: H + 0.03, z: t.z - t.d / 2 });
      b.box(MAT.steelPolished(), t.w + 0.016, 0.06, 0.008, { x: t.x, y: H + 0.03, z: t.z + t.d / 2 });
      b.box(MAT.steelPolished(), 0.008, 0.06, t.d, { x: t.x - t.w / 2, y: H + 0.03, z: t.z });
      b.box(MAT.steelPolished(), 0.008, 0.06, t.d, { x: t.x + t.w / 2, y: H + 0.03, z: t.z });
    }
    // トング
    b.box(MAT.steelPolished(), 0.025, 0.01, 0.26, { x: 0.3, y: H + 0.07, z: 0.15, rx: 0.25, ry: -0.3 });
    b.box(MAT.steelPolished(), 0.025, 0.01, 0.26, { x: 0.33, y: H + 0.07, z: 0.15, rx: 0.2, ry: -0.25 });
    // 小さじ（ニンニク用）
    b.cyl(MAT.steelPolished(), 0.004, 0.004, 0.16, 6, { x: -0.34, y: H + 0.07, z: -0.12, rx: 1.2 });
  });
  const dome = cached('topdome', () => new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2));
  const sproutMat = cached('eqm:sproutmound', () => new THREE.MeshStandardMaterial({ map: texSprouts(), color: '#f6f2e6', roughness: 0.45, emissive: '#3a362a', emissiveIntensity: 0.5 }));
  const aburaMat = cached('eqm:aburafill', () => new THREE.MeshStandardMaterial({ color: '#d9c29a', roughness: 0.22, emissive: '#3a2a14', emissiveIntensity: 0.3, envMap: texEnv(), envMapIntensity: 0.5 }));
  const chiliMat = cached('eqm:chilifill', () => new THREE.MeshStandardMaterial({ map: texChiliPowder(), color: '#ffffff', roughness: 0.9 }));
  const yasai = new THREE.Mesh(dome, sproutMat);
  yasai.position.set(trays.yasai.x, H + 0.008, trays.yasai.z);
  const garlic = new THREE.Mesh(garlicDomeGeometry(), porkMat());
  garlic.position.set(trays.garlic.x, H + 0.008, trays.garlic.z);
  const abura = new THREE.Mesh(
    cached('aburafill', () => {
      const g = new THREE.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.attributes.position!;
      const r = makeRng(4);
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * rr(r, 0.75, 1.15));
      g.computeVertexNormals();
      return g;
    }),
    aburaMat,
  );
  abura.position.set(trays.abura.x, H + 0.008, trays.abura.z);
  const chili = new THREE.Mesh(disc(16), chiliMat);
  chili.position.set(trays.ichimi.x, H, trays.ichimi.z);
  chili.scale.set(0.044, 1, 0.044);
  const butaMax = 12;
  const buta = new THREE.InstancedMesh(porkSliceGeometry(), porkMat(), butaMax);
  buta.castShadow = true;
  c.owned.push(buta);
  for (let i = 0; i < butaMax; i++) {
    const row = Math.floor(i / 6);
    const col = i % 6;
    tmp.e.set(0.18, 0.1 * (col % 2), 0);
    tmp.q.setFromEuler(tmp.e);
    tmp.v.set(trays.buta.x - 0.06 + row * 0.115, H + 0.022 + col * 0.003, trays.buta.z + 0.075 - col * 0.031);
    tmp.m.compose(tmp.v, tmp.q, tmp.s.set(0.8, 0.9, 0.8));
    buta.setMatrixAt(i, tmp.m);
  }
  buta.instanceMatrix.needsUpdate = true;
  buta.computeBoundingSphere();
  for (const m of [yasai, garlic, abura, chili]) {
    m.castShadow = false;
    m.receiveShadow = true;
  }
  c.group.add(yasai, garlic, abura, chili, buta);
  let acc = 1;
  c.updaters.push((_e, s, _t, dt) => {
    // 在庫の集計は数フレームに1回で十分
    acc += Math.max(0, dt);
    if (acc < 0.25) return;
    acc = 0;
    const fy = clamp(stockOf(s, 'yasai') / 3000, 0, 1);
    const fg = clamp(stockOf(s, 'garlic') / 300, 0, 1);
    const fa = clamp(stockOf(s, 'abura') / 1000, 0, 1);
    const fi = clamp(stockOf(s, 'ichimi') / 300, 0, 1);
    const nb = Math.min(butaMax, Math.floor(stockOf(s, 'buta')));
    yasai.visible = fy > 0.005;
    yasai.scale.set(trays.yasai.w * 0.46, 0.02 + 0.14 * fy, trays.yasai.d * 0.44);
    garlic.visible = fg > 0.005;
    garlic.scale.set(trays.garlic.w * 0.44, 0.012 + 0.05 * fg, trays.garlic.d * 0.44);
    abura.visible = fa > 0.005;
    abura.scale.set(trays.abura.w * 0.45, 0.012 + 0.05 * fa, trays.abura.d * 0.45);
    chili.visible = fi > 0.005;
    chili.position.y = H + 0.005 + 0.085 * fi;
    buta.count = nb;
  });
}

// ───────────────────────── 丼棚 ─────────────────────────

export function buildBowlRack(c: EqCtx): void {
  const { W, D, H } = c;
  const shelves = [0.12, 0.5, 0.88];
  addStatic(c, c.type, (b) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(MAT.steelDark(), 0.014, 0.014, H, 8, { x: sx * (W / 2 - 0.02), z: sz * (D / 2 - 0.02) });
    for (const y of [...shelves, H - 0.02]) {
      b.box(MAT.steel(), W - 0.02, 0.02, D - 0.02, { y });
      b.box(MAT.steelDark(), W - 0.02, 0.03, 0.01, { y: y + 0.01, z: -D / 2 + 0.01 });
    }
    // 上段のレンゲ・箸立て
    b.box(plastic('#f4f4f0', 0.4), 0.3, 0.08, 0.14, { x: -0.25, y: H + 0.04 - 0.01, z: 0 });
    b.cyl(plastic('#2a2a2a', 0.5), 0.05, 0.05, 0.14, 12, { x: 0.25, y: H - 0.01, z: 0 });
    for (let i = 0; i < 10; i++) b.box(plastic('#d8b880', 0.6), 0.006, 0.23, 0.006, { x: 0.23 + (i % 4) * 0.012, y: H + 0.1, z: -0.02 + Math.floor(i / 4) * 0.015, rz: (i - 5) * 0.03 });
  });
  const cap = EQUIPMENT[c.type]?.capacity ?? 30;
  const mesh = new THREE.InstancedMesh(bowlShellGeometry('low'), MAT.ceramic(), cap);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  c.owned.push(mesh);
  // 中段→上段→下段の順に、3列×最大5段で積む
  const order = [1, 2, 0];
  let k = 0;
  for (const si of order) {
    for (let col = 0; col < 3 && k < cap; col++) {
      for (let lv = 0; lv < 5 && k < cap; lv++) {
        tmp.m.makeTranslation((col - 1) * 0.31, shelves[si]! + 0.01 + lv * BOWL_DIMS.stackStep, 0);
        mesh.setMatrixAt(k++, tmp.m);
      }
    }
  }
  // 段ごとに満たすため、列→段の順を「段内で列ごとに積む」並びへ
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.count = 0;
  c.group.add(mesh);
  c.topY = H;
  c.updaters.push((e, s) => {
    let clean = 0;
    for (const b of s.bowls) if (b.state === 'clean' && b.loc.at === 'rack') clean++;
    let nRacks = 0;
    let myIdx = 0;
    for (const q of s.equipment) {
      if (q.type !== e.type || !q.placed) continue;
      if (q.id === e.id) myIdx = nRacks;
      nRacks++;
    }
    nRacks = Math.max(1, nRacks);
    const mine = Math.floor(clean / nRacks) + (myIdx < clean % nRacks ? 1 : 0);
    mesh.count = Math.min(cap, mine);
  });
}

// ───────────────────────── 洗い場 ─────────────────────────

export function buildSink(c: EqCtx): void {
  const { W, D, H } = c;
  const bw = 0.5;
  const bd = 0.46;
  const basin = new THREE.Shape();
  {
    const r = 0.04;
    const hw = bw / 2;
    const hd = bd / 2;
    basin.moveTo(-hw + r, -hd);
    basin.lineTo(hw - r, -hd);
    basin.quadraticCurveTo(hw, -hd, hw, -hd + r);
    basin.lineTo(hw, hd - r);
    basin.quadraticCurveTo(hw, hd, hw - r, hd);
    basin.lineTo(-hw + r, hd);
    basin.quadraticCurveTo(-hw, hd, -hw, hd - r);
    basin.lineTo(-hw, -hd + r);
    basin.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
  }
  const bx = [-W / 2 + 0.3, -W / 2 + 0.85];
  const bz = -0.05;
  const depth = 0.3;
  addStatic(c, c.type, (b) => {
    cabinet(b, W, D, H - 0.03, { doors: 3, top: false, hollow: true });
    plateWithHoles(b, MAT.steel(), W, D, H, 0.03, bx.map((x) => ({ shape: basin, x, z: bz })));
    for (const x of bx) {
      const shifted = new THREE.Shape(basin.getPoints(24).map((p) => new THREE.Vector2(p.x + x, p.y)));
      innerWall(b, MAT.steel(), shifted, H - depth, H - 0.03, bz, true);
    }
    b.box(MAT.steel(), W, 0.16, 0.02, { y: H + 0.08, z: D / 2 - 0.01 });
    // 水切りの溝
    for (let i = 0; i < 6; i++) b.box(MAT.steelDark(), 0.008, 0.004, 0.36, { x: W / 2 - 0.08 - i * 0.05, y: H + 0.002, z: bz });
    // 蛇口（グースネック）と洗浄シャワー
    const fx = (bx[0]! + bx[1]!) / 2;
    b.cyl(MAT.steelPolished(), 0.016, 0.018, 0.3, 10, { x: fx, y: H, z: D / 2 - 0.08 });
    const neck = new THREE.TorusGeometry(0.11, 0.013, 6, 12, Math.PI);
    neck.rotateY(Math.PI / 2);
    b.add(MAT.steelPolished(), neck, { x: fx, y: H + 0.3, z: D / 2 - 0.19 });
    b.cyl(MAT.steelPolished(), 0.016, 0.012, 0.06, 10, { x: fx, y: H + 0.24, z: D / 2 - 0.3 });
    b.box(MAT.steelPolished(), 0.12, 0.02, 0.02, { x: fx, y: H + 0.08, z: D / 2 - 0.06 });
    // 洗剤とスポンジ
    b.cyl(plastic('#3fa34d', 0.35), 0.03, 0.03, 0.18, 10, { x: W / 2 - 0.12, y: H, z: D / 2 - 0.12 });
    b.box(plastic('#f2d23a', 0.9), 0.1, 0.035, 0.065, { x: W / 2 - 0.25, y: H + 0.017, z: D / 2 - 0.12 });
    b.box(plastic('#2e8b3a', 0.9), 0.1, 0.01, 0.065, { x: W / 2 - 0.25, y: H + 0.04, z: D / 2 - 0.12 });
  });
  // 汚れた丼（左の槽に積む）
  const cap = EQUIPMENT[c.type]?.capacity ?? 14;
  const shells = new THREE.InstancedMesh(bowlShellGeometry('low'), MAT.ceramic(), cap);
  const stains = new THREE.InstancedMesh(bowlStainGeometry(), bowlStainMaterial(), cap);
  shells.castShadow = true;
  c.owned.push(shells, stains);
  const r = makeRng(2);
  for (let i = 0; i < cap; i++) {
    const stack = i % 3;
    const lv = Math.floor(i / 3);
    const x = bx[0]! + (stack - 1) * 0.14 + rr(r, -0.01, 0.01);
    const z = bz + (stack === 1 ? 0.08 : -0.06);
    tmp.e.set(rr(r, -0.12, 0.12), r() * 6, rr(r, -0.12, 0.12));
    tmp.q.setFromEuler(tmp.e);
    tmp.m.compose(tmp.v.set(x, H - depth + 0.01 + lv * BOWL_DIMS.stackStep * 1.2, z), tmp.q, tmp.s.set(0.82, 0.82, 0.82));
    shells.setMatrixAt(i, tmp.m);
    stains.setMatrixAt(i, tmp.m);
  }
  for (const m of [shells, stains]) {
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
    m.count = 0;
    c.group.add(m);
  }
  // 洗い水と流水
  const water = new THREE.Mesh(
    cached('sinkwater', () => {
      const g = new THREE.PlaneGeometry(bw - 0.01, bd - 0.01);
      g.rotateX(-Math.PI / 2);
      return g;
    }),
    cached('eqm:sinkwater', () => new THREE.MeshStandardMaterial({ color: '#cfdad8', roughness: 0.05, transparent: true, opacity: 0.55, envMap: texEnv() })),
  );
  water.position.set(bx[0]!, H - depth + 0.12, bz);
  c.group.add(water);
  const stream = new THREE.Mesh(
    cached('streamgeo', () => new THREE.CylinderGeometry(0.006, 0.009, 1, 6, 1, true)),
    cached('eqm:stream', () => new THREE.MeshStandardMaterial({ color: '#e8f2f6', roughness: 0.05, transparent: true, opacity: 0.55, envMap: texEnv() })),
  );
  const fx = (bx[0]! + bx[1]!) / 2;
  stream.position.set(fx, H + 0.06, D / 2 - 0.3);
  stream.scale.set(1, 0.3, 1);
  c.group.add(stream);
  c.updaters.push((e, s, t) => {
    let n = 0;
    for (const b of s.bowls) if (b.loc.at === 'sink' && b.loc.stationId === e.id) n++;
    n = Math.min(cap, n);
    shells.count = n;
    stains.count = n;
    water.visible = n > 0;
    stream.visible = n > 0 && !broken(e);
    stream.scale.x = 1 + Math.sin(t * 30) * 0.08;
  });
}

// ───────────────────────── 食洗機 ─────────────────────────

export function buildDishwasher(c: EqCtx): void {
  const { W, D, H } = c;
  const cw = 0.64;
  addStatic(c, c.type, (b) => {
    feet(b, W, D, 0.1);
    // 本体（下部）
    b.box(MAT.steel(), cw, 0.42, D - 0.1, { y: 0.31 });
    // 洗浄室（ドア式のフード）
    b.box(MAT.steel(), cw + 0.02, H - 0.55, D - 0.12, { y: 0.52 + (H - 0.55) / 2 });
    b.box(MAT.steelPolished(), cw - 0.06, 0.03, 0.03, { y: H - 0.12, z: -D / 2 + 0.03 });
    for (const sx of [-1, 1]) b.box(MAT.steelPolished(), 0.03, 0.12, 0.03, { x: sx * (cw / 2 - 0.05), y: H - 0.17, z: -D / 2 + 0.05 });
    // 左右の作業テーブル
    for (const sx of [-1, 1]) {
      b.box(MAT.steel(), (W - cw) / 2 - 0.01, 0.03, D - 0.1, { x: sx * (cw / 2 + (W - cw) / 4), y: 0.86 });
      b.cyl(MAT.steelDark(), 0.016, 0.016, 0.85, 8, { x: sx * (W / 2 - 0.04), z: -D / 2 + 0.1 });
      b.cyl(MAT.steelDark(), 0.016, 0.016, 0.85, 8, { x: sx * (W / 2 - 0.04), z: D / 2 - 0.1 });
    }
    // 洗浄ラック（手前に置いたもの）
    b.box(plastic('#3a5a8a', 0.6), (W - cw) / 2 - 0.03, 0.08, 0.34, { x: -(cw / 2 + (W - cw) / 4), y: 0.915, z: 0 });
    // 操作パネル
    b.box(MAT.darkPanel(), 0.3, 0.12, 0.012, { y: H - 0.06, z: -D / 2 + 0.054 });
    b.box(namePlate('食器洗浄機'), 0.16, 0.035, 0.004, { y: 0.45, z: -D / 2 + 0.05 - 0.002 });
  });
  const lamp = new THREE.Mesh(cached('dwlamp', () => new THREE.BoxGeometry(0.05, 0.03, 0.01)), MAT.lampOff());
  lamp.position.set(0.08, H - 0.06, -D / 2 + 0.048);
  c.group.add(lamp);
  const disp = new THREE.Mesh(cached('dwdisp', () => new THREE.BoxGeometry(0.08, 0.04, 0.01)), glow('#5aff8a', 0.6));
  disp.position.set(-0.07, H - 0.06, -D / 2 + 0.048);
  c.group.add(disp);
  const steam = createSteam({ count: 6, radius: 0.18, rise: 0.6, size: 0.25, speed: 0.4, spread: 0.04, opacity: 0.35, seed: 51 });
  steam.position.set(0, H, 0);
  c.group.add(steam);
  c.updaters.push((e, _s, t) => {
    const washing = e.washElapsed > 0 && !broken(e);
    lamp.material = washing ? (Math.sin(t * 6) > -0.3 ? MAT.lampGreen() : MAT.lampOff()) : MAT.lampOff();
    steam.visible = washing;
    disp.visible = !broken(e);
  });
}

// ───────────────────────── 冷蔵庫・冷凍庫 ─────────────────────────

function tempDisplayMat(text: string, color: string): THREE.MeshStandardMaterial {
  return cached(`eqm:temp:${text}:${color}`, () => {
    const tex = canvasTexture(128, 48, (cx, w, h) => {
      cx.fillStyle = '#0c1410';
      cx.fillRect(0, 0, w, h);
      cx.fillStyle = color;
      cx.font = `bold 32px ${JP_FONT}`;
      cx.textAlign = 'center';
      cx.textBaseline = 'middle';
      cx.fillText(text, w / 2, h / 2 + 1);
    });
    return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 1.1, roughness: 0.3 });
  });
}

export function buildFridge(c: EqCtx): void {
  const { W, D, H } = c;
  const freezer = c.type === 'freezer';
  const cols = c.type === 'fridge_l' ? 3 : 2;
  addStatic(c, c.type, (b) => {
    if (freezer) {
      cabinet(b, W, D, H, { doors: 2, backsplash: true, handleY: H - 0.18 });
      b.box(namePlate('冷凍庫'), 0.14, 0.035, 0.004, { x: -W / 2 + 0.14, y: H - 0.06, z: -D / 2 + 0.0 });
      return;
    }
    feet(b, W, D, 0.1);
    b.box(MAT.steel(), W - 0.02, H - 0.1, D - 0.06, { y: 0.1 + (H - 0.1) / 2 });
    // 扉（上下2段）
    const dw = (W - 0.04) / cols;
    const rows: [number, number][] = [
      [0.12, 0.98],
      [1.0, H - 0.14],
    ];
    for (let i = 0; i < cols; i++) {
      const x = -W / 2 + 0.02 + dw * (i + 0.5);
      for (const [y0, y1] of rows) {
        b.box(MAT.steel(), dw - 0.012, y1 - y0 - 0.012, 0.03, { x, y: (y0 + y1) / 2, z: -D / 2 + 0.015 });
        // 扉のパッキン
        b.box(MAT.rubber(), dw - 0.008, 0.006, 0.026, { x, y: y0 + 0.002, z: -D / 2 + 0.017 });
        // 取っ手（縦のバー）
        const hx = x + (i % 2 === 0 ? dw / 2 - 0.06 : -dw / 2 + 0.06);
        b.box(MAT.steelPolished(), 0.02, 0.2, 0.025, { x: hx, y: y0 < 0.5 ? y1 - 0.15 : y0 + 0.15, z: -D / 2 - 0.018 });
      }
    }
    // 上部の操作パネルと通気口
    b.box(MAT.darkPanel(), W - 0.04, 0.1, 0.02, { y: H - 0.07, z: -D / 2 + 0.02 });
    for (let i = 0; i < 8; i++) b.box(MAT.black(), 0.05, 0.008, 0.005, { x: W / 2 - 0.1 - i * 0.06 + 0.0, y: H - 0.05, z: -D / 2 + 0.008 });
    b.box(namePlate(c.type === 'fridge_l' ? '業務用冷蔵庫' : '冷蔵庫'), 0.16, 0.035, 0.004, { x: -W / 2 + 0.14, y: H - 0.07, z: -D / 2 + 0.008 });
  });
  const disp = new THREE.Mesh(cached('fdisp', () => new THREE.BoxGeometry(0.09, 0.034, 0.006)), tempDisplayMat(freezer ? '-20℃' : '3℃', '#7dff9a'));
  disp.position.set(freezer ? W / 2 - 0.15 : 0.0, freezer ? H - 0.06 : H - 0.07, -D / 2 + (freezer ? -0.004 : 0.008));
  c.group.add(disp);
  const ok = disp.material;
  const bad = tempDisplayMat(freezer ? '-5℃' : '15℃', '#ff4a3a');
  c.updaters.push((e) => {
    disp.material = e.status === 'broken' ? bad : ok;
  });
  c.lampPos.set(W / 2 - 0.08, H + 0.08, -D / 2 + 0.08);
}

// ───────────────────────── 製麺機 ─────────────────────────

export function buildNoodleMaker(c: EqCtx): void {
  const { W, D, H } = c;
  const paint = plastic('#4f6f62', 0.45);
  addStatic(c, c.type, (b) => {
    cabinet(b, W, D, 0.62, { doors: 2 });
    // 機械本体
    b.box(paint, 0.7, 0.36, 0.5, { y: 0.62 + 0.18, z: 0.1 });
    b.box(paint, 0.5, 0.18, 0.4, { y: 0.98 + 0.09, z: 0.15 });
    // ホッパー（粉の投入口）
    b.cyl(MAT.steel(), 0.2, 0.12, 0.16, 4, { y: 1.04, z: 0.18, ry: Math.PI / 4, open: true });
    // ローラーの窓枠
    b.box(MAT.steelDark(), 0.6, 0.02, 0.2, { y: 0.85, z: -0.16 });
    // 出口の受け台と切り出した麺
    b.box(MAT.steel(), 0.5, 0.02, 0.24, { y: 0.66, z: -0.32 });
    const r = makeRng(9);
    for (let i = 0; i < 4; i++) {
      b.add(MAT.noodle(), new THREE.TorusGeometry(0.045, 0.014, 4, 10), { x: -0.18 + i * 0.12, y: 0.69, z: -0.34 + rr(r, -0.02, 0.02), rx: Math.PI / 2, sy: 0.6 });
    }
    // 操作箱
    b.box(MAT.steel(), 0.16, 0.2, 0.08, { x: W / 2 - 0.12, y: 0.95, z: -0.2 });
    b.cyl(glow('#2ecc40', 0.8), 0.018, 0.018, 0.015, 10, { x: W / 2 - 0.15, y: 0.98, z: -0.245, rx: -Math.PI / 2 });
    b.cyl(glow('#ff3020', 0.8), 0.022, 0.022, 0.015, 10, { x: W / 2 - 0.09, y: 0.98, z: -0.245, rx: -Math.PI / 2 });
    // 粉袋
    b.box(plastic('#f2efe6', 0.95), 0.26, 0.4, 0.14, { x: -W / 2 + 0.16, y: 0.82, z: 0.3, rz: 0.08 });
  });
  const rollers: THREE.Mesh[] = [];
  const rollerGeo = cached('roller', () => new THREE.CylinderGeometry(0.05, 0.05, 0.56, 12).rotateZ(Math.PI / 2));
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(rollerGeo, MAT.steelPolished());
    m.position.set(0, 0.9 + i * 0.1, -0.12);
    c.group.add(m);
    rollers.push(m);
  }
  const sheet = new THREE.Mesh(cached('doughsheet', () => new THREE.PlaneGeometry(0.5, 0.26).rotateX(-1.2)), cached('eqm:dough', () => new THREE.MeshStandardMaterial({ color: '#efd9a0', roughness: 0.6, side: THREE.DoubleSide })));
  sheet.position.set(0, 0.78, -0.24);
  c.group.add(sheet);
  c.updaters.push((e, _s, _t, dt) => {
    const on = !!e.process && !broken(e);
    sheet.visible = on;
    if (on) {
      rollers[0]!.rotation.x += dt * 4;
      rollers[1]!.rotation.x -= dt * 4;
    }
  });
  const bar = processBar(c, H + 0.3);
  c.updaters.push(bar);
}

// ───────────────────────── ゴミ箱・掃除用具入れ・事務机 ─────────────────────────

export function buildTrash(c: EqCtx): void {
  const { W, D, H } = c;
  const body = plastic('#5d6b5f', 0.6);
  const bw = W - 0.08;
  const bd = D - 0.1;
  addStatic(c, c.type, (b) => {
    // 四角いペダル式のゴミ箱（上すぼまり）
    const g = new THREE.CylinderGeometry(Math.SQRT1_2, Math.SQRT1_2 * 0.92, 1, 4, 1, true);
    g.rotateY(Math.PI / 4);
    g.scale(bw, H - 0.05, bd);
    g.translate(0, (H - 0.05) / 2, 0);
    b.add(body, g);
    const inner = insideOut(g.clone());
    inner.scale(0.97, 1, 0.97);
    b.add(plastic('#3e4840', 0.7), inner);
    b.box(plastic('#3e4840', 0.7), bw * 0.92, 0.02, bd * 0.92, { y: 0.01 });
    // 袋の縁（外へ折り返した白い袋）
    b.box(plastic('#f2f2ee', 0.4), bw + 0.012, 0.04, 0.008, { y: H - 0.07, z: -bd / 2 - 0.005 });
    b.box(plastic('#f2f2ee', 0.4), bw + 0.012, 0.04, 0.008, { y: H - 0.07, z: bd / 2 + 0.005 });
    b.box(plastic('#f2f2ee', 0.4), 0.008, 0.04, bd, { x: -bw / 2 - 0.005, y: H - 0.07 });
    b.box(plastic('#f2f2ee', 0.4), 0.008, 0.04, bd, { x: bw / 2 + 0.005, y: H - 0.07 });
    // 開いた蓋（後ろの蝶番）
    b.box(body, bw + 0.02, 0.02, bd + 0.02, { y: H - 0.03 + (bd / 2) * Math.sin(1.25), z: bd / 2 + 0.01 - (bd / 2) * Math.cos(1.25), rx: 1.25 });
    // ペダル
    b.box(MAT.steelDark(), 0.12, 0.02, 0.06, { y: 0.04, z: -bd / 2 - 0.03 });
  });
  const fill = new THREE.Group();
  const lump = new THREE.Mesh(
    cached('trashlump', () => {
      const g = new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
      const p = g.attributes.position!;
      const r = makeRng(12);
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * rr(r, 0.6, 1.3));
      g.computeVertexNormals();
      return g;
    }),
    cached('eqm:trashlump', () => new THREE.MeshStandardMaterial({ color: '#d9d6cc', roughness: 0.5, transparent: true, opacity: 0.95 })),
  );
  lump.scale.set(bw * 0.46, 0.06, bd * 0.46);
  fill.add(lump);
  // ゴミの中身（色のついた紙くず・容器）
  const bits = cached('trashbits', () => {
    const b = new GeoBuilder();
    const r = makeRng(4);
    const cols = ['#c0392b', '#f1c40f', '#3498db', '#ecf0f1', '#8e6e4a', '#2ecc71'];
    for (let i = 0; i < 9; i++) {
      b.box(plastic(cols[i % cols.length]!, 0.6), rr(r, 0.03, 0.07), rr(r, 0.015, 0.04), rr(r, 0.03, 0.06), { x: rr(r, -bw * 0.3, bw * 0.3), y: rr(r, 0.01, 0.05), z: rr(r, -bd * 0.3, bd * 0.3), ry: r() * 6, rx: rr(r, -0.4, 0.4) });
    }
    return b.merged();
  });
  for (const { geo, mat } of bits) fill.add(new THREE.Mesh(geo, mat));
  c.group.add(fill);
  const cap = EQUIPMENT[c.type]?.capacity ?? 30;
  c.updaters.push((e) => {
    const f = clamp(e.fill / cap, 0, 1.2);
    fill.visible = f > 0.02;
    fill.position.y = 0.03 + (H - 0.12) * Math.min(1, f);
    lump.scale.y = 0.04 + (f > 0.9 ? (f - 0.9) * 0.6 : 0);
  });
  c.topY = H;
}

export function buildLocker(c: EqCtx): void {
  const { W, D, H } = c;
  const paint = plastic('#7d8a99', 0.5);
  const label = cached('eqm:lockerlabel', () =>
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 64, (cx, w, h) => {
        cx.fillStyle = '#fbfbf4';
        cx.fillRect(0, 0, w, h);
        cx.fillStyle = '#1d2a3a';
        cx.font = `bold 34px ${JP_FONT}`;
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText('清掃用具入れ', w / 2, h / 2 + 1);
      }),
      roughness: 0.6,
    }),
  );
  addStatic(c, c.type, (b) => {
    b.box(paint, W - 0.04, H - 0.04, D - 0.04, { y: (H - 0.04) / 2 + 0.02 });
    b.box(plastic('#6b7887', 0.45), W - 0.08, H - 0.14, 0.01, { y: H / 2 + 0.02, z: -D / 2 + 0.018 });
    for (let i = 0; i < 6; i++) b.box(MAT.black(), W * 0.5, 0.008, 0.004, { y: H - 0.25 - i * 0.025, z: -D / 2 + 0.012 });
    for (let i = 0; i < 6; i++) b.box(MAT.black(), W * 0.5, 0.008, 0.004, { y: 0.25 + i * 0.025, z: -D / 2 + 0.012 });
    b.box(MAT.steelPolished(), 0.025, 0.14, 0.03, { x: W / 2 - 0.08, y: H * 0.55, z: -D / 2 + 0.0 });
    b.box(label, 0.24, 0.06, 0.004, { y: H * 0.72, z: -D / 2 + 0.012 });
  });
  c.lampPos.set(W / 2 - 0.08, H + 0.08, -D / 2 + 0.08);
}

export function buildDesk(c: EqCtx): void {
  const { W, D, H } = c;
  const wood = cached('eqm:deskwood', () => new THREE.MeshStandardMaterial({ color: '#8c6d4f', roughness: 0.6 }));
  const screen = cached('eqm:deskscreen', () => {
    const tex = canvasTexture(256, 160, (cx, w, h) => {
      cx.fillStyle = '#10202e';
      cx.fillRect(0, 0, w, h);
      cx.fillStyle = '#e8f0f8';
      cx.font = `bold 20px ${JP_FONT}`;
      cx.fillText('本日の売上', 14, 28);
      const vals = [30, 52, 41, 70, 64, 88, 95];
      vals.forEach((v, i) => {
        cx.fillStyle = i === vals.length - 1 ? '#f2c200' : '#4aa3ff';
        cx.fillRect(20 + i * 32, h - 16 - v, 20, v);
      });
    });
    return new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: '#ffffff', emissiveIntensity: 0.9, roughness: 0.3 });
  });
  const boxLabel = cached('eqm:lostbox', () =>
    new THREE.MeshStandardMaterial({
      map: canvasTexture(256, 96, (cx, w, h) => {
        cx.fillStyle = '#c9a26a';
        cx.fillRect(0, 0, w, h);
        cx.fillStyle = '#fffaf0';
        cx.fillRect(20, 14, w - 40, h - 28);
        cx.fillStyle = '#b3261e';
        cx.font = `bold 44px ${JP_FONT}`;
        cx.textAlign = 'center';
        cx.textBaseline = 'middle';
        cx.fillText('忘れ物', w / 2, h / 2 + 2);
      }),
      roughness: 0.85,
    }),
  );
  addStatic(c, c.type, (b) => {
    b.box(wood, W, 0.035, D, { y: H - 0.0175 });
    for (const sx of [-1, 1]) b.box(wood, 0.035, H - 0.035, D - 0.04, { x: sx * (W / 2 - 0.02), y: (H - 0.035) / 2 });
    // 引き出し
    b.box(wood, 0.32, 0.4, D - 0.06, { x: W / 2 - 0.2, y: H - 0.24 });
    for (let i = 0; i < 3; i++) b.box(MAT.steelDark(), 0.08, 0.012, 0.01, { x: W / 2 - 0.2, y: H - 0.1 - i * 0.13, z: -D / 2 + 0.02 });
    // ノートPC
    b.box(MAT.darkPanel(), 0.3, 0.015, 0.2, { x: -0.12, y: H + 0.0075, z: -0.02 });
    b.box(MAT.darkPanel(), 0.3, 0.2, 0.012, { x: -0.12, y: H + 0.1, z: 0.09, rx: -0.2 });
    b.add(screen, new THREE.PlaneGeometry(0.27, 0.17), { x: -0.12, y: H + 0.1, z: 0.0815, rx: -0.2, ry: Math.PI });
    // 忘れ物の箱
    b.box(plastic('#c9a26a', 0.85), 0.26, 0.16, 0.2, { x: 0.28, y: H + 0.08, z: 0.05 });
    b.add(boxLabel, new THREE.PlaneGeometry(0.22, 0.08), { x: 0.28, y: H + 0.08, z: 0.05 - 0.101, ry: Math.PI });
    // 書類とペン立て
    b.box(plastic('#f6f6f0', 0.9), 0.21, 0.006, 0.297, { x: 0.05, y: H + 0.003, z: -0.05, ry: 0.2 });
    b.cyl(plastic('#2a2a2a', 0.5), 0.03, 0.03, 0.09, 10, { x: -0.38, y: H, z: 0.1 });
    b.box(plastic('#d23a2a', 0.5), 0.006, 0.14, 0.006, { x: -0.385, y: H + 0.09, z: 0.1, rz: 0.15 });
  });
  c.topY = H;
}

/** 正面の向きなどを確認する補助: なにも表示しない */
export function buildNothing(c: EqCtx): void {
  void c;
}

export const _unused = { feet, MAT };
