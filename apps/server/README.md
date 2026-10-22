# @jiro/server — 共同経営バックエンド（Cloudflare）

Cloudflare Workers + Durable Objects + D1 + R2 で動く、次郎系ラーメン経営ゲームのバックエンドです。
設計書の 2.2 / 2.3 / 16.4 / 17 / 18 に対応します。デプロイ手順は [docs/CLOUDFLARE_SETUP.md](../../docs/CLOUDFLARE_SETUP.md) を参照してください。

## 構成

```
クライアント ──HTTP──▶ Worker（src/index.ts）
                        ├─ 認証（匿名アカウント・Bearer トークン）……… D1 players
                        ├─ クラウドセーブ ……………………………………… D1 save_slots + R2 saves/
                        ├─ ルーム作成・参加・退出 ……………………………… D1 rooms / room_members
                        ├─ CORS・本文サイズ制限・入力検証・レート制限・監査記録（D1 audit_log）
                        └─ WebSocket 接続: joinToken を検証して ──▶ GameRoom（Durable Object, src/room.ts）
                                                                     1ルーム = 1インスタンス（idFromName(roomId)）
                                                                     状態の確定・シミュレーション・差分配信
                                                                     チェックポイント（DO の SQLite）
                                                                     ルームの保存（R2 rooms/）
```

| ファイル | 内容 |
| --- | --- |
| `src/index.ts` | ルーティング、CORS、HTTP のレート制限、エラー処理 |
| `src/api/account.ts` | `POST /api/v1/auth/anonymous`、`GET /api/v1/profile`、`GET /api/v1/game-version` |
| `src/api/saves.ts` | `POST /api/v1/save`、`GET`/`DELETE /api/v1/save/:slot`（競合検出・3世代保持） |
| `src/api/session.ts` | `POST /api/v1/session/{create,join,leave}`、`GET /api/v1/room/:roomId/ws` |
| `src/room.ts` | `GameRoom`（Durable Object）。WebSocket プロトコルのサーバー側 |
| `src/checkpoint.ts` | チェックポイントの断片化・検証、requestId の重複検出キャッシュ |
| `src/protocol.ts` | クライアントメッセージ・操作要求の形式検証 |
| `src/auth.ts` | アカウントトークン（SHA-256 ハッシュで保存）、joinToken（HMAC-SHA256、10分） |
| `src/ratelimit.ts` | トークンバケット（HTTP は isolate 内メモリ、WebSocket は接続ごと） |
| `migrations/0001_init.sql` | D1 のスキーマ |

## HTTP API（すべて JSON）

エラーは `{"error": "<日本語メッセージ>", "code": "<種別>"}`。認証が必要な API は `Authorization: Bearer <token>`。

| メソッドとパス | 本文 → 応答 |
| --- | --- |
| `GET /api/v1/game-version` | → `{gameVersion, minClientVersion, protocol}` |
| `POST /api/v1/auth/anonymous` | `{name}` → `201 {playerId, token, name}`（トークンは一度だけ返る） |
| `GET /api/v1/profile` | → `{playerId, name, createdAt, slots:[{slot, saveId, revision, checksum, updatedAt, meta}]}`（401 ならトークン無効） |
| `POST /api/v1/save` | `{slot, save: SaveFile, baseRevision}` → `{slot, revision, checksum, saveId, updatedAt}`。競合は `409 {code:'conflict', cloud:{revision, saveId, checksum, meta, updatedAt}}`、破損は `422` |
| `GET /api/v1/save/:slot` | → `{slot, revision, updatedAt, save}` |
| `DELETE /api/v1/save/:slot` | → `{ok, slot}` |
| `POST /api/v1/session/create` | `{}` → `{roomId, code, joinToken, expiresAt, isHost:true}` |
| `POST /api/v1/session/join` | `{code}`（または `{roomId}`）→ `{roomId, code, joinToken, expiresAt, isHost}`。ルーム作成者が呼ぶと `isHost:true` のまま（再接続用） |
| `POST /api/v1/session/leave` | `{roomId}` → `{ok, ended}`。ホストが退出するとルームは終了する |
| `GET /api/v1/room/:roomId/ws?token=<joinToken>` | WebSocket（下記） |

