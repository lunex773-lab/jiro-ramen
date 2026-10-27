-- 初期スキーマ（設計書 2.2 D1 の担当: プロフィール、セーブ、ルーム記録、監査記録）。
-- リアルタイムの状態同期には使わない。
-- R2 は使わず（オーナーの判断。docs/adr/ADR-002-no-r2.md）、セーブ本体も D1 に置く（1行 2MB までなのでサーバーで上限を設ける）。
-- 時刻はすべて UNIX エポックのミリ秒。
-- この内容は src/schema.ts の MIGRATIONS と同じにすること（Worker が起動時に自分で適用する。テストで一致を確認している）。

-- プレイヤー（匿名アカウント）。トークンそのものは保存せず SHA-256 のハッシュだけを持つ
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- クラウドセーブのスロット（1〜3）。revision は競合検出に使う世代番号
CREATE TABLE IF NOT EXISTS save_slots (
  player_id TEXT NOT NULL REFERENCES players(id),
  slot INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  save_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, slot)
);

-- クラウドセーブの本体（SaveFile の JSON）。スロットごとに直近 3 世代を残す
CREATE TABLE IF NOT EXISTS save_bodies (
  player_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, slot, revision)
);

-- 共同経営ルーム。status は 'open'（参加可能）か 'ended'（終了）
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  host_id TEXT NOT NULL REFERENCES players(id),
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('open', 'ended'))
);
-- 参加コードは「開いているルームの中で」一意（終了したルームのコードは再利用できる）
CREATE UNIQUE INDEX IF NOT EXISTS rooms_open_code ON rooms(code) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS rooms_host ON rooms(host_id, created_at);

-- ルームの参加記録
CREATE TABLE IF NOT EXISTS room_members (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, player_id)
);
CREATE INDEX IF NOT EXISTS room_members_player ON room_members(player_id);

-- 共同経営の保存の控え（kind = 'save': ホストが保存したとき、'final': ルームを終えたとき）
CREATE TABLE IF NOT EXISTS room_snapshots (
  room_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('save', 'final')),
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, kind, revision)
);
CREATE INDEX IF NOT EXISTS room_snapshots_created ON room_snapshots(created_at);

-- 監査記録（不正操作・重要イベント）。トークンなどの機密情報は detail に入れない
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  player_id TEXT,
  room_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_ts ON audit_log(ts);
CREATE INDEX IF NOT EXISTS audit_log_player ON audit_log(player_id, ts);
CREATE INDEX IF NOT EXISTS audit_log_room ON audit_log(room_id, ts);
