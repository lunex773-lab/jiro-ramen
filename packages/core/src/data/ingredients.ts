// 食材の定義。原材料（仕入れ）と仕込み品（店内で作る）を同じ表で扱う。
// 単位: g（グラム）, ml, 個, 枚。保存期間は営業日数（0 = 当日中のみ）。

export type IngredientStorage = 'fridge' | 'dry' | 'freezer' | 'station';

export interface IngredientDef {
  id: string;
  name: string;
  unit: 'g' | 'ml' | '枚' | '個' | '本';
  /** 仕入れ可能か。false は仕込みでのみ得られる */
  purchasable: boolean;
  /** 仕入れ単位（1パック）の数量と価格 */
  packQty: number;
  packPrice: number;
  storage: IngredientStorage;
  /** 保管容量の計算に使う 1 単位あたりの重さ(kg) */
  kgPerUnit: number;
  shelfLifeDays: number;
  /** 冷凍庫があるときの保存期間 */
  frozenShelfLifeDays?: number;
  /** 解放に必要なアンロックID */
  unlock?: string;
}

export const INGREDIENTS: Record<string, IngredientDef> = {
  // ── 原材料 ──
  noodle: {
    id: 'noodle', name: '極太麺（製麺所）', unit: 'g', purchasable: true,
    packQty: 5000, packPrice: 1_500, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 3,
  },
  flour: {
    id: 'flour', name: '強力粉（オーション）', unit: 'g', purchasable: true,
    packQty: 10000, packPrice: 2_200, storage: 'dry', kgPerUnit: 0, shelfLifeDays: 60, unlock: 'noodle_maker',
  },
  pork_raw: {
    id: 'pork_raw', name: '豚ウデ肉ブロック', unit: '本', purchasable: true,
    packQty: 2, packPrice: 1_700, storage: 'fridge', kgPerUnit: 2, shelfLifeDays: 3, frozenShelfLifeDays: 10,
  },
  bones: {
    id: 'bones', name: '豚ゲンコツ・背ガラ', unit: 'g', purchasable: true,
    packQty: 10000, packPrice: 1_800, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 2, frozenShelfLifeDays: 8,
  },
  backfat_raw: {
    id: 'backfat_raw', name: '背脂（生）', unit: 'g', purchasable: true,
    packQty: 2000, packPrice: 700, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 3, frozenShelfLifeDays: 10,
  },
  moyashi: {
    id: 'moyashi', name: 'もやし', unit: 'g', purchasable: true,
    packQty: 4000, packPrice: 480, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 2,
  },
  cabbage: {
    id: 'cabbage', name: 'キャベツ', unit: 'g', purchasable: true,
    packQty: 3000, packPrice: 450, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 4,
  },
  garlic_raw: {
    id: 'garlic_raw', name: 'にんにく', unit: 'g', purchasable: true,
    packQty: 1000, packPrice: 1_000, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 10,
  },
  soy: {
    id: 'soy', name: '醤油（カネシ系）', unit: 'ml', purchasable: true,
    packQty: 1800, packPrice: 700, storage: 'dry', kgPerUnit: 0, shelfLifeDays: 60,
  },
  ichimi: {
    id: 'ichimi', name: '一味唐辛子', unit: 'g', purchasable: true,
    packQty: 300, packPrice: 600, storage: 'dry', kgPerUnit: 0, shelfLifeDays: 60,
  },
  egg: {
    id: 'egg', name: '生卵', unit: '個', purchasable: true,
    packQty: 30, packPrice: 750, storage: 'fridge', kgPerUnit: 0.06, shelfLifeDays: 7, unlock: 'menu_egg',
  },

  // ── 仕込み品 ──
  yasai: {
    id: 'yasai', name: 'ヤサイ（ゆでもやし・キャベツ）', unit: 'g', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'station', kgPerUnit: 0, shelfLifeDays: 0,
  },
  garlic: {
    id: 'garlic', name: '刻みニンニク', unit: 'g', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'station', kgPerUnit: 0, shelfLifeDays: 1,
  },
  abura: {
    id: 'abura', name: 'アブラ（背脂）', unit: 'g', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'station', kgPerUnit: 0, shelfLifeDays: 1,
  },
  pork_block: {
    id: 'pork_block', name: '煮豚ブロック', unit: '本', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'fridge', kgPerUnit: 1.4, shelfLifeDays: 2,
  },
  buta: {
    id: 'buta', name: '豚（スライス）', unit: '枚', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'station', kgPerUnit: 0, shelfLifeDays: 1,
  },
  tare: {
    id: 'tare', name: 'タレ（醤油ダレ）', unit: 'ml', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'station', kgPerUnit: 0, shelfLifeDays: 3,
  },
  homemade_noodle: {
    id: 'homemade_noodle', name: '自家製麺', unit: 'g', purchasable: false,
    packQty: 0, packPrice: 0, storage: 'fridge', kgPerUnit: 0.001, shelfLifeDays: 2, unlock: 'noodle_maker',
  },
};

export const INGREDIENT_IDS = Object.keys(INGREDIENTS);

/** 麺として使える食材（品質の高い順） */
export const NOODLE_SOURCES = ['homemade_noodle', 'noodle'] as const;
