# 営業改良: 現状監査（Phase 0）

「営業改良設計書」（SNS バズ・クレーム・覆面調査員・珍しい客・爆発事故とリセット）に着手する前に、既存のコードとテストを読んで現状をまとめたものです。
調査日: 2026-10-29。ブランチ `SecondAKIRA`、作業ツリーに未コミットの変更なし（調査開始時の最新コミット `a752c39`）。

実装の有無は設計書ではなく、コードとテストで判断しています。分類は次のとおりです。

| 分類 | 意味 |
| --- | --- |
| A | コードとテストで動作を確認 |
| B | コードは存在するが検証不足 |
| C | 一部実装 |
| D | 未実装 |
| E | 現状不明 |

## 1. 関係する既存の仕組み

| 仕組み | 場所 | 中身 | 分類 | 根拠（テスト） |
| --- | --- | --- | --- | --- |
| 営業日の進行 | `packages/core/src/sim/day.ts`, `sim/step.ts` | `prep`（仕込み）→ `open`（営業 540 秒）→ `closing` → 精算 `settleDay` → `closed` → `nextDay` で翌日の `prep`。`step` は 0.25 秒ごとに分割して進め、`closed`/`bankrupt`/`paused` では止まる | A | `smoke.test.ts`, `balance.test.ts`, `economy.test.ts` |
| 来客の計算 | `sim/customers.ts` の `arrivalRate`, `updateArrivals` | 評判・時間帯・価格・設備効果・常連・券売機の倍率を掛けた 1 秒あたりの期待値を累積し、1 を超えるたびに客を作る（乱数は状態の `rng`）。行列の長さで並ぶか決める。同時に店にいる客は最大 60 人 | A | `customers.test.ts`, `balance.test.ts` |
| 客 AI | `sim/customers.ts` | `arriving → queue → ticket → waitingSeat → toSeat → seated → eating → leaving → left`。途中退店 `abandoned`、クレーム `complaint`。満足度は 8 項目（味・速さ・接客・清潔さ・正確さ・品切れ・値段・居心地） | A | `customers.test.ts`, `complaint.test.ts`, `cleaning.test.ts` |
| クレーム | `sim/customers.ts` の `onServed`、`sim/interact.ts` の `complaint_remake` / `complaint_refund`、`handleComplaint` | 提供した丼に盛り間違いがあるか品質が低いと、確率で `complaint` 状態になる。対応は「お詫びして作り直す」「お詫びして返金する」の 2 つだけ。30 秒放置すると怒って帰る。従業員は常に「作り直す」 | C | `complaint.test.ts`（返金の流れのみ） |
| 口コミ・評判 | `sim/customers.ts` の `finalizeVisit`, `sim/day.ts` の `settleDay` | 退店時に確率で口コミ（★1〜5）を書き、閉店時にその日の口コミの平均で評判を更新（重みは件数で増え最大 0.25） | A | `customers.test.ts` |
| 常連 | `sim/customers.ts` | 満足した客が常連になり、翌日以降に来店しやすい | A | `customers.test.ts` |
| 吹き出し（客のセリフ） | core: `Customer.say` / `sayUntil`（`sayFor`）。client: `render/world.ts` の `updateOverlay` | 客の頭上に HTML の吹き出しを出す。9m 以内・画面内のときだけ表示し、出せなくてもゲームは止まらない。クレーム中は赤い吹き出し | B | 単体テストなし（E2E のスクリーンショットで目視） |
| 通知 | `sim/notices.ts` の `notify` / `clearNotice`、client `ui/hud.ts` | コードごとに 1 件、重大度（info/warn/danger/good）。danger と good は画面にトーストも出す | A | 多くのテストで間接的に確認 |
| イベント（効果音・演出用） | `sim/notices.ts` の `emit(ctx, …)`、client `audio/sfx.ts`, `game/app.ts` | 状態には残らない一時的な出来事の通知（提供・クレーム・開店など）。共同経営ではパッチと一緒に配る | A | `net.test.ts`, `room.test.ts` |
| イベント抽選の仕組み | — | **専用の仕組みはない**。ランダムな出来事（忘れ物・こぼし・故障など）は各処理の中で `rand(s)` を直接引いている | D | — |
| 乱数 | `packages/core/src/util.ts` の `rand`（mulberry32、状態は `s.rng`） | シードから決定的に再現できる。サーバーとクライアントで同じ結果 | A | `determinism.test.ts` |
| 設備の状態 | `sim/equipment.ts` | 状態値・摩耗・故障・修理・メンテ。壊れた見た目は `render/models/fx.ts` の `StatusFx` | A | `employees.test.ts` ほか |
| 従業員 AI | `sim/employees.ts` | タスクボード方式。クレーム対応は優先度 96 で `complaint_remake` 固定 | A | `employees.test.ts` |
| 経済 | `sim/economy.ts` | 現金（取引キーで二重計上を防ぐ `cash`）と損益（`recordPL`）を分離。売上は提供時に `sale:<注文ID>:<作り直し回数>` のキーで計上、返金は `refund:<注文ID>:<回数>` | A | `economy.test.ts` |
| 設定値 | `packages/core/src/data/balance.ts` の `BALANCE` | 数値を 1 か所に集める方針（コードに直書きしない） | A | — |
| ローカルセーブ | `packages/core/src/save.ts`, `apps/client/src/game/app.ts` | 3 スロット。一時キー → 読み戻し検証 → バックアップ → 本体。チェックサム、移行、ゲストを除く。自動保存は閉店時・画面を離れたとき・タイトルに戻るとき | A | `save.test.ts`、E2E |
| クラウドセーブ | `apps/server/src/api/saves.ts`, `apps/client/src/net/cloud.ts` | スロットのセーブファイルを丸ごと D1 に保存（上限 1.9MB）。競合は revision で判定しユーザーに選ばせる | A | `saves.test.ts` |
| 共同経営の同期 | `apps/server/src/room.ts`, `packages/core/src/net.ts` | 1 ルーム = 1 Durable Object。操作要求は順番に 1 つずつ `applyAction` で適用（requestId で重複排除）。10Hz で `step`、差分パッチを配信、チェックサムでずれを検出 | A | `room.test.ts`, `net.test.ts`, `remote.integration.test.ts` |
| ルームの保存 | `room.ts` の `checkpoint` | 状態と requestId 一覧を、DO の SQLite に 1 つのトランザクションで保存（閉店・破産・定期・停止時）。D1 の `room_snapshots` は別の保存先で、ホストが保存したときの控え | A | `room.test.ts` |
| ひとりプレイ専用の操作 | `apps/server/src/protocol.ts` の `SOLO_ONLY_ACTION_TYPES`、`HOST_ONLY`（`sim/actions.ts`） | `tutorial` はサーバーが受け付けない。次の日・売却・拡張などはホストだけ | A | `room.test.ts` |
| 一人称の移動・視点 | `apps/client/src/game/controls.ts`, `game/app.ts` | 左で移動・右で視点。メニューや画面を開くと操作を止める | A | E2E |
| 3D の店内 | `apps/client/src/render/world.ts`, `render/models/*` | 状態から店・設備・椅子・人物・丼・汚れを描く。素材はコードで生成し、材質（`MAT`）は共有 | B | 型チェックと E2E のスクリーンショット |
| 人物の姿勢 | `render/models/character.ts` | 立つ・歩く・座る・食べる・作業・運ぶ。見た目は `appearance` の数値から決まり、指定はできない | B | 目視のみ |
| 効果音 | `apps/client/src/audio/sfx.ts` | WebAudio で合成（音声ファイルなし）、コールは音声合成。店内の環境音あり | B | 目視・試聴のみ |
| チュートリアル | `sim/tutorial.ts` | 0 日目（練習の日）と 3 日目の従業員の回。決まった客（`Customer.script`）だけを呼ぶ | A | `tutorial.test.ts` |
| 「仕込み開始時点」の保存 | — | **ない**。巻き戻しに使える日ごとの状態の控えは存在しない（3 スロットのセーブは別の用途） | D | — |

