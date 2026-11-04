// オンライン市場の作成・参加・表示・操作（統合進化設計書 v2.1 Phase 3+4）。
// 市場の中身は Durable Object（MarketRoom）が持ち、D1 には招待コードと参加の記録だけを置く。
// オーナーの判断: 招待コードで友達と入る。一人でも AI 企業だけの市場で遊べる（作った人＋AI 5社）。

import { audit } from '../audit';
import type { AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json, readJson } from '../http';
import { MARKET_IDENTITY } from '../market';
import { parseAction } from '../protocol';
import { cleanName, isObj, isUuid, log, normalizeRoomCode, randomRoomCode } from '../util';

export const MARKET_BODY_LIMIT = 4096;
/** 1人が作れる開いた市場の数 */
const MAX_OPEN_MARKETS_PER_PLAYER = 5;

function stub(env: Env, marketId: string) {
  return env.MARKETS.get(env.MARKETS.idFromName(marketId));
}

function identity(player: AuthedPlayer): Record<string, string> {
  return { [MARKET_IDENTITY.playerId]: player.id, [MARKET_IDENTITY.name]: encodeURIComponent(player.name) };
}

async function forward(res: Response): Promise<Response> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: 'bad_gateway', message: '市場からの応答を読めません' };
  }
  if (!res.ok) {
    const b = isObj(body) ? body : {};
    throw new HttpError(res.status, typeof b.error === 'string' ? b.error : 'market_error', typeof b.message === 'string' ? b.message : '市場で問題が起きました');
  }
  return json(body);
}

async function requireMember(env: Env, marketId: string, playerId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 AS ok FROM market_members WHERE market_id = ? AND player_id = ?').bind(marketId, playerId).first();
  if (!row) throw new HttpError(404, 'market_not_found', 'この市場に参加していません');
}

/** POST /api/v1/market/create {name, companyName} → {marketId, code} */
export async function createMarketApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  const name = cleanName(body.name) ?? `${player.name}の市場`.slice(0, 20);
  const companyName = cleanName(body.companyName);
  if (!companyName) throw new HttpError(400, 'invalid_name', '会社（店）の名前は1〜20文字で入力してください');
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM markets WHERE owner_id = ? AND status = 'open'").bind(player.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_MARKETS_PER_PLAYER) throw new HttpError(409, 'too_many_markets', `作れる市場は${MAX_OPEN_MARKETS_PER_PLAYER}つまでです`);
  const marketId = crypto.randomUUID();
  const now = Date.now();
  let code = '';
  for (let attempt = 0; ; attempt++) {
    code = randomRoomCode();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO markets (id, code, owner_id, name, created_at, status) VALUES (?, ?, ?, ?, ?, 'open')").bind(marketId, code, player.id, name, now),
        env.DB.prepare('INSERT INTO market_members (market_id, player_id, joined_at) VALUES (?, ?, ?)').bind(marketId, player.id, now),
      ]);
      break;
    } catch (e) {
      if (attempt < 5 && /UNIQUE/i.test(String(e))) continue;
      throw e;
    }
  }
  const init = await stub(env, marketId).fetch('https://market/internal/init', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketId, code, name, ownerId: player.id, companyName }),
  });
  if (!init.ok) {
    log('error', 'market_init_failed', { marketId, status: init.status });
    throw new HttpError(503, 'market_unavailable', '市場を作成できませんでした。時間をおいて再度お試しください');
  }
  ctx.waitUntil(audit(env.DB, { kind: 'market_create', playerId: player.id, detail: { marketId } }));
  return json({ marketId, code, name }, 201);
}

/** POST /api/v1/market/join {code, companyName} → {marketId, companyId} */
export async function joinMarketApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  const code = normalizeRoomCode(body.code);
  if (!code) throw new HttpError(400, 'invalid_code', '招待コードは6文字の英数字です');
  const companyName = cleanName(body.companyName);
  if (!companyName) throw new HttpError(400, 'invalid_name', '会社（店）の名前は1〜20文字で入力してください');
  const m = await env.DB.prepare("SELECT id FROM markets WHERE code = ? AND status = 'open'").bind(code).first<{ id: string }>();
  if (!m) throw new HttpError(404, 'market_not_found', '市場が見つかりません（招待コードを確認してください）');
  const res = await stub(env, m.id).fetch('https://market/internal/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...identity(player) },
    body: JSON.stringify({ companyName }),
  });
  const out = await forward(res);
  await env.DB.prepare('INSERT OR IGNORE INTO market_members (market_id, player_id, joined_at) VALUES (?, ?, ?)').bind(m.id, player.id, Date.now()).run();
  ctx.waitUntil(audit(env.DB, { kind: 'market_join', playerId: player.id, detail: { marketId: m.id } }));
  const b = (await out.json()) as { companyId?: string };
  return json({ marketId: m.id, companyId: b.companyId ?? null });
}

/** GET /api/v1/markets → 参加している市場の一覧 */
export async function listMarketsApi(env: Env, player: AuthedPlayer): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT m.id, m.code, m.name, m.created_at, m.owner_id FROM market_members mm JOIN markets m ON m.id = mm.market_id WHERE mm.player_id = ? AND m.status = 'open' ORDER BY mm.joined_at DESC LIMIT 20",
  )
    .bind(player.id)
    .all<{ id: string; code: string; name: string; created_at: number; owner_id: string }>();
  return json({ markets: rows.results.map((r) => ({ marketId: r.id, code: r.code, name: r.name, createdAt: r.created_at, isOwner: r.owner_id === player.id })) });
}

/** GET /api/v1/market/:id → その市場の今（自分の企業は中身ごと） */
export async function viewMarketApi(env: Env, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  await requireMember(env, marketId, player.id);
  return forward(await stub(env, marketId).fetch('https://market/internal/view', { headers: identity(player) }));
}

/** POST /api/v1/market/:id/act {cid, action} → 操作の結果（cid が同じなら二度適用しない） */
export async function actMarketApi(req: Request, env: Env, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body) || typeof body.cid !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(body.cid)) throw new HttpError(400, 'bad_request', '操作の ID が不正です');
  const action = parseAction(body.action);
  if (!action) throw new HttpError(400, 'bad_action', '操作の形式が不正です');
  await requireMember(env, marketId, player.id);
  return forward(
    await stub(env, marketId).fetch('https://market/internal/act', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(player) },
      body: JSON.stringify({ cid: body.cid, action }),
    }),
  );
}
