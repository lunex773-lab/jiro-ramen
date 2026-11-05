// 共通市場（コミュニティ）の Durable Object（docs/MARKET_RANKING_PLAN.md）。1つの市場 = 1つの MarketRoom。
// 市場の経済の状態（企業・店舗・お金・同期の状態機械）はここだけが確定する（サーバー権威）。
//
// 時間: プレイヤーは端末で1日ずつ営業し、日の始め（day/start）に条件をもらい、日の終わり（day/commit）に状態を送る。
// JST の0時に期間を締め、いちばん進んだ企業の日付まで、遅れた企業を自動営業でそろえる（core の runSync）。
// 0時のアラームで同期を始め、続きがあればアラームで続け、全社がそろったら期間ごとの集計を D1 に書いてから期間を終える。
// 要求が来たときにも同期が残っていれば先に進める（アラームが遅れても、時計はサーバーの時刻だけで決まる）。
// Durable Object は要求を1つずつ処理するので、同じ日を二度計算しない（D1 への書き込みを待つ間も、同期の状態で操作を断る）。
//
// 保存: 市場の共通部分（企業の状態を除く）と、企業ごとの状態を、それぞれ固定長の断片に分けて SQLite に保存する。
// 変わった部分だけを書く（日の確定では、その企業と共通部分だけ）。読み込むときはチェックサムで確かめる。

import { DurableObject } from 'cloudflare:workers';
import {
  checksum,
  commitDay,
  createMarket,
  exportCompany,
  finishSync,
  importCompany,
  joinMarket,
  jstDateKey,
  marketAction,
  marketView,
  migrateMarket,
  MARKET_SCHEMA,
  nextJstMidnight,
  nextSyncAt,
  periodSummary,
  playerCompany,
  restoreCompany,
  retireCompany,
  runSync,
  startDay,
  syncPending,
  type Action,
  type ActionResult,
  type CommunitySettings,
  type ExportedCompany,
  type GameState,
  type MarketCompany,
  type MarketState,
  type MarketView,
} from '@jiro/core';
import type { Env } from './env';
import { RidCache } from './checkpoint';
import { grantCommunityRewards, grantFinalRewards, rankStatements } from './rank-store';
import { ensureSchema } from './schema';
import { isObj, log, safeJsonParse } from './util';

const CHUNK_CHARS = 64 * 1024;
/** 同期の集計を D1 に書けなかったときに、やり直すまでの時間 */
const RETRY_MS = 60_000;
/**
 * 1回の呼び出し（要求・アラーム）で自動営業する企業・日の数。Free の CPU 時間（1回あたりの上限）に収めるため小分けにし、
 * 続きはすぐ次のアラームで進める（結果は一度に計算したときと同じ）。計測: 1社1日 約0.6〜1.7ミリ秒（docs/MARKET_RANKING_REPORT.md 6章）
 */
export const SYNC_STEP_BUDGET = 4;
/** 小分けの途中は数回に1回だけ保存する（保存の書き込み行数を抑える。止まっても、保存した所から計算し直せば同じ結果） */
const SYNC_SAVE_EVERY = 5;
/** 同期を進めている最中に来たアラームを、かけ直すまでの時間 */
const ALARM_BUSY_RETRY_MS = 500;

export interface MarketMeta {
  marketId: string;
  code: string;
  name: string;
  ownerId: string;
  createdAt: number;
}

/** 画面に出す時計（サーバーの時刻。端末の時計は使わない） */
export interface MarketClock {
  serverNow: number;
  /** 次の JST の0時 */
  nextMidnight: number;
  /** 次に同期を始める時刻（同期することがなければ null） */
  nextSyncAt: number | null;
  /** 0時を過ぎて同期が済んでいない（新しい日は始められない） */
  syncPending: boolean;
}

/** Worker から渡される本人の情報（Durable Object は Worker からしか呼べないので信用してよい） */
export const MARKET_IDENTITY = { playerId: 'X-Jiro-Player-Id', name: 'X-Jiro-Player-Name' } as const;

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

/** 企業の状態を除いた市場（共通部分として保存する形） */
type MarketShell = Omit<MarketState, 'companies'> & { companies: Omit<MarketCompany, 'state'>[] };