## 2. 設計書の各機能の現状

| 機能 | 分類 | 現状 |
| --- | --- | --- |
| 共通イベント基盤（定義・条件・確率・クールダウン・状態・保存・同期） | D | 専用の仕組みなし。部品（状態は JSON、乱数は決定的、通知・イベント・設定値）は揃っている |
| A. SNS でバズる | D | 来客の計算（A）はあるが、一時的に客を増やす仕組みはない |
| B. 怒った客・理不尽なクレーム | C | 提供後の品質・盛り間違いのクレームと「作り直す」「返金する」はある。遅延・汚れ・性格による理不尽な要求、「謝罪」「説明」「断る」、同じ客のクレームの重複防止はない。従業員は常に作り直す |
| C. 有名レビュアー・覆面調査員 | D | 口コミと評判（A）はあるが、特別な客も、時間をおいて公開される評価もない |
| D-1. 金髪の女性客とその彼氏 | D | 客はすべて一人ずつ来店する。見た目を指定する方法もない |
| D-2. 一人でラーメンを愛する客 | D | 食事中のセリフ（「うまっ…！」など、提供直後のみ）はある |
| E. 爆発事故 | D | — |
| 爆発後の焼けた店内の探索 | D | 一人称の移動（A）はある。焼けた見た目・倒れた人物の姿勢はない |
| 仕込み開始時点へのリセット | D | 日ごとの状態の控えがない |

