# Phase 0 技術検証レポート・実装計画・リスク一覧

設計書 25「Claude Code で最初に実行する作業」と 21「Phase 0」に対応する報告です。

## 1. 既存リポジトリの調査結果（2026-10-21）

| 項目 | 結果 |
| --- | --- |
| リポジトリ | `lunex773-lab/jiro-ramen`（公開）。コミット・ファイルなしの空リポジトリ |
| 既存エンジン・依存・アセット | なし |
| 開発環境 | Linux クラウドコンテナ、Node.js 22、npm 10、Chromium（Playwright 用） |
| Unity / macOS / Xcode | **なし**（インストール・ライセンス認証・iOS ビルドができない） |
| Cloudflare への接続 | **不可**。`api.cloudflare.com` などへの通信がこの環境のネットワーク設定で遮断されている。API トークンも未設定 |
| npm レジストリ | 接続可能（wrangler・workerd・three などは取得できる） |

## 2. 技術判断

- クライアントは Unity ではなく **Three.js + TypeScript（Web）** で実装する → [ADR-001](adr/ADR-001-web-3d-instead-of-unity.md)（オーナー承認済み）
- ゲームルールは描画・通信に依存しない `@jiro/core` に集約し、ブラウザ（シングルプレイ）と Cloudflare Durable Object（共同経営）で同じコードを動かす
- 通信は `GameHost` インターフェースで抽象化（`LocalHost` / `RemoteHost`）。通信方式を替えてもゲーム本体は変わらない（設計書 2.3）
- コミット先: `SecondAKIRA` ブランチ（オーナー指定）。公開: ソースコード＋GitHub Pages

## 3. Cloudflare の機能と制約（設計書 2.3 の技術検証項目）

公式ドキュメントのサイトはこの環境から閲覧できなかったため、インストールした `wrangler`・`@cloudflare/workers-types`・`@cloudflare/vitest-pool-workers` 同梱の型定義・スキーマで API を確認した。**料金・上限の数値は未確認**（デプロイ前にオーナー側で公式ドキュメントの確認が必要）。

| 検証項目 | 方法 | 状態 |
| --- | --- | --- |
| 1. iPhone 実機から WebSocket 接続 | 実機が必要 | **未検証**（デプロイ後に要確認） |
| 2. 最大4クライアントが同一ルームに参加 | ローカル workerd 上のテスト | `apps/server/test` で検証（結果はテスト実行ログ参照） |
| 3. 連続した移動・操作イベント | 同上 | 同上 |
| 4. 遅延・重複への耐性 | requestId による重複排除、状態バージョン付きパッチ、ハッシュ照合 | core と server のテストで検証 |
| 5. DO の CPU 制限内で動作 | シミュレーション1ステップの計算量を計測 | ローカルで計測（本番の制限値は未確認） |
| 6. セーブを D1/R2 に安全に保存 | ローカル D1/R2（miniflare） | server テストで検証 |
| 7. 切断・再接続で二重購入・二重売上が起きない | requestId 重複排除・取引キーの一意性 | core / server テストで検証 |
| 8. 想定プレイ時間での料金 | 本番の請求データが必要 | **未検証**。DO はシミュレーション中ずっと稼働するため、稼働時間課金を要確認 |

## 4. 各 Phase の依存関係

```
Phase 0 調査・計画
  └─ core（ゲームルール）: Phase 2 調理 → 3 客AI・清掃 → 4 在庫・経済 → 5 設備・従業員 → 6 レイアウト・拡張 → 7 評判・キャリア → 8 セーブ
        ├─ client（一人称3D・UI）: Phase 1 操作 → 各 Phase の画面
        └─ server（Cloudflare）: Phase 9 → Phase 10 マルチプレイ（core の同期プロトコルに依存）
  └─ Phase 11 品質向上（3Dモデル・音）→ Phase 12 QA・公開
```

core を先に作り、client と server は core の公開 API（`applyAction`・`step`・`diff/applyPatch`・セーブ関数）だけに依存させた。

## 5. 最小実装計画と受け入れテスト

| 受け入れ条件（設計書 21 の完了条件） | テスト |
| --- | --- |
| 店内を移動し対象物を操作できる | E2E `apps/client/e2e/game.spec.ts`（丼を取る・並べる） |
| 注文から提供まで1杯の調理が成立 | `packages/core/test/cooking.test.ts` |
| 客が来店・食事・退店し、店が再利用可能な状態に戻る | `customers.test.ts` |
| 利益と資金が一貫して計算される | `economy.test.ts`（取引の合計＝資金の変化、二重計上なし） |
| 従業員を雇うと業務負荷が減り人件費が増える | `employees.test.ts`・`balance.test.ts` |
| 配置変更と拡張で運営能力が変わる | `layout.test.ts` |
| 経営成績が需要と成長に影響 | `customers.test.ts`（評判と来客・常連・口コミ） |
| 終了・再起動しても進行が復元される | `save.test.ts`・E2E |
| バックエンド各機能を独立してテストできる | `apps/server/test/*` |
| 4人で共同経営し二重処理・状態不一致がない | server の WebSocket テスト・`net.test.ts` |

## 6. 技術的リスク

| リスク | 影響 | 対策 |
| --- | --- | --- |
| 実機（iPhone Safari）で未検証 | 操作性・性能・音声が想定と違う可能性 | Playwright の iPhone 相当ビューポート＋タッチで代替検証。画質設定（低/中/高）を用意。実機確認は残課題 |
| Cloudflare 未デプロイ | 本番での DO の挙動・料金が未確認 | ローカルの workerd で同じコードをテスト。デプロイ手順書を用意 |
| DO の稼働時間課金 | 長時間プレイで費用が増える | プレイヤー0人でループ停止、一定時間で checkpoint。料金は要実測 |
| WebGL 負荷（古い iPhone） | フレームレート低下 | インスタンス描画・低詳細モデル・画質設定・影は「高」のみ |
| 日本語音声合成の有無 | コールの読み上げが出ない端末がある | 吹き出しでも表示。設定で OFF 可能 |
| 3Dモデルがプロシージャル | 写実性に限界 | 写真を参考に形状・色を調整。将来は glTF アセットに差し替え可能な構造 |

## 7. 追加費用が発生しうる箇所

- Cloudflare Workers / Durable Objects / D1 / R2 の利用料（無料枠・有料プランの条件は公式で要確認）
- App Store 公開時: Apple Developer Program（年額）、Mac と Xcode、Capacitor 等でのネイティブ化作業
- GitHub Pages は公開リポジトリなら無料

## 8. 不明点（オーナー確認済み・未確認）

確認済み: エンジン（Web 3D）、コミット先（SecondAKIRA ブランチ）、公開形態（ソース＋GitHub Pages）、範囲（完成まで）。
未確認（仮決め）: ゲームタイトル（仮「次郎系ラーメン屋 経営シミュレーター」）、初期店名の既定値（「ラーメン まし屋」・プレイヤーが変更可能）。
