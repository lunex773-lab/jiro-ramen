// 爆発事故の演出（3D）: 予兆の火花とガス、爆発後の焼け焦げた店内。
// 新しい店のモデルは作らず、今ある店・設備・椅子・丼・人物の材質の色を焦げた色に変え、
// 照明を落として点滅させ、煙・灰・残り火・火花を足す。リセットしたら元の色・照明に戻す。
// ゲームのルールはここに置かない（状態は読むだけ）。

import * as THREE from 'three';
import { createSteam } from './models/fx';

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

  // ───────────────── 焼け跡 ─────────────────

  /**
   * 焼け跡にする。lights はシーンの照明（店の照明は点滅、空の光は暗く）。
   * bounds は店の内側（灰と残り火を撒く範囲）
   */
  enter(lights: THREE.Light[], bounds: { w: number; d: number }, pos: { x: number; z: number }): void {
    if (this.burned) return;
    this.burned = true;
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
    this.embers = this.makePoints(150, bounds, '#ff7a2a', 0.05, THREE.AdditiveBlending, () => Math.random() * 0.25);
    this.ash = this.makePoints(220, bounds, '#8a847c', 0.022, THREE.NormalBlending, () => Math.random() * 2.6);
    // 煙（爆心と、店のあちこち）
    const spots = [pos, { x: bounds.w * 0.3, z: bounds.d * 0.6 }, { x: bounds.w * 0.7, z: bounds.d * 0.35 }];
    spots.forEach((p, i) => {
      const smoke = createSteam({ count: 12, radius: 0.5, rise: 2.4, size: 1.1, speed: 0.12, spread: 0.12, color: '#2b2622', opacity: 0.55, seed: 11 + i });
      smoke.position.set(p.x, 0.2, p.z);
      this.fx.add(smoke);
    });
  }

  /** 元に戻す（リセット） */
  exit(): void {
    this.setWarning(false, null, 0);
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
      if (o instanceof THREE.Points) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
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
