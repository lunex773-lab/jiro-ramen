// 認証: 匿名アカウントのトークン（Bearer）と、ルーム参加用の署名付きトークン（joinToken）。
//
// - アカウントのトークンは 32 バイトの乱数。D1 には SHA-256 のハッシュだけを保存する（漏えいしても再利用できない）。
// - joinToken は HMAC-SHA256 で署名した短命のトークン（10分）。WebSocket 接続時に Worker が検証し、
//   検証済みの身元だけを Durable Object に渡す。

import { HttpError } from './http';
import type { Env } from './env';
import { base64UrlToBytes, bytesToBase64Url, isObj, randomBytes, sha256Hex, utf8 } from './util';

// ───────────────────────── アカウントのトークン ─────────────────────────

export interface AuthedPlayer {
  id: string;
  name: string;
  createdAt: number;
}

/** 新しいアカウントのトークン（base64url で 43 文字） */
export function newAccountToken(): string {
  return bytesToBase64Url(randomBytes(32));
}

export function newPlayerId(): string {
  return `p_${bytesToBase64Url(randomBytes(16))}`;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/** Authorization: Bearer <token> を検証してプレイヤーを返す。失敗は 401 */
export async function requirePlayer(req: Request, env: Env, ctx: ExecutionContext): Promise<AuthedPlayer> {
  const h = req.headers.get('Authorization') ?? '';
  const m = /^Bearer ([^\s]+)$/.exec(h);
  if (!m || !TOKEN_RE.test(m[1]!)) throw new HttpError(401, 'unauthorized', '認証トークンがありません');
  const hash = await hashToken(m[1]!);
  const row = await env.DB.prepare('SELECT id, name, created_at, last_seen FROM players WHERE token_hash = ?')
    .bind(hash)
    .first<{ id: string; name: string; created_at: number; last_seen: number }>();
  if (!row) throw new HttpError(401, 'unauthorized', '認証トークンが無効です');
  const now = Date.now();
  // 最終アクセス時刻は10分に1回だけ更新する（毎回の書き込みを避ける）
  if (now - row.last_seen > 10 * 60_000) {
    ctx.waitUntil(
      env.DB.prepare('UPDATE players SET last_seen = ? WHERE id = ?')
        .bind(now, row.id)
        .run()
        .catch(() => undefined),
    );
  }
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

// ───────────────────────── 参加トークン ─────────────────────────

export interface JoinPayload {
  v: 1;
  roomId: string;
  playerId: string;
  name: string;
  host: boolean;
  /** 発行時刻（UNIX 秒） */
  iat: number;
  /** 有効期限（UNIX 秒） */
  exp: number;
}

export const JOIN_TOKEN_TTL_SEC = 10 * 60;

const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, k);
  }
  return k;
}

function requireSecret(env: Env): string {
  const s = env.SESSION_SECRET;
  if (typeof s !== 'string' || s.length < 32) {
    throw new HttpError(500, 'server_misconfigured', 'SESSION_SECRET が設定されていません（32文字以上が必要）');
  }
  return s;
}

export async function signJoinToken(env: Env, p: Omit<JoinPayload, 'v' | 'iat' | 'exp'>, nowSec = Math.floor(Date.now() / 1000)): Promise<{ token: string; exp: number }> {
  const payload: JoinPayload = { v: 1, ...p, iat: nowSec, exp: nowSec + JOIN_TOKEN_TTL_SEC };
  const body = bytesToBase64Url(utf8(JSON.stringify(payload)));
  const key = await hmacKey(requireSecret(env));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(body)));
  return { token: `${body}.${bytesToBase64Url(sig)}`, exp: payload.exp };
}

/** 署名・期限・形式を検証する。失敗は null（理由は外に出さない） */
export async function verifyJoinToken(env: Env, token: string | null, nowSec = Math.floor(Date.now() / 1000)): Promise<JoinPayload | null> {
  if (!token || token.length > 1024) return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = base64UrlToBytes(token.slice(dot + 1));
  if (!sig || sig.length !== 32) return null;
  const key = await hmacKey(requireSecret(env));
  // crypto.subtle.verify は一定時間で比較する
  const ok = await crypto.subtle.verify('HMAC', key, sig, utf8(body));
  if (!ok) return null;
  const raw = base64UrlToBytes(body);
  if (!raw) return null;
  let p: unknown;
  try {
    p = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
  if (!isObj(p) || p.v !== 1) return null;
  if (typeof p.roomId !== 'string' || typeof p.playerId !== 'string' || typeof p.name !== 'string' || typeof p.host !== 'boolean') return null;
  if (typeof p.exp !== 'number' || typeof p.iat !== 'number') return null;
  if (p.exp <= nowSec) return null;
  return p as unknown as JoinPayload;
}
