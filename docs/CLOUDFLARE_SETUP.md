# Cloudflare バックエンドのセットアップ手順

共同経営（最大4人）とクラウドセーブ用のサーバー（`apps/server`）を Cloudflare にデプロイし、
ブラウザ版クライアント（GitHub Pages）から使えるようにするまでの手順です。

> **この文書の前提と確認状況**
>
> - サーバーのコードは、この開発環境のローカル（workerd / Miniflare）で動作を確認済みです。
>   自動テスト 58 件（HTTP API・セーブ・ルーム・WebSocket・永続化）、`wrangler dev` 上での疎通確認スクリプト、
>   `wrangler deploy --dry-run`（バンドルの確認）が通っています。
> - **本番の Cloudflare へのデプロイは未検証です。** 開発に使った Claude Code のクラウド環境からは
>   `api.cloudflare.com`・`developers.cloudflare.com` への通信がネットワーク設定で遮断されていたため、
>   デプロイも公式ドキュメントの閲覧もできませんでした（第6章）。
> - API の使い方は、インストールした `wrangler` 4.151.3・`@cloudflare/workers-types`・`@cloudflare/vitest-pool-workers`
>   に同梱の型定義と設定スキーマで確認しました。**料金・無料枠・プランの条件の数値は確認できていません。**
>   本文中の「（要確認）」の箇所は、デプロイ前に公式ドキュメント（https://developers.cloudflare.com/ ）で確かめてください。

---

## 0. Wrangler を実行する場所（重要）

このリポジトリは npm workspaces のモノレポです。Cloudflare にデプロイするのは **`apps/server`（Worker）だけ**で、
ブラウザ版クライアント（`apps/client` のビルド結果 `apps/client/dist`）は GitHub Pages で公開します（`.github/workflows/pages.yml`）。
Wrangler の設定ファイルは `apps/server/wrangler.jsonc` の1つだけです。

| やりたいこと | 実行する場所とコマンド |
| --- | --- |
| サーバーをデプロイする | `apps/server` で `npx wrangler deploy`、またはリポジトリのルートで `npm run deploy:server` |
| デプロイ前の確認（アップロードしない） | `apps/server` で `npx wrangler deploy --dry-run --outdir dist`、またはルートで `npm run deploy:server:dry` |
| その他の Wrangler コマンド（`d1`・`r2`・`secret`・`tail`） | `cd apps/server` してから実行 |

- リポジトリの**ルートで `npx wrangler deploy` を実行しないでください**。ルートには Wrangler の設定ファイルがないため、
  Wrangler の自動構成（フレームワークの検出）が動き、次のエラーで止まります。
  ```
  ✘ [ERROR] The Cloudflare application detection logic has been run in the root of a workspace instead of targeting a specific project. Change your working directory to one of the applications in the workspace and try again.
  ```
- ルートで `npx wrangler` を実行すると、テスト用パッケージ（`@cloudflare/vitest-pool-workers`）の依存として入った
  別のバージョンの Wrangler が使われます（2026-10-27 時点で 4.124.0）。`apps/server` で実行するか `npm run deploy:server` を使うと、
  `apps/server/package.json` で指定したバージョン（4.151.3）が使われます。
- **このリポジトリは Cloudflare のダッシュボードの GitHub 連携でデプロイします。手順は 2.10 です。** 2.1〜2.8 はパソコンからコマンドでデプロイする場合の手順です。

---

## 1. 必要なもの

| もの | 内容 |
| --- | --- |
| Cloudflare アカウント | 無料で作成できます（https://dash.cloudflare.com/sign-up ）。独自ドメインは不要です（`*.workers.dev` の URL で動きます） |
| Workers のプラン | Durable Objects は **SQLite ストレージ方式**（`wrangler.jsonc` の `new_sqlite_classes`）で登録しています。この方式は Workers 無料プランでも使える、というのが筆者の知識です（**要確認**）。旧来の KV ストレージ方式の Durable Objects は有料プラン（Workers Paid）が必要です |
| D1 | 無料プランで使えます（データベース数・読み書き行数に上限あり。**要確認**） |
| R2 | 初回はダッシュボードで R2 を有効化する必要があります。有効化の際に支払い情報の登録を求められることがあります（無料枠内なら課金されない、というのが筆者の知識です。**要確認**） |
| パソコン | Node.js 22 以上、Git。Windows / macOS / Linux のどれでも可 |

