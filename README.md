# 次郎系ラーメン屋 経営シミュレーター

一人称視点で次郎系ラーメン店を切り盛りする 3D 経営シミュレーションゲームです。
ブラウザ（iPhone の Safari を主対象）で動き、GitHub Pages で公開します。**iPhone を横向き（左に倒して、カメラが左）にして遊ぶ横画面専用**です。画面の回転ロック中で画面が縦のままでも、ゲームの表示ごと 90° 回して横画面で表示します。最大4人のオンライン共同経営（Cloudflare）にも対応しています。

- 遊ぶ: https://lunex773-lab.github.io/jiro-ramen/ （`SecondAKIRA` ブランチへの push で自動更新。iPhone ではホーム画面に追加するとアプリのように使えます）
- 設計書: [docs/DESIGN_SPEC.md](docs/DESIGN_SPEC.md) / 技術判断: [docs/adr](docs/adr) / Phase 0 レポート: [docs/PHASE0_REPORT.md](docs/PHASE0_REPORT.md)
- 変更履歴: [docs/CHANGELOG.md](docs/CHANGELOG.md) / タスクと残課題: [docs/TASKS.md](docs/TASKS.md) / バランス: [docs/BALANCE.md](docs/BALANCE.md)
- Cloudflare の設定: [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md)

## ゲームの流れ

0. **チュートリアル（営業0日目）** — 新しく始めるときに選べる練習の日（スキップ可。タイトルの「チュートリアル」からいつでもやり直せる）。仕込み、在庫と発注、値段、設備の手入れ、レイアウト、1杯目の調理と提供、片付け・掃除、2杯目は自分で、閉店と精算 を1手順ずつ案内する。練習の結果は残らず、終えると1日目（資金¥300,000）から始まる。3日目には、従業員の雇い方のチュートリアルを受けるか選べる
1. **仕込み** — 豚を煮込んでタレと煮豚を作り、豚を切り、ヤサイをゆで、ニンニクを刻み、背脂を炊き、寸胴でスープを炊く
2. **開店** — 客が店の前に並び、券売機で食券を買い、カウンターに座る
3. **ロットで調理** — 丼を並べる → タレ → スープ → 麺をゆでる（約18秒） → 「ニンニク入れますか？」でコールを聞く → 麺上げ → コールどおりにヤサイ・ニンニク・アブラ・カラメ・唐辛子と豚を盛る → 席に提供
4. **片付け** — 丼を下げて洗う、カウンターを拭く、床の汚れやこぼれたスープを掃除、忘れ物を保管
5. **閉店・精算** — 家賃・給与・維持費・光熱費を支払い、口コミが評判に反映される
6. **経営** — 発注、価格、設備の購入・修理・メンテ、従業員の採用と担当設定、レイアウト変更、店舗拡張（8→12→16→22席）
7. 資金が尽き、支払期限を過ぎ、融資・設備売却でも払えなければ **破産**

## 操作

| | スマホ（横向き） | PC |
| --- | --- | --- |
| 移動 | 画面左側をなぞる | WASD / 矢印キー |
| 視点 | 画面右側をなぞる | 画面をクリック後マウス |
| 操作 | 画面中央の照準を設備や席に合わせ、右下の小さな丸いボタン（縁が点線のボタンは長押し。周りの輪が一周するまで押し続ける） | 照準を合わせて E / 左クリック（長押し可）、1〜6 で他の操作 |
| 中断 | ボタンを離す | Q |
| 経営メニュー | 右上「☰ 経営」 | Tab |
| 共同経営の参加コード | 右上「コード ABC123」を押すと大きく表示・コピー | 同じ |

## 構成

| パス | 内容 |
| --- | --- |
| `packages/core` | ゲームルール本体（純粋な TypeScript。描画・通信に非依存）。調理・客AI・在庫・経済・設備・従業員AI・レイアウト・評判・キャリア・セーブ・同期プロトコル |
| `apps/client` | Three.js の一人称 3D クライアント（Vite）。HUD・経営メニュー・レイアウト編集・音（WebAudio＋音声合成）・オンライン接続 |
| `apps/server` | Cloudflare Workers / Durable Objects / D1 のバックエンド（R2 は使わない）（認証・ルーム・共同経営の権威サーバー・クラウドセーブ） |
| `docs` | 設計書・ADR・検証レポート・手順書 |

同じ `@jiro/core` をブラウザ（シングルプレイ）とサーバー（共同経営）で動かします。クライアントは状態を直接書き換えず、必ず「操作要求（Action）」を送り、検証に通ったものだけが確定します。

## 開発

```bash
npm install          # 依存関係（.npmrc で legacy-peer-deps を有効化済み）
npm run dev          # クライアント開発サーバー http://localhost:5173
npm test             # core と server のテスト
npm run typecheck    # 型チェック
npm run build        # クライアントの本番ビルド（apps/client/dist）
npm run dev:server   # Cloudflare バックエンドをローカルで起動（wrangler dev）
npm run deploy:server   # 手元からバックエンドを Cloudflare にデプロイ（apps/server の Wrangler で実行。ルートで npx wrangler deploy は使わない）

# E2E（Playwright, iPhone 13 を横向きにした Safari 相当の画面 750×342＋タッチ、PC）
cd apps/client && npx playwright test
```

## 公開（GitHub Pages）

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする（設定済み）
2. `SecondAKIRA` ブランチに push すると `.github/workflows/pages.yml` がビルドして公開する（公開元が GitHub Actions でない間は公開をスキップし、実行結果に案内を出す）
3. 同時に `.github/workflows/ci.yml` が型チェック・テスト・ビルド・E2E を実行する
4. 共同経営サーバー（Cloudflare）は `.github/workflows/deploy-server.yml` がデプロイする。**Settings → Secrets and variables → Actions → Secrets** に `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID` を登録すると動き、D1 の用意・秘密鍵の登録も自動で行う。ブラウザ版にはサーバーの URL（`https://jiro-ramen.<サブドメイン>.workers.dev`）が自動で埋め込まれる（手順: [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md) の 2.10。ゲーム内のオンライン画面からも URL を入力できる）

## ライセンス・注意

- 店名・人物・口コミはすべて架空です。実在の店舗名（「ラーメン二郎」等）は使っていません
- 3D モデル・効果音はすべてコードで生成しており、外部アセットを含みません
