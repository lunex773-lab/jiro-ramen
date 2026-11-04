// Worker のエントリーポイント: API のルーティング、CORS、レート制限、認証（設計書 2.2 / 18）。
// 共同経営のリアルタイム処理は Durable Object（./room.ts の GameRoom）が担当する。

import { createAnonymous, gameVersion, profile } from './api/account';
import { deleteSave, downloadSave, uploadSave } from './api/saves';
import { connectRoom, createSession, joinSession, leaveSession } from './api/session';
import { actMarketApi, createMarketApi, joinMarketApi, listMarketsApi, viewMarketApi } from './api/market';
import { requirePlayer } from './auth';
import type { Env } from './env';
import { allowedOrigins, corsHeaders, errorResponse, HttpError, withCors } from './http';
import { HTTP_LIMITS, type KeyedLimiter } from './ratelimit';
import { ensureSchema } from './schema';
import { log } from './util';

export { GameRoom } from './room';
export { MarketRoom } from './market';
export type { Env } from './env';

function clientIp(req: Request): string {
  // Cloudflare の前段が付ける接続元IP（クライアントが付けたものは上書きされる）。ローカルでは無いことがある
  return req.headers.get('CF-Connecting-IP') ?? 'local';
}

function limit(l: KeyedLimiter, key: string): void {
  const retry = l.check(key);
  if (retry > 0) throw new HttpError(429, 'rate_limited', 'リクエストが多すぎます。しばらく待ってから再度お試しください', { retryAfter: retry }, { 'Retry-After': String(retry) });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;
  const ip = clientIp(req);

  if (path === '/api/v1/game-version' && m === 'GET') {
    limit(HTTP_LIMITS.api, ip);
    return gameVersion(env);
  }
  // ここから先は D1 を使う。テーブルがまだ無ければ作る（インスタンスごとに最初の1回だけ確認する）
  await ensureSchema(env.DB);
  if (path === '/api/v1/auth/anonymous' && m === 'POST') {
    limit(HTTP_LIMITS.auth, ip);
    return createAnonymous(req, env, ctx);
  }
  const ws = /^\/api\/v1\/room\/([^/]+)\/ws$/.exec(path);
  if (ws && m === 'GET') {
    limit(HTTP_LIMITS.ws, ip);
    return connectRoom(req, env, decodeURIComponent(ws[1]!));
  }
  const saveSlot = /^\/api\/v1\/save\/([^/]+)$/.exec(path);
  const marketView = /^\/api\/v1\/market\/([^/]+)$/.exec(path);
  const marketAct = /^\/api\/v1\/market\/([^/]+)\/act$/.exec(path);
  const known =
    path === '/api/v1/profile' ||
    path === '/api/v1/save' ||
    path === '/api/v1/session/create' ||
    path === '/api/v1/session/join' ||
    path === '/api/v1/session/leave' ||
    path === '/api/v1/markets' ||
    saveSlot !== null ||
    marketView !== null ||
    marketAct !== null;
  if (!known) throw new HttpError(404, 'not_found', 'API が見つかりません');

  // ここから先は認証が必要
  limit(HTTP_LIMITS.api, ip);
  const player = await requirePlayer(req, env, ctx);

  if (path === '/api/v1/profile' && m === 'GET') return profile(env, player);
  if (path === '/api/v1/save' && m === 'POST') {
    limit(HTTP_LIMITS.save, player.id);
    return uploadSave(req, env, ctx, player);
  }
  if (saveSlot && m === 'GET') return downloadSave(env, player, saveSlot[1]!);
  if (saveSlot && m === 'DELETE') {
    limit(HTTP_LIMITS.save, player.id);
    return deleteSave(env, ctx, player, saveSlot[1]!);
  }
  if (path === '/api/v1/session/create' && m === 'POST') {
    limit(HTTP_LIMITS.session, player.id);
    return createSession(req, env, ctx, player);
  }
  if (path === '/api/v1/session/join' && m === 'POST') {
    limit(HTTP_LIMITS.session, player.id);
    return joinSession(req, env, ctx, player);
  }
  if (path === '/api/v1/session/leave' && m === 'POST') {
    limit(HTTP_LIMITS.session, player.id);
    return leaveSession(req, env, ctx, player);
  }
  // オンライン市場（Phase 3+4）
  if (path === '/api/v1/markets' && m === 'GET') return listMarketsApi(env, player);
  if (marketView && marketView[1] === 'create' && m === 'POST') {
    limit(HTTP_LIMITS.session, player.id);
    return createMarketApi(req, env, ctx, player);
  }
  if (marketView && marketView[1] === 'join' && m === 'POST') {
    limit(HTTP_LIMITS.session, player.id);
    return joinMarketApi(req, env, ctx, player);
  }
  if (marketView && m === 'GET') return viewMarketApi(env, player, decodeURIComponent(marketView[1]!));
  if (marketAct && m === 'POST') {
    limit(HTTP_LIMITS.market, player.id);
    return actMarketApi(req, env, player, decodeURIComponent(marketAct[1]!));
  }
  throw new HttpError(405, 'method_not_allowed', 'このメソッドは使えません');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = req.headers.get('Origin');
    const allowed = allowedOrigins(env.ALLOWED_ORIGINS);
    const cors = corsHeaders(origin, allowed);
    // 許可していないオリジンのブラウザからの要求は拒否する（ネイティブアプリ等の Origin なしは通す）
    if (origin !== null && !allowed.has(origin)) {
      return withCors(errorResponse(new HttpError(403, 'origin_not_allowed', 'このオリジンからは利用できません')), {});
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return withCors(await route(req, env, ctx), cors);
    } catch (e) {
      if (e instanceof HttpError) return withCors(errorResponse(e), cors);
      // 予期しないエラー。URL のクエリ（参加トークン）や Authorization はログに出さない
      log('error', 'unhandled', { method: req.method, path: new URL(req.url).pathname, error: String((e as Error)?.stack ?? e) });
      return withCors(errorResponse(new HttpError(500, 'internal_error', 'サーバーでエラーが発生しました')), cors);
    }
  },
} satisfies ExportedHandler<Env>;
