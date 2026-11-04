// 共通市場（コミュニティ）の作成・参加・表示・操作・日の始めと確定（docs/MARKET_RANKING_PLAN.md）。
// 市場の中身は Durable Object（MarketRoom）が持ち、D1 には招待コード・参加・企業の記録・期間の集計を置く。
// オーナーの判断: 招待コードで友達と入る。AI で埋めるかは作る人が決める（2〜6社）。1人が持てる市場の企業は5社まで。
// 手動の営業は端末で処理し、1日ごとにサーバーへ送る（Worker は本文を解釈せずに Durable Object へ渡す。CPU を使わない）。

import { BALANCE } from '@jiro/core';
import { audit } from '../audit';
import type { AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json, readJson, readJsonText } from '../http';
import { MARKET_IDENTITY } from '../market';
import { parseAction } from '../protocol';
import { cleanName, isObj, isUuid, log, normalizeRoomCode, randomRoomCode } from '../util';

export const MARKET_BODY_LIMIT = 4096;
/** 日の確定の本文（会社の状態。店が多いと大きくなる）の上限 */
export const COMMIT_BODY_LIMIT = 2_000_000;
/** 1人が作れる開いた市場の数 */
const MAX_OPEN_MARKETS_PER_PLAYER = 5;
/** 競争期間の候補（日。null = 無期限。仕様書 6.1） */
export const PERIOD_CHOICES: readonly (number | null)[] = [30, 90, 180, 365, null];

function stub(env: Env, marketId: string) {
  return env.MARKETS.get(env.MARKETS.idFromName(marketId));
}

function identity(player: AuthedPlayer): Record<string, string> {
  return { [MARKET_IDENTITY.playerId]: player.id, [MARKET_IDENTITY.name]: encodeURIComponent(player.name) };
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: 'bad_gateway', message: '市場からの応答を読めません' };
  }
  const b = isObj(body) ? body : {};
  if (!res.ok) throw new HttpError(res.status, typeof b.error === 'string' ? b.error : 'market_error', typeof b.message === 'string' ? b.message : '市場で問題が起きました');
  return b;
}

async function forward(res: Response): Promise<Response> {
  return json(await readBody(res));
}

async function requireMember(env: Env, marketId: string, playerId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT 1 AS ok FROM market_members WHERE market_id = ? AND player_id = ?').bind(marketId, playerId).first();
  if (!row) throw new HttpError(404, 'market_not_found', 'この市場に参加していません');
}

/** 1人が持てる市場の企業（引退・移動した企業は数えない） */
async function requireCompanySlot(env: Env, playerId: string): Promise<void> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM market_companies WHERE player_id = ? AND status NOT IN ('retired', 'moved')").bind(playerId).first<{ n: number }>();
  const max = BALANCE.market.maxCompaniesPerPlayer;
  if ((r?.n ?? 0) >= max) throw new HttpError(409, 'too_many_companies', `市場の企業は${max}社までです（終わった市場の企業を引退させると、新しく作れます）`);
}

/** 作るときの設定（範囲の確認。最終的な値は core の normalizeSettings が決める） */
function parseSettings(v: unknown): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (!isObj(v)) throw new HttpError(400, 'bad_settings', '設定の形式が不正です');
  const out: Record<string, unknown> = {};
  if (v.description !== undefined) {
    if (typeof v.description !== 'string' || v.description.length > 200) throw new HttpError(400, 'bad_settings', '説明は200文字までです');
    out.description = v.description;
  }
  if (v.visibility !== undefined) {
    if (v.visibility !== 'public' && v.visibility !== 'invite') throw new HttpError(400, 'bad_settings', '公開の設定が不正です');
    out.visibility = v.visibility;
  }
  if (v.entry !== undefined) {
    if (v.entry !== 'grown' && v.entry !== 'fresh') throw new HttpError(400, 'bad_settings', '参加の条件が不正です');
    out.entry = v.entry;
  }
  if (v.aiFill !== undefined) {
    if (typeof v.aiFill !== 'boolean') throw new HttpError(400, 'bad_settings', 'AI の設定が不正です');
    out.aiFill = v.aiFill;
  }
  if (v.maxCompanies !== undefined) {
    const n = v.maxCompanies;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < BALANCE.market.minCompanies || n > BALANCE.market.maxCompanies) {
      throw new HttpError(400, 'bad_settings', `参加企業数は${BALANCE.market.minCompanies}〜${BALANCE.market.maxCompanies}社です`);
    }
    out.maxCompanies = n;
  }
  if (v.periodDays !== undefined) {
    if (!PERIOD_CHOICES.includes(v.periodDays as number | null)) throw new HttpError(400, 'bad_settings', '競争期間は30・90・180・365日か無期限です');
    out.periodDays = v.periodDays;
  }
  return out;
}

