# 統合進化設計書 v2.1 — 現状監査（Phase 0）

調査日: 2026-11-04。対象: リポジトリ `lunex773-lab/jiro-ramen`、ブランチ `SecondAKIRA`（調査開始時 248d14e、作業ツリーに未コミットの変更なし）。
分類（設計書 2.2）: **A** 実装確認済み（コードあり・関連テスト成功） / **B** コードあり・検証不足 / **C** 一部実装 / **D** 未実装 / **E** 不明。
設計書に書かれているだけのものは A にしていない。テスト件数は調査時点のもの。

## 1. 構成（実際のコードで確認）

| 項目 | 実際 | 根拠 |
| --- | --- | --- |
| モノレポ | npm workspaces。`packages/core`（ゲームのルール・シミュレーション、描画に依存しない）、`apps/client`（Vite 7 + Three.js 0.186 + TypeScript）、`apps/server`（Cloudflare Workers + Durable Objects(SQLite) + D1） | `package.json`, 各 `package.json` |
| 時間 | 1営業日 = 営業 540 秒（実時間9分、表示は 11:00〜15:00）＋仕込み（時間制限なし）＋閉店作業。sim は 0.1 秒刻み。ひとりプレイは ×1〜×3 の倍速 | `data/balance.ts`（openDuration）, `client/src/game/host.ts` |
| 乱数 | 状態に保存する種（`s.rng`）とイベント専用の種（`s.events.rng`）。同じ種と同じ操作列で同じ結果 | `util.ts`, `sim/events.ts`, `test/determinism.test.ts` |
| 状態 | `GameState` 1つが1つの店（キャリア）全体。店と会社の区別はない | `types.ts`（GameState） |
| セーブ | 3スロット（ローカル）・クラウドセーブ（D1）。`SAVE_FORMAT`・`schema`（現在 1）・チェックサム・移行の仕組み（`migrate`） | `save.ts`, `server/src/api/*`, `test/save.test.ts`（10件）, `server/test/saves.test.ts`（7件） |
| 共同経営 | 最大4人。Durable Object 1つ = 1ルーム（サーバー権威、10Hz で step、差分配信、約10秒ごとにチェックポイント、操作の rid で二重処理を防ぐ。ホストが接続している間だけ進む） | `server/src/room.ts`, `server/test/room.test.ts`（25件） |
| CI/CD | GitHub Actions: CI（型チェック・単体・E2E）、Pages、Cloudflare（サーバー） | `.github/workflows/*.yml` |

## 2. 店舗運営（設計書 3.1）

| 機能 | 分類 | 根拠・備考 |
| --- | --- | --- |
| 一人称移動・視点・インタラクション | A | client（controls/targeting）、E2E 25本（iPhone 相当・PC の両方）、`client/test/targeting.test.ts` |
| 仕込み・麺ゆで・湯切り・スープ・タレ・具材・盛り付け・提供 | A | `sim/cooking.ts`, `sim/interact.ts`, `test/cooking.test.ts`（7件）, E2E |
| コール（ヤサイ・ニンニク・アブラ・カラメ・一味） | A | `data/menu.ts`（CALLS）, cooking テスト |
| 食券・注文・着席・行列・途中退店 | A | `sim/customers.ts`, `test/customers.test.ts`（6件）, `test/guests.test.ts`（24件） |
| カウンター清掃・丼回収・洗浄・床清掃 | A | `test/cleaning.test.ts`（4件） |
| 忘れ物・クレーム・返金・作り直し・こぼし | A | `sim/complaints.ts`, `test/complaint.test.ts`, `test/events.test.ts`（21件） |
| 消費期限・冷蔵庫容量・発注・欠品・廃棄 | A | `sim/inventory.ts`, `test/inventory.test.ts`（7件） |
| 設備の購入・売却・修理・摩耗・故障・自動メンテナンス | A | `sim/equipment.ts`, economy・smoke テスト |
| 従業員（能力・担当・優先度・経路探索・勤怠・シフト・出退勤） | A | `sim/employees.ts`, `sim/staff.ts`, `sim/commute.ts`, staff（20件）・employees（5件）・commute（4件） |
| レイアウト編集（0.5m グリッド・通路幅・到達可能性） | A | `sim/layout.ts`, `test/layout.test.ts`（10件） |
| 店舗拡張・キャリア目標・解放 | A（機能）／B（バランス） | `sim/layout.ts`（expand）, `data/career.ts`, `data/stages.ts`。拡張したときに利益が増えるかは下の経済監査で確認 |
| 現金と損益の分離・融資・支払い遅延・破産 | A（機能）／B（会計の区分） | `sim/economy.ts`, `sim/day.ts`, `test/economy.test.ts`（9件）, balance テスト（3件）。営業利益に利息を含めている（設計書 4.2 は利息を営業外）→ 経済監査 2 章 |
| 3スロットのローカルセーブ・クラウドセーブ | A（テスト）／B（実ネットワーク・実機） | save・saves テスト。実機のクラウドセーブは未確認 |
| 共同経営（最大4人） | A（workerd 上のテスト）／B（実機・実ネットワーク） | room（25件）・session・http テスト、E2E（ゲストの退出・終了の知らせ） |
| 営業中のイベント（SNS バズ・クレーム・覆面調査員・珍しい客・YouTuber・テレビ取材・爆発事故） | A | events・media・accident テスト、E2E |

