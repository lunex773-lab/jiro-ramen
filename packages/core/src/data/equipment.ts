// 設備の定義（設計書 10.2）。数値はゲーム調整用の仮値。

export type EquipmentZone = 'kitchen' | 'dining' | 'none';
export type EquipmentRole =
  | 'boiler'
  | 'soup'
  | 'pot'
  | 'veg'
  | 'prep'
  | 'assembly'
  | 'topping'
  | 'rack'
  | 'sink'
  | 'dishwasher'
  | 'fridge'
  | 'freezer'
  | 'noodle_maker'
  | 'trash'
  | 'locker'
  | 'desk'
  | 'ticket'
  | 'water'
  | 'decor'
  | 'upgrade';

export interface EquipmentDef {
  id: string;
  name: string;
  role: EquipmentRole;
  zone: EquipmentZone;
  /** グリッド上の大きさ（セル数, 0.5m/セル）。0 は配置不要の設備 */
  w: number;
  d: number;
  /** 3D表示の高さ(m) */
  h: number;
  price: number;
  upkeep: number;
  /** 1回使うごとの光熱費 */
  utilityPerUse: number;
  /** 作業速度の倍率 */
  speed: number;
  /** 容量（スロット数・L・kg・枚数など役割ごとに意味が違う） */
  capacity: number;
  /** 1回の使用で減る状態値 */
  wearPerUse: number;
  /** 1回の使用あたりの基本故障率 */
  failureBase: number;
  repairCost: number;
  /** 修理にかかるsim秒 */
  repairTime: number;
  /** 微調整（グリッド外の細かい位置）を許可するか */
  fineAdjust: boolean;
  unlock?: string;
  maxCount: number;
  /** その他の効果 */
  effects?: {
    comfort?: number;
    demand?: number;
    grimeReduction?: number;
    lostItemReduction?: number;
    service?: number;
  };
  description: string;
  color: string;
}

const base = {
  utilityPerUse: 0,
  speed: 1,
  capacity: 0,
  wearPerUse: 0.0,
  failureBase: 0,
  repairCost: 0,
  repairTime: 0,
  fineAdjust: false,
  maxCount: 4,
};

