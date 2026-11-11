// オンライン市場のデータ（統合進化設計書 v2.1 Phase 3+4）。地域・AI 企業の名前と戦略。名前はすべて架空。

export interface HomeAreaDef {
  id: string;
  name: string;
}

/** 本店のある地域（企業は順番に割り当てる。同じ地域の本店どうしで客を取り合う） */
export const MARKET_HOME_AREAS: readonly HomeAreaDef[] = [
  { id: 'kita', name: '北口商店街' },
  { id: 'minami', name: '南口商店街' },
  { id: 'kawa', name: '川沿い商店街' },
];

/** 出店先の地域の名前（物件の id と同じ） */
export const MARKET_BRANCH_AREA_NAMES: Record<string, string> = {
  station: '駅前',
  residential: '住宅街',
  roadside: '郊外',
};

export type AiStrategy = 'budget' | 'standard' | 'premium';

export const AI_STRATEGY_LABEL: Record<AiStrategy, string> = {
  budget: '安さで勝負',
  standard: 'ふつう',
  premium: '高めの値段',
};

/** AI 企業の名前と戦略（架空） */
export const AI_COMPANIES: readonly { name: string; strategy: AiStrategy }[] = [
  { name: '麺屋 鉄心', strategy: 'standard' },
  { name: 'ドカ盛軒', strategy: 'budget' },
  { name: '大盛ラーメン 山盛亭', strategy: 'premium' },
  { name: '麺工房 まんぷく', strategy: 'budget' },
  { name: 'ラーメン 剛腕', strategy: 'standard' },
  { name: '豚骨醤油 ガッツリ屋', strategy: 'premium' },
  // 25社の市場（じろ2: 改修設計書04）のための架空の会社
  { name: '麺処 極太', strategy: 'standard' },
  { name: 'ニンニク亭', strategy: 'budget' },
  { name: '背脂番長', strategy: 'premium' },
  { name: 'ラーメン 野菜山', strategy: 'standard' },
  { name: '麺屋 アブラ', strategy: 'budget' },
  { name: '豚王', strategy: 'premium' },
  { name: '麺匠 からめ', strategy: 'standard' },
  { name: 'まし増し軒', strategy: 'budget' },
  { name: '濃厚麺 轟', strategy: 'premium' },
  { name: 'ラーメン 腹八分', strategy: 'standard' },
  { name: '極盛 天地', strategy: 'budget' },
  { name: '麺屋 雷鳴', strategy: 'premium' },
  { name: '醤油豚骨 大将', strategy: 'standard' },
  { name: 'ガツ麺 北風', strategy: 'budget' },
  { name: '麺道 一徹', strategy: 'premium' },
  { name: 'ラーメン 鉄鍋', strategy: 'standard' },
  { name: 'もやし御殿', strategy: 'budget' },
  { name: '麺屋 豪傑', strategy: 'premium' },
  { name: '太麺堂', strategy: 'standard' },
];
