// 匿名アカウント・プロフィール・ゲームバージョン。

import { PROTOCOL_VERSION, type SaveMeta } from '@jiro/core';
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

export interface SlotSummary {
  slot: number;
  saveId: string;
  revision: number;
  checksum: string;
  updatedAt: number;
  meta: SaveMeta | null;
}

export async function listSlotSummaries(env: Env, playerId: string): Promise<SlotSummary[]> {
  const rows = await env.DB.prepare('SELECT slot, save_id, revision, checksum, meta_json, updated_at FROM save_slots WHERE player_id = ? ORDER BY slot')
    .bind(playerId)
    .all<{ slot: number; save_id: string; revision: number; checksum: string; meta_json: string; updated_at: number }>();
  return rows.results.map((r) => ({
    slot: r.slot,
    saveId: r.save_id,
    revision: r.revision,
    checksum: r.checksum,
    updatedAt: r.updated_at,
    meta: safeParseMeta(r.meta_json),
  }));
}

function safeParseMeta(text: string): SaveMeta | null {
  try {
    return JSON.parse(text) as SaveMeta;
  } catch {
    return null;
  }
}

/** GET /api/v1/profile → {playerId, name, createdAt, slots} */
export async function profile(env: Env, player: AuthedPlayer): Promise<Response> {
  const slots = await listSlotSummaries(env, player.id);
  return json({ playerId: player.id, name: player.name, createdAt: player.createdAt, slots });
}