## 3. 企業経営・市場（設計書 5〜9）

| 機能 | 分類 | 根拠・備考 |
| --- | --- | --- |
| 企業と店舗のデータの分離 | D | `GameState` が1店舗＝1キャリア。会社・株式・純資産の概念はない |
| 複数店舗の所有 | D | 店は `s.career.stage`（同じ店の拡張段階）だけ |
| 店長・自動運営の方針 | C | 従業員の自動の仕事（タスクボード）、担当設定、自動発注（`s.autoOrder`）、自動メンテナンスはある。店長という役割・方針（修理費の上限・利益目標など）はない |
| 店舗別・企業全体の財務 | D | 日報（`s.history`、直近60日）は1店舗分のみ |
| 法人化・株式会社化・株式・株価・企業価値 | D | なし |
| 共通市場・地域需要・物件・人材市場・食材市場 | D | 来客は店ごとの式（`arrivalRate`: 評判・時間帯・価格・常連・券売機・イベント）。競合の概念はない |
| AI 企業 | D | なし |
| 市場シェア | D | なし |
| 買収・統合 | D | なし |
| サーバー側の時間管理・不在中の進行 | D | ルームのループはホストの接続中だけ（`room.ts` ensureLoop）。不在中は止まり、時間差の追いつき処理はない。アラームは番犬と無人ルームの終了にだけ使う |
| 操作の二重処理防止 | A | rid のキャッシュ（`room.ts`、状態と一緒に保存）。現金取引は key で二重適用しない（`economy.ts` cash） |

## 4. 未達・未確認（設計書 3.2。「未達」と「未確認」を分ける）

| 項目 | 区分 | 内容 |
| --- | --- | --- |
| iPhone Safari 実機での性能・操作・長時間動作 | 未確認 | Playwright の iPhone 13 相当（Chromium）では確認済み。実機の Safari は未確認 |
| 実機ブラウザでのオンライン共同経営 | 未確認 | workerd 上のテストと E2E（通信を模したもの）では確認済み |
| 長期プレイの経済バランス | 未達 | `docs/ECONOMY_BALANCE_AUDIT.md` |
| 3D モデルと音響の品質 | 未達（改善の余地） | 簡易モデル・合成音 |
| App Store 公開 | 未達（未着手） | 技術構成・審査要件の調査もまだ |
| 企業経営への連続的な成長（複数店舗・共通市場・AI 競合・株価・市場シェア・買収） | 未達 | 3 章のとおりすべて D（店長の自動運営だけ C） |

## 5. 監査中に見つけて直した不具合

| 不具合 | 影響 | 修正 |
| --- | --- | --- |
| 従業員 AI の「失敗した仕事を3秒避ける記録」をゲームの状態の外（モジュールの表）に、その日の時刻で持っていた | 時刻は毎朝 0 に戻るので、前日の終わりに失敗した仕事を翌日のほとんどの時間選ばず、店が回らなくなることがあった。タイトルに戻って始めたゲーム・同じサーバーで動く別のルームにも記録が残り、「同じ種なら同じ結果」が崩れていた（経済の測定で、同じ条件のはずのケースの1日目が食い違ったことから発見） | aa27e44。従業員の状態（`ai.failed`）に持ち、毎朝消す。テスト（毎朝消えること・別のゲームのあとでも同じ結果）。古いコードではテストが失敗することを確認 |

## 6. 変更のリスク（要点。詳細は `EVOLUTION_RISK_REGISTER.md`）

- `GameState` は1店舗を前提に、ほぼすべての sim 関数・描画・サーバーの差分配信が参照している。会社・複数店舗を足すときに、今の店の状態をそのまま「店舗1」として使える形にしないと、作り直しの範囲が非常に大きくなる
- 共同経営のサーバーはホストの接続中だけ進む作り。不在中の進行（設計書 9）はループ・課金・保存の設計の変更を伴う
- セーブの `schema` は 1。企業モデルを入れるときは移行の手順（`migrate`）と古いセーブの読み込みのテストが必要