/** POST /api/v1/market/create {name, companyName, settings?} → {marketId, code} */
export async function createMarketApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  const name = cleanName(body.name) ?? `${player.name}の市場`.slice(0, 20);
  const companyName = cleanName(body.companyName);
  if (!companyName) throw new HttpError(400, 'invalid_name', '会社（店）の名前は1〜20文字で入力してください');
  const settings = parseSettings(body.settings);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM markets WHERE owner_id = ? AND status = 'open'").bind(player.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_MARKETS_PER_PLAYER) throw new HttpError(409, 'too_many_markets', `作れる市場は${MAX_OPEN_MARKETS_PER_PLAYER}つまでです`);
  await requireCompanySlot(env, player.id);
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
    body: JSON.stringify({ marketId, code, name, ownerId: player.id, companyName, settings }),
  });
  if (!init.ok) {
    log('error', 'market_init_failed', { marketId, status: init.status });
    throw new HttpError(503, 'market_unavailable', '市場を作成できませんでした。時間をおいて再度お試しください');
  }
  const out = (await init.json()) as { companyId?: string | null; settings?: Record<string, unknown> };
  const st = out.settings ?? {};
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR REPLACE INTO communities (market_id, description, visibility, entry, ai_fill, max_companies, period_days, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      marketId,
      typeof st.description === 'string' ? st.description : '',
      st.visibility === 'public' ? 'public' : 'invite',
      st.entry === 'fresh' ? 'fresh' : 'grown',
      st.aiFill === false ? 0 : 1,
      typeof st.maxCompanies === 'number' ? st.maxCompanies : BALANCE.market.maxCompanies,
      typeof st.periodDays === 'number' ? st.periodDays : null,
      typeof st.startsAt === 'number' ? st.startsAt : now,
      typeof st.endsAt === 'number' ? st.endsAt : null,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO market_companies (market_id, company_id, player_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").bind(
      marketId,
      out.companyId ?? 'c1',
      player.id,
      companyName,
      now,
      now,
    ),
  ]);
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
  const already = await env.DB.prepare('SELECT 1 AS ok FROM market_members WHERE market_id = ? AND player_id = ?').bind(m.id, player.id).first();
  if (!already) await requireCompanySlot(env, player.id);
  const b = await readBody(
    await stub(env, m.id).fetch('https://market/internal/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(player) },
      body: JSON.stringify({ companyName }),
    }),
  );
  const now = Date.now();
  const companyId = typeof b.companyId === 'string' ? b.companyId : null;
  const stmts = [env.DB.prepare('INSERT OR IGNORE INTO market_members (market_id, player_id, joined_at) VALUES (?, ?, ?)').bind(m.id, player.id, now)];
  if (companyId) {
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO market_companies (market_id, company_id, player_id, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").bind(
        m.id,
        companyId,
        player.id,
        typeof b.companyName === 'string' ? b.companyName : companyName,
        now,
        now,
      ),
    );
  }
  await env.DB.batch(stmts);
  ctx.waitUntil(audit(env.DB, { kind: 'market_join', playerId: player.id, detail: { marketId: m.id } }));
  return json({ marketId: m.id, companyId });
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

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** POST /api/v1/market/:id/day/start {token, baseVersion} → その日の条件（ticket） */
export async function startDayApi(req: Request, env: Env, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body) || typeof body.token !== 'string' || !TOKEN_RE.test(body.token) || typeof body.baseVersion !== 'number' || !Number.isInteger(body.baseVersion)) {
    throw new HttpError(400, 'bad_request', '日の始めの形式が不正です');
  }
  await requireMember(env, marketId, player.id);
  return forward(
    await stub(env, marketId).fetch('https://market/internal/day/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(player) },
      body: JSON.stringify({ token: body.token, baseVersion: body.baseVersion }),
    }),
  );
}

/**
 * POST /api/v1/market/:id/day/commit {token, state} → 受け取った・受け取らなかった（理由）。
 * 本文（会社の状態）は Worker では解釈せず、Durable Object が確かめる。受け取らなかった日・上限を超えた日は監査記録に残す
 */
export async function commitDayApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  const text = await readJsonText(req, COMMIT_BODY_LIMIT);
  await requireMember(env, marketId, player.id);
  const b = await readBody(
    await stub(env, marketId).fetch('https://market/internal/day/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity(player) },
      body: text,
    }),
  );
  const detail = { marketId, companyId: b.companyId ?? null, gameDate: b.gameDate ?? null };
  if (b.code === 'rejected') {
    ctx.waitUntil(audit(env.DB, { kind: 'market_day_rejected', playerId: player.id, detail: { ...detail, reasons: (Array.isArray(b.reject) ? b.reject : []).slice(0, 8) } }));
  } else if (b.code === 'expired') {
    ctx.waitUntil(audit(env.DB, { kind: 'market_day_expired', playerId: player.id, detail }));
  } else if (b.ok === true && Array.isArray(b.flags) && b.flags.length > 0 && b.duplicate !== true) {
    ctx.waitUntil(audit(env.DB, { kind: 'market_day_flagged', playerId: player.id, detail: { ...detail, reasons: b.flags.slice(0, 8) } }));
  }
  return json(b);
}
