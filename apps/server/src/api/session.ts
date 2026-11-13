// 共同経営ルームの作成・参加・退出と、WebSocket 接続の受け付け（設計書 18.1 / 18.2）。

import { audit } from '../audit';
import { signJoinToken, verifyJoinToken, type AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json, readJson } from '../http';
import { IDENTITY_HEADERS } from '../room';
import { isObj, isUuid, log, normalizeRoomCode, randomRoomCode } from '../util';

export const SESSION_BODY_LIMIT = 1024;

function roomStub(env: Env, roomId: string) {
  // ルームIDから決まる1つの Durable Object に集約する（同じルームの状態が分散しない。設計書 2.2）
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

/** POST /api/v1/session/create → {roomId, code, joinToken, expiresAt} */
export async function createSession(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  // 本文は空でも {} でもよい（将来の設定用）
  if (req.headers.get('Content-Length') !== '0' && req.body) await readJson(req, SESSION_BODY_LIMIT);
  const roomId = crypto.randomUUID();
  const now = Date.now();
  let code = '';
  // 開いているルームの中で一意なコードを選ぶ（部分ユニークインデックスで保証し、衝突したら引き直す）
  for (let attempt = 0; ; attempt++) {
    code = randomRoomCode();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO rooms (id, code, host_id, created_at, ended_at, status) VALUES (?, ?, ?, ?, NULL, 'open')").bind(roomId, code, player.id, now),
        env.DB.prepare('INSERT INTO room_members (room_id, player_id, joined_at) VALUES (?, ?, ?)').bind(roomId, player.id, now),
      ]);
      break;
    } catch (e) {
      if (attempt < 5 && /UNIQUE/i.test(String(e))) continue;
      throw e;
    }
  }
  // Durable Object 側のルーム情報を初期化（設計書 18.2 の 4）
  const init = await roomStub(env, roomId).fetch('https://room/internal/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, code, hostId: player.id, createdAt: now }),
  });
  if (!init.ok) {
    log('error', 'room_init_failed', { roomId, status: init.status });
    throw new HttpError(503, 'room_unavailable', 'ルームを作成できませんでした。時間をおいて再度お試しください');
  }
  const { token, exp } = await signJoinToken(env, { roomId, playerId: player.id, name: player.name, host: true });
  ctx.waitUntil(audit(env.DB, { kind: 'room_create', playerId: player.id, roomId }));
  return json({ roomId, code, joinToken: token, expiresAt: exp * 1000, isHost: true });
}

/**
 * POST /api/v1/session/join {code} → {roomId, code, joinToken, isHost}
 * 再接続のときも同じコードで呼べば新しい joinToken がもらえる。ルームを作ったホスト本人なら host:true のまま。
 */
export async function joinSession(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, SESSION_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  let room: { id: string; code: string; host_id: string } | null = null;
  if (body.code !== undefined) {
    const code = normalizeRoomCode(body.code);
    if (!code) throw new HttpError(400, 'invalid_code', '参加コードは6文字の英数字です');
    room = await env.DB.prepare("SELECT id, code, host_id FROM rooms WHERE code = ? AND status = 'open'").bind(code).first();
  } else if (isUuid(body.roomId)) {
    room = await env.DB.prepare("SELECT id, code, host_id FROM rooms WHERE id = ? AND status = 'open'").bind(body.roomId).first();
  } else {
    throw new HttpError(400, 'invalid_code', '参加コードを入力してください');
  }
  if (!room) throw new HttpError(404, 'room_not_found', 'ルームが見つかりません（コードを確認してください。終了したルームには参加できません）');
  const host = room.host_id === player.id;
  await env.DB.prepare('INSERT OR IGNORE INTO room_members (room_id, player_id, joined_at) VALUES (?, ?, ?)').bind(room.id, player.id, Date.now()).run();
  const { token, exp } = await signJoinToken(env, { roomId: room.id, playerId: player.id, name: player.name, host });
  ctx.waitUntil(audit(env.DB, { kind: 'room_join', playerId: player.id, roomId: room.id, detail: { host } }));
  return json({ roomId: room.id, code: room.code, joinToken: token, expiresAt: exp * 1000, isHost: host });
}

/** POST /api/v1/session/leave {roomId} → {ok, ended} */
export async function leaveSession(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, SESSION_BODY_LIMIT);
  const roomId = isObj(body) ? body.roomId : undefined;
  if (!isUuid(roomId)) throw new HttpError(400, 'bad_request', 'roomId が不正です');
  const member = await env.DB.prepare('SELECT 1 AS ok FROM room_members WHERE room_id = ? AND player_id = ?').bind(roomId, player.id).first();
  if (!member) throw new HttpError(404, 'room_not_found', 'このルームに参加していません');
  const res = await roomStub(env, roomId).fetch('https://room/internal/leave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: player.id }),
  });
  const r = res.ok ? ((await res.json()) as { ended?: boolean }) : {};
  ctx.waitUntil(audit(env.DB, { kind: 'room_leave', playerId: player.id, roomId }));
  return json({ ok: true, ended: !!r.ended });
}

/**
 * GET /api/v1/room/:roomId/ws?token=<joinToken>
 * Worker で署名・期限・ルームIDを検証してから Durable Object へ渡す。
 * 身元は X-Jiro-* ヘッダーで渡す。クライアントが同じ名前のヘッダーを付けてきても必ず消してから付け直すので、
 * Durable Object はこのヘッダーを信用してよい（Durable Object はこの Worker からしか呼べない）。
 */
export async function connectRoom(req: Request, env: Env, roomId: string): Promise<Response> {
  if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new HttpError(426, 'upgrade_required', 'WebSocket で接続してください');
  }
  if (!isUuid(roomId)) throw new HttpError(404, 'room_not_found', 'ルームが見つかりません');
  const url = new URL(req.url);
  const p = await verifyJoinToken(env, url.searchParams.get('token'));
  if (!p || p.roomId !== roomId) throw new HttpError(401, 'unauthorized', '参加トークンが無効か期限切れです。もう一度参加してください');
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!k.toLowerCase().startsWith('x-jiro-')) headers.set(k, v);
  }
  headers.set(IDENTITY_HEADERS.playerId, p.playerId);
  headers.set(IDENTITY_HEADERS.name, encodeURIComponent(p.name));
  headers.set(IDENTITY_HEADERS.roomId, roomId);
  return roomStub(env, roomId).fetch('https://room/ws', { method: 'GET', headers });
}
