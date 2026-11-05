// 共通市場（コミュニティ）の作成・参加・表示・操作・日の始めと確定（docs/MARKET_RANKING_PLAN.md）。
// 市場の中身は Durable Object（MarketRoom）が持ち、D1 には招待コード・参加・企業の記録・期間の集計を置く。
// オーナーの判断: 招待コードで友達と入る。AI で埋めるかは作る人が決める（2〜6社）。1人が持てる市場の企業は5社まで。
// 手動の営業は端末で処理し、1日ごとにサーバーへ送る（Worker は本文を解釈せずに Durable Object へ渡す。CPU を使わない）。

import { BALANCE, locationInfo, locationLabel, locationProblem } from '@jiro/core';
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
  // 市場の街（市区町村のコード。出店マップ）
  if (v.cityCode !== undefined && v.cityCode !== null) {
    if (typeof v.cityCode !== 'string' || !/^\d{5}$/.test(v.cityCode) || locationProblem(v.cityCode) || !locationInfo(v.cityCode)) {
      throw new HttpError(400, 'bad_settings', '市場の街（市区町村）が不正です');
    }
    out.cityCode = v.cityCode;
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
  // 競争期間が終わった市場は数えない（そこで営業は続けられるが、新しい市場を作れなくはしない）
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM markets m LEFT JOIN communities c ON c.market_id = m.id WHERE m.owner_id = ? AND m.status = 'open' AND (c.ends_at IS NULL OR c.ends_at > ?)",
  )
    .bind(player.id, Date.now())
    .first<{ n: number }>();
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
    ...(typeof st.cityCode === 'string' ? [env.DB.prepare('INSERT OR REPLACE INTO community_cities (market_id, city_code) VALUES (?, ?)').bind(marketId, st.cityCode)] : []),
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

interface CommunityRow {
  id: string;
  visibility: string | null;
  entry: string | null;
  ends_at: number | null;
}

/** 市場を探す（招待コード、または公開の市場の id） */
async function findMarket(env: Env, body: Record<string, unknown>): Promise<CommunityRow> {
  if (body.marketId !== undefined) {
    if (typeof body.marketId !== 'string' || !isUuid(body.marketId)) throw new HttpError(400, 'bad_request', '市場の指定が不正です');
    const m = await env.DB.prepare(
      "SELECT m.id, c.visibility, c.entry, c.ends_at FROM markets m LEFT JOIN communities c ON c.market_id = m.id WHERE m.id = ? AND m.status = 'open'",
    )
      .bind(body.marketId)
      .first<CommunityRow>();
    // 公開の市場だけ、招待コードなしで入れる（オーナーの判断 18）
    if (!m || m.visibility !== 'public') throw new HttpError(404, 'market_not_found', '公開の市場が見つかりません');
    return m;
  }
  const code = normalizeRoomCode(body.code);
  if (!code) throw new HttpError(400, 'invalid_code', '招待コードは6文字の英数字です');
  const m = await env.DB.prepare(
    "SELECT m.id, c.visibility, c.entry, c.ends_at FROM markets m LEFT JOIN communities c ON c.market_id = m.id WHERE m.code = ? AND m.status = 'open'",
  )
    .bind(code)
    .first<CommunityRow>();
  if (!m) throw new HttpError(404, 'market_not_found', '市場が見つかりません（招待コードを確認してください）');
  return m;
}

/**
 * POST /api/v1/market/join {code | marketId, companyName, bring?: {marketId, companyId}} → {marketId, companyId}
 * bring: 終わった市場の自分の会社を持っていく（育てた企業で参加できる市場だけ。オーナーの判断 15）
 */
