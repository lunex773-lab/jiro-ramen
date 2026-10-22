// 演出用の軽量エフェクト: 湯気・煙（頂点シェーダーで動かす板ポリ）、進捗リング/バー（ビルボード）、状態ランプ。
// 時間はグローバルな uniform を1つだけ持ち、tickModels(t) で更新する（毎フレームの確保なし）。

import * as THREE from 'three';
import { cached, makeRng, rr, GeoBuilder } from './common';
import { MAT, plastic } from './materials';
import { texWisp } from './textures';

/** 全エフェクト共有の時間 uniform */
export const FX_TIME = { value: 0 };

export function tickFx(t: number): void {
  FX_TIME.value = t;
}

// ───────────────────────── 湯気 ─────────────────────────

const STEAM_VS = /* glsl */ `
attribute vec4 aPuff;
uniform float uTime;
uniform float uRise;
uniform float uSpeed;
uniform float uSpread;
varying float vAlpha;
varying vec2 vUv;
void main() {
  float life = fract(uTime * uSpeed + aPuff.z);
  float sway = sin(life * 4.0 + aPuff.z * 31.0) * uSpread;
  float grow = 1.0 + life * 0.8;
  vec3 c = vec3(aPuff.x * grow + sway, life * uRise, aPuff.y * grow + cos(life * 3.0 + aPuff.z * 17.0) * uSpread * 0.6);
  vec4 mv = modelViewMatrix * vec4(c, 1.0);
  float sc = length(modelMatrix[0].xyz);
  float s = aPuff.w * (0.4 + life * 1.3) * sc;
  float rot = aPuff.z * 6.2831 + life * 1.5;
  vec2 p = vec2(position.x * cos(rot) - position.y * sin(rot), position.x * sin(rot) + position.y * cos(rot));
  mv.xy += p * s;
  gl_Position = projectionMatrix * mv;
  vAlpha = smoothstep(0.0, 0.18, life) * (1.0 - smoothstep(0.45, 1.0, life));
  vUv = uv;
}`;

const STEAM_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
varying vec2 vUv;
void main() {
  float a = texture2D(uMap, vUv).a * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SteamOpts {
  /** 板の枚数 */
  count: number;
  /** 発生範囲の半径(m) */
  radius: number;
  /** 上昇する高さ(m) */
  rise: number;
  /** 板の大きさ(m) */
  size: number;
  /** 1秒あたりの周期数 */
  speed?: number;
  spread?: number;
  color?: string;
  opacity?: number;
  seed?: number;
}

function steamGeometry(count: number, radius: number, size: number, seed: number): THREE.BufferGeometry {
  return cached(`steamgeo:${count}:${radius}:${size}:${seed}`, () => {
    const r = makeRng(seed);
    const pos: number[] = [];
    const uv: number[] = [];
    const puff: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * radius;
      const px = Math.cos(a) * d;
      const pz = Math.sin(a) * d;
      const ph = i / count + rr(r, -0.3, 0.3) / count;
      const sz = size * rr(r, 0.7, 1.3);
      const b = i * 4;
      pos.push(-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0);
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      for (let k = 0; k < 4; k++) puff.push(px, pz, ph, sz);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aPuff', new THREE.Float32BufferAttribute(puff, 4));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.5, 0), 2.5);
    return g;
  });
}

function steamMaterial(rise: number, speed: number, spread: number, color: string, opacity: number): THREE.ShaderMaterial {
  return cached(`steammat:${rise}:${speed}:${spread}:${color}:${opacity}`, () =>
    new THREE.ShaderMaterial({
      uniforms: {
        uTime: FX_TIME,
        uRise: { value: rise },
        uSpeed: { value: speed },
        uSpread: { value: spread },
        uMap: { value: texWisp() },
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity },
      },
      vertexShader: STEAM_VS,
      fragmentShader: STEAM_FS,
      transparent: true,
      depthWrite: false,
    }),
  );
}

/** 湯気（または煙）のメッシュ。ジオメトリとマテリアルは共有、Mesh だけ個別 */
export function createSteam(o: SteamOpts): THREE.Mesh {
  const geo = steamGeometry(o.count, o.radius, o.size, o.seed ?? 1);
  const mat = steamMaterial(o.rise, o.speed ?? 0.35, o.spread ?? 0.02, o.color ?? '#ffffff', o.opacity ?? 0.6);
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 5;
  m.castShadow = false;
  m.receiveShadow = false;
  m.frustumCulled = true;
  return m;
}

// ───────────────────────── 進捗リング/バー ─────────────────────────

const IND_VS = /* glsl */ `
uniform vec2 uSize;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
}`;

const IND_FS = /* glsl */ `
uniform float uProgress;
uniform vec3 uColor;
uniform float uMode;
varying vec2 vUv;
void main() {
  vec4 col;
  if (uMode < 0.5) {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.x, p.y);
    a = a < 0.0 ? a + 6.2831853 : a;
    float f = a / 6.2831853;
    float ring = smoothstep(0.50, 0.55, r) * (1.0 - smoothstep(0.90, 0.95, r));
    float edge = smoothstep(0.42, 0.47, r) * (1.0 - smoothstep(0.97, 1.0, r));
    vec3 c = f <= uProgress ? uColor : vec3(0.16);
    float inner = 1.0 - smoothstep(0.24, 0.3, r);
    vec3 outc = mix(vec3(0.03), c, ring);
    outc = mix(outc, uColor, inner);
    float alpha = max(max(ring, edge * 0.75), inner * 0.95);
    col = vec4(outc, alpha);
  } else {
    vec2 p = vUv;
    float inside = step(0.18, p.y) * step(p.y, 0.82) * step(0.03, p.x) * step(p.x, 0.97);
    float f = (p.x - 0.03) / 0.94;
    vec3 c = f <= uProgress ? uColor : vec3(0.16);
    col = vec4(mix(vec3(0.03), c, inside), 0.92);
  }
  if (col.a < 0.01) discard;
  gl_FragColor = col;
  #include <colorspace_fragment>
}`;

