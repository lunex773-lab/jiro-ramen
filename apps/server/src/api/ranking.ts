// ランキングと報酬の API（docs/MARKET_RANKING_PLAN.md。仕様書 5・8.3）。
// GET /api/v1/rankings?board=community|fresh|grown&marketId=…&scope=week|month|year|total&date=YYYY-MM-DD&metric=…
//   コミュニティ内（board=community）は参加している市場だけ。全体（fresh・grown）は誰でも見られる。日付は JST（省略すると今日）。
//   前の期間の順位（順位の変動）と、自分の企業の順位を付ける。全体は数分だけ Worker のキャッシュに置く（D1 の読み出しを減らす）。
// GET /api/v1/rewards → 自分の称号の一覧

import { isDateKey, jstDateKey, previousScopeKey, scopeKey, type RankScope } from '@jiro/core';
import type { AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json } from '../http';
import { computeRanking, RANK_METRIC_LABEL, RANK_METRICS, type RankAggRow, type RankBoard, type RankLine, type RankMetric } from '../ranking';
import { isUuid } from '../util';

const SCOPES: readonly RankScope[] = ['week', 'month', 'year', 'total'];
const BOARDS: readonly RankBoard[] = ['community', 'fresh', 'grown'];
/** 全体ランキングのキャッシュの秒数 */
const GLOBAL_CACHE_SEC = 300;
/** 返す行の数（自分の企業は別に返す） */
const TOP_N = 100;

async function rows(env: Env, board: RankBoard, key: string, marketId: string | null): Promise<RankAggRow[]> {
  const r =
    board === 'community'
      ? await env.DB.prepare('SELECT * FROM rank_agg WHERE scope_key = ? AND market_id = ?').bind(key, marketId).all<RankAggRow>()
      : await env.DB.prepare('SELECT * FROM rank_agg WHERE scope_key = ? AND entry = ?').bind(key, board).all<RankAggRow>();
  return r.results;
}

interface Board {
  key: string;
  prevKey: string | null;
  lines: RankLine[];
  prev: Map<string, number>;
}

async function board(env: Env, b: RankBoard, scope: RankScope, date: string, metric: RankMetric, marketId: string | null): Promise<Board> {
  const key = scopeKey(scope, date);
  const prevKey = previousScopeKey(key);
  const lines = computeRanking(await rows(env, b, key, marketId), b, metric);
  const prev = new Map<string, number>();
  if (prevKey) for (const l of computeRanking(await rows(env, b, prevKey, marketId), b, metric)) prev.set(`${l.marketId}:${l.companyId}`, l.rank);
  return { key, prevKey, lines, prev };
}

export async function rankingsApi(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const url = new URL(req.url);
  const b = (url.searchParams.get('board') ?? 'community') as RankBoard;
  const scope = (url.searchParams.get('scope') ?? 'week') as RankScope;
  const metric = (url.searchParams.get('metric') ?? 'overall') as RankMetric;
  const date = url.searchParams.get('date') ?? jstDateKey(Date.now());
  const marketId = url.searchParams.get('marketId');
  if (!BOARDS.includes(b) || !SCOPES.includes(scope) || !RANK_METRICS.includes(metric) || !isDateKey(date)) throw new HttpError(400, 'bad_request', 'ランキングの指定が不正です');
  if (b === 'community') {
    if (!marketId || !isUuid(marketId)) throw new HttpError(400, 'bad_request', '市場を指定してください');
    const row = await env.DB.prepare('SELECT 1 AS ok FROM market_members WHERE market_id = ? AND player_id = ?').bind(marketId, player.id).first();
    if (!row) throw new HttpError(404, 'market_not_found', 'この市場に参加していません');
  }
  // 全体は数分だけキャッシュ（誰が見ても同じ。自分の企業の行は毎回ここで付ける）
  const cacheKey = new Request(`https://cache.jiro/rankings/${b}/${scope}/${date}/${metric}`);
  let data: { key: string; prevKey: string | null; lines: RankLine[]; prev: [string, number][] } | null = null;
  const cache = b === 'community' ? null : (caches as unknown as { default: Cache }).default;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) data = (await hit.json()) as typeof data;
  }
  if (!data) {
    const bd = await board(env, b, scope, date, metric, b === 'community' ? marketId : null);
    data = { key: bd.key, prevKey: bd.prevKey, lines: bd.lines, prev: [...bd.prev.entries()] };
    if (cache) ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(data), { headers: { 'Cache-Control': `max-age=${GLOBAL_CACHE_SEC}`, 'Content-Type': 'application/json' } })));
  }
  const prev = new Map(data.prev);
  const withPrev = (l: RankLine) => ({ ...l, prevRank: prev.get(`${l.marketId}:${l.companyId}`) ?? null, mine: l.playerId === player.id, playerId: undefined });
  const mine = data.lines.filter((l) => l.playerId === player.id).map(withPrev);
  return json({
    board: b,
    scope,
    scopeKey: data.key,
    prevKey: data.prevKey,
    metric,
    metricLabel: RANK_METRIC_LABEL[metric],
    perDay: b !== 'community',
    total: data.lines.length,
    rows: data.lines.slice(0, TOP_N).map(withPrev),
    mine,
  });
}

export async function rewardsApi(env: Env, player: AuthedPlayer): Promise<Response> {
  const r = await env.DB.prepare('SELECT reward_key, market_id, company_id, scope_key, board, metric, rank, title, created_at FROM rewards WHERE player_id = ? ORDER BY created_at DESC LIMIT 100')
    .bind(player.id)
    .all<{ reward_key: string; market_id: string; company_id: string; scope_key: string; board: string; metric: string; rank: number; title: string; created_at: number }>();
  return json({ rewards: r.results.map((x) => ({ key: x.reward_key, marketId: x.market_id, companyId: x.company_id, scopeKey: x.scope_key, board: x.board, metric: x.metric, rank: x.rank, title: x.title, createdAt: x.created_at })) });
}
