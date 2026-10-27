# タスクと残課題

設計書 23.1 の項目（タスクID・概要・優先度・依存・変更ファイル・実装内容・テスト・結果・未解決事項）で記録します。
「結果」は自動テスト・ビルド・画面確認で確かめた内容だけを書いています。

最終確認（2026-10-27）: 型チェック OK、単体テスト core 71 件・server 61 件・client 4 件 合格、E2E 18 件（iPhone 横向き相当 10・PC 8）合格、本番ビルド OK。GitHub Actions の CI（同じ内容）合格、GitHub Pages への公開ジョブ成功。

## 完了したタスク

| ID | 概要 | 優先度 | 依存 | 主な変更ファイル | 実装内容 | テスト | 結果 | 未解決事項 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T00 | Phase 0: 調査・技術判断・計画 | 最高 | — | `docs/PHASE0_REPORT.md`, `docs/adr/ADR-001-*.md`, ルートの `package.json` ほか | リポジトリ調査、Unity ではなく Web 3D を採用（オーナー確認済み）、Cloudflare の制約確認、Phase の依存関係、受け入れテスト、リスク・費用 | — | 完了 | Cloudflare の料金は実測が必要 |
| T01 | 一人称移動と対象物の操作 | 最高 | T00 | `apps/client/src/game/{controls,targeting}.ts`, `packages/core/src/{geometry,nav}.ts` | スマホ（左で移動・右で視点）と PC（WASD＋マウス）、衝突、注視対象の判定、操作ボタン（長押し） | `apps/client/test/targeting.test.ts`、E2E | 合格 | iPhone 実機の操作感は未確認 |
| T02 | 調理（ロット・コール・提供） | 最高 | T00 | `packages/core/src/sim/{cooking,interact}.ts`, `data/menu.ts` | 丼 → タレ → スープ → 麺ゆで → コール → 麺上げ → トッピング → 提供、作り直し、冷め・のび | `cooking.test.ts`、E2E（丼を取って並べる） | 合格 | — |
| T03 | 客AI・清掃・忘れ物 | 高 | T02 | `sim/customers.ts` | 行列・食券・着席・食事・退店、個性、満足度、汚れ・こぼし・忘れ物 | `customers.test.ts` | 合格 | — |
| T04 | 在庫・発注・経済・破産 | 高 | T02 | `sim/{inventory,economy,day}.ts` | 消費期限・容量・自動発注、現金と損益の分離、二重計上防止、延滞・融資・設備売却・破産 | `inventory.test.ts`, `economy.test.ts` | 合格 | — |
| T05 | 設備・従業員AI | 高 | T04 | `sim/{equipment,employees}.ts` | 購入・修理・メンテ・摩耗故障、タスクボード方式の従業員AI（予約・冷却・在庫を見た優先度） | `employees.test.ts`, `balance.test.ts` | 合格 | 従業員の動きの自然さは実プレイで要調整 |
| T06 | レイアウト・店舗拡張 | 中 | T05 | `sim/layout.ts`, `data/stages.ts`, `apps/client/src/ui/layout-editor.ts` | グリッド配置、ゾーン・重なり・到達可能性・通路幅の検証、拡張 8→12→16→22 席 | `layout.test.ts`、E2E（レイアウト編集を開く） | 合格 | — |
| T07 | 評判・キャリア | 中 | T03 | `data/career.ts`, `sim/day.ts` | 星評価・口コミ・目標と解放 | `customers.test.ts` | 合格 | — |
| T08 | セーブ（3スロット） | 高 | T04 | `packages/core/src/save.ts`, `apps/client/src/game/app.ts` | 一時 → 検証 → バックアップ → 本体、チェックサム、移行、ゲストの除外 | `save.test.ts`、E2E（保存して再読み込み） | 合格 | — |
| T09 | Cloudflare バックエンド | 高 | T08 | `apps/server/src/**`, `apps/server/wrangler.jsonc`, `migrations/0001_init.sql` | 匿名認証・ルーム・クラウドセーブ（D1・R2）、レート制限、オリジン制限 | `apps/server/test/*`（workerd 上で実行） | 合格 | 本番デプロイは未実施（下の U02） |
| T10 | 共同経営（最大4人） | 高 | T09 | `apps/server/src/room.ts`, `packages/core/src/net.ts`, `apps/client/src/net/*` | Durable Object の権威サーバー、パッチ同期、requestId の重複排除、再接続、ホスト離脱時の一時停止 | `net.test.ts`, `room.test.ts`, `apps/client/test/remote.integration.test.ts`（ローカルの wrangler dev と結合） | 合格 | 実ネットワーク（遅延・回線切替）での検証は未実施 |
| T11 | 3D モデル・音 | 中 | T01 | `apps/client/src/render/models/*`, `apps/client/src/audio/sfx.ts` | 丼（コールどおりの盛り）・人物・全設備・店舗・小物をコードで生成、湯気・湯面、効果音と読み上げ | 型チェック、`scripts/shots.mjs` のスクリーンショット確認 | 合格（ゲーム中の描画呼び出し 約50 回） | プロシージャルのため写実性に限界 |
| T12 | HUD のスマホ縦画面対応 | 高 | T01 | `apps/client/src/ui/hud.ts`, `apps/client/src/styles.css` | 上部（状態・伝票・案内・通知）と右下（詳細・操作ボタン）を積み上げ式にして重なりを解消 | E2E のスクリーンショット確認（390×844） | 合格（T16 で横向き専用に置き換え） | — |
| T13 | CI・公開 | 高 | T12 | `.github/workflows/{ci,pages}.yml` | push で型チェック・テスト・ビルド・E2E、GitHub Pages へ自動公開 | GitHub Actions | 公開ジョブ成功 | — |
| T14 | 遅い端末でタップが外れる不具合 | 高 | T13 | `apps/client/src/ui/{manage,hud}.ts`, `apps/client/src/game/app.ts` | 経営メニューのタブと HUD 上部を作り直さず文字だけ更新、押下中は再描画を保留、メニュー表示中は 3D 描画を停止 | CI の E2E で発見 → CPU を 6 倍遅くして再現 → 修正後に解消を確認 | CI（GitHub Actions）全ジョブ合格 | — |
| T15 | ゲームタイトルと初期店名の確定 | 中 | T00 | `docs/PHASE0_REPORT.md` | タイトル「次郎系ラーメン屋 経営シミュレーター」、初期店名「ラーメン まし屋」で確定（オーナー確認済み。コードは変更なし） | — | 完了 | — |
| T16 | iPhone の横向き専用にする | 高 | T12 | `apps/client/src/ui/hud.ts`, `apps/client/src/styles.css`, `apps/client/src/game/app.ts`, `apps/client/src/render/world.ts`, `apps/client/public/manifest.webmanifest`, `apps/client/playwright.config.ts`, `apps/client/e2e/game.spec.ts` | 横画面の HUD（上: 状態 / 左: 伝票・通知 / 上中央: 案内・手元 / 右: 詳細＋操作ボタン / 下中央: 開店）、タイトル・スロット・経営メニューの横画面配置、縦向きでは「横向きにしてください」を表示してゲームを一時停止、横長の画面で左右が引き伸ばされないよう画角を調整、マニフェストを横向きに | E2E を iPhone 13 横向きの Safari 相当（750×342）で実行、縦向きの案内と一時停止のテストを追加、750×342・844×390・1280×800 のスクリーンショット確認 | 合格 | iOS の Safari は画面の向きを固定できないため、縦向きでは案内で対応（実機での確認が必要） |
| T17 | Cloudflare のデプロイ先を `apps/server` に向ける | 高 | T09 | `package.json`, `apps/server/package.json`, `docs/CLOUDFLARE_SETUP.md`, `README.md` | ルートで `wrangler deploy` すると設定ファイルがなく自動構成がワークスペースのルートで止まっていた。ルートに `deploy:server`・`deploy:server:dry`、サーバーに `deploy:migrate`（D1 のテーブル作成→デプロイ。T20 で Worker が自分でテーブルを作るようになり削除）を追加し、ダッシュボードの GitHub 連携の設定手順を記載 | エラーをルートで再現、`apps/server` とルートのスクリプトで `wrangler deploy --dry-run` 成功、新しく複製したリポジトリで `npm ci`→dry-run 成功、`deploy:migrate` と同じ手順を `--local`・`--dry-run` で非対話に実行して成功 | 修正済み（本番デプロイは未実施） | U02 |
| T18 | 返金した客の丼を下げられない不具合 | 高 | T03 | `packages/core/src/sim/customers.ts`, `packages/core/src/sim/interact.ts` | クレームで返金した客と、忘れ物を受け取った客が、通常の退店処理を通らずに帰っていた。返金した客の丼は下げて洗う丼にし、席を空け、来店の評価も記録する。忘れ物の客は店内の待ち場所を空ける | `packages/core/test/complaint.test.ts`（修正前のコードで失敗することを確認） | 合格 | — |
| T19 | チュートリアル（営業0日目・3日目の従業員の回） | 高 | T02〜T08 | `packages/core/src/sim/tutorial.ts`, `packages/core/src/sim/{actions,customers,step}.ts`, `packages/core/src/{state,save,types}.ts`, `apps/client/src/ui/tutorial.ts`, `apps/client/src/game/app.ts`, `apps/client/src/render/world.ts`, `apps/client/src/ui/{hud,manage,screens,dom}.ts`, `apps/client/src/styles.css` | 1手順ずつの案内（操作で状態が変わると次へ、経営メニューのタブなど画面の操作は画面が判定）、決まった注文で帰らないチュートリアル用の客、練習の日は自然な来店を止め結果を残さない、開店は案内の手順まで止める、3日目の回（受ける・受けない、雇う・雇わない）、案内パネル・3D の目印・画面外の矢印・ボタンとタブの強調、新規開始時の選択とタイトルからの開始 | `packages/core/test/tutorial.test.ts`（0日目を最後まで操作で進める、3日目の回）、E2E（新規開始で選んで進める・やめると1日目、3日目の回、タイトルから）、横向き 750×342 のスクリーンショット確認 | 合格 | 案内の文言・長さは実際に遊んで調整が必要 |
| T20 | R2 を使わない構成 | 高 | T09 | `apps/server/migrations/0001_init.sql`, `apps/server/src/{schema,migrations.gen,room,audit,index,env}.ts`, `apps/server/src/api/{saves,session}.ts`, `apps/server/wrangler.jsonc`, `apps/server/scripts/gen-schema.mjs`, `docs/adr/ADR-002-no-r2.md` | オーナーの判断で R2 をやめ、セーブ本体と共同経営の保存の控えを D1 に置く。D1 のテーブルは Worker が自分で作る（wrangler と同じ記録表） | server テスト 61 件（保存の世代・削除・ルームの控え・テーブル自動作成）、`wrangler deploy --dry-run`（バインディングは DO と D1 のみ） | 合格 | 利用者が増えたら D1 の容量（無料 500MB）に注意（ADR-002） |

