// オンライン市場の Durable Object（統合進化設計書 v2.1 Phase 3+4）。1つの市場 = 1つの MarketRoom。
// 市場の経済の状態（企業・店舗・お金・市場シェア・AI の意思決定）はここだけが確定する。
//
// 時計: 市場の日は開始の時刻から dayMs ごとに1日進む（サーバーの時計。オーナーの判断: 市場の1日＝実時間9分の営業日の周期）。
// 毎フレーム動かさず、アクセスのとき（と数時間おきのアラーム）に、今の時刻までの日をまとめて計算する（時間差の追いつき）。
// 計算は同期処理で、途中で別の要求が割り込まない（Durable Object は1つずつ処理する）ので、同じ日を二度計算しない。
// だれもアクセスしない期間が DORMANT_MS を超えた市場は、その先の時間を数えない（費用の上限。次に開いたときから再開する）。
//
// 状態は JSON を固定長の断片に分けて SQLite ストレージに保存する（1値の上限を超えないように。checkpoint.ts と同じ形）。
// 操作は cid（クライアントが付ける操作の ID）で二重適用しない（結果を覚えて同じ答えを返す）。

import { DurableObject } from 'cloudflare:workers';
import {
  advanceMarketTo,
  BALANCE,
  checksum,
  createMarket,
  joinMarket,
  marketAction,
  marketView,
  MARKET_SCHEMA,
  playerCompany,
  type Action,
  type ActionResult,
  type MarketState,
  type MarketView,
} from '@jiro/core';
import type { Env } from './env';
import { RidCache } from './checkpoint';
import { isObj, log, safeJsonParse } from './util';

/** だれもアクセスしないとき、時間を数え続ける長さ（これを超えた分は数えない） */
export const DORMANT_MS = 7 * 86_400_000;
/** 追いつきのアラームの間隔 */
export const ALARM_EVERY_MS = 6 * 3_600_000;
/** 1回の要求で追いつく日数の上限（長く止まっていた市場は、何回かに分けて追いつく） */
const MAX_DAYS_PER_REQUEST = 1500;
const CHUNK_CHARS = 64 * 1024;

export interface MarketMeta {
  marketId: string;
  code: string;
  name: string;
  ownerId: string;
  createdAt: number;
  /** 市場の1日目が始まった時刻（眠っていた分だけ後ろへずらす） */
  startedAt: number;
  dayMs: number;
  /** 最後にプレイヤーがアクセスした時刻 */
  lastAccessAt: number;
}

export interface MarketClock {
  /** 営業が済んだ最後の日 */
  day: number;
  dayMs: number;
  /** 次の日の営業が済む時刻 */
  nextDayAt: number;
  serverNow: number;
}

