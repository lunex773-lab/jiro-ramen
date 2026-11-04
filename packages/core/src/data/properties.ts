// 出店できる物件（統合進化設計書 v2.1 Phase 2。オーナーの判断: 2店舗目の物件は候補から選ぶ）。
// 立地ごとに家賃・来客の多さ・最初の広さ・初期費用が違う。数値は仮の値で、経済の測定（test/econ）で調整する。

export interface PropertyDef {
  id: string;
  /** 店の名前に付ける地名（「〇〇店」） */
  area: string;
  name: string;
  description: string;
  /** 最初の店の大きさ（STAGES の段階。0 = 8席、1 = 12席） */
  stage: number;
  /** 来客の倍率（立地の人通り） */
  demand: number;
  /** 家賃の倍率（段階の家賃に掛ける） */
  rentMult: number;
  /** 初期費用（内装・設備一式・最初の仕入れ。運転資金は別） */
  initialCost: number;
  /** 出店の工事で休む日数（出店した日の翌日から営業） */
  openingDays: number;
}

export const PROPERTIES: Record<string, PropertyDef> = {
  // 1店舗目（キャリアの最初の店）。出店の候補には出さない
  home: {
    id: 'home', area: '本店', name: '本店', description: '最初に開いた店。',
    stage: 0, demand: 1, rentMult: 1, initialCost: 0, openingDays: 0,
  },
  station: {
    id: 'station', area: '駅前', name: '駅前の路面店（8席）',
    description: '人通りが多く客は多いが、家賃が高い。行列ができやすく、値上げしても客が来る。',
    stage: 0, demand: 1.3, rentMult: 1.6, initialCost: 900_000, openingDays: 1,
  },
  residential: {
    id: 'residential', area: '住宅街', name: '住宅街の店（8席）',
    description: '家賃が安く初期費用も少ないが、客は少なめ。空席が出やすいので、値段を下げて常連を増やすと生きる。',
    stage: 0, demand: 0.75, rentMult: 0.7, initialCost: 550_000, openingDays: 1,
  },
  roadside: {
    id: 'roadside', area: '郊外', name: '郊外の幹線道路沿い（12席）',
    description: '最初から12席。車で来る客がいて広いが、初期費用が高い。人手と冷蔵庫をそろえないと回らない。',
    stage: 1, demand: 1.0, rentMult: 0.9, initialCost: 1_300_000, openingDays: 2,
  },
};

/** 出店の候補（1店舗目の 'home' を除く） */
export const PROPERTY_CANDIDATES: readonly string[] = ['station', 'residential', 'roadside'];
