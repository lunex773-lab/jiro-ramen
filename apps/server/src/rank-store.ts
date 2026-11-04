// ランキングの集計と報酬を D1 に書く（docs/MARKET_RANKING_PLAN.md。仕様書 5.2・5.4・5.5）。
// 0時の同期で、企業ごと・期間ごとの集計（company_periods・company_period_ext）を書き、その企業の週・月・年・累計の集計（rank_agg）を
// その企業の行から作り直す（INSERT OR REPLACE … SELECT。同じ期間を二度書いても同じ値。二重に数えない）。
// 報酬（称号）は reward_key で一意（INSERT OR IGNORE。同じ順位で二度は受け取らない）。

import { addDays, scopeKey, scopeRange, type CompanyPeriodSummary, type DateKey, type RankScope } from '@jiro/core';
import { computeRanking, rewardTitle, type RankAggRow, type RankBoard } from './ranking';

const ALL_FROM = '0000-00-00';
const ALL_TO = '9999-99-99';

/** その日付が入る週・月・年・累計の、集計の範囲 */
export function scopesFor(period: DateKey): { scope: RankScope; key: string; from: string; to: string }[] {
  return (['week', 'month', 'year', 'total'] as RankScope[]).map((scope) => {
    const key = scopeKey(scope, period);
    const r = scopeRange(key);
    return { scope, key, from: r?.from ?? ALL_FROM, to: r?.to ?? ALL_TO };
  });
}

/** その日付で終わる期間のキー（週は日曜、月は末日、年は12月31日）。累計は終わらない */
export function scopesEndingOn(period: DateKey): string[] {
  return scopesFor(period)
    .filter((x) => x.scope !== 'total' && x.to === period)
    .map((x) => x.key);
}