---

## 2. デプロイ手順（ご自身のパソコンから）

コマンドはすべて、リポジトリを取得したフォルダで実行します。

### 2.1 準備

```bash
git clone https://github.com/lunex773-lab/jiro-ramen.git
cd jiro-ramen
git checkout SecondAKIRA        # 作業ブランチ（必要に応じて）
npm ci                          # 依存パッケージをインストール（wrangler も入ります）
cd apps/server
```

### 2.2 Cloudflare にログインする

どちらか一方で構いません。

**A. ブラウザでログイン（自分のパソコンならこちらが簡単）**

```bash
npx wrangler login              # ブラウザが開くので「Allow」を押す
npx wrangler whoami             # アカウント名とアカウントID が表示されれば OK
```

**B. API トークンを使う（CI やクラウド環境から使う場合）**

1. ダッシュボード → 右上のアイコン → **My Profile → API Tokens → Create Token**
2. 「Edit Cloudflare Workers」テンプレートを元に、次の権限を付けます（権限名は**要確認**）
   - Account → **Workers Scripts: Edit**（Worker と Durable Objects のデプロイ）
   - Account → **D1: Edit**
   - Account → **Workers R2 Storage: Edit**
   - Account → **Account Settings: Read**
   - （ログを見るなら）Account → **Workers Tail: Read**
   - 対象アカウントは自分のアカウントだけに絞ってください
3. 環境変数に設定します（トークンはリポジトリやチャットに貼らないこと）

```bash
export CLOUDFLARE_API_TOKEN=（作成したトークン）
export CLOUDFLARE_ACCOUNT_ID=（ダッシュボードの Workers & Pages 画面右側に表示されるアカウントID）
```

### 2.3 D1 データベースを作る

```bash
npx wrangler d1 create jiro-db
```

表示される `database_id`（`xxxxxxxx-xxxx-...` の形式）を、`apps/server/wrangler.jsonc` の

```jsonc
"database_id": "00000000-0000-0000-0000-000000000000",
```

と置き換えて保存します（この値は秘密情報ではないので、コミットして構いません）。

### 2.4 R2 バケットを作る

初めて R2 を使う場合は、先にダッシュボードの **R2 Object Storage** を開いて有効化してください。

```bash
npx wrangler r2 bucket create jiro-saves
```

### 2.5 データベースのテーブルを作る

```bash
npx wrangler d1 migrations apply jiro-db --remote
```

`0001_init.sql` が ✅ になれば完了です。

### 2.6 秘密鍵（SESSION_SECRET）を設定する

ルームへの参加トークンの署名に使う鍵です。32文字以上のランダムな文字列にします。

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"   # 鍵を作る
npx wrangler secret put SESSION_SECRET                                           # 聞かれたら上の文字列を貼る
```

- この鍵はリポジトリに書かないでください（`wrangler.jsonc` の `vars` にも書かない）。
- 鍵を変えると、発行済みの参加トークン（有効期限10分）が使えなくなるだけで、アカウントやセーブには影響しません。

### 2.7 接続を許可するオリジンを確認する

`apps/server/wrangler.jsonc` の `ALLOWED_ORIGINS` に、クライアントを公開する URL の**オリジン**（`https://ホスト名[:ポート]`、パスは含めない）をカンマ区切りで書きます。

```jsonc
"ALLOWED_ORIGINS": "https://lunex773-lab.github.io,http://localhost:5173"
```

GitHub Pages の `https://lunex773-lab.github.io/jiro-ramen/` から使う場合も、オリジンは `https://lunex773-lab.github.io` です。
ここにないオリジンのブラウザからの要求は 403 で拒否されます。

### 2.8 デプロイする

```bash
npx wrangler deploy                 # apps/server で実行する
# または、リポジトリのルートで
npm run deploy:server
```

- 先に `npx wrangler deploy --dry-run --outdir dist`（ルートでは `npm run deploy:server:dry`）で、アップロードせずに設定とバンドルを確認できます。
- `wrangler deploy` は、同じ名前（`wrangler.jsonc` の `name` = `jiro-ramen-server`）の Worker のコードを置き換えます。
  ダッシュボードの **Workers & Pages** で、同じ名前の Worker を別の用途に使っていないか確認してください。
