-- オンライン市場（統合進化設計書 v2.1 Phase 3+4）。市場の中身（企業・店舗・時計）は Durable Object（MarketRoom）が持ち、
-- D1 には招待コードと参加の記録だけを置く（D1 と Durable Object の更新を1つのトランザクションとはみなさない）。
-- 時刻はすべて UNIX エポックのミリ秒。

-- 市場。status は 'open'（参加できる）か 'ended'（終了）
CREATE TABLE IF NOT EXISTS markets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES players(id),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'ended'))
);
-- 招待コードは開いている市場の中で一意
CREATE UNIQUE INDEX IF NOT EXISTS markets_open_code ON markets(code) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS markets_owner ON markets(owner_id, created_at);

-- 市場への参加の記録（プレイヤーの企業は市場の中に1社）
CREATE TABLE IF NOT EXISTS market_members (
  market_id TEXT NOT NULL REFERENCES markets(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (market_id, player_id)
);
CREATE INDEX IF NOT EXISTS market_members_player ON market_members(player_id, joined_at);
