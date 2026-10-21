# ADR-001: クライアントを Unity ではなく Web 3D（Three.js + TypeScript）で実装する

- 状態: 承認（2026-10-21 プロジェクトオーナー確認済み）
- 関連: 設計書 2.1「クライアント」, 2.3, 3, 21

## 背景

設計書はクライアントを Unity（URP / iPhone）と定めている。しかし開発環境（Linux のクラウドコンテナ）には
Unity Editor・macOS・Xcode が存在せず、Unity プロジェクトのビルド・実行・テストができない。
設計書 0.1 / 23.3 は「ビルド・テストが成功したものだけを完了とする」「未検証のものを実装済みと報告しない」と定めているため、
検証できない Unity コードを大量に書くことは設計書の原則に反する。

また、当面の目標は「GitHub での公開」であり、ストア公開は将来の目標である。

## 決定

- クライアントは **Three.js + TypeScript + Vite** で実装し、iPhone の Safari を主対象とした Web アプリとする。
- GitHub Pages で誰でも遊べる形で公開する。
- ゲームルール（経済・調理・客AI・従業員AI・在庫・レイアウト検証・セーブ）はすべて
  **描画に依存しない純粋な TypeScript パッケージ `@jiro/core`** に置く（設計書 3 の責務分離に対応）。
- 同じ `@jiro/core` を Cloudflare Durable Object 上でも実行し、マルチプレイ時のサーバー権威型シミュレーションとする。
- クライアントは `GameHost` インターフェース経由でのみゲーム状態を操作する。
  シングルプレイは `LocalHost`、オンラインは `RemoteHost`（WebSocket）を使い、通信アダプターを交換可能にする（設計書 2.3 末尾）。

## 影響

- 設計書の Unity 固有の記述（URP, MonoBehaviour, Unity Netcode）は Three.js の相当機能に読み替える。
  - URP → Three.js の WebGLRenderer（PBR マテリアル, 影, トーンマッピング）
  - MonoBehaviour に置かない → `@jiro/core` に置く
- ストア公開時の選択肢:
  1. Capacitor 等で Web アプリを iOS ネイティブアプリとして包む（コード資産をそのまま使える）
  2. Unity へ移植する（`@jiro/core` のロジックとデータ定義を C# に移植する。データ駆動設計なので仕様は流用できる）
- 実機（iPhone）での検証はこの環境ではできない。Playwright による iPhone 相当のビューポート／タッチ操作のエミュレーションで代替し、
  実機検証は残課題として明記する。
