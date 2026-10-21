// キャリア目標と解放要素（設計書 4.2, Phase 7）。

import type { GameState } from '../types';

export interface GoalDef {
  id: string;
  name: string;
  description: string;
  unlocks: string[];
  check: (s: GameState) => boolean;
  /** 進捗表示 0..1 */
  progress: (s: GameState) => number;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const GOALS: GoalDef[] = [
  {
    id: 'first_bowl', name: '初めての一杯', description: 'ラーメンを1杯提供する',
    unlocks: [],
    check: (s) => s.career.totalServed >= 1,
    progress: (s) => clamp01(s.career.totalServed),
  },
  {
    id: 'ten_bowls', name: '店の味が知られ始める', description: '累計10杯提供する',
    unlocks: ['menu_large'],
    check: (s) => s.career.totalServed >= 10,
    progress: (s) => clamp01(s.career.totalServed / 10),
  },
  {
    id: 'black_day', name: '初めての黒字', description: '1日の営業利益を黒字にする',
    unlocks: ['hiring'],
    check: (s) => s.career.bestDayProfit > 0,
    progress: (s) => (s.career.bestDayProfit > 0 ? 1 : 0),
  },
  {
    id: 'rep3', name: '評判店', description: '評判 ★3.0 に到達する',
    unlocks: ['menu_double', 'dishwasher', 'stage2'],
    check: (s) => s.reputation >= 3.0,
    progress: (s) => clamp01((s.reputation - 1) / 2),
  },
  {
    id: 'regulars5', name: '常連さん', description: '常連客を5人つくる',
    unlocks: ['noodle_maker', 'freezer'],
    check: (s) => s.regulars.length >= 5,
    progress: (s) => clamp01(s.regulars.length / 5),
  },
  {
    id: 'served300', name: '鍛えられた厨房', description: '累計300杯提供する',
    unlocks: ['boiler_l', 'assembly_l', 'soup_l'],
    check: (s) => s.career.totalServed >= 300,
    progress: (s) => clamp01(s.career.totalServed / 300),
  },
  {
    id: 'day40', name: '行列のできる店', description: '1日に40杯提供する',
    unlocks: ['stage3', 'fridge_l', 'prep_l', 'vent'],
    check: (s) => s.career.bestDayServed >= 40,
    progress: (s) => clamp01(s.career.bestDayServed / 40),
  },
  {
    id: 'money2m', name: '資金200万円', description: '手元資金を200万円にする',
    unlocks: ['ticket_fast', 'menu_egg'],
    check: (s) => s.money >= 2_000_000,
    progress: (s) => clamp01(s.money / 2_000_000),
  },
  {
    id: 'rep4', name: '名店の仲間入り', description: '評判 ★4.0 かつ 1日70杯',
    unlocks: ['stage4'],
    check: (s) => s.reputation >= 4.0 && s.career.bestDayServed >= 70,
    progress: (s) => clamp01(Math.min((s.reputation - 1) / 3, s.career.bestDayServed / 70)),
  },
  {
    id: 'legend', name: '行列の絶えない名店', description: '評判 ★4.5 かつ 1日120杯',
    unlocks: ['title_legend'],
    check: (s) => s.reputation >= 4.5 && s.career.bestDayServed >= 120,
    progress: (s) => clamp01(Math.min((s.reputation - 1) / 3.5, s.career.bestDayServed / 120)),
  },
];

export const UNLOCK_NAMES: Record<string, string> = {
  menu_large: 'メニュー「大」',
  menu_double: 'メニュー「豚ダブル」',
  menu_egg: 'メニュー「生卵」',
  hiring: '従業員の採用',
  dishwasher: '業務用食洗機',
  stage2: '店舗拡張（12席）',
  stage3: '店舗拡張（16席）',
  stage4: '店舗拡張（22席）',
  noodle_maker: '製麺機・自家製麺',
  freezer: '冷凍庫',
  boiler_l: '大型麺釜',
  assembly_l: '盛り付け台（6杯）',
  soup_l: '大寸胴',
  fridge_l: '業務用冷蔵庫',
  prep_l: '広い仕込み台',
  vent: '換気設備',
  ticket_fast: '高速券売機',
  title_legend: '称号「行列の絶えない名店」',
};
