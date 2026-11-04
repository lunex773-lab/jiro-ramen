// 爆発事故の演出（3D）: 予兆の火花とガス、爆発後の焼け焦げた店内。
// 新しい店のモデルは作らず、今ある店・設備・椅子・丼・人物の材質の色を焦げた色に変え、
// 照明を落として点滅させ、煙・灰・残り火・火花を足す。リセットしたら元の色・照明に戻す。
// ゲームのルールはここに置かない（状態は読むだけ）。

import * as THREE from 'three';
import { createSteam } from './models/fx';
import { CEILING_Y } from './models/shop';
import { wreckLayout, type Debris, type DebrisKind } from './wreck';

/** 燃えている設備（world.ts が状態から作る） */
export interface FireSpot {
  id: string;
  x: number;
  z: number;
  /** 設備の上面の高さ（m） */
  top: number;
  /** 設備の大きさ（m） */
  w: number;
  d: number;
  /** 燃え始めてからの秒数 */
  age: number;
  /** 炎の大きさ（爆発のあとの燃え残りは小さめ） */
  scale: number;
}

interface Flame {
  group: THREE.Group;
  cones: THREE.Mesh[];
  phase: number;
}

const flameGeo = new THREE.ConeGeometry(1, 1, 8, 1, true);
flameGeo.translate(0, 0.5, 0);