/** 期間の集計を書く文（company_period_ext と、その企業の rank_agg の作り直し）。company_periods の行のあとに実行する */
export function rankStatements(db: D1Database, marketId: string, entry: string, rows: CompanyPeriodSummary[], period: DateKey, now: number): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    out.push(
      db
        .prepare('INSERT OR REPLACE INTO company_period_ext (market_id, company_id, period, emp_sat_sum, emp_sat_days, quality_sum, quality_days, value_start, value_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(marketId, r.companyId, period, r.empSatSum, r.empSatDays, r.qualitySum, r.qualityDays, Math.round(r.valueStart), Math.round(r.valueEnd)),
    );
    for (const s of scopesFor(period)) {
      out.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO rank_agg (scope_key, market_id, company_id, entry, kind, player_id, name, days, manual_days, flagged_days, net_sales, operating_profit, final_profit,
               sat_sum, sat_count, market_net_sales, emp_sat_sum, emp_sat_days, quality_sum, quality_days, value_start, value_end, updated_at)
             SELECT ?, p.market_id, p.company_id, ?, ?, ?, ?, SUM(p.days), SUM(p.manual_days), SUM(p.flagged_days), SUM(p.net_sales), SUM(p.operating_profit), SUM(p.final_profit),
               SUM(p.satisfaction_sum), SUM(p.satisfaction_count), SUM(p.market_net_sales),
               COALESCE(SUM(x.emp_sat_sum), 0), COALESCE(SUM(x.emp_sat_days), 0), COALESCE(SUM(x.quality_sum), 0), COALESCE(SUM(x.quality_days), 0),
               COALESCE((SELECT a.value_start FROM company_period_ext a WHERE a.market_id = p.market_id AND a.company_id = p.company_id AND a.period BETWEEN ? AND ? ORDER BY a.period ASC LIMIT 1), 0),
               COALESCE((SELECT b.value_end FROM company_period_ext b WHERE b.market_id = p.market_id AND b.company_id = p.company_id AND b.period BETWEEN ? AND ? ORDER BY b.period DESC LIMIT 1), 0),
               ?
             FROM company_periods p
             LEFT JOIN company_period_ext x ON x.market_id = p.market_id AND x.company_id = p.company_id AND x.period = p.period
             WHERE p.market_id = ? AND p.company_id = ? AND p.period BETWEEN ? AND ?
             GROUP BY p.market_id, p.company_id`,
          )
          .bind(s.key, entry, r.kind, r.ownerId, r.name, s.from, s.to, s.from, s.to, now, marketId, r.companyId, s.from, s.to),
      );
    }
  }
  return out;
}

async function rowsOf(db: D1Database, sql: string, ...binds: unknown[]): Promise<RankAggRow[]> {
  const r = await db.prepare(sql).bind(...binds).all<RankAggRow>();
  return r.results;
}

/** 順位の上位3社（プレイヤー企業だけ）に称号を渡す。何度呼んでも二重には渡さない */
async function grant(db: D1Database, rows: RankAggRow[], board: RankBoard, scope: string, where: string, now: number): Promise<number> {
  const top = computeRanking(rows, board, 'overall').filter((l) => l.rank <= 3 && l.kind === 'player' && l.playerId);
  if (top.length === 0) return 0;
  await db.batch(
    top.map((l) =>
      db
        .prepare('INSERT OR IGNORE INTO rewards (reward_key, player_id, market_id, company_id, scope_key, board, metric, rank, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(`${scope}:${board}:${where}:overall:${l.rank}:${l.marketId}:${l.companyId}`, l.playerId, l.marketId, l.companyId, scope, board, 'overall', l.rank, rewardTitle(board, scope, l.rank), now),
    ),
  );
  return top.length;
}

/** コミュニティの週・月・年が終わったら（その期間の最後の日の同期のあと）、コミュニティ内の総合の上位3社に称号 */
export async function grantCommunityRewards(db: D1Database, marketId: string, period: DateKey, now: number): Promise<number> {
  let n = 0;
  for (const key of scopesEndingOn(period)) {
    const rows = await rowsOf(db, 'SELECT * FROM rank_agg WHERE scope_key = ? AND market_id = ?', key, marketId);
    n += await grant(db, rows, 'community', key, marketId, now);
  }
  return n;
}

/** 全体の週・月・年が終わったら（毎日の定時の処理。昨日で終わった期間）、全体（2種類）の総合の上位3社に称号 */
export async function grantGlobalRewards(db: D1Database, today: DateKey, now: number): Promise<number> {
  const yesterday = addDays(today, -1);
  let n = 0;
  for (const key of scopesEndingOn(yesterday)) {
    for (const board of ['fresh', 'grown'] as const) {
      const rows = await rowsOf(db, 'SELECT * FROM rank_agg WHERE scope_key = ? AND entry = ?', key, board);
      n += await grant(db, rows, board, key, 'global', now);
    }
  }
  return n;
}

/** 大会の称号（オーナーの判断 17「上位3社に称号」） */
export function finalTitle(marketName: string, rank: number): string {
  return rank === 1 ? `🏆 ${marketName} 優勝` : rank === 2 ? `🥈 ${marketName} 準優勝` : `🥉 ${marketName} 3位`;
}

/**
 * 大会が終わったら（競争期間の最後の日の同期のあと）、その市場の累計の総合で上位3社（プレイヤー企業だけ）に称号。
 * 企業ごとに一つ（reward_key で一意。何度呼んでも二重には渡さない）
 */
export async function grantFinalRewards(db: D1Database, marketId: string, marketName: string, now: number): Promise<number> {
  const rows = await rowsOf(db, "SELECT * FROM rank_agg WHERE scope_key = 'T' AND market_id = ?", marketId);
  const top = computeRanking(rows, 'community', 'overall').filter((l) => l.rank <= 3 && l.kind === 'player' && l.playerId);
  if (top.length === 0) return 0;
  await db.batch(
    top.map((l) =>
      db
        .prepare('INSERT OR IGNORE INTO rewards (reward_key, player_id, market_id, company_id, scope_key, board, metric, rank, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(`final:${marketId}:${l.companyId}`, l.playerId, marketId, l.companyId, 'T', 'community', 'final', l.rank, finalTitle(marketName, l.rank), now),
    ),
  );
  return top.length;
}

/** 大会の称号を渡し忘れた市場（最後の日に誰も遊ばず同期がなかった市場など）を、終わって1日たってから拾う（毎日の定時の処理） */
export async function grantEndedCommunities(db: D1Database, now: number): Promise<number> {
  const r = await db
    .prepare('SELECT m.id, m.name FROM communities c JOIN markets m ON m.id = c.market_id WHERE c.ends_at IS NOT NULL AND c.ends_at <= ? AND c.ends_at > ?')
    .bind(now - 86_400_000, now - 7 * 86_400_000)
    .all<{ id: string; name: string }>();
  let n = 0;
  for (const m of r.results) n += await grantFinalRewards(db, m.id, m.name, now);
  return n;
}
