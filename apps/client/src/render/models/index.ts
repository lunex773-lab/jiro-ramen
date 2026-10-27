// 手続き生成の3Dモデル一式（外部アセットなし）。描画側（world.ts）はここだけを参照する。
//
// 座標: メートル・Y 上。x=店の左→右、z=正面（通り, z<0 は歩道）→奥（厨房）。床 y=0。
// 金属などの反射は各マテリアルに簡易環境マップを持たせているので scene.environment は不要
// （より良い反射が欲しければ createEnvMap(renderer) を scene.environment に設定してもよい）。

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { tickFx } from './fx';
import { tickEquipment } from './equipment';
import { MAT } from './materials';

export type { Disposable } from './common';
export { createBowl, BOWL_DIMS, innerRadiusAt, type BowlModel, type BowlDetail } from './bowl';
export { createCharacter, type CharacterModel, type CharacterPose, type CharacterOpts } from './character';
export { createEquipment, type EquipmentModel } from './equipment';
export { createShopShell, createStool, COUNTER_TOP_Y, COUNTER_SHELF_Y, CEILING_Y, type ShopShell } from './shop';
export { createDirt, createLostItem, createHeldItem, type HeldKind } from './props';

/** 全モデル共有のアニメーション（湯気・湯面など）。毎フレーム1回呼ぶ */
export function tickModels(t: number): void {
  tickFx(t);
  tickEquipment(t);
}

/** 任意: RoomEnvironment から作る高品質な環境マップ（scene.environment 用） */
export function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(new RoomEnvironment(), 0.04).texture;
  pm.dispose();
  return tex;
}

/** ギャラリー用（カウンターの見本） */
export const galleryMaterials = { counter: MAT.woodCounter, lightWood: MAT.woodLight };
