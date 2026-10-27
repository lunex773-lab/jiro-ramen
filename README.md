# 次郎系ラーメン屋 経営シミュレーター

一人称視点で次郎系ラーメン店を切り盛りする 3D 経営シミュレーションゲームです。
ブラウザ（iPhone の Safari を主対象）で動き、GitHub Pages で公開します。最大4人のオンライン共同経営（Cloudflare）にも対応しています。

- 遊ぶ: https://lunex773-lab.github.io/jiro-ramen/ （`SecondAKIRA` ブランチへの push で自動更新。iPhone ではホーム画面に追加するとアプリのように使えます）
- 設計書: [docs/DESIGN_SPEC.md](docs/DESIGN_SPEC.md) / 技術判断: [docs/adr](docs/adr) / Phase 0 レポート: [docs/PHASE0_REPORT.md](docs/PHASE0_REPORT.md)
- 変更履歴: [docs/CHANGELOG.md](docs/CHANGELOG.md) / タスクと残課題: [docs/TASKS.md](docs/TASKS.md) / バランス: [docs/BALANCE.md](docs/BALANCE.md)
- Cloudflare の設定: [docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md)

## ゲームの流れ

1. **仕込み** — 豚を煮込んでタレと煮豚を作り、豚を切り、ヤサイをゆで、ニンニクを刻み、背脂を炊き、寸胴でスープを炊く
2. **開店** — 客が店の前に並び、券売機で食券を買い、カウンターに座る
3. **ロットで調理** — 丼を並べる → タレ → スープ → 麺をゆでる（約18秒） → 「ニンニク入れますか？」でコールを聞く → 麺上げ → コールどおりにヤサイ・ニンニク・アブラ・カラメ・唐辛子と豚を盛る → 席に提供
4. **片付け** — 丼を下げて洗う、カウンターを拭く、床の汚れやこぼれたスープを掃除、忘れ物を保管
5. **閉店・精算** — 家賃・給与・維持費・光熱費を支払い、口コミが評判に反映される
6. **経営** — 発注、価格、設備の購入・修理・メンテ、従業員の採用と担当設定、レイアウト変更、店舗拡張（8→12→16→22席）
7. 資金が尽き、支払期限を過ぎ、融資・設備売却でも払えなければ **破産**

## 操作

| | スマホ | PC |
| --- | --- | --- |
| 移動 | 画面左側をなぞる | WASD / 矢印キー |
| 視点 | 画面右側をなぞる | 画面をクリック後マウス |
| 操作 | 右下のボタン（「長押し」は押し続ける） | E / 左クリック（長押し可）、1〜6 で他の操作 |
| 中断 | ボタンを離す | Q |
| 経営メニュー | 右上「☰ 経営」 | Tab |

## 構成

| パス | 内容 |
| --- | --- |
| `packages/core` | ゲームルール本体（純粋な TypeScript。描画・通信に非依存）。調理・客AI・在庫・経済・設備・従業員AI・レイアウト・評判・キャリア・セーブ・同期プロトコル |
| `apps/client` | Three.js の一人称 3D クライアント（Vite）。HUD・経営メニュー・レイアウト編集・音（WebAudio＋音声合成）・オンライン接続 |
| `apps/server` | Cloudflare Workers / Durable Objects / D1 / R2 のバックエンド（認証・ルーム・共同経営の権威サーバー・クラウドセーブ） |
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
npm run deploy:server   # バックエンドを Cloudflare にデプロイ（apps/server の Wrangler で実行。ルートで npx wrangler deploy は使わない）

# E2E（Playwright, iPhone 相当の画面＋タッチ）
cd apps/client && npx playwright test
```

## 公開（GitHub Pages）

1. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする（設定済み）
2. `SecondAKIRA` ブランチに push すると `.github/workflows/pages.yml` がビルドして公開する（公開元が GitHub Actions でない間は公開をスキップし、実行結果に案内を出す）
3. 同時に `.github/workflows/ci.yml` が型チェック・テスト・ビルド・E2E を実行する
3. 共同経営サーバーを使う場合は、**Settings → Secrets and variables → Actions → Variables** に `VITE_SERVER_URL`（例: `https://jiro-ramen-server.<アカウント>.workers.dev`）を登録すると埋め込まれる（ゲーム内のオンライン画面からも入力できる）

## ライセンス・注意

- 店名・人物・口コミはすべて架空です。実在の店舗名（「ラーメン二郎」等）は使っていません
- 3D モデル・効果音はすべてコードで生成しており、外部アセットを含みません