/** Worker から渡される本人の情報（Durable Object は Worker からしか呼べないので信用してよい） */
export const MARKET_IDENTITY = { playerId: 'X-Jiro-Player-Id', name: 'X-Jiro-Player-Name' } as const;

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export class MarketRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  meta: MarketMeta | null = null;
  market: MarketState | null = null;
  private corrupt = false;
  private cids = new Map<string, RidCache>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      this.load();
    });
  }

  // ───────────────────────── 保存 ─────────────────────────

  private load(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS market_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const m = this.kvGet('meta');
    this.meta = m ? (JSON.parse(m) as MarketMeta) : null;
    const h = this.kvGet('market');
    if (!h) return;
    const hdr = JSON.parse(h) as { n: number; sum: string; length: number };
    const rows = this.sql.exec<{ idx: number; data: string }>('SELECT idx, data FROM market_chunks ORDER BY idx').toArray();
    const text = rows.map((r) => r.data).join('');
    if (rows.length !== hdr.n || text.length !== hdr.length || checksum(text) !== hdr.sum) {
      this.corrupt = true;
      log('error', 'market_corrupt', { marketId: this.meta?.marketId });
      return;
    }
    const raw = safeJsonParse(text);
    if (!isObj(raw) || !isObj(raw.market) || (raw.market as { schema?: unknown }).schema !== MARKET_SCHEMA) {
      this.corrupt = true;
      log('error', 'market_bad_format', { marketId: this.meta?.marketId });
      return;
    }
    this.market = raw.market as unknown as MarketState;
    const cids = isObj(raw.cids) ? raw.cids : {};
    this.cids = new Map(Object.entries(cids).map(([k, v]) => [k, RidCache.from(v, 100)]));
  }

  private kvGet(k: string): string | null {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }

  private kvPut(k: string, v: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  private save(): void {
    if (!this.market || !this.meta) return;
    const text = JSON.stringify({ market: this.market, cids: Object.fromEntries([...this.cids.entries()].map(([k, c]) => [k, c.entries()])) });
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM market_chunks');
      chunks.forEach((c, i) => this.sql.exec('INSERT INTO market_chunks (idx, data) VALUES (?, ?)', i, c));
      this.kvPut('market', JSON.stringify({ n: chunks.length, sum: checksum(text), length: text.length, savedAt: Date.now() }));
      this.kvPut('meta', JSON.stringify(this.meta));
    });
  }

  // ───────────────────────── 時計 ─────────────────────────

  /** 今の時刻で、営業が済んでいるはずの最後の日 */
  private targetDone(now: number): number {
    const m = this.meta!;
    return Math.max(0, Math.floor((now - m.startedAt) / m.dayMs));
  }

  /**
   * 今の時刻まで市場を進める。access なら最後のアクセスの時刻を更新する（眠っていた分の時間は数えない）。進めた日数を返す
   */
  catchUp(now: number, access: boolean): number {
    if (!this.meta || !this.market) return 0;
    const gap = now - this.meta.lastAccessAt;
    if (access && gap > DORMANT_MS) this.meta.startedAt += gap - DORMANT_MS;
    const limitNow = access ? now : Math.min(now, this.meta.lastAccessAt + DORMANT_MS);
    const target = this.targetDone(limitNow) + 1;
    const n = advanceMarketTo(this.market, target, MAX_DAYS_PER_REQUEST);
    if (access) this.meta.lastAccessAt = now;
    if (n > 0 || access) this.save();
    return n;
  }

  clock(now: number): MarketClock {
    const m = this.meta!;
    const day = this.market ? this.market.day - 1 : 0;
    return { day, dayMs: m.dayMs, nextDayAt: m.startedAt + (day + 1) * m.dayMs, serverNow: now };
  }

  private scheduleAlarm(now: number): void {
    void this.ctx.storage.setAlarm(now + ALARM_EVERY_MS);
  }

  override async alarm(): Promise<void> {
    if (!this.meta || !this.market || this.corrupt) return;
    const now = Date.now();
    this.catchUp(now, false);
    // 眠った市場はアラームを止める（次のアクセスで再開する）
    if (now - this.meta.lastAccessAt <= DORMANT_MS) this.scheduleAlarm(now);
  }

  // ───────────────────────── HTTP（Worker からの内部呼び出し） ─────────────────────────

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/internal/init' && req.method === 'POST') return this.init(await req.json());
    if (this.corrupt) return json({ error: 'market_corrupt', message: '市場のデータが壊れているため開けません' }, 503);
    if (!this.meta || !this.market) return json({ error: 'market_not_found', message: '市場が見つかりません' }, 404);
    const playerId = req.headers.get(MARKET_IDENTITY.playerId);
    if (!playerId) return json({ error: 'unauthorized', message: '本人の情報がありません' }, 401);
    const now = Date.now();
    if (url.pathname === '/internal/join' && req.method === 'POST') {
      const body = (await req.json()) as { companyName?: unknown };
      this.catchUp(now, true);
      const r = joinMarket(this.market, playerId, typeof body.companyName === 'string' ? body.companyName : '');
      if (!r.ok) return json({ error: 'join_refused', message: r.reason ?? '参加できません' }, 409);
      this.save();
      return json({ ok: true, companyId: r.company!.id });
    }
    if (url.pathname === '/internal/view' && req.method === 'GET') {
      this.catchUp(now, true);
      void this.scheduleAlarmIfNone(now);
      return json(this.viewFor(playerId, now));
    }
    if (url.pathname === '/internal/act' && req.method === 'POST') {
      const body = (await req.json()) as { cid?: unknown; action?: unknown };
      if (typeof body.cid !== 'string' || !isObj(body.action)) return json({ error: 'bad_request', message: '操作の形式が不正です' }, 400);
      this.catchUp(now, true);
      const cache = this.cids.get(playerId) ?? new RidCache(100);
      const prev = cache.get(body.cid);
      if (prev) return json({ ...prev, duplicate: true });
      const r: ActionResult = marketAction(this.market, playerId, body.action as unknown as Action);
      cache.set(body.cid, r);
      this.cids.set(playerId, cache);
      this.save();
      return json(r);
    }
    return json({ error: 'not_found', message: '見つかりません' }, 404);
  }

  private async scheduleAlarmIfNone(now: number): Promise<void> {
    const a = await this.ctx.storage.getAlarm();
    if (a === null) this.scheduleAlarm(now);
  }

  private init(body: unknown): Response {
    if (this.meta) return json({ ok: true, existing: true });
    if (!isObj(body) || typeof body.marketId !== 'string' || typeof body.code !== 'string' || typeof body.ownerId !== 'string') return json({ error: 'bad_request' }, 400);
    const now = Date.now();
    const startedAt = typeof body.startedAt === 'number' ? body.startedAt : now;
    const dayMs = typeof body.dayMs === 'number' && body.dayMs >= 1000 ? body.dayMs : BALANCE.market.dayRealSec * 1000;
    this.meta = {
      marketId: body.marketId,
      code: body.code,
      name: typeof body.name === 'string' ? body.name.slice(0, 30) : '市場',
      ownerId: body.ownerId,
      createdAt: now,
      startedAt,
      dayMs,
      lastAccessAt: now,
    };
    const seed = typeof body.seed === 'number' ? body.seed >>> 0 : (crypto.getRandomValues(new Uint32Array(1))[0]! >>> 0);
    this.market = createMarket({
      id: body.marketId,
      name: this.meta.name,
      seed,
      creator: { ownerId: body.ownerId, companyName: typeof body.companyName === 'string' ? body.companyName : '' },
    });
    this.catchUp(now, true);
    this.scheduleAlarm(now);
    return json({ ok: true });
  }

  viewFor(playerId: string, now: number): MarketView & { clock: MarketClock; code: string; isOwner: boolean; joined: boolean } {
    const m = this.market!;
    return { ...marketView(m, playerId), clock: this.clock(now), code: this.meta!.code, isOwner: this.meta!.ownerId === playerId, joined: !!playerCompany(m, playerId) };
  }
}
