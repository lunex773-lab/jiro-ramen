// 昼夜・星空・街の明かり（じろ7 1）。時刻・月齢・光害は core の skyState で決め、ここでは描くだけ。
// - 空: カメラに付いて動く大きな球の内側に、時刻で色の変わるグラデーション（深夜〜夜明け前〜朝焼け〜朝〜昼〜夕方〜夕焼け〜日没〜夜）。
//   太陽の光の輪・地平線の街明かり（光害）もシェーダーで描く（光源は増やさない）
// - 星: 一度だけ作る点の集まり。明るさは星ごとに違い（暗い星が多く明るい星は少ない）、天の川の帯に多く集まる。
//   瞬きはシェーダーで星ごとに違う速さ・位相（全部が一緒に点滅しない。CPU は使わない）。昼は描かない。光害が強いと暗い星から見えなくなる
// - 月: 月齢で満ち欠けする円（シェーダーで影の形を描く）。月明かりは明かりの強さに入れる
// - 雲: 薄い雲を数枚（画質が低いときは出さない）
// - 車のライト: 夜の都会の通りを流れる前照灯・尾灯（光害が強いほど多い。光源ではなく光る点）
// 時刻が急に変わる（閉店後の夜へ移るなど）ときも、表示の時刻を数秒かけて追いつかせて滑らかに変える。

import * as THREE from 'three';
import { moonIllumination, nightness, sunHeight, type SkyState } from '@jiro/core';
import type { Quality } from './world';

/** 時刻ごとの空と明かりの色（分。間は滑らかにつなぐ） */
interface Key {
  m: number;
  zenith: string;
  horizon: string;
  sun: string;
  hemiSky: string;
  hemiGround: string;
  hemi: number;
  sunI: number;
}
const KEYS: Key[] = [
  { m: 0, zenith: '#03081a', horizon: '#0b1330', sun: '#8fa6ff', hemiSky: '#2c3b66', hemiGround: '#14110e', hemi: 0.26, sunI: 0.0 },
  { m: 270, zenith: '#071030', horizon: '#1c2a58', sun: '#8fa6ff', hemiSky: '#33426e', hemiGround: '#15120f', hemi: 0.3, sunI: 0.0 },
  { m: 330, zenith: '#26407e', horizon: '#f08a5d', sun: '#ffb07a', hemiSky: '#9a8aa8', hemiGround: '#3a2e26', hemi: 0.5, sunI: 0.45 },
  { m: 420, zenith: '#5a8dd2', horizon: '#f3cfa8', sun: '#ffe0b8', hemiSky: '#f4ead8', hemiGround: '#55463a', hemi: 0.78, sunI: 1.0 },
  { m: 600, zenith: '#3f7fd6', horizon: '#bcd3e6', sun: '#fff1d6', hemiSky: '#fff6e8', hemiGround: '#5b4a3a', hemi: 0.85, sunI: 1.2 },
  { m: 930, zenith: '#3f7fd6', horizon: '#bfd4e6', sun: '#fff1d6', hemiSky: '#fff6e8', hemiGround: '#5b4a3a', hemi: 0.85, sunI: 1.2 },
  { m: 1020, zenith: '#4a78c0', horizon: '#f2cc9e', sun: '#ffd9a8', hemiSky: '#f6e4cc', hemiGround: '#55443a', hemi: 0.78, sunI: 1.0 },
  { m: 1080, zenith: '#38508f', horizon: '#ff7b45', sun: '#ff9a5a', hemiSky: '#c49a8a', hemiGround: '#40302a', hemi: 0.6, sunI: 0.65 },
  { m: 1125, zenith: '#1b2452', horizon: '#8a4a6a', sun: '#ff7a5a', hemiSky: '#6a5a7e', hemiGround: '#251c18', hemi: 0.42, sunI: 0.18 },
  { m: 1200, zenith: '#060c22', horizon: '#121a3c', sun: '#8fa6ff', hemiSky: '#2f3d68', hemiGround: '#15110e', hemi: 0.28, sunI: 0.0 },
  { m: 1440, zenith: '#03081a', horizon: '#0b1330', sun: '#8fa6ff', hemiSky: '#2c3b66', hemiGround: '#14110e', hemi: 0.26, sunI: 0.0 },
];