export const EQUIPMENT: Record<string, EquipmentDef> = {
  noodle_boiler: {
    ...base, id: 'noodle_boiler', name: '麺釜（4ロット）', role: 'boiler', zone: 'kitchen', w: 2, d: 2, h: 0.9,
    price: 280_000, upkeep: 500, utilityPerUse: 6, capacity: 4, wearPerUse: 0.158, failureBase: 0.0015,
    repairCost: 15_000, repairTime: 45, description: '極太麺を同時に4玉ゆでられる釜。', color: '#9aa3ab',
  },
  noodle_boiler_l: {
    ...base, id: 'noodle_boiler_l', name: '大型麺釜（6ロット）', role: 'boiler', zone: 'kitchen', w: 3, d: 2, h: 0.9,
    price: 560_000, upkeep: 800, utilityPerUse: 6, capacity: 6, speed: 1.1, wearPerUse: 0.113, failureBase: 0.001,
    repairCost: 24_000, repairTime: 45, unlock: 'boiler_l', description: '6玉同時。湯量が多く温度が落ちにくい。', color: '#a6aeb6',
  },
  soup_pot: {
    ...base, id: 'soup_pot', name: '寸胴（スープ30L）', role: 'soup', zone: 'kitchen', w: 2, d: 2, h: 1.0,
    price: 120_000, upkeep: 300, utilityPerUse: 4, capacity: 30, wearPerUse: 0.09, failureBase: 0.001,
    repairCost: 9000, repairTime: 40, maxCount: 2, description: '豚骨と背脂を炊いて乳化スープを作る寸胴とコンロ。', color: '#b9c0c6',
  },
  soup_pot_l: {
    ...base, id: 'soup_pot_l', name: '大寸胴（スープ50L）', role: 'soup', zone: 'kitchen', w: 2, d: 2, h: 1.1,
    price: 230_000, upkeep: 450, utilityPerUse: 4, capacity: 50, wearPerUse: 0.068, failureBase: 0.0008,
    repairCost: 12_000, repairTime: 40, maxCount: 2, unlock: 'soup_l', description: '大容量。仕込み回数を減らせる。', color: '#c2c9cf',
  },
  braise_pot: {
    ...base, id: 'braise_pot', name: '煮込み鍋（豚・背脂）', role: 'pot', zone: 'kitchen', w: 2, d: 2, h: 0.9,
    price: 90_000, upkeep: 250, utilityPerUse: 10, wearPerUse: 0.18, failureBase: 0.002,
    repairCost: 7000, repairTime: 35, description: '豚を醤油で煮込み、タレと煮豚を作る。背脂も炊ける。', color: '#8f969c',
  },
  veg_boiler: {
    ...base, id: 'veg_boiler', name: '野菜ゆで釜', role: 'veg', zone: 'kitchen', w: 2, d: 2, h: 0.9,
    price: 100_000, upkeep: 250, utilityPerUse: 8, wearPerUse: 0.18, failureBase: 0.002,
    repairCost: 7000, repairTime: 35, description: 'もやしとキャベツをまとめてゆでる。', color: '#99a1a8',
  },
  prep_table: {
    ...base, id: 'prep_table', name: '仕込み台', role: 'prep', zone: 'kitchen', w: 3, d: 2, h: 0.85,
    price: 60_000, upkeep: 100, wearPerUse: 0.045, failureBase: 0,
    description: 'ニンニクを刻み、煮豚を切る作業台。', color: '#c8ced3',
  },
  prep_table_l: {
    ...base, id: 'prep_table_l', name: '広い仕込み台', role: 'prep', zone: 'kitchen', w: 4, d: 2, h: 0.85,
    price: 120_000, upkeep: 150, speed: 1.3, wearPerUse: 0.036, failureBase: 0, unlock: 'prep_l',
    description: '作業スペースが広く仕込みが速い。', color: '#ced4d9',
  },
  assembly: {
    ...base, id: 'assembly', name: '盛り付け台（4杯）', role: 'assembly', zone: 'kitchen', w: 3, d: 2, h: 0.9,
    price: 70_000, upkeep: 100, capacity: 4, wearPerUse: 0.023, failureBase: 0, maxCount: 3,
    description: '丼を並べ、タレ・スープ・麺・トッピングを盛る。ロット単位で作業する。', color: '#d0d6db',
  },
  assembly_l: {
    ...base, id: 'assembly_l', name: '盛り付け台（6杯）', role: 'assembly', zone: 'kitchen', w: 4, d: 2, h: 0.9,
    price: 140_000, upkeep: 150, capacity: 6, wearPerUse: 0.018, failureBase: 0, maxCount: 3, unlock: 'assembly_l',
    description: '6杯を一度に盛れる長い台。', color: '#d5dbe0',
  },
  topping: {
    ...base, id: 'topping', name: 'トッピング台', role: 'topping', zone: 'kitchen', w: 2, d: 2, h: 0.9,
    price: 50_000, upkeep: 80, speed: 1, wearPerUse: 0.023, failureBase: 0, maxCount: 3,
    description: 'ヤサイ・ニンニク・アブラ・唐辛子・豚を並べた台。盛り付け台の近くに置く。', color: '#c4b59a',
  },
  bowl_rack: {
    ...base, id: 'bowl_rack', name: '丼棚', role: 'rack', zone: 'kitchen', w: 2, d: 1, h: 1.2,
    price: 30_000, upkeep: 0, capacity: 30, maxCount: 3, description: '洗った丼を置く棚。', color: '#b5a184',
  },
  sink: {
    ...base, id: 'sink', name: '洗い場', role: 'sink', zone: 'kitchen', w: 3, d: 2, h: 0.85,
    price: 80_000, upkeep: 150, utilityPerUse: 2, capacity: 14, wearPerUse: 0.023, failureBase: 0.0005,
    repairCost: 6000, repairTime: 30, maxCount: 2, description: '下げた丼を手で洗う。', color: '#aeb6bd',
  },
  dishwasher: {
    ...base, id: 'dishwasher', name: '業務用食洗機', role: 'dishwasher', zone: 'kitchen', w: 2, d: 2, h: 1.1,
    price: 450_000, upkeep: 600, utilityPerUse: 15, capacity: 8, speed: 1, wearPerUse: 0.27, failureBase: 0.004,
    repairCost: 27_000, repairTime: 60, maxCount: 2, unlock: 'dishwasher',
    description: '8枚まとめて20秒で洗う。故障すると手洗いに戻る。', color: '#9fa8b0',
  },
  fridge: {
    ...base, id: 'fridge', name: '冷蔵庫', role: 'fridge', zone: 'kitchen', w: 2, d: 2, h: 1.9,
    price: 150_000, upkeep: 300, capacity: 100, wearPerUse: 0.009, failureBase: 0.0004,
    repairCost: 18_000, repairTime: 60, maxCount: 3, description: '生鮮食材を保管する（容量100kg）。', color: '#e3e7ea',
  },
  fridge_l: {
    ...base, id: 'fridge_l', name: '業務用冷蔵庫', role: 'fridge', zone: 'kitchen', w: 3, d: 2, h: 1.9,
    price: 320_000, upkeep: 500, capacity: 150, wearPerUse: 0.007, failureBase: 0.0003,
    repairCost: 24_000, repairTime: 60, maxCount: 3, unlock: 'fridge_l', description: '容量150kg。', color: '#e9edf0',
  },
  freezer: {
    ...base, id: 'freezer', name: '冷凍庫', role: 'freezer', zone: 'kitchen', w: 2, d: 2, h: 1.0,
    price: 180_000, upkeep: 400, capacity: 40, wearPerUse: 0.009, failureBase: 0.0004,
    repairCost: 18_000, repairTime: 60, maxCount: 2, unlock: 'freezer', description: '豚・ガラ・背脂の保存期間が延びる。', color: '#dfe5ea',
  },
  noodle_maker: {
    ...base, id: 'noodle_maker', name: '製麺機', role: 'noodle_maker', zone: 'kitchen', w: 2, d: 2, h: 1.2,
    price: 650_000, upkeep: 700, utilityPerUse: 20, wearPerUse: 0.36, failureBase: 0.004,
    repairCost: 36_000, repairTime: 60, maxCount: 1, unlock: 'noodle_maker',
    description: '小麦粉から自家製麺を打つ。原価が下がり麺の品質が上がる。', color: '#b0b7be',
  },
  trash: {
    ...base, id: 'trash', name: 'ゴミ箱', role: 'trash', zone: 'kitchen', w: 1, d: 1, h: 0.7,
    price: 5_000, upkeep: 0, capacity: 30, maxCount: 3, description: '満杯になると厨房が汚れやすくなる。', color: '#5d6b5f',
  },
  locker: {
    ...base, id: 'locker', name: '掃除用具入れ', role: 'locker', zone: 'kitchen', w: 1, d: 1, h: 1.8,
    price: 15_000, upkeep: 0, maxCount: 2, description: 'モップがしまってある。', color: '#7d8a99',
  },
  desk: {
    ...base, id: 'desk', name: '事務机・忘れ物入れ', role: 'desk', zone: 'kitchen', w: 2, d: 1, h: 0.75,
    price: 20_000, upkeep: 0, maxCount: 1, description: '経営端末と忘れ物の保管箱。', color: '#8c6d4f',
  },
  ticket_machine: {
    ...base, id: 'ticket_machine', name: '券売機', role: 'ticket', zone: 'dining', w: 1, d: 1, h: 1.7,
    price: 250_000, upkeep: 200, speed: 1, wearPerUse: 0.036, failureBase: 0.001,
    repairCost: 12_000, repairTime: 50, maxCount: 2, description: '食券を売る。故障すると手売りになり時間がかかる。', color: '#e7e1cf',
  },
  ticket_machine_fast: {
    ...base, id: 'ticket_machine_fast', name: '高速券売機', role: 'ticket', zone: 'dining', w: 1, d: 1, h: 1.7,
    price: 480_000, upkeep: 300, speed: 1.8, wearPerUse: 0.023, failureBase: 0.0006,
    repairCost: 18_000, repairTime: 50, maxCount: 2, unlock: 'ticket_fast', description: '電子決済対応で食券購入が速い。', color: '#ece7d8',
  },
  water_server: {
    ...base, id: 'water_server', name: '給水器（セルフ）', role: 'water', zone: 'dining', w: 1, d: 1, h: 1.2,
    price: 40_000, upkeep: 100, maxCount: 2, effects: { comfort: 0.06 }, description: '冷たい水をセルフで。快適さが上がる。', color: '#cfe3ef',
  },
  plant: {
    ...base, id: 'plant', name: '観葉植物', role: 'decor', zone: 'dining', w: 1, d: 1, h: 1.3,
    price: 12_000, upkeep: 50, fineAdjust: true, maxCount: 4, effects: { comfort: 0.02 }, description: '店内が少し落ち着く。', color: '#4f8a4a',
  },
  coat_rack: {
    ...base, id: 'coat_rack', name: '荷物フック・棚', role: 'decor', zone: 'dining', w: 1, d: 1, h: 1.6,
    price: 18_000, upkeep: 0, fineAdjust: true, maxCount: 2, effects: { comfort: 0.02, lostItemReduction: 0.4 },
    description: '荷物の置き場。忘れ物が減る。', color: '#7a5c3e',
  },
  vent: {
    ...base, id: 'vent', name: '換気設備の強化', role: 'upgrade', zone: 'none', w: 0, d: 0, h: 0,
    price: 200_000, upkeep: 300, maxCount: 1, effects: { comfort: 0.05, grimeReduction: 0.35 },
    description: '油煙を減らし厨房が汚れにくくなる。店内の快適さも上がる。', color: '#888888', unlock: 'vent',
  },
  sign: {
    ...base, id: 'sign', name: '黄色い大看板', role: 'upgrade', zone: 'none', w: 0, d: 0, h: 0,
    price: 150_000, upkeep: 100, maxCount: 1, effects: { demand: 0.08 }, description: '遠くからでも目立つ看板。来客が増える。', color: '#f2c200',
  },
  cushion: {
    ...base, id: 'cushion', name: '座り心地の良い丸椅子', role: 'upgrade', zone: 'none', w: 0, d: 0, h: 0,
    price: 80_000, upkeep: 50, maxCount: 1, effects: { comfort: 0.08 }, description: '全席の椅子を交換する。', color: '#c0392b',
  },
};

export const EQUIPMENT_IDS = Object.keys(EQUIPMENT);

/** 丼の追加購入 */
export const BOWL_PACK = { qty: 6, price: 9_000 };
/** 席（丸椅子）1脚の設置費 */
export const SEAT_PRICE = 15_000;