- ダッシュボードで追加した**平文の変数**は、デプロイのたびに `wrangler.jsonc` の `vars` で置き換えられます（Secret は残ります）。

初回は `workers.dev` のサブドメイン登録を聞かれることがあります。完了すると次のような URL が表示されます。

```
https://jiro-ramen-server.<あなたのサブドメイン>.workers.dev
```

### 2.9 動作確認

```bash
curl https://jiro-ramen-server.<サブドメイン>.workers.dev/api/v1/game-version
# → {"gameVersion":"0.9.0","minClientVersion":"0.1.0","protocol":1}

node scripts/smoke.mjs https://jiro-ramen-server.<サブドメイン>.workers.dev
# → ホストとゲストで接続し、操作・保存・退出まで行って "smoke test passed" と表示されれば OK
```

### 2.10 ダッシュボードから GitHub 連携でデプロイする場合（Workers Builds）

**このリポジトリのデプロイ方法です**（オーナー確認済み）。パソコンでコマンドを打たずに、Cloudflare のダッシュボードだけで準備できます。
ダッシュボードの画面名は変わることがあるので、見つからないときは近い名前の項目を探してください。

#### (1) D1 データベースを作る

1. ダッシュボード → **Storage & Databases → D1 SQL Database → Create** で、名前を `jiro-db` にして作成します。
2. 表示される **Database ID**（`xxxxxxxx-xxxx-...` の形式）を、`apps/server/wrangler.jsonc` の `"database_id"` に書いてコミットします
   （秘密情報ではありません）。`00000000-...` のままだとデプロイに失敗します。
3. テーブルは (4) のデプロイコマンドが自動で作ります（D1 の画面で SQL を実行する必要はありません）。

#### (2) R2 バケットを作る

1. ダッシュボード → **R2 Object Storage**。初めてなら R2 を有効化します（支払い情報の登録を求められることがあります。料金は第5章）。
2. **Create bucket** で、名前を `jiro-saves` にして作成します。

#### (3) ビルド用の API トークンに D1 の権限を足す

Workers Builds が自動で作る API トークンには、D1 の権限が含まれていません（Workers Scripts・KV・R2 の編集権限のみ）。
テーブルを自動で作るために、D1 の編集権限を足してください。

1. ダッシュボード右上のアイコン → **My Profile → API Tokens** で、Workers Builds 用に作られたトークンの **Edit** を開きます
   （Worker の **Settings → Build** の「API token」に表示されているトークンです）。
2. **Permissions** に **Account → D1 → Edit** を追加して保存します。

#### (4) ビルドの設定

Worker の **Settings → Build → Build configuration** を次のようにします。

| 項目 | 設定値 | 理由 |
| --- | --- | --- |
| Root directory（Path） | `apps/server` | Wrangler の設定ファイルがある場所。既定のルート（`/`）のままだと、0章のエラーになる |
| Build command | 空欄 | Worker は `wrangler deploy` がバンドルする。ルートの `npm run build` はクライアント（GitHub Pages 用）のビルドで、Worker には不要 |
| Deploy command | `npm run deploy:migrate` | D1 のテーブルを最新にしてから（`wrangler d1 migrations apply jiro-db --remote`）デプロイする（`wrangler deploy`）。適用済みなら何もしない |
| Preview（プレビュー）用のコマンド | 既定のまま | 本番ブランチ以外のプレビュー。Root directory で実行される |
| Build watch paths | 既定（すべて）のまま | サーバーは `packages/core` も使うので、`apps/server` だけに絞らない |

- 依存パッケージは、ルートの `package-lock.json` を使って入ります（npm は `apps/server` からでもワークスペースのルートを見つけてインストールします）。
- **Worker の名前**: Workers Builds は、ダッシュボード上の Worker の名前でデプロイします（`wrangler.jsonc` の `name` より優先）。
  URL は `https://<ダッシュボード上の Worker 名>.<サブドメイン>.workers.dev` になります。

#### (5) 秘密鍵（SESSION_SECRET）を設定する

Worker の **Settings → Variables and Secrets → Add** で、**Type: Secret**、**Variable name: `SESSION_SECRET`**、
**Value: 32文字以上のランダムな英数字**（パスワード管理アプリの生成機能などで作る）を追加します。
ビルド用の「Build variables and secrets」ではなく、こちらに追加してください。デプロイしても消えません。