## 残課題

| ID | 概要 | 優先度 | 状態・必要な作業 |
| --- | --- | --- | --- |
| U01 | iPhone 実機（Safari）での確認 | 高 | 自動テストは Chromium の iPhone 相当画面で実施。実機での操作感・性能・音声は未確認 |
| U02 | Cloudflare への本番デプロイ | 高 | デプロイ方法は Cloudflare ダッシュボードの GitHub 連携（オーナー確認済み）。ルートで実行して失敗していた原因は修正済み（T17）。R2 は使わない（ADR-002）。残りはダッシュボードでの作業 3 つ: D1 `jiro-db` の Database ID（8-4-4-4-12 文字）を設定ファイルに入れる、ビルド設定（Root directory `apps/server`、Build command 空欄、Deploy command は既定）、`SESSION_SECRET` の設定。手順は [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) の 2.10。デプロイ後にリポジトリの Variables へ `VITE_SERVER_URL` を登録 |
| U04 | 長時間プレイでのバランス調整 | 中 | シミュレーションでは 1 人営業で 1 日 +6,000〜12,000 円程度（[BALANCE.md](BALANCE.md)）。実プレイでの調整が必要 |
| U05 | App Store 公開 | 低 | 将来の目標。Capacitor 等でのネイティブ化、Apple Developer Program、Mac と Xcode が必要 |
| U06 | クライアントのバンドルサイズ | 低 | Three.js を含むチャンクが gzip 約 220KB。必要なら分割読み込みを検討 |
