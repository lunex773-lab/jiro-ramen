// 設備モデルの入口。種類ごとの組み立て関数を呼び、状態ランプ（不調・故障・修理中）を共通で付ける。
// 規約: 正面（作業者が立つ側）= -Z、中心=原点、床=y0。幅 X = EQUIPMENT[type].w*0.5m、奥行 Z = d*0.5m。
// 呼び出し側が position=設置範囲の中心、rotation.y = -rot*π/2 を設定する。

import * as THREE from 'three';
import { EQUIPMENT, type Equipment, type GameState } from '@jiro/core';
import type { Disposable } from './common';
import { createStatusFx } from './fx';
import { texBoil, type EqCtx } from './equip-common';
import {
  buildAssembly,
  buildBoiler,
  buildBowlRack,
  buildBraisePot,
  buildDesk,
  buildDishwasher,
  buildFridge,
  buildLocker,
  buildNoodleMaker,
  buildPrepTable,
  buildSink,
  buildSoupPot,
  buildTopping,
  buildTrash,
  buildVegBoiler,
} from './equip-kitchen';
import { buildCoatRack, buildPlant, buildTicketMachine, buildWaterServer } from './equip-dining';

export interface EquipmentModel extends Disposable {
  group: THREE.Group;
  /** 毎フレーム、実際の設備とゲーム状態で見た目を更新する */
  update(e: Equipment, s: GameState, t: number, dt: number): void;
  /** 盛り付け台に丼（BowlModel）を置く位置（group のローカル座標） */
  bowlAnchors: THREE.Vector3[];
  /** 作業面の高さ(m) */
  topY: number;
}

const BUILDERS: Record<string, (c: EqCtx) => void> = {
  noodle_boiler: buildBoiler,
  noodle_boiler_l: buildBoiler,
  soup_pot: buildSoupPot,
  soup_pot_l: buildSoupPot,
  braise_pot: buildBraisePot,
  veg_boiler: buildVegBoiler,
  prep_table: buildPrepTable,
  prep_table_l: buildPrepTable,
  assembly: buildAssembly,
  assembly_l: buildAssembly,
  topping: buildTopping,
  bowl_rack: buildBowlRack,
  sink: buildSink,
  dishwasher: buildDishwasher,
  fridge: buildFridge,
  fridge_l: buildFridge,
  freezer: buildFridge,
  noodle_maker: buildNoodleMaker,
  trash: buildTrash,
  locker: buildLocker,
  desk: buildDesk,
  ticket_machine: buildTicketMachine,
  ticket_machine_fast: buildTicketMachine,
  water_server: buildWaterServer,
  plant: buildPlant,
  coat_rack: buildCoatRack,
};

/** 設備モデルを作る。w=0 の種類（換気・看板・椅子の交換）は空の group を返す */
export function createEquipment(type: string): EquipmentModel {
  const def = EQUIPMENT[type];
  const group = new THREE.Group();
  group.name = 'equipment:' + type;
  if (!def || def.w === 0) {
    return { group, update() {}, bowlAnchors: [], topY: 0, dispose() {} };
  }
  const W = def.w * 0.5;
  const D = def.d * 0.5;
  const H = def.h;
  const c: EqCtx = {
    type,
    W,
    D,
    H,
    group,
    owned: [],
    updaters: [],
    bowlAnchors: [],
    topY: H,
    lampPos: new THREE.Vector3(W / 2 - 0.08, H + 0.08, -D / 2 + 0.08),
  };
  const build = BUILDERS[type];
  if (build) build(c);
  // 故障しうる設備には状態ランプ（ランプ・煙・修理道具）
  const breakable = def.repairCost > 0;
  const status = breakable ? createStatusFx(c.lampPos, -D / 2, W / 2) : null;
  if (status) group.add(status.group);
  const ups = c.updaters;
  return {
    group,
    bowlAnchors: c.bowlAnchors,
    topY: c.topY,
    update(e, s, t, dt) {
      for (let i = 0; i < ups.length; i++) ups[i]!(e, s, t, dt);
      status?.update(e.status, t);
    },
    dispose() {
      for (const o of c.owned) o.dispose();
      c.owned.length = 0;
      group.removeFromParent();
    },
  };
}

/** 設備の共有アニメーション（湯面のスクロールなど） */
export function tickEquipment(t: number): void {
  const tex = texBoil();
  tex.offset.set((t * 0.05) % 1, (t * 0.083) % 1);
  tex.rotation = Math.sin(t * 0.7) * 0.05;
}