export async function joinMarketApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, MARKET_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  const m = await findMarket(env, body);
  const now = Date.now();
  if (m.ends_at !== null && now >= m.ends_at) throw new HttpError(409, 'market_ended', 'この市場の競争期間は終わっています');
  const already = await env.DB.prepare('SELECT 1 AS ok FROM market_members WHERE market_id = ? AND player_id = ?').bind(m.id, player.id).first();
  const bring = isObj(body.bring) ? body.bring : null;
  let b: Record<string, unknown>;
  let companyName: string;
  if (bring) {
    if (m.entry === 'fresh') throw new HttpError(409, 'fresh_only', 'この市場は新規の企業だけが参加できます');
    if (typeof bring.marketId !== 'string' || !isUuid(bring.marketId) || typeof bring.companyId !== 'string') throw new HttpError(400, 'bad_request', '持っていく会社の指定が不正です');
    const own = await env.DB.prepare("SELECT name FROM market_companies WHERE market_id = ? AND company_id = ? AND player_id = ? AND status = 'active'")
      .bind(bring.marketId, bring.companyId, player.id)
      .first<{ name: string }>();
    if (!own) throw new HttpError(404, 'company_not_found', '持っていける会社が見つかりません');
    // 元の市場から出す（終わった市場だけ）→ 新しい市場に入れる。入れられなければ元に戻す
    const ex = await readBody(await stub(env, bring.marketId).fetch('https://market/internal/export', { method: 'POST', headers: identity(player) }));
    try {
      b = await readBody(
        await stub(env, m.id).fetch('https://market/internal/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...identity(player) },
          body: JSON.stringify({ company: ex.company }),
        }),
      );
    } catch (e) {
      await stub(env, bring.marketId).fetch('https://market/internal/restore', { method: 'POST', headers: identity(player) });
      throw e;
    }
    companyName = own.name;
    await env.DB.prepare("UPDATE market_companies SET status = 'moved', updated_at = ? WHERE market_id = ? AND company_id = ?").bind(now, bring.marketId, bring.companyId).run();
  } else {
    companyName = cleanName(body.companyName) ?? '';
    if (!companyName) throw new HttpError(400, 'invalid_name', '会社（店）の名前は1〜20文字で入力してください');
    if (!already) await requireCompanySlot(env, player.id);
    b = await readBody(
      await stub(env, m.id).fetch('https://market/internal/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...identity(player) },
        body: JSON.stringify({ companyName }),
      }),
    );
  }
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
  ctx.waitUntil(audit(env.DB, { kind: 'market_join', playerId: player.id, detail: { marketId: m.id, brought: bring ? bring.marketId : null } }));
  return json({ marketId: m.id, companyId });
}

/** GET /api/v1/communities → 公開の市場の一覧（終わる前・空きのあるもの。オーナーの判断 18） */
export async function publicCommunitiesApi(env: Env): Promise<Response> {
  const now = Date.now();
  const rows = await env.DB.prepare(
    `SELECT m.id, m.name, m.created_at, c.description, c.entry, c.ai_fill, c.max_companies, c.period_days, c.ends_at, cc.city_code,
       (SELECT COUNT(*) FROM market_companies mc WHERE mc.market_id = m.id AND mc.status = 'active') AS players
     FROM markets m JOIN communities c ON c.market_id = m.id LEFT JOIN community_cities cc ON cc.market_id = m.id
     WHERE m.status = 'open' AND c.visibility = 'public' AND (c.ends_at IS NULL OR c.ends_at > ?)
     ORDER BY m.created_at DESC LIMIT 50`,
  )
    .bind(now)
    .all<{ id: string; name: string; created_at: number; description: string; entry: string; ai_fill: number; max_companies: number; period_days: number | null; ends_at: number | null; city_code: string | null; players: number }>();
  return json({
    communities: rows.results
      .filter((r) => r.players < r.max_companies)
      .map((r) => ({
        marketId: r.id,
        name: r.name,
        description: r.description,
        entry: r.entry,
        aiFill: r.ai_fill === 1,
        maxCompanies: r.max_companies,
        periodDays: r.period_days,
        endsAt: r.ends_at,
        cityCode: r.city_code,
        cityName: locationLabel(r.city_code),
        players: r.players,
        createdAt: r.created_at,
      })),
  });
}

/** POST /api/v1/market/:id/retire → 会社を引退させる（終わった市場・破産した会社。1人5社の数から外れる） */
export async function retireCompanyApi(env: Env, ctx: ExecutionContext, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  await requireMember(env, marketId, player.id);
  const b = await readBody(await stub(env, marketId).fetch('https://market/internal/retire', { method: 'POST', headers: identity(player) }));
  if (typeof b.companyId === 'string') {
    await env.DB.prepare("UPDATE market_companies SET status = 'retired', updated_at = ? WHERE market_id = ? AND company_id = ?").bind(Date.now(), marketId, b.companyId).run();
  }
  ctx.waitUntil(audit(env.DB, { kind: 'market_retire', playerId: player.id, detail: { marketId, companyId: b.companyId ?? null } }));
  return json({ ok: true });
}

