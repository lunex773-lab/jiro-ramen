-- 共通市場の街（日本地図の出店マップ。docs/STORE_MAP_PLAN.md。オーナーの判断「市場は1つの街」）。
-- 市区町村のコード（5桁）。前の市場には行がない。何度実行しても壊れないよう、列を足さずに別の表にする
CREATE TABLE IF NOT EXISTS community_cities (
  market_id TEXT PRIMARY KEY REFERENCES markets(id),
  city_code TEXT NOT NULL
);
