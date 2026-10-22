// 仕込みレシピ（設計書 8.2）。
// kind='hold' は仕込み台で人が付きっきりで行う作業、'process' は鍋などに投入すると自動で進む工程。

export interface PrepRecipe {
  id: string;
  name: string;
  kind: 'hold' | 'process';
  /** 実行する設備の役割 */
  station: 'pot' | 'prep' | 'veg' | 'soup' | 'noodle_maker';
  inputs: { itemId: string; qty: number }[];
  /** costShare: 投入原価のうちこの成果物に配分する割合 */
  outputs: { itemId: string; qty: number; costShare: number }[];
  /** 作業時間（sim秒） */
  time: number;
  /** 寸胴へのスープ追加量（L） */
  soupL?: number;
  /** 中断しても進捗が残るか */
  interruptible: boolean;
  unlock?: string;
  /** 従業員AIが補充を判断する目安（この量を下回ったら仕込む） */
  restockBelow?: { itemId: string; qty: number };
}

export const PREP_RECIPES: Record<string, PrepRecipe> = {
  braise_pork: {
    id: 'braise_pork', name: '豚を煮込む', kind: 'process', station: 'pot',
    inputs: [{ itemId: 'pork_raw', qty: 4 }, { itemId: 'soy', qty: 2000 }],
    outputs: [{ itemId: 'pork_block', qty: 4, costShare: 0.8 }, { itemId: 'tare', qty: 2500, costShare: 0.2 }],
    time: 90, interruptible: false,
    restockBelow: { itemId: 'buta', qty: 60 },
  },
  render_abura: {
    id: 'render_abura', name: '背脂を炊く', kind: 'process', station: 'pot',
    inputs: [{ itemId: 'backfat_raw', qty: 1000 }, { itemId: 'soy', qty: 80 }],
    outputs: [{ itemId: 'abura', qty: 1000, costShare: 1 }],
    time: 25, interruptible: false,
    restockBelow: { itemId: 'abura', qty: 250 },
  },
  slice_pork: {
    id: 'slice_pork', name: '豚を切る', kind: 'hold', station: 'prep',
    inputs: [{ itemId: 'pork_block', qty: 1 }],
    outputs: [{ itemId: 'buta', qty: 18, costShare: 1 }],
    time: 6, interruptible: true,
    restockBelow: { itemId: 'buta', qty: 20 },
  },
  chop_garlic: {
    id: 'chop_garlic', name: 'ニンニクを刻む', kind: 'hold', station: 'prep',
    inputs: [{ itemId: 'garlic_raw', qty: 500 }],
    outputs: [{ itemId: 'garlic', qty: 500, costShare: 1 }],
    time: 8, interruptible: true,
    restockBelow: { itemId: 'garlic', qty: 100 },
  },
  boil_veg: {
    id: 'boil_veg', name: 'ヤサイをゆでる', kind: 'process', station: 'veg',
    inputs: [{ itemId: 'moyashi', qty: 4000 }, { itemId: 'cabbage', qty: 1000 }],
    outputs: [{ itemId: 'yasai', qty: 5000, costShare: 1 }],
    time: 18, interruptible: false,
    restockBelow: { itemId: 'yasai', qty: 1200 },
  },
  boil_moyashi: {
    id: 'boil_moyashi', name: 'もやしだけゆでる', kind: 'process', station: 'veg',
    inputs: [{ itemId: 'moyashi', qty: 4500 }],
    outputs: [{ itemId: 'yasai', qty: 4500, costShare: 1 }],
    time: 16, interruptible: false,
    restockBelow: { itemId: 'yasai', qty: 1200 },
  },
  simmer_soup: {
    id: 'simmer_soup', name: 'スープを炊く', kind: 'process', station: 'soup',
    inputs: [{ itemId: 'bones', qty: 5000 }, { itemId: 'backfat_raw', qty: 400 }],
    outputs: [],
    soupL: 18,
    time: 70, interruptible: false,
  },
  make_noodles: {
    id: 'make_noodles', name: '製麺する', kind: 'process', station: 'noodle_maker',
    inputs: [{ itemId: 'flour', qty: 5000 }],
    outputs: [{ itemId: 'homemade_noodle', qty: 6800, costShare: 1 }],
    time: 40, interruptible: false, unlock: 'noodle_maker',
    restockBelow: { itemId: 'homemade_noodle', qty: 1500 },
  },
};

export const PREP_IDS = Object.keys(PREP_RECIPES);
