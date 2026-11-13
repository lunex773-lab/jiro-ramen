-- ひとりプレイ・共同経営のクラウドセーブを廃止する（オーナーの判断 2026-11-13）。サーバーに保存してあったデータも消す。
-- クラウドセーブはオンライン市場だけ（市場の会社の状態と途中のセーブは、市場の Durable Object の中にある）。
-- 何度実行しても同じ結果になる書き方（DROP ... IF EXISTS）
DROP TABLE IF EXISTS save_bodies;
DROP TABLE IF EXISTS save_slots;
DROP TABLE IF EXISTS room_snapshots;