## 3. 調査で分かったこと（設計に影響するもの）

1. **乱数を 1 本で共有している。** イベントの抽選を同じ `s.rng` から引くと、イベントが起きなくても以後の乱数がすべてずれ、既存の挙動とテストの前提が変わる。
2. **売上は提供したときに計上する。** 食券を買った時点ではお金は動かない。提供前のクレームで「返金」するときに `refund` を計上すると、払っていない代金を返すことになる（二重の減額）。
3. **今の「作り直す」は提供済みの丼が前提。** 提供前の客に使うと、まだ計上していない売上を取り消してしまう。新しいクレームの種類を足すときは、提供の前後を区別する必要がある。
4. **状態は 1 つの JSON。** 12 日営業したあとの大きさは約 89KB（常連 36KB・取引 16KB・口コミ 13KB・日報 8KB）。仕込み開始時点の控えを状態の中に持っても、セーブの上限（ローカル数 MB・クラウド 1.9MB・持ち込み 1MB）に収まる。
5. **共同経営のサーバーは操作を 1 つずつ順番に適用する。** 同時に届いた「リセット」も順番に処理されるので、「事故が起きているときだけ受け付ける」と決めれば、復元は必ず 1 回になる。
6. **ルームの保存（DO の SQLite）は状態全体を 1 つのトランザクションで書く。** 状態の中に控えを入れれば、控えと状態がずれることはない。D1 の控え（`room_snapshots`）とローカルのスロットは別の保存先で、まとめて原子的には書けない。
7. **差分パッチは状態全体を比べる。** 控えを状態に入れたまま配ると、毎日 1 回、控えの全体（約 70KB）が全員に送られ、比較の計算も増える。配信からは除くのがよい。
8. **ひとりプレイは、経営メニューを開いている間や閉店後は `step` を呼ばない。** 時間で進むイベントは営業中しか進まない。
9. **吹き出しは画面内・9m 以内でしか出ない。** 出なくても状態は進むので、セリフの表示が失敗してもゲームは止まらない。
10. **人物の見た目は `appearance` の数値でしか決まらない。** 金髪の女性客を出すには、見た目を指定する仕組みを足す必要がある。
11. **操作ボタンは押せるものを最大 5 つまで出す。** クレームの対応 5 種類はちょうど収まる。
