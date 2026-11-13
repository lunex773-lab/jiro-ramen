// 匿名アカウント・プロフィール・ゲームバージョン。

import { PROTOCOL_VERSION } from '@jiro/core';
import { audit } from '../audit';
import { hashToken, newAccountToken, newPlayerId, type AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json, readJson } from '../http';
import { cleanName, isObj } from '../util';

export const AUTH_BODY_LIMIT = 1024;

/** POST /api/v1/auth/anonymous {name} → {playerId, token} */
export async function createAnonymous(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await readJson(req, AUTH_BODY_LIMIT);
  const name = cleanName(isObj(body) ? body.name : undefined);
  if (!name) throw new HttpError(400, 'invalid_name', '名前は1〜20文字で入力してください');
  const token = newAccountToken();
  const playerId = newPlayerId();
  const now = Date.now();
  await env.DB.prepare('INSERT INTO players (id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)')
    .bind(playerId, await hashToken(token), name, now, now)
    .run();
  ctx.waitUntil(audit(env.DB, { kind: 'player_create', playerId }));
  // トークンは一度だけ返す（サーバーには保存しない）
  return json({ playerId, token, name }, 201);
}

/** GET /api/v1/game-version */
export function gameVersion(env: Env): Response {
  return json({ gameVersion: env.GAME_VERSION, minClientVersion: env.MIN_CLIENT_VERSION, protocol: PROTOCOL_VERSION });
}

/** GET /api/v1/profile → {playerId, name, createdAt}（クラウドセーブは廃止。2026-11-13） */
export async function profile(env: Env, player: AuthedPlayer): Promise<Response> {
  return json({ playerId: player.id, name: player.name, createdAt: player.createdAt });
}
