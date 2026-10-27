// Worker / Durable Object に渡されるバインディングと環境変数（wrangler.jsonc と対応させる）。

import type { GameRoom } from './room';

export interface Env {
  /** 共同経営ルーム（1ルーム = 1 Durable Object） */
  ROOMS: DurableObjectNamespace<GameRoom>;
  /** プロフィール・セーブ（本体も）・ルーム記録と保存の控え・監査記録（R2 は使わない） */
  DB: D1Database;
  GAME_VERSION: string;
  MIN_CLIENT_VERSION: string;
  /** CORS を許可するオリジン（カンマ区切り） */
  ALLOWED_ORIGINS: string;
  /** 参加トークンの HMAC 鍵（secret。リポジトリに書かない） */
  SESSION_SECRET: string;
}