export class MarketRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  meta: MarketMeta | null = null;
  market: MarketState | null = null;
  private corrupt = false;
  private cids = new Map<string, RidCache>();
  /** 状態が変わった企業（保存するもの。共通部分は毎回保存する） */
  private dirtyCompanies = new Set<string>();
  /** 同期を進めている最中（D1 への書き込みを待つ間に、二重に進めない） */
  private syncBusy = false;
  private syncSteps = 0;
  /** テスト用: サーバーの時刻のずれ（ミリ秒） */
  skewMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      this.load();
    });
  }

  now(): number {
    return Date.now() + this.skewMs;
  }

  // ───────────────────────── 保存 ─────────────────────────

  private load(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (key TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (key, idx))');
    this.corrupt = false;
    this.market = null;
    const m = this.kvGet('meta');
    this.meta = m ? (JSON.parse(m) as MarketMeta) : null;
    if (!this.meta) return;
    // 古い形（市場をまるごと1つの断片の列に保存していた）
    if (this.kvGet('market') !== null) {
      this.loadLegacy();
      return;
    }
    const shellText = this.readBlob('shell');
    if (shellText === null) return;
    const shell = safeJsonParse(shellText);
    if (!isObj(shell) || shell.schema !== MARKET_SCHEMA || !Array.isArray(shell.companies)) {
      this.fail('market_bad_format');
      return;
    }
    const companies: MarketCompany[] = [];
    for (const c of shell.companies as Omit<MarketCompany, 'state'>[]) {
      const st = this.readBlob(`company:${c.id}`);
      const state = st === null ? null : safeJsonParse(st);
      if (!isObj(state)) {
        this.fail('market_company_corrupt');
        return;
      }
      companies.push({ ...c, state: state as unknown as GameState });
    }
    this.market = { ...(shell as unknown as MarketShell), companies } as MarketState;
    const cids = this.readBlob('cids');
    const raw = cids === null ? {} : safeJsonParse(cids);
    this.cids = new Map(Object.entries(isObj(raw) ? raw : {}).map(([k, v]) => [k, RidCache.from(v, 100)]));
  }

  /** 古い形の市場（schema 1）を読み、新しい形にして保存し直す（データは消さない） */
  private loadLegacy(): void {
    const h = JSON.parse(this.kvGet('market')!) as { n: number; sum: string; length: number };
    const rows = this.sql.exec<{ idx: number; data: string }>("SELECT idx, data FROM market_chunks ORDER BY idx").toArray();
    const text = rows.map((r) => r.data).join('');
    if (rows.length !== h.n || text.length !== h.length || checksum(text) !== h.sum) {
      this.fail('market_corrupt');
      return;
    }
    const raw = safeJsonParse(text);
    const m = isObj(raw) && isObj(raw.market) ? migrateMarket(raw.market as Record<string, unknown>, this.now()) : null;
    if (!m) {
      this.fail('market_bad_format');
      return;
    }
    this.market = m;
    this.cids = new Map(Object.entries(isObj(raw) && isObj(raw.cids) ? raw.cids : {}).map(([k, v]) => [k, RidCache.from(v, 100)]));
    this.markAll();
    this.save();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM kv WHERE k = 'market'");
      this.sql.exec('DROP TABLE IF EXISTS market_chunks');
    });
    log('info', 'market_migrated', { marketId: this.meta?.marketId });
  }

  private fail(kind: string): void {
    this.corrupt = true;
    this.market = null;
    log('error', kind, { marketId: this.meta?.marketId });
  }

  private kvGet(k: string): string | null {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }

  private kvPut(k: string, v: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  /** 断片に分けた値を読む（チェックサムが合わなければ null） */
  private readBlob(key: string): string | null {
    const h = this.kvGet(`blob:${key}`);
    if (!h) return null;
    const hdr = JSON.parse(h) as { n: number; sum: string; length: number };
    const rows = this.sql.exec<{ data: string }>('SELECT data FROM chunks WHERE key = ? ORDER BY idx', key).toArray();
    const text = rows.map((r) => r.data).join('');
    if (rows.length !== hdr.n || text.length !== hdr.length || checksum(text) !== hdr.sum) return null;
    return text;
  }

  private writeBlob(key: string, text: string): void {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
    this.sql.exec('DELETE FROM chunks WHERE key = ?', key);
    chunks.forEach((c, i) => this.sql.exec('INSERT INTO chunks (key, idx, data) VALUES (?, ?, ?)', key, i, c));
    this.kvPut(`blob:${key}`, JSON.stringify({ n: chunks.length, sum: checksum(text), length: text.length }));
  }

  private markAll(): void {
    for (const c of this.market?.companies ?? []) this.dirtyCompanies.add(c.id);
  }

  /** 変わった部分を1つのトランザクションで保存する */
  private save(): void {
    if (!this.market || !this.meta) return;
    const m = this.market;
    const shell: MarketShell = { ...m, companies: m.companies.map(({ state: _s, ...rest }) => rest) };
    const shellText = JSON.stringify(shell);
    const companies = [...this.dirtyCompanies].map((id) => m.companies.find((c) => c.id === id)).filter((c): c is MarketCompany => !!c);
    this.ctx.storage.transactionSync(() => {
      for (const c of companies) this.writeBlob(`company:${c.id}`, JSON.stringify(c.state));
      // 共通部分は毎回書く（企業の進行・同期の状態が入っている。小さい）
      this.writeBlob('shell', shellText);
      this.writeBlob('cids', JSON.stringify(Object.fromEntries([...this.cids.entries()].map(([k, c]) => [k, c.entries()]))));
      this.kvPut('meta', JSON.stringify(this.meta));
    });
    this.dirtyCompanies.clear();
  }

  // ───────────────────────── 同期（0時） ─────────────────────────

  private async ensureAlarm(now: number): Promise<void> {
    if (!this.market) return;
    const at = nextSyncAt(this.market, now);
    if (at === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at);
  }

  /**
   * 同期を小分けの1つ分進める（core の runSync）。全社がそろったら集計を D1 に書いてから期間を終える。
   * 何度呼んでも同じ結果。D1 に書けなければ ranking のまま残し、少しあとにやり直す
   */
  async advanceSync(now: number): Promise<void> {
    if (!this.market || this.corrupt || this.syncBusy) return;
    this.syncBusy = true;
    try {
      const m = this.market;
      // 1回の呼び出しでは小分けの1つだけ進める（CPU 時間の上限）。続きはすぐ次のアラームで
      const step = runSync(m, now, SYNC_STEP_BUDGET);
      if (step.status === 'idle') {
        await this.ensureAlarm(now);
        return;
      }
      if (step.status === 'waiting') {
        this.save();
        await this.ctx.storage.setAlarm(step.until);
        return;
      }
      // 自動営業した企業の状態は変わっている
      this.markAll();
      if (step.status === 'more') {
        this.syncSteps++;
        if (this.syncSteps % SYNC_SAVE_EVERY === 0) this.save();
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }
      // ranking: 期間ごとの集計を D1 へ（同じ行を同じ値で書き直すので、二重に書いても同じ）
      this.save();
      try {
        await this.writePeriod(step.periodId, now);
      } catch (e) {
        log('error', 'market_period_write_failed', { marketId: this.meta?.marketId, period: step.periodId, error: String(e) });
        await this.ctx.storage.setAlarm(now + RETRY_MS);
        return;
      }
      finishSync(m, now);
      this.markAll();
      this.save();
      // 次の期間が残っていれば、すぐ続ける
      if (syncPending(m, now)) await this.ctx.storage.setAlarm(Date.now());
      else await this.ensureAlarm(now);
    } finally {
      this.syncBusy = false;
    }
  }

  private async writePeriod(periodId: string, now: number): Promise<void> {
    const m = this.market!;
    const db = this.env.DB;
    await ensureSchema(db);
    const rows = periodSummary(m, periodId);
    const run = m.sync!;
    const stmts = rows.map((r) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO company_periods (market_id, company_id, period, entry, kind, player_id, name, days, manual_days, auto_days, flagged_days,
            net_sales, operating_profit, final_profit, served, customers, satisfaction_sum, satisfaction_count, market_net_sales, money_end, debt_end, stores, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          m.id,
          r.companyId,
          periodId,
          m.settings.entry,
          r.kind,
          r.ownerId,
          r.name,
          r.days,
          r.manualDays,
          r.autoDays,
          r.flaggedDays,
          Math.round(r.netSales),
          Math.round(r.operatingProfit),
          Math.round(r.finalProfit),
          r.served,
          r.customers,
          r.satisfactionSum,
          r.satisfactionCount,
          Math.round(r.marketNetSales),
          Math.round(r.moneyEnd),
          Math.round(r.debtEnd),
          r.stores,
          now,
        ),
    );
    stmts.push(
      db
        .prepare('INSERT OR REPLACE INTO sync_runs (market_id, period, target_date, auto_days, expired_days, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(m.id, periodId, run.targetDate, run.autoDays, run.expiredDays, run.startedAt, now),
    );
    // ランキングの集計（追加の数値と、企業ごとの週・月・年・累計の作り直し）
    stmts.push(...rankStatements(db, m.id, m.settings.entry, rows, periodId, now));
    // プレイヤーの企業の状態（破産など）
    for (const c of m.companies) {
      if (c.kind !== 'player' || !c.ownerId) continue;
      stmts.push(
        db
          .prepare('UPDATE market_companies SET status = ?, name = ?, updated_at = ? WHERE market_id = ? AND company_id = ? AND (status != ? OR name != ?)')
          .bind(c.status, c.name, now, m.id, c.id, c.status, c.name),
      );
    }
    await db.batch(stmts);
    // その日で週・月・年が終わるなら、コミュニティ内の上位に称号（同じ順位で二度は渡さない）
    await grantCommunityRewards(db, m.id, periodId, now);
    // 競争期間の最後の日なら、大会の上位3社に称号
    if (m.settings.endsAt !== null && periodId >= jstDateKey(m.settings.endsAt - 1)) await grantFinalRewards(db, m.id, m.name, now);
  }

  override async alarm(): Promise<void> {
    if (!this.market || this.corrupt) return;
    // 要求の処理で同期を進めている最中なら、少しあとにかけ直す（アラームは一度動くと消えるので、そのまま返すと続きが止まる）
    if (this.syncBusy) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_BUSY_RETRY_MS);
      return;
    }
    await this.advanceSync(this.now());
  }

  // ───────────────────────── HTTP（Worker からの内部呼び出し） ─────────────────────────

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/internal/init' && req.method === 'POST') return this.init(await req.json());
    if (this.corrupt) return json({ error: 'market_corrupt', message: '市場のデータが壊れているため開けません' }, 503);
    if (!this.meta || !this.market) return json({ error: 'market_not_found', message: '市場が見つかりません' }, 404);
    const playerId = req.headers.get(MARKET_IDENTITY.playerId);
    if (!playerId) return json({ error: 'unauthorized', message: '本人の情報がありません' }, 401);
    const now = this.now();
    // 0時を過ぎて同期が残っていれば、先に進める（アラームが遅れても同じ結果）
    if (syncPending(this.market, now)) await this.advanceSync(now);
    const m = this.market;
    if (url.pathname === '/internal/join' && req.method === 'POST') {
      const body = (await req.json()) as { companyName?: unknown };
      const r = joinMarket(m, playerId, typeof body.companyName === 'string' ? body.companyName : '', now);
      if (!r.ok) return json({ error: 'join_refused', message: r.reason ?? '参加できません' }, 409);
      this.markAll();
      this.save();
      return json({ ok: true, companyId: r.company!.id, companyName: r.company!.name });
    }
    // 育てた会社を別の市場へ移す（出す・入れる・戻す）と引退（仕様書 6.2。オーナーの判断 15・16）
    if (url.pathname === '/internal/export' && req.method === 'POST') {
      const r = exportCompany(m, playerId, now);
      if (!r.ok) return json({ error: 'export_refused', message: r.reason ?? '移せません' }, 409);
      this.save();
      return json({ ok: true, company: r.company });
    }
    if (url.pathname === '/internal/import' && req.method === 'POST') {
      const body = safeJsonParse(await req.text());
      if (!isObj(body) || !isObj(body.company)) return json({ error: 'bad_request', message: '形式が不正です' }, 400);
      const r = importCompany(m, playerId, body.company as unknown as ExportedCompany, now);
      if (!r.ok) return json({ error: 'import_refused', message: r.reason ?? '参加できません' }, 409);
      this.markAll();
      this.save();
      return json({ ok: true, companyId: r.company!.id, companyName: r.company!.name });
    }
    if (url.pathname === '/internal/restore' && req.method === 'POST') {
      const ok = restoreCompany(m, playerId);
      this.save();
      return json({ ok });
    }
    if (url.pathname === '/internal/retire' && req.method === 'POST') {
      const before = m.companies.find((x) => x.kind === 'player' && x.ownerId === playerId && (x.status === 'active' || x.status === 'bankrupt'));
      const r = retireCompany(m, playerId, now);
      if (!r.ok) return json({ error: 'retire_refused', message: r.reason ?? '引退できません' }, 409);
      this.save();
      return json({ ok: true, companyId: before?.id ?? null });
    }
    if (url.pathname === '/internal/view' && req.method === 'GET') {
      return json(this.viewFor(playerId, now));
    }
    if (url.pathname === '/internal/act' && req.method === 'POST') {
      const body = (await req.json()) as { cid?: unknown; action?: unknown };
      if (typeof body.cid !== 'string' || !isObj(body.action)) return json({ error: 'bad_request', message: '操作の形式が不正です' }, 400);
      const cache = this.cids.get(playerId) ?? new RidCache(100);
      const prev = cache.get(body.cid);
      if (prev) return json({ ...prev, duplicate: true });
      const r: ActionResult = marketAction(m, playerId, body.action as unknown as Action, now);
      cache.set(body.cid, r);
      this.cids.set(playerId, cache);
      const c = playerCompany(m, playerId);
      if (c) this.dirtyCompanies.add(c.id);
      this.save();
      return json(r);
    }
    if (url.pathname === '/internal/day/start' && req.method === 'POST') {
      const body = (await req.json()) as { token?: unknown; baseVersion?: unknown };
      if (typeof body.token !== 'string' || typeof body.baseVersion !== 'number') return json({ error: 'bad_request', message: '形式が不正です' }, 400);
      const r = startDay(m, playerId, now, body.token, body.baseVersion);
      if (!r.ok) return json({ error: r.code, message: r.reason }, 409);
      const c = playerCompany(m, playerId);
      if (c) this.dirtyCompanies.add(c.id);
      this.save();
      await this.ensureAlarm(now);
      return json({ ok: true, ticket: r.ticket, clock: this.clock(now) });
    }
    if (url.pathname === '/internal/day/commit' && req.method === 'POST') {
      const body = safeJsonParse(await req.text());
      if (!isObj(body) || typeof body.token !== 'string' || !isObj(body.state)) return json({ error: 'bad_request', message: '形式が不正です' }, 400);
      const c = playerCompany(m, playerId);
      const r = commitDay(m, playerId, now, body.token, body.state as unknown as GameState);
      if (c) this.dirtyCompanies.add(c.id);
      this.save();
      // 0時の締めを待っていたなら、この日が届いたので先へ進める
      if (m.sync && m.sync.status !== 'done') await this.advanceSync(now);
      return json({ ...r, companyId: c?.id ?? null, clock: this.clock(now) });
    }
    return json({ error: 'not_found', message: '見つかりません' }, 404);
  }

  private init(body: unknown): Response {
    if (this.meta) return json({ ok: true, existing: true });
    if (!isObj(body) || typeof body.marketId !== 'string' || typeof body.code !== 'string' || typeof body.ownerId !== 'string') return json({ error: 'bad_request' }, 400);
    const now = this.now();
    this.meta = {
      marketId: body.marketId,
      code: body.code,
      name: typeof body.name === 'string' ? body.name.slice(0, 30) : '市場',
      ownerId: body.ownerId,
      createdAt: now,
    };
    const seed = typeof body.seed === 'number' ? body.seed >>> 0 : (crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0);
    this.market = createMarket({
      id: body.marketId,
      name: this.meta.name,
      seed,
      now,
      settings: isObj(body.settings) ? (body.settings as Partial<CommunitySettings>) : {},
      creator: { ownerId: body.ownerId, companyName: typeof body.companyName === 'string' ? body.companyName : '' },
    });
    this.markAll();
    this.save();
    const me = playerCompany(this.market, body.ownerId);
    return json({ ok: true, companyId: me?.id ?? null, settings: this.market.settings });
  }

  clock(now: number): MarketClock {
    const m = this.market!;
    return { serverNow: now, nextMidnight: nextJstMidnight(now), nextSyncAt: nextSyncAt(m, now), syncPending: syncPending(m, now) };
  }

  viewFor(playerId: string, now: number): MarketView & { clock: MarketClock; code: string; isOwner: boolean; joined: boolean; today: string } {
    const m = this.market!;
    return { ...marketView(m, playerId, now), clock: this.clock(now), code: this.meta!.code, isOwner: this.meta!.ownerId === playerId, joined: !!playerCompany(m, playerId), today: jstDateKey(now) };
  }
}