#### (6) デプロイと確認

1. Worker の **Deployments**（または **Builds**）で、失敗したビルドを **Retry** するか、GitHub に push します。
2. 成功したら、ブラウザで `https://<Worker 名>.<サブドメイン>.workers.dev/api/v1/game-version` を開き、
   `{"gameVersion":"0.9.0",...}` と表示されれば動いています。
3. GitHub のリポジトリ → **Settings → Secrets and variables → Actions → Variables** に `VITE_SERVER_URL`（上の URL のうち
   `https://…workers.dev` まで。末尾のスラッシュなし）を追加し、Actions の「GitHub Pages」を **Run workflow** で実行し直します（3章）。

#### ルートのまま使いたい場合

Root directory を `/` のままにする場合は、Deploy command を `npm run deploy:server` にします（テーブルの自動作成は行わないので、
別途 `apps/server` で `npm run db:migrate:remote` を実行してください）。

---

## 3. クライアントの設定

クライアントはサーバーの URL を `VITE_SERVER_URL`（ビルド時の環境変数）から読みます。**末尾のスラッシュなし**で指定します。

```
VITE_SERVER_URL=https://jiro-ramen-server.<サブドメイン>.workers.dev
```

- **GitHub Pages で公開する場合**: GitHub のリポジトリ → **Settings → Secrets and variables → Actions → Variables** に
  `VITE_SERVER_URL` を追加し、「GitHub Pages」ワークフローを実行し直します（`.github/workflows/pages.yml` が読み込みます）。
- **ローカル開発**: `apps/client/.env.local` に `VITE_SERVER_URL=http://localhost:8787` と書き、`npm run dev:server` と `npm run dev` を両方起動します。
- ビルドに埋め込まなくても、ゲームのロビー画面でサーバーの URL を入力できます（入力した URL はブラウザに記憶されます）。
- GitHub Pages は https なので、サーバーも https（`workers.dev` は https）である必要があります。

クライアントが使うエンドポイント:

| 用途 | パス |
| --- | --- |
| バージョン確認 | `GET /api/v1/game-version` |
| 匿名アカウント作成 | `POST /api/v1/auth/anonymous` `{name}` → `{playerId, token}` |
| トークンの確認 | `GET /api/v1/profile`（`Authorization: Bearer <token>`、無効なら 401） |
| ルーム作成 / 参加 / 退出 | `POST /api/v1/session/create` `{}` / `join` `{code}` / `leave` `{roomId}` |
| クラウドセーブ | `POST /api/v1/save`、`GET /api/v1/save/:slot`、`DELETE /api/v1/save/:slot` |
| 共同経営の接続 | `wss://<サーバー>/api/v1/room/<roomId>/ws?token=<joinToken>` |

詳しい仕様は [apps/server/README.md](../apps/server/README.md) にあります。

---

## 4. ログの確認

```bash
cd apps/server
npx wrangler tail                    # 本番のログをリアルタイムに表示（Ctrl+C で終了）
npx wrangler tail --format pretty
```

- ダッシュボードの **Workers & Pages → jiro-ramen-server → Logs** でも見られます（`wrangler.jsonc` で `observability` を有効にしています）。
- サーバーは JSON 形式でログを出します（例: `{"level":"error","msg":"checkpoint_corrupt",...}`）。トークンや Authorization ヘッダーは出力しません。
- ただし WebSocket の接続 URL には参加トークン（`?token=`）が含まれるため、リクエストの URL を表示するログには写ります。
  有効期限10分・ルーム限定のトークンですが、ログを第三者に共有しないでください。
- 重要な出来事（アカウント作成、ルーム作成・終了、保存、競合、不正な操作、レート制限）は D1 の `audit_log` テーブルに残ります。

```bash
npx wrangler d1 execute jiro-db --remote --command "SELECT ts, kind, player_id, room_id, detail FROM audit_log ORDER BY id DESC LIMIT 20"
```

---

## 5. 料金の考え方

> 料金表・無料枠の数値は確認できていません（**要確認**: https://developers.cloudflare.com/durable-objects/platform/pricing/ など）。
> ここでは「何に対して課金されるか」と、このサーバーの実測値を示します。

