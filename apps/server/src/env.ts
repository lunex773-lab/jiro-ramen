// Worker / Durable Object に渡されるバインディングと環境変数（wrangler.jsonc と対応させる）。

import type { GameRoom } from './room';

export interface Env {
  /** 共同経営ルーム（1ルーム = 1 Durable Object） */
  ROOMS: DurableObjectNamespace<GameRoom>;
  /** プロフィール・セーブのメタデータ・ルーム記録・監査記録 */
  DB: D1Database;
  /** セーブのスナップショット本体 */
  SAVES: R2Bucket;
  GAME_VERSION: string;
  MIN_CLIENT_VERSION: string;
  /** CORS を許可するオリジン（カンマ区切り） */
  ALLOWED_ORIGINS: string;
  /** 参加トークンの HMAC 鍵（secret。リポジトリに書かない） */
  SESSION_SECRET: string;
}