## WebSocket のメッセージの流れ（`@jiro/core` の `net.ts`）

```
クライアント                         GameRoom
  hello{name, protocol, clientVersion} ─▶  バージョン確認・席の割り当て（最大4人。同じプレイヤーの再接続は古い接続を置き換え）
                                     ◀─  welcome{playerId, isHost, needInit}, layoutLock, peers
（ホストで needInit のとき）
  hostInit{state}                    ─▶  validateState で検証 → 状態を確定
                                     ◀─  welcome（playerId = 状態の中のホストID。単独プレイのキャリアなら 'p1'）, full{seq, state}
                                     ◀─  patch{from, to, ops, ev, h?}  … 5Hz。h（チェックサム）は約2秒ごと
  act{rid, a, v}                     ─▶  rid の重複検出 → 権限・ロック確認 → applyAction
                                     ◀─  res{rid, r}
  resync                             ─▶  ◀─ full
  save{rid}（ホストのみ）             ─▶  ◀─ saved{rid, ok, state, checksum}（R2 rooms/<roomId>/ にも控え）
  layoutLock{on}                     ─▶  ◀─ layoutLock{holder}（全員へ）
  ping{ts}                           ─▶  ◀─ pong{ts, serverTime}
```

- `welcome.playerId` は **状態（GameState.players）の中の自分のID**。ゲストはアカウントの playerId、ホストは持ち込んだキャリアのプレイヤーID。
- `act.v` には最後に適用した `seq` を入れる（大きく遅れていれば全体を送り直す）。
- `move` 以外の `rid` はプレイヤーごとに直近200件の結果を覚えていて、再送には前回の結果を返す（再適用しない）。この記録はチェックポイントにも含まれるので、ルームが再起動しても二重適用しない。
- ホストが切断すると `paused` を全員へ送り、シミュレーションを止める（ゲストの操作も受け付けない）。ホストが戻ると `resumed`。
- `place` / `store` / `seatOffset` はレイアウト編集ロックを持つ人だけが実行できる。切断するとロックは外れる。
- エラーは `{t:'error', code, message}`。close コード: 4000 置き換え / 4001 バージョン違い / 4003 満員 / 4004 ルーム終了 / 4008 送信過多 / 4010 hello なし。

## 永続化

- **チェックポイント**: DO の SQLite に、状態の JSON を 64K 文字ごとの断片で保存（KV 型 API の 1 値 128 KiB 上限を避けるため）。
  約10秒ごと・閉店（closed）時・ホスト切断時・保存時・参加/切断時に書く。全体のチェックサムで破損を検出し、壊れていたら推測で続行せず、ホストにキャリアを持ち込み直してもらう（`needInit: true`）。
- **休止（Hibernation）**: WebSocket は Hibernation API で受ける。ループ（`setInterval`）が動いている間は休止しないが、ホスト不在で一時停止中・無人のときはループを止めるので休止でき、実行時間の課金が止まる。復帰時はチェックポイントから戻して全員に `full` を送る。
- **無人ルームの終了**: 誰も接続しないまま24時間たつとアラームで終了し、最終状態を R2 に残す。

## 開発・テスト

```bash
# リポジトリのルートで
npm ci
npm test -w @jiro/server          # vitest + @cloudflare/vitest-pool-workers（workerd 上で実行。D1/R2/DO もローカル）
npm run typecheck -w @jiro/server

# ローカルサーバー
cd apps/server
cp .dev.vars.example .dev.vars     # SESSION_SECRET を書き換える
npm run db:migrate:local
npx wrangler dev                   # http://localhost:8787
node scripts/smoke.mjs             # 別ターミナルで疎通確認（ホスト＋ゲストで接続・操作・保存・退出）

npm run deploy:dry                 # バンドルの確認（ネットワーク不要）
```

テストは `test/` にあります（HTTP・セーブ・セッション・ルームの WebSocket・単体テスト）。
ルームのテストは実際に WebSocket で接続し、受信したパッチを core の `applyPatch` で当てた結果が `full` と一致するか、
同じ requestId の再送で資金が二重に減らないか、ホスト切断で一時停止・再開するか、Durable Object の退避後に復元できるか、などを確認しています。