### 5.1 Durable Objects（共同経営ルーム）

- **実行時間（duration）**: ルームのシミュレーションが動いている間（ホストが接続していて一時停止していない間）は、
  10Hz のタイマー（`setInterval`）が動き続けるため、Durable Object は休止できず、**その間ずっと実行時間の課金対象**になります。
  実行時間は「メモリ量（128MB として計算される、というのが筆者の知識。要確認）× 経過秒数」で数えられます。
  目安: 1ルームを1時間動かすと 0.125GB × 3600秒 = **450 GB 秒**。
- **休止（Hibernation）**: WebSocket は Hibernation API で受けています。ホストが切断して一時停止中のルームや、
  誰もいないルームはタイマーを止めるので休止でき、その間は実行時間の課金が止まります（ローカルのテストで、タイマーが止まっていれば
  WebSocket を保ったまま休止・復帰できることを確認済み）。
- **リクエスト数**: クライアントから届く WebSocket メッセージもリクエストとして数えられます（複数メッセージで1リクエスト換算、という
  のが筆者の知識。比率は要確認）。クライアントは移動中だけ最大 12.5 回/秒の移動要求を送るので、4人が動き回ると約50メッセージ/秒です。
- **サーバーからの配信**（パッチ）は 5 回/秒、1クライアントあたり平均約 8KB/秒（ローカルで営業日を1日回して計測）。
- **CPU**: 1ティック（シミュレーション0.1秒分＋差分作成）は中央値 0.6ms、95% で 2ms、最大 21ms（ローカルの Node.js で計測）。
- ルームの状態は約10秒ごとに Durable Object の SQLite に保存します（1回あたり数行の書き込み）。

**費用を抑えるには**: 遊び終わったらホストが「退出」する（ルームが終了し、タイマーが止まります）。
放置されたルームも、誰も接続しないまま24時間たつと自動で終了します。

### 5.2 その他

| サービス | 主な課金対象 | このゲームでの使い方 |
| --- | --- | --- |
| Workers | リクエスト数・CPU 時間 | API 呼び出し（ログイン、ルーム作成・参加、セーブ） |
| D1 | 読み取り行数・書き込み行数・保存容量 | アカウント、セーブのメタデータ、ルーム記録、監査記録。リアルタイムの同期には使わない |
| R2 | 保存容量・操作回数（取り出しの転送量は無料、というのが筆者の知識。要確認） | セーブ本体（1スロット直近3世代）、共同経営の保存の控え |

無料プランの Workers は 1 リクエストあたりの CPU 時間の上限が小さい（10ms、というのが筆者の知識。要確認）ため、
非常に大きなセーブデータ（数百KB以上）のアップロードでは上限を超える可能性があります。通常のセーブは 20〜30KB 程度です。

---

## 6. Claude Code のクラウド環境からデプロイする場合

開発に使った Claude Code のクラウド環境（claude.ai/code）では、次のホストへの通信がネットワーク設定で遮断されていたため、
デプロイできませんでした（2026-10-27 時点では `api.cloudflare.com` には到達できるようになりましたが、
Cloudflare の認証情報（API トークン）が環境に設定されていないため、引き続きデプロイはできません）。

- `api.cloudflare.com`（デプロイ・D1・R2 の操作に必要）
- `developers.cloudflare.com`（公式ドキュメント）
- `workers.cloudflare.com`（`wrangler dev` が `Request.cf` の見本を取りに行く先。遮断されていても警告が出るだけで動きます）

方法は2つあります。

1. **ご自身のパソコンからデプロイする（おすすめ）**: 第2章の手順をそのまま実行してください。トークンをクラウドに置かずに済みます。
2. **クラウド環境の設定を変える**: セッションのタイトルバーにあるクラウド環境のメニュー → **Edit** で
   - **Network access** を広いレベルにするか、**Allowed domains** に `api.cloudflare.com`（必要なら `developers.cloudflare.com`、
     デプロイ後の確認用に `*.workers.dev`）を追加します（「Allow package managers」はチェックしたまま）。
     手順: https://code.claude.com/docs/en/cloud-environments#network-access
   - API トークン（2.2 B の権限）を環境の **Network secrets**（古いアプリでは API credentials）か環境変数
     `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` として登録します。新しいセッションから使えるようになります。
   - トークンはデプロイ（書き込み）ができる強い権限なので、対象アカウントを絞り、不要になったら削除してください。
     チャットにトークンを貼り付けないでください。

