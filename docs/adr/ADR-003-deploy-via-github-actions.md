# ADR-003: Cloudflare へのデプロイを GitHub Actions で行う

- 状態: 承認（2026-10-27 プロジェクトオーナーの選択「GitHub に鍵（GitHub Actions でデプロイ）」）
- 関連: [ADR-002](ADR-002-no-r2.md)、docs/CLOUDFLARE_SETUP.md 2.10・6章、docs/TASKS.md T21・U02

## 背景

サーバー（`apps/server`）は Cloudflare ダッシュボードの GitHub 連携（Workers Builds）でデプロイする予定だった。
しかし Workers Builds はコードのデプロイしかしない。D1 の作成と ID の設定、秘密鍵 `SESSION_SECRET` の登録、
ビルド設定の変更はオーナーがダッシュボードで行う必要があった。
オーナーから「GitHub と Cloudflare を API で接続し、Claude が GitHub 経由で Cloudflare を編集できるようにできるか」と相談があった。

## 検討した案

| 案 | 内容 | 判断 |
| --- | --- | --- |
| A. 今のまま（Workers Builds） | Claude はコードの push だけ。D1・秘密鍵・設定はオーナーの手作業 | 不採用（オーナーの手作業が残る） |
| B. GitHub に鍵を預ける | Cloudflare の API トークンを GitHub の Secrets に登録し、GitHub Actions が wrangler と Cloudflare API で操作する。Claude はワークフローとスクリプトを push する | **採用** |
| C. Claude の作業環境に鍵を預ける | Claude Code のクラウド環境に API トークンを登録し、Claude が直接 wrangler を実行する | 不採用（鍵が作業環境に置かれ、操作の記録が GitHub に残らない） |

## 決定

- `.github/workflows/deploy-server.yml` が、`SecondAKIRA` への push（サーバー・core・依存の変更時）と手動実行で動く。
  処理は次の順に行う。
  1. サーバーの型チェックとテスト
  2. `apps/server/scripts/cloudflare.mjs prepare`
  3. `wrangler deploy`
  4. `/api/v1/game-version` の応答確認
- `prepare` は Cloudflare API を直接呼ぶ。
  - D1 `jiro-db` を探し、なければ作る。
  - 実行中だけ `wrangler.jsonc` の `database_id` を実際の ID に置き換える。D1 の ID はアカウントの情報なので、リポジトリには書かない。
  - `SESSION_SECRET` が未登録のときだけランダムな値を作り、`wrangler deploy --secrets-file` で一緒に登録する。
    秘密鍵の確認が権限エラーで失敗したときは、作り直さずに止める（登録済みの鍵を置き換えて、発行済みの参加トークンを無効にしないため）。
- 公開リポジトリの実行ログは誰でも読めるので、D1 の ID・秘密鍵・Cloudflare アカウントのメールアドレスは `::add-mask::` で伏せる。
  トークンとアカウント ID は GitHub の Secrets なので自動で伏せられる。
- ブラウザ版のビルド（`pages.yml`）は、同じ鍵で workers.dev のサブドメインを求め、サーバーの URL を埋め込む。
  リポジトリの Variables に `VITE_SERVER_URL` があればそちらを優先する。
- 鍵が未登録のあいだはデプロイをスキップし、案内を表示する。Pages は共同経営なしでビルドする。
- 二重デプロイを避けるため、ダッシュボードの GitHub 連携（Workers Builds）は外す（オーナーの作業）。

## 影響

- オーナーの作業は、API トークンを作って GitHub に登録し、Workers Builds を外すことだけになる。
  トークンの権限は Workers Scripts の編集・D1 の編集・Account Settings の読み取り。
- Claude はトークンを見ずに、push で Cloudflare を更新できる。結果は Actions のログで確認する。操作はコミットと実行記録として残る。
- トークンは書き込みのできる強い権限なので、対象を自分のアカウントに絞る。漏れたときは Cloudflare の画面で再発行・削除する。
- 手でデプロイする方法（2.1〜2.8）と Workers Builds（2.11）も、手順書に残している。
