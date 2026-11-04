-- 企業間ランキングと報酬（docs/MARKET_RANKING_PLAN.md。仕様書 5 章）。
-- ランキングはサーバーが確定した日（0時の同期で書く company_periods）だけから作る。端末の申告は使わない。
-- 何度実行しても同じ結果になる文だけを書く。

-- 企業ごと・期間（JST の1日）ごとの追加の数値（従業員満足度・店舗品質・企業価値。company_periods と同じ行に対応）
CREATE TABLE IF NOT EXISTS company_period_ext (
  market_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,
  emp_sat_sum REAL NOT NULL,
  emp_sat_days INTEGER NOT NULL,
  quality_sum REAL NOT NULL,
  quality_days INTEGER NOT NULL,
  value_start INTEGER NOT NULL,
  value_end INTEGER NOT NULL,
  PRIMARY KEY (market_id, company_id, period)
);

-- ランキングの集計（企業 × 週・月・年・累計のキー）。0時の同期のたびに、その企業のその期間の行から作り直す（同じ値で書き直すので何度でも同じ）
-- scope_key: 'W2026-11-02'（週は月曜日）・'M2026-11'・'Y2026'・'T'（累計）。entry: コミュニティの種類（全体ランキングを分ける）
CREATE TABLE IF NOT EXISTS rank_agg (
  scope_key TEXT NOT NULL,
  market_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  kind TEXT NOT NULL,
  player_id TEXT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  manual_days INTEGER NOT NULL,
  flagged_days INTEGER NOT NULL,
  net_sales INTEGER NOT NULL,
  operating_profit INTEGER NOT NULL,
  final_profit INTEGER NOT NULL,
  sat_sum REAL NOT NULL,
  sat_count INTEGER NOT NULL,
  market_net_sales INTEGER NOT NULL,
  emp_sat_sum REAL NOT NULL,
  emp_sat_days INTEGER NOT NULL,
  quality_sum REAL NOT NULL,
  quality_days INTEGER NOT NULL,
  value_start INTEGER NOT NULL,
  value_end INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_key, market_id, company_id)
);
CREATE INDEX IF NOT EXISTS rank_agg_global ON rank_agg(scope_key, entry);
CREATE INDEX IF NOT EXISTS rank_agg_player ON rank_agg(player_id, scope_key);

-- 報酬（称号・トロフィー。経済的な効果はない）。reward_key で一意（同じ順位で二度は受け取らない）
CREATE TABLE IF NOT EXISTS rewards (
  reward_key TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  market_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  board TEXT NOT NULL,
  metric TEXT NOT NULL,
  rank INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rewards_player ON rewards(player_id, created_at);