const tmpA = new THREE.Color();
const tmpB = new THREE.Color();
/** 毎フレーム使う色（作り直さない） */
const C = {
  cityTone: new THREE.Color('#5a4a52'),
  cityHorizon: new THREE.Color('#6a4a3a'),
  white: new THREE.Color('#ffffff'),
  cityWarm: new THREE.Color('#ffb070'),
  cityGround: new THREE.Color('#8a6a52'),
  cityHaze: new THREE.Color('#5c4e4a'),
};
const moonDirTmp = new THREE.Vector3();

function lerpColor(a: string, b: string, k: number, out: THREE.Color): THREE.Color {
  tmpA.set(a);
  tmpB.set(b);
  return out.copy(tmpA).lerp(tmpB, k);
}

/** 時刻の色（前後の2つのキーの間） */
function keyAt(minute: number): { a: Key; b: Key; k: number } {
  const m = ((minute % 1440) + 1440) % 1440;
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i]!;
    const b = KEYS[i + 1]!;
    if (m >= a.m && m <= b.m) {
      const k = (m - a.m) / Math.max(1, b.m - a.m);
      return { a, b, k: k * k * (3 - 2 * k) };
    }
  }
  return { a: KEYS[0]!, b: KEYS[0]!, k: 0 };
}

/** 空の明かり（3D の世界の光・霧・背景に入れる値） */
export interface SkyLighting {
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  sunColor: THREE.Color;
  sunIntensity: number;
  /** 太陽（夜は月）の向き（光の来る方向。単位ベクトル） */
  lightDir: THREE.Vector3;
  fog: THREE.Color;
  /** 夜の度合い（0〜1）。窓・街灯・看板の光を強める */
  night: number;
  lightPollution: number;
}

const DOME_RADIUS = 60;

/** 太陽・月の向き（東 +x から昇り、南（通りの向こう −z）の空を通って西 −x へ沈む） */
function arcDir(progress: number, height: number, out: THREE.Vector3): THREE.Vector3 {
  const az = Math.PI * progress;
  return out.set(Math.cos(az), height * 0.95, -0.35 - Math.sin(az) * 0.45).normalize();
}

/** 日中の進み（0 = 日の出 〜 1 = 日の入り。夜は 1〜2 で地平線の下を回る） */
function dayProgress(minute: number): number {
  const rise = 5.5 * 60;
  const set = 18.5 * 60;
  const m = ((minute % 1440) + 1440) % 1440;
  if (m >= rise && m <= set) return (m - rise) / (set - rise);
  const night = 1440 - (set - rise);
  const t = m > set ? m - set : m + 1440 - set;
  return 1 + t / night;
}

/** ふつうの乱数（星の並びを毎回同じにする） */
function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function starCount(q: Quality): number {
  return q === 'low' ? 1400 : q === 'medium' ? 3200 : 5200;
}

export class Sky {
  /** カメラに付いて動く部分（空の球・星・月・雲） */
  readonly dome = new THREE.Group();
  /** 世界に置く部分（通りを流れる車のライト） */
  readonly street = new THREE.Group();
  private domeMat: THREE.ShaderMaterial;
  private stars: THREE.Points | null = null;
  private starMat: THREE.ShaderMaterial;
  private moon: THREE.Mesh;
  private moonMat: THREE.ShaderMaterial;
  private clouds: THREE.Sprite[] = [];
  private cars: { mesh: THREE.Points; speed: number; lane: number; offset: number }[] = [];
  private carMat: THREE.PointsMaterial;
  /** 表示している時刻（目標の時刻へ数秒かけて追いつく） */
  private shownMinute: number | null = null;
  private quality: Quality;
  private readonly out: SkyLighting = {
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 0.85,
    sunColor: new THREE.Color(),
    sunIntensity: 1.2,
    lightDir: new THREE.Vector3(0, 1, 0),
    fog: new THREE.Color(),
    night: 0,
    lightPollution: 0.5,
  };
  /** テスト・調べる用: 最後に描いた空の値 */
  last: { minute: number; night: number; starsVisible: number; lightPollution: number; moonLight: number } = { minute: 720, night: 0, starsVisible: 0, lightPollution: 0.5, moonLight: 0 };