/** 炎の色（下は濃いオレンジ、上へ行くほど黄色く薄く消える） */
function flameTexture(inner: boolean): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 64, 0, 0);
    if (inner) {
      grad.addColorStop(0, 'rgba(255,240,170,0.95)');
      grad.addColorStop(0.45, 'rgba(255,200,80,0.7)');
      grad.addColorStop(1, 'rgba(255,160,40,0)');
    } else {
      grad.addColorStop(0, 'rgba(200,40,10,0.9)');
      grad.addColorStop(0.3, 'rgba(255,100,20,0.85)');
      grad.addColorStop(0.7, 'rgba(255,170,40,0.45)');
      grad.addColorStop(1, 'rgba(255,190,60,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
let flameMatsCache: { outer: THREE.Material; inner: THREE.Material } | null = null;
function flameMats(): { outer: THREE.Material; inner: THREE.Material } {
  if (flameMatsCache) return flameMatsCache;
  flameMatsCache = {
    outer: new THREE.MeshBasicMaterial({ map: flameTexture(false), transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    inner: new THREE.MeshBasicMaterial({ map: flameTexture(true), transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  };
  return flameMatsCache;
}

/** 焦げた色 */
const CHAR = new THREE.Color('#15110d');

interface SavedMat {
  color: THREE.Color | null;
  emissive: THREE.Color | null;
  emissiveIntensity: number;
}

interface LightSave {
  light: THREE.Light;
  intensity: number;
  color: THREE.Color;
}

/** 0..1 の決定的な疑似乱数（同じ ID なら同じ値） */
export function hash01(str: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

let dot: THREE.Texture | null = null;
/** 粒の形（ふちのぼやけた丸。四角い点に見えないように） */
function dotTexture(): THREE.Texture {
  if (dot) return dot;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
  }
  dot = new THREE.CanvasTexture(c);
  dot.colorSpace = THREE.SRGBColorSpace;
  return dot;
}

export class Aftermath {
  /** 焼け跡の表示中 */
  burned = false;
  private mats = new Map<THREE.Material, SavedMat>();
  private lights: LightSave[] = [];
  private bg: { color: THREE.Color | null; fogColor: THREE.Color | null; near: number; far: number } | null = null;
  private fx = new THREE.Group();
  private embers: THREE.Points | null = null;
  private ash: THREE.Points | null = null;
  private sparks: THREE.Points | null = null;
  private sparkVel: Float32Array | null = null;
  private sparkLife = 0;
  private nextSpark = 0;
  private fireLight: THREE.PointLight | null = null;
  private warnLight: THREE.PointLight | null = null;
  private gas: THREE.Mesh | null = null;
  private rescanAcc = 0;
  private flames = new Map<string, Flame>();
  private fireGlow: THREE.PointLight | null = null;
  private smokeLayers: THREE.Mesh[] = [];
  private wreck: THREE.Group | null = null;

  constructor(private scene: THREE.Scene) {
    this.fx.name = 'aftermath';
    this.fx.userData.noBurn = true;
    scene.add(this.fx);
  }

  // ───────────────── 予兆 ─────────────────

  /** 設備の異常（ガス・火花・赤い点滅）。on=false で消す */
  setWarning(on: boolean, pos: { x: number; z: number } | null, t: number): void {
    if (!on || !pos) {
      if (this.warnLight) {
        this.fx.remove(this.warnLight);
        this.warnLight = null;
      }
      if (this.gas) {
        this.fx.remove(this.gas);
        this.gas = null;
      }
      if (!this.burned) {
        this.setFires([], t);
        this.setSmoke(0, null);
      }
      return;
    }
    if (!this.warnLight) {
      this.warnLight = new THREE.PointLight('#ff2a1a', 0, 6, 1.5);
      this.fx.add(this.warnLight);
      this.gas = createSteam({ count: 10, radius: 0.25, rise: 1.6, size: 0.5, speed: 0.6, spread: 0.08, color: '#dfe6d8', opacity: 0.45, seed: 7 });
      this.fx.add(this.gas);
    }
    this.warnLight.position.set(pos.x, 1.6, pos.z);
    this.warnLight.intensity = (Math.sin(t * 9) > 0 ? 5 : 0.4) * (0.6 + 0.4 * Math.sin(t * 1.7));
    this.gas!.position.set(pos.x, 1.1, pos.z);
    // 火花はだんだん激しく
    if (t > this.nextSpark) {
      this.burstSparks(pos, 1.2);
      this.nextSpark = t + 0.25 + Math.random() * 0.6;
    }
  }

  // ───────────────── 燃え広がる火 ─────────────────

  /** 燃えている設備の炎（増えた分は足し、消えた分は外す）。毎フレーム呼ぶ */
  setFires(spots: readonly FireSpot[], t: number): void {
    const seen = new Set<string>();
    let cx = 0;
    let cz = 0;
    for (const sp of spots) {
      seen.add(sp.id);
      let f = this.flames.get(sp.id);
      if (!f) {
        f = this.makeFlame(sp);
        this.flames.set(sp.id, f);
        this.fx.add(f.group);
      }
      f.group.position.set(sp.x, sp.top, sp.z);
      // 燃え始めは小さく、2.5秒ほどで大きくなる。炎はゆらめく
      const grow = Math.min(1, 0.25 + sp.age / 2.5) * sp.scale;
      f.cones.forEach((c, i) => {
        const base = c.userData.base as { r: number; h: number };
        const fl = 0.78 + 0.22 * Math.sin(t * (11 + i * 2.3) + f!.phase + i) + 0.1 * Math.sin(t * 23 + i * 7);
        c.scale.set(base.r * grow * (0.9 + 0.1 * fl), base.h * grow * fl, base.r * grow * (0.9 + 0.1 * fl));
      });
      cx += sp.x;
      cz += sp.z;
    }
    for (const [id, f] of this.flames) {
      if (seen.has(id)) continue;
      this.fx.remove(f.group);
      f.group.traverse((o) => {
        if (o instanceof THREE.Mesh && o.geometry !== flameGeo) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.flames.delete(id);
    }
    // 炎の明かり（1つだけ。燃えている設備の真ん中で、数が多いほど明るい）
    if (spots.length > 0) {
      if (!this.fireGlow) {
        this.fireGlow = new THREE.PointLight('#ff7a2a', 0, 9, 1.3);
        this.fx.add(this.fireGlow);
      }
      this.fireGlow.position.set(cx / spots.length, 1.4, cz / spots.length);
      this.fireGlow.intensity = Math.min(7, 1.6 + spots.length * 0.45) * (0.85 + 0.15 * Math.sin(t * 13) + 0.08 * Math.random());
    } else if (this.fireGlow) {
      this.fx.remove(this.fireGlow);
      this.fireGlow = null;
    }
  }

  /** 天井にたまる煙（level 0..1）。bounds は店の内側 */
  setSmoke(level: number, bounds: { w: number; d: number } | null): void {
    if (level <= 0 || !bounds) {
      for (const m of this.smokeLayers) {
        this.fx.remove(m);
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      this.smokeLayers = [];
      return;
    }
    if (this.smokeLayers.length === 0) {
      for (const [y, k] of [
        [CEILING_Y - 0.06, 1],
        [CEILING_Y - 0.55, 0.55],
        [1.75, 0.3],
      ] as const) {
        const m = new THREE.Mesh(
          new THREE.PlaneGeometry(bounds.w, bounds.d),
          new THREE.MeshBasicMaterial({ color: '#1a1714', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
        );
        m.rotation.x = -Math.PI / 2;
        m.position.set(bounds.w / 2, y, bounds.d / 2);
        m.userData.k = k;
        m.renderOrder = 6;
        this.fx.add(m);
        this.smokeLayers.push(m);
      }
    }
    for (const m of this.smokeLayers) (m.material as THREE.MeshBasicMaterial).opacity = Math.min(0.85, level * 0.85 * (m.userData.k as number));
  }

  private makeFlame(sp: FireSpot): Flame {
    const g = new THREE.Group();
    g.name = `flame:${sp.id}`;
    const cones: THREE.Mesh[] = [];
    const n = 3 + Math.round(Math.min(2, (sp.w * sp.d) / 0.4));
    let seed = 0;
    for (let i = 0; i < sp.id.length; i++) seed = (seed * 31 + sp.id.charCodeAt(i)) >>> 0;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      for (const inner of [false, true]) {
        const c = new THREE.Mesh(flameGeo, inner ? flameMats().inner : flameMats().outer);
        const r = (inner ? 0.06 : 0.11) + rnd() * 0.05;
        const hgt = (inner ? 0.3 : 0.5) + rnd() * 0.35;
        c.userData.base = { r, h: hgt };
        c.position.set((rnd() - 0.5) * sp.w * 0.7, -0.04, (rnd() - 0.5) * sp.d * 0.7);
        c.rotation.set((rnd() - 0.5) * 0.25, rnd() * 6.28, (rnd() - 0.5) * 0.25);
        c.renderOrder = 7;
        g.add(c);
        cones.push(c);
      }
    }
    // 黒い煙の柱
    const smoke = createSteam({ count: 8, radius: Math.max(0.15, Math.min(sp.w, sp.d) * 0.3), rise: 1.8, size: 0.7, speed: 0.4, spread: 0.1, color: '#1f1b18', opacity: 0.5, seed: Math.floor(rnd() * 1000) });
    smoke.position.y = 0.3;
    g.add(smoke);
    return { group: g, cones, phase: rnd() * 6.28 };
  }

  // ───────────────── 焼け跡 ─────────────────

  /**
   * 焼け跡にする。lights はシーンの照明（店の照明は点滅、空の光は暗く）。
   * bounds は店の内側（灰と残り火を撒く範囲）
   */
  enter(lights: THREE.Light[], bounds: { w: number; d: number }, pos: { x: number; z: number }, seed = 'accident'): void {
    if (this.burned) return;
    this.burned = true;
    // 店内をぐちゃぐちゃにする（落ちた天井・板・かけら・ガラス・焦げ跡・スープ・麺・電線・紙）
    this.wreck = buildWreck(wreckLayout({ w: bounds.w, d: bounds.d, blast: pos, ceiling: CEILING_Y, seed }));
    this.fx.add(this.wreck);
    this.addSoot(bounds, pos);
    // 煙が天井にたまったまま
    this.setSmoke(0.75, bounds);
    this.scan();
    this.lights = lights.map((light) => ({ light, intensity: light.intensity, color: light.color.clone() }));
    for (const l of this.lights) {
      if (l.light instanceof THREE.PointLight) l.light.color.set('#ff9a55');
      else l.light.intensity = l.intensity * 0.18;
    }
    const s = this.scene;
    const fog = s.fog as THREE.Fog | null;
    this.bg = { color: s.background instanceof THREE.Color ? s.background.clone() : null, fogColor: fog ? fog.color.clone() : null, near: fog?.near ?? 0, far: fog?.far ?? 0 };
    if (s.background instanceof THREE.Color) s.background.set('#1a1714');
    if (fog) {
      fog.color.set('#1d1915');
      fog.near = 2.5;
      fog.far = 15;
    }
    // 残り火の明かり（爆心の近く）
    this.fireLight = new THREE.PointLight('#ff6a20', 2.5, 7, 1.4);
    this.fireLight.position.set(pos.x, 0.6, pos.z);
    this.fx.add(this.fireLight);
    this.embers = this.makePoints(260, bounds, '#ff7a2a', 0.05, THREE.AdditiveBlending, () => Math.random() * 0.25);
    this.ash = this.makePoints(380, bounds, '#8a847c', 0.022, THREE.NormalBlending, () => Math.random() * 2.6);
    // 煙（爆心と、店のあちこち）
    const spots = [pos, { x: bounds.w * 0.3, z: bounds.d * 0.6 }, { x: bounds.w * 0.7, z: bounds.d * 0.35 }, { x: bounds.w * 0.5, z: bounds.d * 0.8 }, { x: bounds.w * 0.15, z: bounds.d * 0.25 }];
    spots.forEach((p, i) => {
      const smoke = createSteam({ count: 12, radius: 0.5, rise: 2.4, size: 1.1, speed: 0.12, spread: 0.12, color: '#2b2622', opacity: 0.55, seed: 11 + i });
      smoke.position.set(p.x, 0.2, p.z);
      this.fx.add(smoke);
    });
  }

  /** 元に戻す（リセット） */
  exit(): void {
    this.setWarning(false, null, 0);
    this.setFires([], 0);
    this.setSmoke(0, null);
    if (!this.burned) return;
    this.burned = false;
    for (const [m, sv] of this.mats) {
      const mm = m as THREE.MeshStandardMaterial;
      if (sv.color && mm.color) mm.color.copy(sv.color);
      if (sv.emissive && mm.emissive) {
        mm.emissive.copy(sv.emissive);
        mm.emissiveIntensity = sv.emissiveIntensity;
      }
    }
    this.mats.clear();
    for (const l of this.lights) {
      l.light.intensity = l.intensity;
      l.light.color.copy(l.color);
    }
    this.lights = [];
    const s = this.scene;
    if (this.bg) {
      if (this.bg.color && s.background instanceof THREE.Color) s.background.copy(this.bg.color);
      const fog = s.fog as THREE.Fog | null;
      if (fog && this.bg.fogColor) {
        fog.color.copy(this.bg.fogColor);
        fog.near = this.bg.near;
        fog.far = this.bg.far;
      }
    }
    this.bg = null;
    for (const o of [...this.fx.children]) {
      this.fx.remove(o);
      if (o instanceof THREE.Points || (o instanceof THREE.Mesh && o.userData.own)) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    if (this.wreck) disposeWreck(this.wreck);
    this.wreck = null;
    this.embers = this.ash = this.sparks = null;
    this.fireLight = null;
  }

  /** 毎フレーム（t は秒） */
  update(t: number, dt: number, pos: { x: number; z: number } | null): void {
    if (!this.burned) return;
    // あとから出てきた物（人物・丼など）も焦がす
    this.rescanAcc += dt;
    if (this.rescanAcc > 0.5) {
      this.rescanAcc = 0;
      this.scan();
    }
    // 店の照明は不安定に点滅し、ときどき消える
    this.lights.forEach((l, i) => {
      if (!(l.light instanceof THREE.PointLight)) return;
      const n = Math.sin(t * 17 + i * 5.1) + Math.sin(t * 6.3 + i * 2.7);
      l.light.intensity = n > 1.2 ? l.intensity * 0.5 * (0.6 + 0.4 * Math.random()) : n > 0.6 ? l.intensity * 0.08 : 0;
    });
    if (this.fireLight) this.fireLight.intensity = 1.8 + Math.sin(t * 11) * 0.5 + Math.random() * 0.6;
    // 残り火は少しずつ上がって消え、灰はゆっくり降る
    this.drift(this.embers, dt, 0.12, 0.3);
    this.drift(this.ash, dt, -0.18, 2.6);
    if (this.embers) (this.embers.material as THREE.PointsMaterial).opacity = 0.6 + 0.4 * Math.sin(t * 7);
    if (pos && t > this.nextSpark) {
      this.burstSparks(pos, 0.5 + Math.random() * 1.2);
      this.nextSpark = t + 1.5 + Math.random() * 3;
    }
    this.updateSparks(dt);
  }

  dispose(): void {
    this.exit();
    this.scene.remove(this.fx);
  }

  // ───────────────── 内部 ─────────────────

  /** シーンの材質を焦げた色にする（元の色は覚えておく） */
  private scan(): void {
    this.scene.traverse((o) => {
      if (o.userData.noBurn) return;
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) return;
      // 親に noBurn があればそのまま（演出の煙・残り火）
      let p: THREE.Object3D | null = o.parent;
      while (p) {
        if (p.userData.noBurn) return;
        p = p.parent;
      }
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of list) {
        if (!m || this.mats.has(m)) continue;
        const mm = m as THREE.MeshStandardMaterial;
        if (!(mm.color instanceof THREE.Color)) continue;
        this.mats.set(m, {
          color: mm.color.clone(),
          emissive: mm.emissive instanceof THREE.Color ? mm.emissive.clone() : null,
          emissiveIntensity: mm.emissiveIntensity ?? 1,
        });
        // 照明のパネルなど光を受けない材質は、明かりが消えたようにほぼ黒くする
        mm.color.lerp(CHAR, (m as THREE.MeshBasicMaterial).isMeshBasicMaterial ? 0.97 : 0.82);
        if (mm.emissive instanceof THREE.Color) mm.emissiveIntensity = 0;
      }
    });
  }

  /** 壁のすす（爆心に近い奥の壁と横の壁、天井） */
  private addSoot(b: { w: number; d: number }, pos: { x: number; z: number }): void {
    const mat = new THREE.MeshBasicMaterial({ color: '#070605', map: dotTexture(), transparent: true, opacity: 0.85, depthWrite: false });
    const geo = new THREE.PlaneGeometry(2, 2);
    const add = (x: number, y: number, z: number, ry: number, rx: number, sx: number, sy: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      m.scale.set(sx, sy, 1);
      m.renderOrder = 4;
      m.userData.own = true;
      this.fx.add(m);
    };
    add(pos.x, 1.4, b.d - 0.015, Math.PI, 0, 1.6, 1.2);
    add(Math.min(b.w - 0.5, pos.x + 1.6), 1.7, b.d - 0.016, Math.PI, 0, 0.9, 0.8);
    add(0.015, 1.5, Math.min(b.d - 0.5, pos.z), Math.PI / 2, 0, 1.3, 1.0);
    add(pos.x, CEILING_Y - 0.01, pos.z, 0, Math.PI / 2, 2.2, 1.8);
  }

  private makePoints(n: number, b: { w: number; d: number }, color: string, size: number, blending: THREE.Blending, y: () => number): THREE.Points {
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = 0.3 + Math.random() * (b.w - 0.6);
      pos[i * 3 + 1] = y();
      pos[i * 3 + 2] = 0.3 + Math.random() * (b.d - 0.6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ color, size, map: dotTexture(), alphaTest: 0.02, transparent: true, opacity: 0.9, depthWrite: false, blending, sizeAttenuation: true });
    const pts = new THREE.Points(g, m);
    pts.userData.noBurn = true;
    pts.userData.bounds = b;
    pts.frustumCulled = false;
    this.fx.add(pts);
    return pts;
  }

  /** 粒を上下に動かし、範囲を出たら反対側へ戻す */
  private drift(p: THREE.Points | null, dt: number, vy: number, top: number): void {
    if (!p) return;
    const a = p.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    for (let i = 0; i < a.count; i++) {
      let y = arr[i * 3 + 1]! + vy * dt * (0.5 + ((i * 37) % 10) / 10);
      if (vy > 0 && y > top) y = 0.02;
      if (vy < 0 && y < 0.01) y = top;
      arr[i * 3 + 1] = y;
      arr[i * 3] = arr[i * 3]! + Math.sin(y * 3 + i) * 0.002;
    }
    a.needsUpdate = true;
  }

  private burstSparks(pos: { x: number; z: number }, height: number): void {
    const n = 40;
    if (!this.sparks) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const m = new THREE.PointsMaterial({ color: '#ffd36a', size: 0.04, map: dotTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      this.sparks = new THREE.Points(g, m);
      this.sparks.userData.noBurn = true;
      this.sparks.frustumCulled = false;
      this.fx.add(this.sparks);
      this.sparkVel = new Float32Array(n * 3);
    }
    const a = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const v = this.sparkVel!;
    for (let i = 0; i < n; i++) {
      arr[i * 3] = pos.x;
      arr[i * 3 + 1] = height;
      arr[i * 3 + 2] = pos.z;
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.8 + Math.random() * 2.2;
      v[i * 3] = Math.cos(ang) * sp;
      v[i * 3 + 1] = 0.5 + Math.random() * 2.5;
      v[i * 3 + 2] = Math.sin(ang) * sp;
    }
    a.needsUpdate = true;
    this.sparkLife = 0.7;
    this.sparks.visible = true;
  }

  private updateSparks(dt: number): void {
    if (!this.sparks || !this.sparkVel) return;
    if (this.sparkLife <= 0) {
      this.sparks.visible = false;
      return;
    }
    this.sparkLife -= dt;
    const a = this.sparks.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const v = this.sparkVel;
    for (let i = 0; i < a.count; i++) {
      v[i * 3 + 1] = v[i * 3 + 1]! - 9.8 * dt;
      arr[i * 3] = arr[i * 3]! + v[i * 3]! * dt;
      arr[i * 3 + 1] = Math.max(0.01, arr[i * 3 + 1]! + v[i * 3 + 1]! * dt);
      arr[i * 3 + 2] = arr[i * 3 + 2]! + v[i * 3 + 2]! * dt;
    }
    a.needsUpdate = true;
    (this.sparks.material as THREE.PointsMaterial).opacity = Math.max(0, this.sparkLife / 0.7);
  }

  /** 予兆の間も火花を動かす */
  tickWarning(dt: number): void {
    this.updateSparks(dt);
  }
}

// ───────────────── 散らばった物（InstancedMesh で種類ごとにまとめて描く） ─────────────────

function debrisGeometry(k: DebrisKind): THREE.BufferGeometry {
  switch (k) {
    case 'panel':
      return new THREE.BoxGeometry(1.0, 0.03, 0.6);
    case 'plank':
      return new THREE.BoxGeometry(0.5, 0.03, 0.09);
    case 'chunk':
      return new THREE.DodecahedronGeometry(1, 0);
    case 'shard':
      return new THREE.CircleGeometry(1, 3);
    case 'scorch':
      return new THREE.PlaneGeometry(2, 2);
    case 'puddle':
      return new THREE.CircleGeometry(1, 14);
    case 'noodle':
      return new THREE.TorusGeometry(1, 0.045, 3, 10, Math.PI * 1.4);
    case 'wire':
      return new THREE.CylinderGeometry(0.008, 0.008, 1, 4);
    case 'paper':
      return new THREE.PlaneGeometry(1, 1);
  }
}

function debrisMaterial(k: DebrisKind): THREE.Material {
  switch (k) {
    case 'panel':
      return new THREE.MeshStandardMaterial({ color: '#3a352f', roughness: 0.95 });
    case 'plank':
      return new THREE.MeshStandardMaterial({ color: '#2a1c12', roughness: 0.9 });
    case 'chunk':
      return new THREE.MeshStandardMaterial({ color: '#45403a', roughness: 1, flatShading: true });
    case 'shard':
      return new THREE.MeshStandardMaterial({ color: '#9fb8c0', roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    case 'scorch':
      return new THREE.MeshBasicMaterial({ color: '#060504', map: dotTexture(), transparent: true, opacity: 0.9, depthWrite: false });
    case 'puddle':
      return new THREE.MeshStandardMaterial({ color: '#2e1c0c', roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.9, depthWrite: false });
    case 'noodle':
      return new THREE.MeshStandardMaterial({ color: '#8a7444', roughness: 0.7 });
    case 'wire':
      return new THREE.MeshStandardMaterial({ color: '#0d0d0d', roughness: 0.6 });
    case 'paper':
      return new THREE.MeshStandardMaterial({ color: '#7d7462', roughness: 1, side: THREE.DoubleSide });
  }
}

function buildWreck(list: readonly Debris[]): THREE.Group {
  const g = new THREE.Group();
  g.name = 'wreck';
  g.userData.noBurn = true;
  const byKind = new Map<DebrisKind, Debris[]>();
  for (const d of list) {
    const arr = byKind.get(d.kind) ?? [];
    arr.push(d);
    byKind.set(d.kind, arr);
  }
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  for (const [k, arr] of byKind) {
    const mesh = new THREE.InstancedMesh(debrisGeometry(k), debrisMaterial(k), arr.length);
    mesh.name = `wreck:${k}`;
    mesh.userData.noBurn = true;
    mesh.castShadow = k === 'panel' || k === 'plank' || k === 'chunk';
    mesh.receiveShadow = true;
    if (k === 'scorch' || k === 'puddle') mesh.renderOrder = 3;
    arr.forEach((d, i) => {
      p.set(d.x, d.y, d.z);
      e.set(d.rx, d.ry, d.rz);
      q.setFromEuler(e);
      if (k === 'noodle') sc.set(d.sy, d.sy, d.sy);
      else sc.set(d.sx, d.sy, d.sz);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    g.add(mesh);
  }
  return g;
}

function disposeWreck(g: THREE.Group): void {
  g.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
      o.dispose();
    }
  });
}
