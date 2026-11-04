-- 共通市場（コミュニティ）と企業間ランキング（docs/MARKET_RANKING_PLAN.md）。
-- 市場の中身（企業の状態・同期の状態機械）は Durable Object（MarketRoom）が権威。D1 には一覧・集計・記録だけを置く。
-- 時刻はすべて UNIX エポックのミリ秒。期間は JST の日付（'YYYY-MM-DD'）。何度実行しても同じ結果になる文だけを書く。

-- コミュニティの設定（仕様書 6.1。公開の一覧・参加の条件に使う。中身の権威は Durable Object）
CREATE TABLE IF NOT EXISTS communities (
  market_id TEXT PRIMARY KEY REFERENCES markets(id),
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'invite' CHECK (visibility IN ('public', 'invite')),
  entry TEXT NOT NULL DEFAULT 'grown' CHECK (entry IN ('grown', 'fresh')),
  ai_fill INTEGER NOT NULL DEFAULT 1,
  max_companies INTEGER NOT NULL DEFAULT 6,
  period_days INTEGER,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER
);
CREATE INDEX IF NOT EXISTS communities_public ON communities(visibility, ends_at);

-- プレイヤーの市場の企業（1人5社まで。どの市場にいるか）。status は core の CompanyStatus
CREATE TABLE IF NOT EXISTS market_companies (
  market_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (market_id, company_id)
);
CREATE INDEX IF NOT EXISTS market_companies_player ON market_companies(player_id, status);

-- 企業ごと・JST の期間（1日）ごとの集計（ランキングのもと。0時の同期で1回だけ書く。同じ行の書き直しは同じ値）。
-- 上限を超えた日（flagged_days）は数に入れない。entry は集計した時点のコミュニティの種類（全体ランキングを分ける）
CREATE TABLE IF NOT EXISTS company_periods (
  market_id TEXT NOT NULL,
  company_id TEXT NOT NULL,
  period TEXT NOT NULL,
  entry TEXT NOT NULL,
  kind TEXT NOT NULL,
  player_id TEXT,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  manual_days INTEGER NOT NULL,
  auto_days INTEGER NOT NULL,
  flagged_days INTEGER NOT NULL,
  net_sales INTEGER NOT NULL,
  operating_profit INTEGER NOT NULL,
  final_profit INTEGER NOT NULL,
  served INTEGER NOT NULL,
  customers INTEGER NOT NULL,
  satisfaction_sum REAL NOT NULL,
  satisfaction_count INTEGER NOT NULL,
  market_net_sales INTEGER NOT NULL,
  money_end INTEGER NOT NULL,
  debt_end INTEGER NOT NULL,
  stores INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (market_id, company_id, period)
);
CREATE INDEX IF NOT EXISTS company_periods_period ON company_periods(entry, period);

-- 0時の同期の記録（市場 × 期間）
CREATE TABLE IF NOT EXISTS sync_runs (
  market_id TEXT NOT NULL,
  period TEXT NOT NULL,
  target_date INTEGER,
  auto_days INTEGER NOT NULL,
  expired_days INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (market_id, period)
);
