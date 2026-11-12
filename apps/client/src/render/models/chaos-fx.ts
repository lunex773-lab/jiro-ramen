// 珍客イベントの3D（じろ7 6-5）: UFO（円盤・ドーム・回る光・光の柱）と、金色覚醒のオーラ（炎のように揺れる金色の光・火の粉）。
// どちらもオリジナルの形。毎フレームの確保はしない（時間は uniform で動かす）。

import * as THREE from 'three';
import { cached, type Disposable } from './common';

// ───────────────────────── UFO ─────────────────────────

export type UfoPhase = 'descend' | 'landed' | 'ascend';

export interface UfoModel extends Disposable {
  group: THREE.Group;
  /** phase の経過秒 pt・全体の時刻 time で、高さ・回転・光を更新する */
  update(phase: UfoPhase, pt: number, time: number): void;
}

/** 着陸中に浮いている高さ（道路の上 m） */
const HOVER_Y = 2.7;
const START_Y = 34;

const BEAM_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BEAM_FS = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
varying vec2 vUv;
void main() {
  // 下ほど広がって薄くなる光。縦に流れる縞
  float stripe = 0.75 + 0.25 * sin(vUv.y * 40.0 - uTime * 6.0 + vUv.x * 18.0);
  float a = uAlpha * (0.25 + 0.75 * vUv.y) * stripe;
  gl_FragColor = vec4(0.62, 1.0, 0.86, a * 0.42);
}`;

export function createUfo(): UfoModel {
  const group = new THREE.Group();
  group.name = 'ufo';
  const owned: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    owned.push(x);
    return x;
  };
  // 金属は周りの景色を映さないと暗く見えるので、少しだけ自分で光らせる
  const metal = own(new THREE.MeshStandardMaterial({ color: '#b9c2cc', metalness: 0.6, roughness: 0.32, emissive: '#3a4654', emissiveIntensity: 0.6 }));
  const dark = own(new THREE.MeshStandardMaterial({ color: '#4a5260', metalness: 0.7, roughness: 0.4 }));
  const glass = own(new THREE.MeshStandardMaterial({ color: '#7fe3ff', metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.55, emissive: '#2a8aa8', emissiveIntensity: 0.6 }));

  // 円盤（回転体）: 上下に膨らんだ薄い円盤
  const pts: THREE.Vector2[] = [];
  const R = 2.6;
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI;
    pts.push(new THREE.Vector2(Math.max(0.001, Math.sin(a) * R), -Math.cos(a) * 0.42 + (a > Math.PI / 2 ? 0.05 : 0)));
  }
  const disc = new THREE.Mesh(own(new THREE.LatheGeometry(pts, 40)), metal);
  disc.scale.set(1, 1, 1);
  disc.castShadow = true;
  group.add(disc);
  // 縁の帯
  const rim = new THREE.Mesh(own(new THREE.TorusGeometry(R * 0.98, 0.09, 6, 48)), dark);
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  // 上のドーム
  const dome = new THREE.Mesh(own(new THREE.SphereGeometry(1.05, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2)), glass);
  dome.position.y = 0.3;
  group.add(dome);
  // 下の光る輪
  const bottomMat = own(new THREE.MeshBasicMaterial({ color: '#9effd8', transparent: true, opacity: 0.85 }));
  const bottom = new THREE.Mesh(own(new THREE.CircleGeometry(0.85, 28)), bottomMat);
  bottom.rotation.x = Math.PI / 2;
  bottom.position.y = -0.43;
  group.add(bottom);
  // 縁の回る光（色が順に変わる）
  const N = 14;
  const lights: THREE.Mesh[] = [];
  const lightGeo = own(new THREE.SphereGeometry(0.11, 8, 6));
  const ring = new THREE.Group();
  for (let i = 0; i < N; i++) {
    const m = own(new THREE.MeshBasicMaterial({ color: '#ffffff' }));
    const l = new THREE.Mesh(lightGeo, m);
    const a = (i / N) * Math.PI * 2;
    l.position.set(Math.cos(a) * R * 0.86, -0.12, Math.sin(a) * R * 0.86);
    ring.add(l);
    lights.push(l);
  }
  group.add(ring);
  // 光の柱（下へ広がる円錐）
  const beamMat = own(
    new THREE.ShaderMaterial({
      vertexShader: BEAM_VS,
      fragmentShader: BEAM_FS,
      uniforms: { uTime: { value: 0 }, uAlpha: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  const beamGeo = own(new THREE.CylinderGeometry(0.7, 2.1, 1, 28, 1, true));
  beamGeo.translate(0, -0.5, 0);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = -0.4;
  beam.renderOrder = 5;
  group.add(beam);
  // 地面に落ちる光の輪（ライトを足すと全部のマテリアルが作り直しになるので、光る板で表す）
  const spotMat = own(new THREE.MeshBasicMaterial({ color: '#9effd8', transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, map: groundGlowTex() }));
  const spot = new THREE.Mesh(own(new THREE.PlaneGeometry(5, 5)), spotMat);
  spot.rotation.x = -Math.PI / 2;
  spot.renderOrder = 4;
  group.add(spot);

  const col = new THREE.Color();
  return {
    group,
    update(phase, pt, time) {
      let y = HOVER_Y;
      let beamA = 0;
      let tilt = 0;
      if (phase === 'descend') {
        // 空からゆっくり降りてくる（最後に減速）
        const k = Math.min(1, pt / 3.5);
        const e = 1 - (1 - k) ** 3;
        y = START_Y + (HOVER_Y - START_Y) * e;
        beamA = Math.min(1, pt / 1.5);
        tilt = Math.sin(time * 1.7) * 0.12 * (1 - k);
      } else if (phase === 'landed') {
        y = HOVER_Y + Math.sin(time * 1.4) * 0.12;
        beamA = Math.max(0.25, 1 - pt / 6);
        tilt = Math.sin(time * 0.9) * 0.03;
      } else {
        // 少し止まってから、加速して空へ
        const k = Math.max(0, pt - 0.6);
        y = HOVER_Y + k * k * 4.5;
        beamA = Math.max(0, 1 - pt / 0.8);
        tilt = Math.min(0.25, k * 0.1);
      }
      group.position.y = y;
      group.rotation.z = tilt;
      ring.rotation.y = time * 1.6;
      dome.rotation.y = -time * 0.4;
      beamMat.uniforms.uTime!.value = time;
      beamMat.uniforms.uAlpha!.value = beamA;
      beam.scale.set(1, Math.max(0.1, y - 0.3), 1);
      beam.visible = beamA > 0.01;
      // 光の輪は地面（group の下 y）に置く
      spot.position.y = -y + 0.03;
      spotMat.opacity = 0.55 * beamA * Math.min(1, 12 / Math.max(1, y));
      bottomMat.opacity = 0.6 + 0.3 * Math.sin(time * 5);
      for (let i = 0; i < lights.length; i++) {
        const h = (i / lights.length + time * 0.35) % 1;
        col.setHSL(h, 0.9, 0.62);
        (lights[i]!.material as THREE.MeshBasicMaterial).color.copy(col);
      }
    },
    dispose() {
      for (const o of owned) o.dispose();
      group.removeFromParent();
    },
  };
}

/** 地面の光の輪（中心が明るく外へ薄くなる丸） */
function groundGlowTex(): THREE.Texture {
  return cached('chaos:groundGlow', () => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  });
}

// ───────────────────────── 金色覚醒のオーラ ─────────────────────────

const AURA_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const AURA_FS = /* glsl */ `
uniform float uTime;
uniform float uPower;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  // 縁ほど明るく（ふちの光）、上へ燃え上がる炎の筋
  float rim = pow(1.0 - abs(dot(vN, vV)), 1.6);
  float flame = 0.55 + 0.45 * sin(vUv.x * 37.0 + uTime * 9.0 + sin(vUv.y * 9.0 - uTime * 7.0) * 2.0);
  float up = smoothstep(0.0, 0.18, vUv.y) * (1.0 - smoothstep(0.62, 1.0, vUv.y));
  float a = uPower * up * (0.35 * rim + 0.18) * flame;
  vec3 c = mix(vec3(1.0, 0.72, 0.12), vec3(1.0, 0.96, 0.55), flame);
  gl_FragColor = vec4(c, a);
}`;

export interface AuraModel extends Disposable {
  group: THREE.Group;
  /** power 0..1（出始め・消えるときに弱く） */
  update(time: number, power: number): void;
}

export function createAura(height = 1.85): AuraModel {
  const group = new THREE.Group();
  group.name = 'aura';
  const mat = new THREE.ShaderMaterial({
    vertexShader: AURA_VS,
    fragmentShader: AURA_FS,
    uniforms: { uTime: { value: 0 }, uPower: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const geo = cached('chaos:auraGeo', () => {
    // 下がすぼまり、上が炎のように細くなる回転体
    const pts: THREE.Vector2[] = [];
    for (let i = 0; i <= 14; i++) {
      const v = i / 14;
      const r = 0.12 + Math.sin(Math.min(1, v * 1.25) * Math.PI) * 0.5 * (1 - v * 0.35);
      pts.push(new THREE.Vector2(Math.max(0.02, r), v));
    }
    return new THREE.LatheGeometry(pts, 24);
  });
  const shell = new THREE.Mesh(geo, mat);
  shell.scale.set(1, height * 1.25, 1);
  shell.position.y = -0.05;
  shell.renderOrder = 6;
  group.add(shell);
  // 立ちのぼる火の粉
  const SP = 26;
  const sparkPos = new Float32Array(SP * 3);
  const seeds: number[] = [];
  for (let i = 0; i < SP; i++) seeds.push(Math.random());
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  // 丸くぼやけた光の粒（地面の光の輪と同じ絵）
  const sparkMat = new THREE.PointsMaterial({ color: '#ffe27a', size: 0.09, map: groundGlowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const sparks = new THREE.Points(sparkGeo, sparkMat);
  sparks.frustumCulled = false;
  group.add(sparks);
  return {
    group,
    update(time, power) {
      mat.uniforms.uTime!.value = time;
      mat.uniforms.uPower!.value = power * (0.85 + 0.15 * Math.sin(time * 13));
      group.visible = power > 0.01;
      sparkMat.opacity = power;
      for (let i = 0; i < SP; i++) {
        const sd = seeds[i]!;
        const life = (time * (0.5 + sd * 0.5) + sd * 7) % 1;
        const a = sd * 40 + time * (1 + sd);
        const r = 0.25 + 0.25 * sd;
        sparkPos[i * 3] = Math.cos(a) * r;
        sparkPos[i * 3 + 1] = life * height * 1.3;
        sparkPos[i * 3 + 2] = Math.sin(a) * r;
      }
      sparkGeo.attributes.position!.needsUpdate = true;
    },
    dispose() {
      mat.dispose();
      sparkGeo.dispose();
      sparkMat.dispose();
      group.removeFromParent();
    },
  };
}