/**
 * DELETE /api/v1/market/:id → 市場を消す（作った人だけ。ほかの人の会社があっても消せる。オーナーの判断）。
 * 先に Durable Object のデータを消し（0時のアラームも止まる）、そのあと D1 の行を消す。称号（報酬）は受け取った人のものなので残す
 */
export async function deleteMarketApi(env: Env, ctx: ExecutionContext, player: AuthedPlayer, marketId: string): Promise<Response> {
  if (!isUuid(marketId)) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  const m = await env.DB.prepare('SELECT owner_id, name FROM markets WHERE id = ?').bind(marketId).first<{ owner_id: string; name: string }>();
  if (!m) throw new HttpError(404, 'market_not_found', '市場が見つかりません');
  if (m.owner_id !== player.id) throw new HttpError(403, 'not_owner', '市場を作った人だけが消せます');
  const others = await env.DB.prepare('SELECT COUNT(*) AS n FROM market_companies WHERE market_id = ? AND player_id != ?').bind(marketId, player.id).first<{ n: number }>();
  await readBody(await stub(env, marketId).fetch('https://market/internal/destroy', { method: 'POST', headers: identity(player) }));
  const del = (table: string) => env.DB.prepare(`DELETE FROM ${table} WHERE market_id = ?`).bind(marketId);
  await env.DB.batch([
    del('rank_agg'),
    del('company_period_ext'),
    del('company_periods'),
    del('sync_runs'),
    del('market_companies'),
    del('market_members'),
    del('community_cities'),
    del('communities'),
    env.DB.prepare('DELETE FROM markets WHERE id = ?').bind(marketId),
  ]);
  ctx.waitUntil(audit(env.DB, { kind: 'market_delete', playerId: player.id, detail: { marketId, name: m.name, otherCompanies: others?.n ?? 0 } }));
  return json({ ok: true });
}

/** GET /api/v1/markets → 参加している市場の一覧（自分の会社の状態・競争期間が終わったか） */
export async function listMarketsApi(env: Env, player: AuthedPlayer): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT m.id, m.code, m.name, m.created_at, m.owner_id, c.ends_at, c.entry,
       (SELECT mc.company_id FROM market_companies mc WHERE mc.market_id = m.id AND mc.player_id = ? ORDER BY mc.created_at DESC LIMIT 1) AS company_id,
       (SELECT mc.status FROM market_companies mc WHERE mc.market_id = m.id AND mc.player_id = ? ORDER BY mc.created_at DESC LIMIT 1) AS company_status,
       (SELECT mc.name FROM market_companies mc WHERE mc.market_id = m.id AND mc.player_id = ? ORDER BY mc.created_at DESC LIMIT 1) AS company_name,
       (SELECT COUNT(*) FROM market_companies mo WHERE mo.market_id = m.id AND mo.player_id != ?) AS others
     FROM market_members mm JOIN markets m ON m.id = mm.market_id LEFT JOIN communities c ON c.market_id = m.id
     WHERE mm.player_id = ? AND m.status = 'open' ORDER BY mm.joined_at DESC LIMIT 20`,
  )
    .bind(player.id, player.id, player.id, player.id, player.id)
    .all<{ id: string; code: string; name: string; created_at: number; owner_id: string; ends_at: number | null; entry: string | null; company_id: string | null; company_status: string | null; company_name: string | null; others: number }>();
  const now = Date.now();
  return json({
    markets: rows.results.map((r) => ({
      marketId: r.id,
      code: r.code,
      name: r.name,
      createdAt: r.created_at,
      isOwner: r.owner_id === player.id,
      endsAt: r.ends_at,
      ended: r.ends_at !== null && now >= r.ends_at,
      entry: r.entry ?? 'grown',
      companyId: r.company_id,
      companyName: r.company_name,
      companyStatus: r.company_status,
      /** ほかのプレイヤーの会社の数（市場を消すときの確認に出す） */
      otherCompanies: r.others,
    })),
  });
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
  if (b.ok === true && Array.isArray(b.watch) && b.watch.length > 0 && b.duplicate !== true) {
    ctx.waitUntil(audit(env.DB, { kind: 'market_day_watch', playerId: player.id, detail: { ...detail, reasons: b.watch.slice(0, 8) } }));
  }
  return json(b);
}
