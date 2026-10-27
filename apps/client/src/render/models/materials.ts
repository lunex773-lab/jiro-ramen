// 共有マテリアル。モデル間で同じものを使い回し、プログラム切り替えとメモリを抑える。
// 金属は環境マップがないと黒く沈むので、createEnvMap()（index.ts）で scene.environment を設定すること。

import * as THREE from 'three';
import { cached, setVcMaterialHook } from './common';
import {
  texCeramic,
  texCounterWood,
  texKitchenFloor,
  texLightWood,
  texPlaster,
  texSteel,
  texWallTile,
  texWoodFloor,
  texSidewalk,
  texAsphalt,
  texEnv,
} from './textures';

function std(key: string, p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return cached('mat:' + key, () => new THREE.MeshStandardMaterial(p));
}

/** 反射環境つき（金属・陶器・濡れた面） */
function refl(key: string, p: THREE.MeshStandardMaterialParameters, intensity = 1): THREE.MeshStandardMaterial {
  return cached('mat:' + key, () => new THREE.MeshStandardMaterial({ envMap: texEnv(), envMapIntensity: intensity, ...p }));
}

function basic(key: string, p: THREE.MeshBasicMaterialParameters): THREE.MeshBasicMaterial {
  return cached('matb:' + key, () => new THREE.MeshBasicMaterial(p));
}

/**
 * 単色プラスチック（色ごとにキャッシュ）。
 * GeoBuilder で結合するときは頂点カラーの共有マテリアルにまとめられる（draw call 削減）。
 */
export function plastic(color: string, roughness = 0.5): THREE.MeshStandardMaterial {
  return cached(`mat:plastic:${color}:${roughness}`, () => {
    const m = new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 });
    m.userData.vc = { color, roughness };
    return m;
  });
}

/** 頂点カラーで色を持つ共有マテリアル（つや 3 段階） */
export function vcMaterial(roughness: number): THREE.MeshStandardMaterial {
  const k = roughness < 0.45 ? 0.32 : roughness < 0.75 ? 0.55 : 0.88;
  return cached(`mat:vc:${k}`, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: k, metalness: 0 }));
}

/** 単色の発光体 */
export function glow(color: string, intensity = 1.6): THREE.MeshStandardMaterial {
  return std(`glow:${color}:${intensity}`, { color: '#111111', emissive: color, emissiveIntensity: intensity, roughness: 0.4 });
}

setVcMaterialHook(vcMaterial);

/** ステンレス系をまとめる頂点カラー版 */
function steelFamily(): THREE.MeshStandardMaterial {
  return cached('mat:steelFamily', () =>
    new THREE.MeshStandardMaterial({ color: '#c4c9ce', map: texSteel(), metalness: 0.72, roughness: 0.38, envMap: texEnv(), vertexColors: true }),
  );
}

export const MAT = {
  /** ヘアラインのステンレス（厨房機器の外装） */
  steel: () =>
    cached('mat:steel', () => {
      const m = new THREE.MeshStandardMaterial({ color: '#c4c9ce', map: texSteel(), metalness: 0.72, roughness: 0.36, envMap: texEnv() });
      m.userData.family = { base: steelFamily(), tint: '#ffffff' };
      return m;
    }),
  /** 磨いたステンレス（寸胴・てぼ・レードル） */
  steelPolished: () => refl('steelPol', { color: '#d9dde0', map: texSteel(), metalness: 0.85, roughness: 0.22 }),
  /** 少し暗いステンレス（天板の縁・脚）。結合時は steel と同じマテリアルに頂点カラーの濃淡でまとめる */
  steelDark: () =>
    cached('mat:steelDark', () => {
      const m = new THREE.MeshStandardMaterial({ color: '#8e9499', map: texSteel(), metalness: 0.7, roughness: 0.42, envMap: texEnv() });
      m.userData.family = { base: steelFamily(), tint: '#b4b8bc' };
      return m;
    }),
  /** 鋳物（五徳・バーナー） */
  castIron: () => refl('castIron', { color: '#2a2a2b', metalness: 0.45, roughness: 0.65 }),
  rubber: () => plastic('#1c1c1e', 0.9),
  ceramic: () => refl('ceramic', { color: '#ffffff', map: texCeramic(), metalness: 0, roughness: 0.16 }, 0.45),
  woodCounter: () => std('woodCounter', { color: '#ffffff', map: texCounterWood(), metalness: 0, roughness: 0.42 }),
  woodLight: () => std('woodLight', { color: '#ffffff', map: texLightWood(), metalness: 0, roughness: 0.5 }),
  woodDark: () => std('woodDark', { color: '#5b3c25', metalness: 0, roughness: 0.7 }),
  woodFloor: () => std('woodFloor', { color: '#ffffff', map: texWoodFloor(), metalness: 0, roughness: 0.62 }),
  kitchenFloor: () => std('kitchenFloor', { color: '#ffffff', map: texKitchenFloor(), metalness: 0, roughness: 0.82 }),
  wallTile: () => std('wallTile', { color: '#ffffff', map: texWallTile(), metalness: 0, roughness: 0.25 }),
  plaster: () => std('plaster', { color: '#ffffff', map: texPlaster(), metalness: 0, roughness: 0.92 }),
  sidewalk: () => std('sidewalk', { color: '#ffffff', map: texSidewalk(), metalness: 0, roughness: 0.95 }),
  asphalt: () => std('asphalt', { color: '#ffffff', map: texAsphalt(), metalness: 0, roughness: 0.95 }),
  glass: () =>
    refl('glass', {
      color: '#a9c3cf',
      metalness: 0.1,
      roughness: 0.06,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  /** 天井の照明パネル */
  lightPanel: () => basic('lightPanel', { color: '#fff8ea' }),
  lampOff: () => std('lampOff', { color: '#3a3330', metalness: 0, roughness: 0.3 }),
  lampAmber: () => glow('#ffa21a', 3),
  lampRed: () => glow('#ff2a1a', 3),
  lampGreen: () => glow('#38ff6a', 2.2),
  black: () => plastic('#141414', 0.6),
  darkPanel: () => refl('darkPanel', { color: '#202326', metalness: 0.3, roughness: 0.4 }),
  /** ゆで湯（白濁した湯） */
  water: () =>
    refl('water', { color: '#c9d2cf', metalness: 0, roughness: 0.08, transparent: true, opacity: 0.88 }),
  noodle: () => std('noodle', { color: '#e2c890', metalness: 0, roughness: 0.48 }),
};