  /** 街灯（夜に灯る頭・光の輪・歩道の明かり） */
  private lamps = new THREE.Group();
  private lampHead: THREE.MeshStandardMaterial;
  private lampGlow: THREE.SpriteMaterial;
  private lampPool: THREE.MeshBasicMaterial;
  private lampKey = '';

  constructor(quality: Quality, street: { x0: number; x1: number }) {
    this.quality = quality;
    const glowTex = radialTexture('rgba(255,214,150,1)');
    this.lampHead = new THREE.MeshStandardMaterial({ color: '#f4e6c8', emissive: '#ffd59a', emissiveIntensity: 0.15, roughness: 0.4 });
    this.lampGlow = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    this.lampPool = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
    this.street.add(this.lamps);
    // 空の球（内側を描く。霧・深度は使わない。いちばん奥に描く）
    this.domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        zenith: { value: new THREE.Color('#3f7fd6') },
        horizon: { value: new THREE.Color('#bcd3e6') },
        ground: { value: new THREE.Color('#2b2722') },
        sunDir: { value: new THREE.Vector3(0, 1, 0) },
        sunColor: { value: new THREE.Color('#fff1d6') },
        sunGlow: { value: 1 },
        cityColor: { value: new THREE.Color('#ff9a52') },
        cityGlow: { value: 0 },
        milkyDir: { value: new THREE.Vector3(0.35, 0.25, 0.9).normalize() },
        milky: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 zenith; uniform vec3 horizon; uniform vec3 ground;
        uniform vec3 sunDir; uniform vec3 sunColor; uniform float sunGlow;
        uniform vec3 cityColor; uniform float cityGlow;
        uniform vec3 milkyDir; uniform float milky;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.45));
          if (y < 0.0) col = mix(horizon, ground, clamp(-y * 5.0, 0.0, 1.0));
          // 地平線の街明かり（光害）。空の低いところほど明るい
          col += cityColor * cityGlow * pow(1.0 - clamp(abs(y), 0.0, 1.0), 5.0);
          // 天の川（暗い空でだけ。帯の中ほどが少し明るく、まだらに）
          float band = 1.0 - abs(dot(d, milkyDir));
          float clumps = 0.62 + 0.38 * sin(dot(d, vec3(9.0, 4.0, 7.0))) * sin(dot(d, vec3(-3.0, 11.0, 5.0)));
          float mw = (pow(band, 9.0) * 0.6 + pow(band, 30.0) * 0.4) * clamp(clumps, 0.0, 1.0);
          col += vec3(0.55, 0.6, 0.8) * mw * milky * clamp(y * 3.0, 0.0, 1.0);
          float s = max(dot(d, normalize(sunDir)), 0.0);
          col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 14.0) * 0.32) * sunGlow;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const domeMesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 40, 20), this.domeMat);
    domeMesh.renderOrder = -10;
    domeMesh.frustumCulled = false;
    this.dome.add(domeMesh);
    // 星
    this.starMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
      uniforms: { time: { value: 0 }, visible: { value: 0 }, cutoff: { value: 0 }, scale: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float bright; attribute float phase; attribute float speed; attribute vec3 tint;
        uniform float time; uniform float visible; uniform float cutoff; uniform float scale;
        varying float vAlpha; varying vec3 vTint;
        void main() {
          // 星ごとに違う速さ・位相でゆっくり瞬く（2つの波を重ねて不規則に）
          float tw = 0.78 + 0.14 * sin(time * speed + phase) + 0.08 * sin(time * speed * 2.37 + phase * 1.7);
          // 光害が強いと、暗い星から見えなくなる
          float seen = smoothstep(cutoff, cutoff + 0.12, bright);
          vAlpha = visible * seen * tw * (0.45 + 1.1 * bright);
          vTint = tint;
          gl_PointSize = scale * (1.6 + 5.0 * bright * bright);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying vec3 vTint;
        void main() {
          vec2 p = gl_PointCoord - 0.5;
          float r = length(p);
          // 芯は鋭く、まわりはやわらかく光る
          float core = smoothstep(0.22, 0.0, r);
          float halo = smoothstep(0.5, 0.0, r);
          float a = core + halo * halo * 0.45;
          gl_FragColor = vec4(vTint * a * vAlpha * 1.4, min(1.0, a * vAlpha));
        }`,
    });
    this.buildStars();
    // 月（月齢で影の形が変わる円）
    this.moonMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: { phase: { value: 0.5 }, opacity: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float phase; uniform float opacity;
        varying vec2 vUv;
        void main() {
          vec2 p = (vUv - 0.5) * 2.0;
          float r = length(p);
          if (r > 1.0) {
            // 月のまわりのかすかな光
            float halo = smoothstep(1.9, 1.0, r) * 0.18;
            gl_FragColor = vec4(vec3(0.75, 0.82, 1.0) * halo * opacity, halo * opacity);
            return;
          }
          float k = cos(phase * 6.2831853);
          float w = sqrt(max(0.0, 1.0 - p.y * p.y));
          bool lit = phase < 0.5 ? p.x > k * w : p.x < -k * w;
          // 月の模様（暗いところ）
          // 月の海（暗い模様）を、ぼかした円をいくつか重ねて
          float spots = 1.0 - 0.13 * smoothstep(0.42, 0.0, length(p - vec2(-0.25, 0.2))) - 0.1 * smoothstep(0.32, 0.0, length(p - vec2(0.18, 0.32))) - 0.08 * smoothstep(0.28, 0.0, length(p - vec2(0.05, -0.3)));
          vec3 c = lit ? vec3(0.97, 0.95, 0.86) * spots : vec3(0.10, 0.12, 0.18);
          float edge = smoothstep(1.0, 0.94, r);
          gl_FragColor = vec4(c * opacity, edge * opacity);
        }`,
    });
    this.moon = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), this.moonMat);
    this.moon.frustumCulled = false;
    this.dome.add(this.moon);
    // 雲
    if (quality !== 'low') {
      const tex = cloudTexture();
      const r = rng(77);
      for (let i = 0; i < 7; i++) {
        const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.25 });
        const sp = new THREE.Sprite(m);
        const a = r() * Math.PI * 2;
        const el = 0.18 + r() * 0.35;
        sp.position.set(Math.cos(a) * Math.cos(el) * 52, Math.sin(el) * 52, Math.sin(a) * Math.cos(el) * 52);
        const w = 16 + r() * 18;
        sp.scale.set(w, w * 0.38, 1);
        sp.userData.base = sp.position.clone();
        sp.userData.drift = 0.004 + r() * 0.006;
        this.clouds.push(sp);
        this.dome.add(sp);
      }
    }
    // 車のライト（前照灯は白、尾灯は赤。通りの2つの車線を流れる）
    this.carMat = new THREE.PointsMaterial({ size: 0.45, map: glowTex, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
    const lanes = [-7.2, -10.8];
    const n = quality === 'low' ? 2 : 6;
    for (let i = 0; i < n; i++) {
      const lane = lanes[i % 2]!;
      const geo = new THREE.BufferGeometry();
      // 1台 = ライト2つ（左右）。進む向きで色を変える（向かってくる白・遠ざかる赤）
      const toward = i % 2 === 0;
      const c = toward ? [1, 0.96, 0.85] : [1, 0.18, 0.12];
      geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.62, -0.7, 0, 0.62, 0.7], 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute([...c, ...c], 3));
      const mesh = new THREE.Points(geo, this.carMat);
      mesh.position.set(street.x0, 0, lane);
      this.cars.push({ mesh, speed: (toward ? 1 : -1) * (7 + (i % 3) * 2.5), lane, offset: (i * 13.7) % (street.x1 - street.x0) });
      this.street.add(mesh);
    }
    this.street.userData.x0 = street.x0;
    this.street.userData.x1 = street.x1;
  }

  private buildStars(): void {
    if (this.stars) {
      this.dome.remove(this.stars);
      this.stars.geometry.dispose();
    }
    const n = starCount(this.quality);
    const r = rng(20261112);
    const pos = new Float32Array(n * 3);
    const bright = new Float32Array(n);
    const phase = new Float32Array(n);
    const speed = new Float32Array(n);
    const tint = new Float32Array(n * 3);
    // 天の川の帯（傾いた大円）。星の3割強をその近くに置く
    const band = new THREE.Vector3(0.35, 0.25, 0.9).normalize();
    const bu = new THREE.Vector3().crossVectors(band, new THREE.Vector3(0, 1, 0)).normalize();
    const bv = new THREE.Vector3().crossVectors(band, bu).normalize();
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      if (r() < 0.34) {
        const a = r() * Math.PI * 2;
        const off = (r() + r() + r() - 1.5) * 0.12;
        v.copy(bu).multiplyScalar(Math.cos(a)).addScaledVector(bv, Math.sin(a)).addScaledVector(band, off).normalize();
        if (v.y < 0) v.y = -v.y;
      } else {
        // 半球に一様
        const y = r();
        const a = r() * Math.PI * 2;
        const rr = Math.sqrt(1 - y * y);
        v.set(Math.cos(a) * rr, y, Math.sin(a) * rr);
      }
      v.y = Math.max(0.02, v.y);
      v.normalize().multiplyScalar(DOME_RADIUS * 0.95);
      pos.set([v.x, v.y, v.z], i * 3);
      // 暗い星が多く、明るい星は少ない
      bright[i] = Math.pow(r(), 2.6);
      phase[i] = r() * Math.PI * 2;
      speed[i] = 0.6 + r() * 2.4;
      // 星の色: 青白い〜白〜少し黄色い
      const c = r();
      const t = c < 0.25 ? [0.78, 0.86, 1.0] : c < 0.85 ? [1, 1, 1] : [1, 0.9, 0.74];
      tint.set(t, i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('bright', new THREE.BufferAttribute(bright, 1));
    geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    geo.setAttribute('speed', new THREE.BufferAttribute(speed, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -9;
    this.dome.add(this.stars);
  }

  /**
   * 通りの街灯を地域に合わせて置き直す（都会ほど多く・田舎はわずか）。front: 店の前の歩道の z、far: 通りの向こうの歩道の z。
   * x0〜x1: 通りの範囲
   */
  setStreet(kind: string, x0: number, x1: number, front = -4.25, far = -13.75): void {
    const key = `${kind}:${x0}:${x1}`;
    if (key === this.lampKey) return;
    this.lampKey = key;
    for (const c of [...this.lamps.children]) {
      this.lamps.remove(c);
      if (c instanceof THREE.Mesh) c.geometry.dispose();
    }
    const gap: Record<string, number> = { metro: 7, station: 8, town: 9, residential: 11, suburb: 14, rural: 26 };
    const step = gap[kind] ?? 10;
    const bothSides = kind === 'metro' || kind === 'station' || kind === 'town';
    const poleMat = new THREE.MeshStandardMaterial({ color: '#4a4d50', roughness: 0.6, metalness: 0.4 });
    const pole = new THREE.CylinderGeometry(0.06, 0.08, 4.6, 8);
    const arm = new THREE.BoxGeometry(0.9, 0.06, 0.06);
    const head = new THREE.BoxGeometry(0.42, 0.12, 0.26);
    const pool = new THREE.CircleGeometry(2.6, 20);
    const place = (x: number, z: number, toward: number) => {
      const p = new THREE.Mesh(pole, poleMat);
      p.position.set(x, 2.3, z);
      const a = new THREE.Mesh(arm, poleMat);
      a.position.set(x, 4.55, z + toward * 0.4);
      a.rotation.y = Math.PI / 2;
      const h = new THREE.Mesh(head, this.lampHead);
      h.position.set(x, 4.48, z + toward * 0.8);
      const g = new THREE.Sprite(this.lampGlow);
      g.position.copy(h.position);
      g.scale.set(2.4, 2.4, 1);
      const pl = new THREE.Mesh(pool, this.lampPool);
      pl.rotation.x = -Math.PI / 2;
      pl.position.set(x, 0.02, z + toward * 0.8);
      this.lamps.add(p, a, h, g, pl);
    };
    for (let x = x0 + step / 2; x < x1; x += step) {
      place(x, front, -1);
      if (bothSides) place(x + step / 2, far, 1);
    }
    this.street.userData.x0 = x0;
    this.street.userData.x1 = x1;
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.buildStars();
    for (const c of this.clouds) c.visible = q !== 'low';
  }

  /** 1フレーム分。camera: 空の球をカメラに付ける。pixelRatio: 星の大きさを画面に合わせる */
  update(sky: SkyState, dt: number, time: number, camera: THREE.Camera, pixelRatio: number): SkyLighting {
    this.dome.position.copy(camera.position);
    this.dome.updateMatrixWorld();
    // 表示の時刻を目標へ近づける（大きく変わったときも数秒で追いつく。近い道で回る）
    if (this.shownMinute === null) this.shownMinute = sky.minute;
    let diff = sky.minute - this.shownMinute;
    if (diff > 720) diff -= 1440;
    if (diff < -720) diff += 1440;
    const rate = Math.max(Math.abs(diff) * 1.4, 40);
    const stepMin = Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);
    this.shownMinute = (((this.shownMinute + stepMin) % 1440) + 1440) % 1440;
    const minute = this.shownMinute;
    const night = nightness(minute);
    const lp = sky.lightPollution;
    const { a, b, k } = keyAt(minute);
    const u = this.domeMat.uniforms;
    const zen = lerpColor(a.zenith, b.zenith, k, u.zenith!.value as THREE.Color);
    const hor = lerpColor(a.horizon, b.horizon, k, u.horizon!.value as THREE.Color);
    // 光害: 夜の空を明るく・赤っぽく（都会の空は星が少なく、地平線が光る）
    zen.lerp(C.cityTone, night * lp * 0.32);
    hor.lerp(C.cityHorizon, night * lp * 0.55);
    u.cityGlow!.value = night * Math.pow(lp, 1.5) * 0.6;
    // 天の川: 暗い空でだけ（光害で見えなくなる。満月の夜は薄い）
    u.milky!.value = night * Math.pow(1 - lp, 3) * (1 - 0.6 * moonIllumination(sky.moonPhase)) * 0.26;
    const ground = u.ground!.value as THREE.Color;
    ground.copy(hor).multiplyScalar(0.35);
    // 太陽の向きと光
    const prog = dayProgress(minute);
    const h = sunHeight(minute);
    const sunDir = arcDir(prog <= 1 ? prog : prog - 1, h, u.sunDir!.value as THREE.Vector3);
    if (prog > 1) sunDir.y = h; // 夜は地平線の下
    sunDir.normalize();
    lerpColor(a.sun, b.sun, k, u.sunColor!.value as THREE.Color);
    u.sunGlow!.value = Math.max(0, Math.min(1, (h + 0.08) / 0.2));
    // 月: 月の出は月齢で遅れる（満月は夕方に昇り、真夜中に南）
    const moonMinute = minute - sky.moonPhase * 1440;
    const mh = sunHeight(moonMinute);
    const mprog = dayProgress(moonMinute);
    const moonDir = arcDir(mprog <= 1 ? mprog : mprog - 1, mh, moonDirTmp);
    if (mprog > 1) moonDir.y = mh;
    moonDir.normalize();
    this.moon.position.copy(moonDir).multiplyScalar(DOME_RADIUS * 0.9);
    this.moon.updateMatrixWorld();
    this.moon.lookAt(camera.position);
    const moonUp = Math.max(0, Math.min(1, (mh + 0.02) / 0.1));
    const moonLight = moonIllumination(sky.moonPhase);
    this.moonMat.uniforms.phase!.value = sky.moonPhase;
    // 昼の月は薄く、夜ははっきり（新月は見えない）
    this.moonMat.uniforms.opacity!.value = moonUp * (0.25 + 0.75 * night) * Math.min(1, moonLight * 6);
    // 星: 夜だけ。光害で減る（都会でも少しは見える）
    const starsVisible = night * (1 - 0.72 * lp);
    this.starMat.uniforms.visible!.value = starsVisible;
    this.starMat.uniforms.cutoff!.value = lp * 0.55;
    this.starMat.uniforms.time!.value = time;
    this.starMat.uniforms.scale!.value = Math.max(1, pixelRatio);
    if (this.stars) this.stars.visible = starsVisible > 0.01;
    // 雲: 空の色に合わせ、ゆっくり流れる
    for (const c of this.clouds) {
      const base = c.userData.base as THREE.Vector3;
      const ang = time * (c.userData.drift as number);
      c.position.set(base.x * Math.cos(ang) - base.z * Math.sin(ang), base.y, base.x * Math.sin(ang) + base.z * Math.cos(ang));
      const m = c.material;
      m.color.copy(hor).lerp(C.white, 0.6 * (1 - night));
      m.opacity = 0.32 * (1 - night) + 0.12 * night;
    }
    // 車のライト（夜・光害が強いほど多い。田舎はほとんど走らない）
    const x0 = this.street.userData.x0 as number;
    const x1 = this.street.userData.x1 as number;
    const span = x1 - x0;
    const carsOn = Math.round(this.cars.length * Math.min(1, lp * 1.3));
    this.carMat.opacity = night * 0.95;
    this.cars.forEach((c, i) => {
      c.mesh.visible = night > 0.05 && i < carsOn;
      if (!c.mesh.visible) return;
      const x = (((c.offset + time * c.speed) % span) + span) % span;
      c.mesh.position.x = c.speed > 0 ? x0 + x : x1 - x;
    });
    // 街灯: 夜に灯る（昼は消えている）
    this.lampHead.emissiveIntensity = 0.12 + 2.6 * night;
    this.lampGlow.opacity = night * 0.85;
    this.lampPool.opacity = night * 0.32;
    // 世界の明かり
    const o = this.out;
    lerpColor(a.hemiSky, b.hemiSky, k, o.hemiSky);
    lerpColor(a.hemiGround, b.hemiGround, k, o.hemiGround);
    // 夜の街明かり（光害）は地面を少し暖かく照らし、月明かりは青白く照らす（田舎でも真っ暗にしない）
    o.hemiSky.lerp(C.cityWarm, night * lp * 0.25);
    // 都会の夜は、街明かりが通りや建物の壁を下から照らす（建物の輪郭が見える）
    o.hemiGround.lerp(C.cityGround, night * lp * 0.7);
    o.hemiIntensity = a.hemi + (b.hemi - a.hemi) * k + night * (0.08 * moonLight + 0.7 * lp * lp);
    o.sunColor.copy(u.sunColor!.value as THREE.Color);
    // 夜の平行光は月明かり
    const sunI = a.sunI + (b.sunI - a.sunI) * k;
    if (h > -0.02) {
      o.sunIntensity = sunI;
      o.lightDir.copy(sunDir);
    } else {
      o.sunColor.set('#9fb4ff');
      o.sunIntensity = 0.32 * moonLight * moonUp;
      o.lightDir.copy(moonDir);
    }
    if (o.lightDir.y < 0.15) o.lightDir.y = 0.15;
    o.lightDir.normalize();
    // 霧: 地平線の色。都会の夜は街明かりで霞が明るい（遠くの建物も暗く沈みすぎない）
    o.fog.copy(hor).lerp(C.cityHaze, night * lp * 0.7);
    o.night = night;
    o.lightPollution = lp;
    this.last = { minute, night, starsVisible, lightPollution: lp, moonLight };
    return o;
  }

  dispose(): void {
    this.lampHead.dispose();
    this.lampGlow.map?.dispose();
    this.lampGlow.dispose();
    this.lampPool.dispose();
    this.stars?.geometry.dispose();
    this.starMat.dispose();
    this.domeMat.dispose();
    this.moonMat.dispose();
    this.carMat.dispose();
    for (const c of this.cars) c.mesh.geometry.dispose();
    for (const c of this.clouds) {
      c.material.map?.dispose();
      c.material.dispose();
    }
  }
}

/** 中心が明るく外へ消える円（街灯の光・光の輪） */
function radialTexture(color: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, color);
    grd.addColorStop(0.35, color.replace(/[\d.]+\)$/, '0.35)'));
    grd.addColorStop(1, color.replace(/[\d.]+\)$/, '0)'));
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 雲の形（ぼかした円を重ねた白） */
function cloudTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const r = rng(9);
    for (let i = 0; i < 14; i++) {
      const x = 20 + r() * 88;
      const y = 22 + r() * 22;
      const rad = 10 + r() * 16;
      const grd = g.createRadialGradient(x, y, 0, x, y, rad);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, rad, 0, Math.PI * 2);
      g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
