// 企業間ランキング（docs/MARKET_RANKING_PLAN.md。仕様書 5 章）。
// もとの数値は rank_agg（0時の同期でサーバーが確定した日の集計）だけ。端末の申告は使わない。上限を超えた日は数えていない。
//
// 種別（仕様書 5.3）と計算（根拠は MARKET_RANKING_PLAN.md「ランキングの種別」）:
//   sales 総売上 / op 営業利益 / final 最終利益: コミュニティ内は期間の合計、全体はゲーム内の1日あたり（オーナーの判断 3b）
//   satisfaction 顧客満足度: 満足度の合計 ÷ 人数（手動の日だけに値がある）
//   growth 企業価値成長率: (期間の終わりの企業価値 − 始めの企業価値) ÷ max(|始め|, 初期資金)。企業価値は純資産（借入は引く）
//   share 市場シェア: 純売上 ÷ 同じ期間の市場全体の純売上
//   employee 従業員満足度・quality 店舗品質: 1日ごとの値の平均
//   overall 総合評価: 上の8種別の順位を同じ重みで平均（値のない種別は最下位として数える。根拠のない配点は使わない。オーナーの判断 6）

import { BALANCE } from '@jiro/core';

export const RANK_METRICS = ['sales', 'op', 'final', 'satisfaction', 'growth', 'share', 'employee', 'quality', 'overall'] as const;
export type RankMetric = (typeof RANK_METRICS)[number];
export const BASE_METRICS = RANK_METRICS.filter((m) => m !== 'overall');

export const RANK_METRIC_LABEL: Record<RankMetric, string> = {
  sales: '総売上',
  op: '営業利益',
  final: '最終利益',
  satisfaction: '顧客満足度',
  growth: '企業価値成長率',
  share: '市場シェア',
  employee: '従業員満足度',
  quality: '店舗品質',
  overall: '総合評価',
};

/** 'community' = コミュニティ内、'fresh' / 'grown' = 全体（新規の企業だけ / 育てた企業も可。オーナーの判断 3a） */
export type RankBoard = 'community' | 'fresh' | 'grown';

export interface RankAggRow {
  scope_key: string;
  market_id: string;
  company_id: string;
  entry: string;
  kind: string;
  player_id: string | null;
  name: string;
  days: number;
  manual_days: number;
  flagged_days: number;
  net_sales: number;
  operating_profit: number;
  final_profit: number;
  sat_sum: number;
  sat_count: number;
  market_net_sales: number;
  emp_sat_sum: number;
  emp_sat_days: number;
  quality_sum: number;
  quality_days: number;
  value_start: number;
  value_end: number;
}

export interface RankLine {
  rank: number;
  marketId: string;
  companyId: string;
  name: string;
  kind: string;
  playerId: string | null;
  value: number;
  days: number;
  flaggedDays: number;
}

/** その企業のその種別の値（値がなければ null） */
export function metricValue(r: RankAggRow, metric: Exclude<RankMetric, 'overall'>, board: RankBoard): number | null {
  const perDay = board !== 'community';
  const per = (x: number) => (perDay ? (r.days > 0 ? x / r.days : null) : x);
  if (r.days <= 0) return null;
  switch (metric) {
    case 'sales':
      return per(r.net_sales);
    case 'op':
      return per(r.operating_profit);
    case 'final':
      return per(r.final_profit);
    case 'satisfaction':
      return r.sat_count > 0 ? r.sat_sum / r.sat_count : null;
    case 'growth':
      return (r.value_end - r.value_start) / Math.max(Math.abs(r.value_start), BALANCE.initialMoney);
    case 'share':
      return r.market_net_sales > 0 ? r.net_sales / r.market_net_sales : null;
    case 'employee':
      return r.emp_sat_days > 0 ? r.emp_sat_sum / r.emp_sat_days : null;
    case 'quality':
      return r.quality_days > 0 ? r.quality_sum / r.quality_days : null;
  }
}

/** 値の大きい順に順位を付ける（同じ値は同じ順位）。値のない企業は入れない */
function rankBy(rows: RankAggRow[], f: (r: RankAggRow) => number | null): Map<string, number> {
  const vals = rows.map((r) => ({ k: `${r.market_id}:${r.company_id}`, v: f(r) })).filter((x): x is { k: string; v: number } => x.v !== null && Number.isFinite(x.v));
  vals.sort((a, b) => b.v - a.v);
  const out = new Map<string, number>();
  let prev: number | null = null;
  let rank = 0;
  vals.forEach((x, i) => {
    if (prev === null || x.v !== prev) rank = i + 1;
    prev = x.v;
    out.set(x.k, rank);
  });
  return out;
}

/** ランキングを作る（rows は同じ scope_key の行）。総合評価は8種別の順位の平均（小さいほど上） */
export function computeRanking(rows: RankAggRow[], board: RankBoard, metric: RankMetric): RankLine[] {
  const live = rows.filter((r) => r.days > 0);
  const key = (r: RankAggRow) => `${r.market_id}:${r.company_id}`;
  let value: (r: RankAggRow) => number | null;
  if (metric === 'overall') {
    const ranks = BASE_METRICS.map((m) => rankBy(live, (r) => metricValue(r, m, board)));
    const n = live.length;
    // 総合評価の値 = 順位の平均（値のない種別は n 位）。大きい順に並べるため符号を反転して使う
    const avgRank = new Map(live.map((r) => [key(r), ranks.reduce((a, rk) => a + (rk.get(key(r)) ?? n), 0) / ranks.length]));
    value = (r) => -(avgRank.get(key(r)) ?? n);
  } else {
    value = (r) => metricValue(r, metric, board);
  }
  const order = rankBy(live, value);
  return live
    .filter((r) => order.has(key(r)))
    .map((r) => ({
      rank: order.get(key(r))!,
      marketId: r.market_id,
      companyId: r.company_id,
      name: r.name,
      kind: r.kind,
      playerId: r.player_id,
      value: metric === 'overall' ? -value(r)! : value(r)!,
      days: r.days,
      flaggedDays: r.flagged_days,
    }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

/** 報酬の称号（経済的な効果はない） */
export function rewardTitle(board: RankBoard, scopeKey: string, rank: number): string {
  const where = board === 'community' ? 'コミュニティ' : board === 'fresh' ? '全体（新規の企業）' : '全体（育てた企業も可）';
  const period = scopeKey.startsWith('W') ? `${scopeKey.slice(1)}の週` : scopeKey.startsWith('M') ? `${scopeKey.slice(1).replace('-', '年')}月` : scopeKey.startsWith('Y') ? `${scopeKey.slice(1)}年` : '累計';
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉';
  return `${medal} ${period}・${where} 総合${rank}位`;
}