---

## 7. トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| `The Cloudflare application detection logic has been run in the root of a workspace instead of targeting a specific project.` | リポジトリのルートで `wrangler deploy` を実行している（0章）。`apps/server` で実行するか、ルートで `npm run deploy:server`。ダッシュボードの GitHub 連携なら Root directory を `apps/server` にする（2.10） |
| ダッシュボードの GitHub 連携で `Missing entry-point` | Root directory が `apps/server` になっていない（2.10） |
| ダッシュボードの GitHub 連携で、`d1 migrations apply` が認証・権限のエラー（code: 10000 など）になる | ビルド用の API トークンに D1 の権限がない。2.10 (3) で **Account → D1 → Edit** を追加する |
| `wrangler deploy` で D1 のエラー（database not found など） | `wrangler.jsonc` の `database_id` が `00000000-...` のまま。2.3 の値に置き換える |
| `no such table: players` などのエラー | 本番のマイグレーション未実行。`npx wrangler d1 migrations apply jiro-db --remote` |
| R2 のエラー（R2 を有効にしてください、など） | ダッシュボードで R2 を有効化してから `wrangler r2 bucket create jiro-saves` |
| Durable Objects に有料プランが必要と言われる | `migrations` が `new_sqlite_classes` になっているか確認。それでも出る場合はプランの条件を公式で確認（有料プランへの変更が必要な可能性） |
| API が `{"error":"SESSION_SECRET が設定されていません…","code":"server_misconfigured"}` を返す | 2.6 の `wrangler secret put SESSION_SECRET` を実行（32文字以上） |
| ブラウザで CORS エラー / 403 `origin_not_allowed` | `ALLOWED_ORIGINS` にページのオリジン（`https://…` のホスト部分だけ、末尾スラッシュなし）を追加して再デプロイ |
| ブラウザから接続できない（Mixed Content） | https のページから http のサーバーには接続できない。`VITE_SERVER_URL` を https の URL にする |
| WebSocket が 401 で切れる | 参加トークンの期限切れ（10分）。クライアントは自動で `session/join` し直します。繰り返す場合はサーバーの `SESSION_SECRET` を変えていないか確認 |
| `room_full` | 1ルームの同時接続は4人まで。誰かが抜けると入れます |
| `client_outdated` / `protocol_mismatch` | クライアントが古い。ページを再読み込み。サーバーの `MIN_CLIENT_VERSION` を上げた場合は、クライアントも更新して公開する |
| 429 `rate_limited` | 短時間に要求が多すぎる。少し待つ（`Retry-After` ヘッダーの秒数） |
| `wrangler dev` で `Unable to fetch the Request.cf object` | ネットワークが遮断されている環境での警告。動作には影響しません |
| `compatibility_date` が新しすぎると言われる | 古い wrangler を使っている。`npm ci` でリポジトリ指定のバージョンを入れる |
| ホストが切断したら全員止まった | 仕様です（設計書 17.7）。ホストが同じコードで参加し直すと、状態を保ったまま再開します |

---

## 8. 運用メモ

- **更新**: コードを変更したら `cd apps/server && npx wrangler deploy`。デプロイすると接続中の WebSocket は切れますが、
  クライアントは自動で再接続し、ルームは約10秒ごとのチェックポイントから再開します（最大で約10秒分の進行が戻る可能性があります）。
- **テーブルの変更**: `apps/server/migrations/0002_*.sql` を追加し、`npx wrangler d1 migrations apply jiro-db --remote`。
- **クライアントの最低バージョン**: 互換性のない変更をしたら `wrangler.jsonc` の `MIN_CLIENT_VERSION` を上げてデプロイ。
  古いクライアントは共同経営に接続できなくなります（`client_outdated`）。
- **レート制限**: HTTP API の制限は Worker のメモリ上のトークンバケットで、データセンター・インスタンスごとに数えるため
  「乱用の抑止」程度の精度です。厳密にしたい場合は Cloudflare の Rate Limiting 機能や、キーごとの Durable Object への置き換えを検討してください。
  WebSocket のメッセージ制限（1接続あたり毎秒40、瞬間80）は Durable Object の中で正確に効きます。
