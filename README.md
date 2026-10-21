# 次郎系ラーメン店舗経営シミュレーション

一人称視点で次郎系ラーメン店を切り盛りする 3D 経営シミュレーションゲーム（Web / iPhone Safari 対応）。

> 開発中です。進捗は [docs/CHANGELOG.md](docs/CHANGELOG.md)、設計書は [docs/DESIGN_SPEC.md](docs/DESIGN_SPEC.md) を参照してください。

## 構成

| パス | 内容 |
| --- | --- |
| `packages/core` | ゲームルール本体（純粋な TypeScript。描画・通信に非依存） |
| `apps/client` | Three.js による一人称 3D クライアント（Vite） |
| `apps/server` | Cloudflare Workers / Durable Objects / D1 / R2 によるバックエンド |
| `docs` | 設計書・技術判断記録（ADR）・検証レポート |

## 開発

```bash
npm install
npm run dev        # クライアント開発サーバー
npm test           # 全パッケージのテスト
npm run typecheck  # 型チェック
```