function indicatorGeometry(): THREE.BufferGeometry {
  return cached('indgeo', () => new THREE.PlaneGeometry(1, 1));
}

export interface Indicator {
  mesh: THREE.Mesh;
  set(progress: number, color: THREE.Color): void;
  dispose(): void;
}

/** カメラの方を向く進捗表示。mode: ring=リング, bar=横バー */
export function createIndicator(mode: 'ring' | 'bar', size: number): Indicator {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color('#3ddc5c') },
      uMode: { value: mode === 'ring' ? 0 : 1 },
      uSize: { value: new THREE.Vector2(mode === 'ring' ? size : size, mode === 'ring' ? size : size * 0.22) },
    },
    vertexShader: IND_VS,
    fragmentShader: IND_FS,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(indicatorGeometry(), mat);
  mesh.renderOrder = 20;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const uP = mat.uniforms.uProgress!;
  const uC = mat.uniforms.uColor!;
  return {
    mesh,
    set(progress, color) {
      uP.value = progress;
      (uC.value as THREE.Color).copy(color);
    },
    dispose() {
      mat.dispose();
    },
  };
}

export const IND_COLORS = {
  blue: new THREE.Color('#3aa0ff'),
  green: new THREE.Color('#3ddc5c'),
  yellow: new THREE.Color('#ffd23a'),
  red: new THREE.Color('#ff3b30'),
  orange: new THREE.Color('#ff8a1e'),
  white: new THREE.Color('#f2f2f2'),
};

// ───────────────────────── 状態ランプ・修理中の小物 ─────────────────────────

export interface StatusFx {
  group: THREE.Group;
  update(status: string, t: number): void;
  dispose(): void;
}

function lampGeometry(): THREE.BufferGeometry {
  return cached('lampgeo', () => {
    const g = new THREE.SphereGeometry(0.035, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    return g;
  });
}

function lampBaseParts(): { geo: THREE.BufferGeometry; mat: THREE.Material }[] {
  return cached('lampbase', () => {
    const b = new GeoBuilder();
    b.cyl(MAT.black(), 0.04, 0.045, 0.03, 12, {});
    b.cyl(MAT.steelDark(), 0.008, 0.008, 0.06, 6, { y: -0.06 });
    return b.merged();
  });
}

function repairParts(): { geo: THREE.BufferGeometry; mat: THREE.Material }[] {
  return cached('repairparts', () => {
    const b = new GeoBuilder();
    // 赤い工具箱
    const red = plastic('#c62828', 0.45);
    b.box(red, 0.36, 0.14, 0.18, { y: 0.07 });
    b.box(MAT.steelDark(), 0.2, 0.012, 0.02, { y: 0.19 });
    b.box(MAT.steelDark(), 0.012, 0.05, 0.02, { x: -0.1, y: 0.165 });
    b.box(MAT.steelDark(), 0.012, 0.05, 0.02, { x: 0.1, y: 0.165 });
    // オレンジのコーン
    const orange = plastic('#ff6d00', 0.5);
    b.box(MAT.black(), 0.3, 0.03, 0.3, { x: 0.42, y: 0.015 });
    b.cyl(orange, 0.025, 0.12, 0.5, 12, { x: 0.42, y: 0.03 });
    b.cyl(plastic('#f5f5f5', 0.5), 0.07, 0.085, 0.08, 12, { x: 0.42, y: 0.22 });
    return b.merged();
  });
}

/**
 * 設備の状態表示: faulty=黄色点滅, broken=赤点滅＋時々煙, repairing=工具箱とコーン。
 * lampPos はランプの位置、frontZ は工具を置く手前の z。
 */
export function createStatusFx(lampPos: THREE.Vector3, frontZ: number, halfW: number): StatusFx {
  const group = new THREE.Group();
  const base = new THREE.Group();
  for (const { geo, mat } of lampBaseParts()) base.add(new THREE.Mesh(geo, mat));
  const lamp = new THREE.Mesh(lampGeometry(), MAT.lampOff());
  lamp.position.y = 0.03;
  base.add(lamp);
  base.position.copy(lampPos);
  group.add(base);
  const smoke = createSteam({ count: 6, radius: 0.08, rise: 0.9, size: 0.3, speed: 0.4, spread: 0.05, color: '#3d3d3d', opacity: 0.7, seed: 99 });
  smoke.position.set(lampPos.x * 0.3, lampPos.y - 0.05, lampPos.z * 0.3);
  group.add(smoke);
  const repair = new THREE.Group();
  for (const { geo, mat } of repairParts()) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    repair.add(m);
  }
  repair.position.set(-halfW + 0.15, 0, frontZ - 0.25);
  group.add(repair);
  base.visible = false;
  smoke.visible = false;
  repair.visible = false;
  return {
    group,
    update(status, t) {
      const faulty = status === 'faulty';
      const broken = status === 'broken';
      base.visible = faulty || broken;
      repair.visible = status === 'repairing';
      if (faulty || broken) {
        const on = Math.sin(t * (broken ? 9 : 5)) > 0;
        lamp.material = on ? (broken ? MAT.lampRed() : MAT.lampAmber()) : MAT.lampOff();
      }
      smoke.visible = broken && t % 7 < 3.2;
    },
    dispose() {
      // 共有物のみなので解放不要
    },
  };
}
