// 共同経営ルーム（Durable Object）。1ルームにつき1インスタンス（ルームIDから idFromName で決まる。設計書 2.2）。
//
// サーバー権威型（設計書 17.4）: 状態を書き換えるのはこのクラスだけ。クライアントは操作要求（act）を送り、
// ここで @jiro/core の applyAction で検証・適用し、step でシミュレーションを進め、差分（patch）を配信する。
//
// ■ WebSocket は Hibernation API（ctx.acceptWebSocket）で受ける
//   - シミュレーションのループ（setInterval）が動いている間は休止しない（タイマーが残っているため）。
//   - ホスト切断で一時停止している間・誰もいない間はループを止めるので、ルームは休止でき、その間は
//     Durable Object の実行時間（duration）課金が発生しない。
//   - 休止・退避（eviction）から復帰したときはコンストラクタでチェックポイントから状態を戻し、
//     接続中の全員に全体状態（full）を送り直す。
//
// ■ ループ
//   - 10Hz で step(state, 0.1)。5Hz で差分を配信し、約2秒ごとに状態のチェックサム（h）を付ける。
//   - 約10秒ごと・閉店時・ホスト切断時・保存時などに SQLite ストレージへチェックポイントを書く。
//   - アラームを番犬として使い、ループが止まっていたら再開する（退避後の復帰にも使う）。

import { DurableObject } from 'cloudflare:workers';
import {
  applyAction,
  cancelWork,
  diff,
  dropHand,
  HOST_ONLY,
  makeCtx,
  makePlayer,
  makeSaveFile,
  MAX_PLAYERS,
  migrate,
  PLAYER_COLORS,
  preSaveCheck,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  stateChecksum,
  step,
  validateState,
  type ActionResult,
  type ClientMsg,
  type GameState,
  type PeerInfo,
  type Player,
  type ServerMsg,
  type SimCtx,
} from '@jiro/core';
import { MAX_STORED_BYTES } from './api/saves';
import { audit, type AuditEntry } from './audit';
import { decodeCheckpoint, encodeCheckpoint, RidCache, type CheckpointData } from './checkpoint';
import type { Env } from './env';
import { LAYOUT_ACTIONS, MAX_HOST_INIT_BYTES, MAX_MSG_BYTES, parseClientMsg } from './protocol';
import { TokenBucket, WS_MSG_COST, WS_MSG_RATE } from './ratelimit';
import { cleanName, isObj, log, safeJsonParse } from './util';
import { ensureSchema } from './schema';
import { isClientSupported } from './version';

/** 保存の控えをルームごとに何世代残すか */
const KEEP_ROOM_SAVES = 3;

// ───────────────────────── 定数 ─────────────────────────

/** シミュレーションの刻み（ms）。step には 0.1 秒ずつ渡す */
export const TICK_MS = 100;
const STEP_DT = 0.1;
/** 何ティックごとに差分を配信するか（2 → 5Hz） */
export const BROADCAST_EVERY_TICKS = 2;
/** チェックサム（patch.h）を付ける間隔 */
export const HASH_INTERVAL_MS = 2000;
/** 定期チェックポイントの間隔（ティック数。100 → 約10秒） */
export const CHECKPOINT_EVERY_TICKS = 100;
/** ループ動作中の番犬アラームの間隔 */
const WATCHDOG_MS = 30_000;
/** 誰も接続していないルームを終了するまでの時間 */
export const IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/** hello を送らない接続を切るまでの時間 */
const HELLO_TIMEOUT_MS = 15_000;
/** クライアントの観測バージョンがこれ以上遅れていたら全体を送り直す */
const BEHIND_SEQ = 150;
/** 1ルームで同時に受け付ける WebSocket の上限（hello 前の接続を含む） */
const MAX_SOCKETS = MAX_PLAYERS * 2 + 2;

/** WebSocket の close コード（クライアントが理由を判別できるように 4000 番台を使う） */
export const CLOSE = {
  replaced: 4000,
  version: 4001,
  roomFull: 4003,
  roomClosed: 4004,
  rateLimited: 4008,
  helloTimeout: 4010,
  left: 1000,
} as const;

/** Worker が検証済みの身元を渡すヘッダー（クライアントが付けたものは Worker で必ず消す） */
export const IDENTITY_HEADERS = {
  playerId: 'X-Jiro-Player-Id',
  name: 'X-Jiro-Player-Name',
  roomId: 'X-Jiro-Room-Id',
} as const;

// ───────────────────────── 型 ─────────────────────────

/** ルームの基本情報（DO ストレージに保存） */
export interface RoomMeta {
  roomId: string;
  code: string;
  /** ホストのアカウントID */
  hostId: string;
  /** 状態の中のホストのプレイヤーID（hostInit で決まる。単独プレイのキャリアでは 'p1' など） */
  hostActorId: string | null;
  createdAt: number;
  ended: boolean;
  /** ルームでの保存回数（D1 の room_snapshots に置く控えの revision） */
  saveRevision: number;
  /** 最後に誰かが切断した時刻（無人ルームの期限切れ判定） */
  lastActivityAt: number;
}

/** 接続ごとの情報。休止しても消えないよう WebSocket の attachment に保存する（2KB 以内） */
interface Attachment {
  /** アカウントのプレイヤーID（joinToken で検証済み） */
  pid: string;
  name: string;
  /** hello を受け付けて席を持っている */
  hello: boolean;
  /** 置き換え・退出・切断の処理が済んでいる（以後のイベントは無視） */
  gone: boolean;
  at: number;
}

/** 接続ごとのメモリ上の情報（休止すると消えるが、復帰時に作り直せばよいもの） */
interface Runtime {
  bucket: TokenBucket;
  /** 次の配信で差分ではなく全体を送る */
  needFull: boolean;
  lastFullAt: number;
}

const fail = (reason: string): ActionResult => ({ ok: false, reason });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ───────────────────────── 本体 ─────────────────────────

export class GameRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  meta: RoomMeta | null = null;
  state: GameState | null = null;
  /** チェックポイントが壊れていて復元できなかった（ホストに hostInit をやり直してもらう） */
  corrupt = false;
  /** 最後に配信した状態（全員がこの状態を持っている）と、その seq */
  private lastSent: GameState | null = null;
  seq = 0;
  private sim: SimCtx = makeCtx();
  private rids = new Map<string, RidCache>();
  layoutHolder: string | null = null;

  private rts = new Map<WebSocket, Runtime>();
  /** 切断処理済みの接続（close と error の両方が来ても一度だけ処理する） */
  private closed = new WeakSet<WebSocket>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private tickCount = 0;
  private lastTickAt = 0;
  private acc = 0;
  private dirty = false;
  private checkpointDirty = false;
  private lastHashAt = 0;
  private saving = new Map<string, Promise<string>>();
  private tickErrors = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    void ctx.blockConcurrencyWhile(async () => {
      this.load();
    });
  }

  // ───────────────────────── 永続化 ─────────────────────────

  private load(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS checkpoint_chunks (idx INTEGER PRIMARY KEY, data TEXT NOT NULL)');
    const m = this.kvGet('meta');
    this.meta = m ? (JSON.parse(m) as RoomMeta) : null;
    if (this.meta && !this.meta.ended) this.restore();
    // 休止・退避から復帰した場合: 接続中の WebSocket を作り直し、全員に全体を送り直す
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a?.hello && !a.gone) this.rts.set(ws, this.newRuntime(true));
    }
    if (this.state) {
      // 接続状態は実際の WebSocket に合わせ直す。ホストがいなければ一時停止のまま（推測で進めない）
      const live = new Set([...this.seated().keys()].map((pid) => this.actorIdOf(pid)));
      for (const p of this.state.players) p.connected = live.has(p.id);
      if (!this.hostConnected()) this.state.paused = true;
      this.dirty = true;
      if (live.size > 0) this.flush();
    }
    this.ensureLoop();
  }

  private kvGet(k: string): string | null {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }

  private kvPut(k: string, v: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  private saveMeta(): void {
    if (this.meta) this.kvPut('meta', JSON.stringify(this.meta));
  }

  /** チェックポイントから状態を戻す。壊れていたら推測で続行しない（設計書 17.7） */
  private restore(): void {
    const h = this.kvGet('checkpoint');
    if (!h) return;
    const hdr = JSON.parse(h) as { n: number; sum: string; length: number };
    const rows = this.sql.exec<{ idx: number; data: string }>('SELECT idx, data FROM checkpoint_chunks ORDER BY idx').toArray();
    const r =
      rows.length === hdr.n && rows.every((row, i) => row.idx === i)
        ? decodeCheckpoint(
            rows.map((x) => x.data),
            hdr.sum,
            hdr.length,
          )
        : ({ ok: false, error: `断片の数が一致しません（${rows.length} / ${hdr.n}）` } as const);
    if (!r.ok) {
      this.corrupt = true;
      this.state = null;
      log('error', 'checkpoint_corrupt', { roomId: this.meta?.roomId, error: r.error });
      this.auditLater({ kind: 'checkpoint_corrupt', detail: r.error });
      return;
    }
    this.state = r.data.state;
    this.seq = r.data.seq;
    this.lastSent = clone(this.state);
    this.rids = new Map(Object.entries(r.data.rids).map(([k, v]) => [k, RidCache.from(v)]));
    this.layoutHolder = null;
  }

  /** 現在の確定状態を保存する（重複検出の requestId も同時に保存） */
  checkpoint(reason: string): void {
    if (!this.state || !this.meta) return;
    const data: CheckpointData = {
      v: 1,
      seq: this.seq,
      savedAt: Date.now(),
      state: this.state,
      rids: Object.fromEntries([...this.rids.entries()].map(([k, c]) => [k, c.entries()])),
    };
    const enc = encodeCheckpoint(data);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM checkpoint_chunks');
      enc.chunks.forEach((c, i) => this.sql.exec('INSERT INTO checkpoint_chunks (idx, data) VALUES (?, ?)', i, c));
      this.kvPut('checkpoint', JSON.stringify({ n: enc.chunks.length, sum: enc.sum, length: enc.length, seq: this.seq, savedAt: data.savedAt, reason }));
      this.saveMeta();
    });
    this.checkpointDirty = false;
  }

  private clearCheckpoint(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM checkpoint_chunks');
      this.sql.exec("DELETE FROM kv WHERE k = 'checkpoint'");
      this.saveMeta();
    });
  }

  // ───────────────────────── HTTP（Worker からの内部呼び出し） ─────────────────────────

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/internal/init' && req.method === 'POST') {
      const b = (await req.json()) as { roomId: string; code: string; hostId: string; createdAt: number };
      if (!this.meta) {
        this.meta = { roomId: b.roomId, code: b.code, hostId: b.hostId, hostActorId: null, createdAt: b.createdAt, ended: false, saveRevision: 0, lastActivityAt: Date.now() };
        this.saveMeta();
        this.scheduleAlarm();
      }
      return Response.json({ ok: true });
    }
    if (url.pathname === '/internal/leave' && req.method === 'POST') {
      const b = (await req.json()) as { playerId: string };
      const ended = await this.leave(b.playerId);
      return Response.json({ ok: true, ended });
    }
    if (url.pathname === '/ws') return this.acceptSocket(req);
    return new Response('not found', { status: 404 });
  }

  private acceptSocket(req: Request): Response {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    const pid = req.headers.get(IDENTITY_HEADERS.playerId);
    const nameRaw = req.headers.get(IDENTITY_HEADERS.name);
    if (!pid || !nameRaw || !this.meta || req.headers.get(IDENTITY_HEADERS.roomId) !== this.meta.roomId) {
      return new Response('room not found', { status: 404 });
    }
    let name = pid;
    try {
      name = decodeURIComponent(nameRaw);
    } catch {
      // そのまま pid を使う
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [pid]);
    const a: Attachment = { pid, name, hello: false, gone: false, at: Date.now() };
    server.serializeAttachment(a);
    if (this.meta.ended) {
      this.reject(server, a, 'room_closed', 'このルームは終了しています', CLOSE.roomClosed);
    } else if (this.ctx.getWebSockets().length > MAX_SOCKETS) {
      this.reject(server, a, 'too_many_connections', '接続が多すぎます', CLOSE.roomFull);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  // ───────────────────────── WebSocket イベント ─────────────────────────

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.att(ws);
    if (!a || a.gone || this.closed.has(ws)) return;
    const rt = this.rt(ws);
    if (typeof message !== 'string') {
      this.sendError(ws, 'bad_message', 'テキストの JSON で送信してください');
      return;
    }
    if (message.length > MAX_HOST_INIT_BYTES) {
      this.sendError(ws, 'too_large', 'メッセージが大きすぎます');
      this.kick(ws, a, 1009, 'too large');
      return;
    }
    // レート制限（move も数える）。大きなメッセージは解析前に多めに消費する
    const pre = message.length > MAX_MSG_BYTES ? (WS_MSG_COST.hostInit ?? 10) : 1;
    if (!rt.bucket.take(pre)) {
      this.rateLimited(ws, a);
      return;
    }
    let v: unknown;
    try {
      v = safeJsonParse(message);
    } catch {
      this.sendError(ws, 'bad_json', 'JSON として読めません');
      return;
    }
    const m = parseClientMsg(v);
    if (typeof m === 'string') {
      this.sendError(ws, 'bad_message', m);
      return;
    }
    if (m.t !== 'hostInit' && message.length > MAX_MSG_BYTES) {
      this.sendError(ws, 'too_large', 'メッセージが大きすぎます');
      return;
    }
    const extra = (WS_MSG_COST[m.t] ?? 1) - pre;
    if (extra > 0 && !rt.bucket.take(extra)) {
      this.rateLimited(ws, a);
      return;
    }
    if (m.t !== 'hello' && !a.hello) {
      this.sendError(ws, 'hello_required', '最初に hello を送ってください');
      return;
    }
    try {
      switch (m.t) {
        case 'hello':
          this.onHello(ws, a, m);
          break;
        case 'act':
          this.onAct(ws, a, m);
          break;
        case 'ping':
          this.send(ws, { t: 'pong', ts: m.ts, serverTime: Date.now() });
          break;
        case 'hostInit':
          this.onHostInit(ws, a, m);
          break;
        case 'resync':
          rt.needFull = true;
          this.flush();
          break;
        case 'save':
          await this.onSave(ws, a, m);
          break;
        case 'layoutLock':
          this.onLayoutLock(ws, a, m.on);
          break;
      }
    } catch (e) {
      log('error', 'ws_handler_error', { roomId: this.meta?.roomId, t: m.t, error: String((e as Error)?.stack ?? e) });
      this.sendError(ws, 'server_error', 'サーバーでエラーが発生しました');
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = this.att(ws);
    if (a) this.onDisconnect(ws, a);
    try {
      ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, 'closed');
    } catch {
      // すでに閉じている
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const a = this.att(ws);
    if (a) this.onDisconnect(ws, a);
  }

  override async alarm(): Promise<void> {
    if (!this.meta || this.meta.ended) return;
    const now = Date.now();
    this.closeSilentSockets(now);
    // 番犬: ループが止まっていたら再開する
    if (this.loop && now - this.lastTickAt > 5000) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.ensureLoop();
    if (this.connectedCount() === 0 && now - this.meta.lastActivityAt >= IDLE_TTL_MS) {
      await this.endRoom('idle');
      return;
    }
    this.scheduleAlarm();
  }

  // ───────────────────────── 接続の補助 ─────────────────────────

  private att(ws: WebSocket): Attachment | null {
    try {
      const a = ws.deserializeAttachment() as Attachment | null;
      return isObj(a) && typeof a.pid === 'string' ? a : null;
    } catch {
      return null;
    }
  }

  private newRuntime(needFull: boolean): Runtime {
    return { bucket: new TokenBucket(WS_MSG_RATE.capacity, WS_MSG_RATE.refillPerSec), needFull, lastFullAt: 0 };
  }

  private rt(ws: WebSocket): Runtime {
    let r = this.rts.get(ws);
    if (!r) {
      r = this.newRuntime(true);
      this.rts.set(ws, r);
    }
    return r;
  }

  /** 席を持っている（hello 済みで生きている）接続。プレイヤーIDごとに1つ */
  private seated(): Map<string, WebSocket> {
    const out = new Map<string, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      if (this.closed.has(ws) || ws.readyState !== 1) continue;
      const a = this.att(ws);
      if (a?.hello && !a.gone) out.set(a.pid, ws);
    }
    return out;
  }

  connectedCount(): number {
    return this.seated().size;
  }

  private hostConnected(): boolean {
    return !!this.meta && this.seated().has(this.meta.hostId);
  }

  /** アカウントID → 状態の中のプレイヤーID */
  private actorIdOf(pid: string): string {
    if (this.meta && pid === this.meta.hostId && this.meta.hostActorId) return this.meta.hostActorId;
    return pid;
  }

  private isHost(pid: string): boolean {
    return !!this.meta && pid === this.meta.hostId;
  }

  private send(ws: WebSocket, msg: ServerMsg | string): void {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch {
      // 切断中の接続には送れない（close イベントで処理する）
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.send(ws, { t: 'error', code, message });
  }

  private broadcast(msg: ServerMsg, except?: WebSocket): void {
    const text = JSON.stringify(msg);
    for (const ws of this.seated().values()) if (ws !== except) this.send(ws, text);
  }

  /** 席を持たない接続を、エラーを伝えてから閉じる */
  private reject(ws: WebSocket, a: Attachment, code: string, message: string, closeCode: number): void {
    this.sendError(ws, code, message);
    a.gone = true;
    try {
      ws.serializeAttachment(a);
    } catch {
      // 無視
    }
    this.closed.add(ws);
    this.rts.delete(ws);
    try {
      ws.close(closeCode, code);
    } catch {
      // 無視
    }
  }

  /** 席を持つ接続をサーバーから切る（切断処理を先に済ませる） */
  private kick(ws: WebSocket, a: Attachment, closeCode: number, reason: string): void {
    this.onDisconnect(ws, a);
    try {
      ws.close(closeCode, reason);
    } catch {
      // 無視
    }
  }

  private rateLimited(ws: WebSocket, a: Attachment): void {
    this.sendError(ws, 'rate_limited', '送信が多すぎます。接続を切断しました');
    this.auditLater({ kind: 'ws_rate_limited', playerId: a.pid });
    this.kick(ws, a, CLOSE.rateLimited, 'rate limited');
  }

  private closeSilentSockets(now: number): void {
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a && !a.hello && !a.gone && now - a.at > HELLO_TIMEOUT_MS) this.reject(ws, a, 'hello_timeout', 'hello がありませんでした', CLOSE.helloTimeout);
    }
  }

  private auditLater(e: AuditEntry): void {
    this.ctx.waitUntil(audit(this.env.DB, { roomId: this.meta?.roomId ?? null, ...e }));
  }

  // ───────────────────────── 入室・退室 ─────────────────────────

  private onHello(ws: WebSocket, a: Attachment, m: Extract<ClientMsg, { t: 'hello' }>): void {
    const meta = this.meta!;
    if (m.protocol !== PROTOCOL_VERSION) {
      this.reject(ws, a, 'protocol_mismatch', `通信プロトコルのバージョンが違います（サーバー: ${PROTOCOL_VERSION}）。ページを再読み込みしてください`, CLOSE.version);
      return;
    }
    if (!isClientSupported(m.clientVersion, this.env.MIN_CLIENT_VERSION)) {
      this.reject(ws, a, 'client_outdated', `クライアントが古いため接続できません（${this.env.MIN_CLIENT_VERSION} 以上が必要）。ページを再読み込みしてください`, CLOSE.version);
      return;
    }
    const rt = this.rt(ws);
    if (a.hello) {
      // 2回目の hello: 状態を送り直すだけ
      this.sendWelcome(ws, a);
      rt.needFull = true;
      this.flush();
      return;
    }
    // 同じプレイヤーの古い接続を置き換える（席を二重に取らない）
    let replaced = false;
    for (const other of this.ctx.getWebSockets(a.pid)) {
      if (other === ws) continue;
      const oa = this.att(other);
      if (!oa || oa.gone) continue;
      if (oa.hello) replaced = true;
      this.reject(other, oa, 'replaced', '別の接続で同じプレイヤーが参加しました', CLOSE.replaced);
    }
    if (!replaced && this.connectedCount() >= MAX_PLAYERS) {
      this.auditLater({ kind: 'ws_room_full', playerId: a.pid });
      this.reject(ws, a, 'room_full', `このルームは満員です（最大${MAX_PLAYERS}人）`, CLOSE.roomFull);
      return;
    }
    a.hello = true;
    // 表示名は hello の名前（検証済み）を優先し、なければアカウント登録時の名前を使う
    a.name = cleanName(m.name) ?? a.name;
    ws.serializeAttachment(a);
    rt.needFull = true;
    const host = this.isHost(a.pid);
    let resumed = false;
    if (this.state) {
      const p = this.ensurePlayer(a.pid, a.name);
      p.connected = true;
      this.dirty = true;
      if (host && this.state.paused) {
        // ホストが戻ったので再開（設計書 17.7）
        this.state.paused = false;
        resumed = true;
      }
    }
    this.sendWelcome(ws, a);
    this.send(ws, { t: 'layoutLock', holder: this.layoutHolder });
    if (this.state) {
      this.flush();
      if (resumed) this.broadcast({ t: 'resumed' }, ws);
      else if (this.state.paused) this.send(ws, { t: 'paused', reason: 'host_disconnected' });
    }
    this.broadcastPeers();
    this.ensureLoop();
    if (this.state && (resumed || !this.loop)) this.checkpoint('join');
    this.scheduleAlarm();
  }

  private sendWelcome(ws: WebSocket, a: Attachment): void {
    const host = this.isHost(a.pid);
    this.send(ws, {
      t: 'welcome',
      playerId: this.state ? this.actorIdOf(a.pid) : a.pid,
      roomId: this.meta!.roomId,
      isHost: host,
      protocol: PROTOCOL_VERSION,
      needInit: host && !this.state,
    });
  }

  /** 状態の中にプレイヤーがいなければ追加する */
  private ensurePlayer(pid: string, name: string): Player {
    const s = this.state!;
    const id = this.actorIdOf(pid);
    let p = s.players.find((x) => x.id === id);
    if (!p) {
      p = makePlayer(s, id, name, this.isHost(pid));
      s.players.push(p);
    }
    return p;
  }

  private onDisconnect(ws: WebSocket, a: Attachment): void {
    if (this.closed.has(ws)) return;
    this.closed.add(ws);
    this.rts.delete(ws);
    if (!a.hello || a.gone) return;
    a.gone = true;
    try {
      ws.serializeAttachment(a);
    } catch {
      // 閉じた接続には書けないことがある
    }
    // 同じプレイヤーの別の接続が生きていれば席はそのまま
    if (this.seated().has(a.pid)) return;
    const meta = this.meta!;
    const host = this.isHost(a.pid);
    meta.lastActivityAt = Date.now();
    if (this.state) {
      const id = this.actorIdOf(a.pid);
      const p = this.state.players.find((x) => x.id === id);
      if (p) {
        // 手に持っていた物を落とさないように戻す（設計書 22: 切断で在庫が不整合にならない）
        if (p.work) cancelWork(this.state, p, this.sim, '切断したため作業を中断した');
        dropHand(this.state, p, this.sim);
        p.connected = false;
      }
      if (host) this.state.paused = true;
      this.dirty = true;
    }
    if (this.layoutHolder !== null && this.layoutHolder === this.actorIdOf(a.pid)) {
      this.layoutHolder = null;
      this.broadcast({ t: 'layoutLock', holder: null });
    }
    if (this.state) {
      this.flush();
      if (host) this.broadcast({ t: 'paused', reason: 'host_disconnected' });
    }
    this.broadcastPeers();
    this.ensureLoop();
    if (this.state) this.checkpoint(host ? 'host_disconnect' : 'disconnect');
    else this.saveMeta();
    this.scheduleAlarm();
  }

  /** 明示的な退出（POST /api/v1/session/leave）。ホストが退出したらルームを終了する */
  async leave(pid: string): Promise<boolean> {
    if (!this.meta) return false;
    for (const ws of this.ctx.getWebSockets(pid)) {
      const a = this.att(ws);
      if (!a) continue;
      if (a.hello && !a.gone) this.kick(ws, a, CLOSE.left, 'left');
      else this.reject(ws, a, 'left', '退出しました', CLOSE.left);
    }
    if (this.isHost(pid)) {
      await this.endRoom('host_left');
      return true;
    }
    return this.meta.ended;
  }

  /** ルームを終了する。最終状態を D1 に控えとして残し、全員を切断する */
  async endRoom(reason: string): Promise<void> {
    const meta = this.meta;
    if (!meta || meta.ended) return;
    this.flush();
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    const now = Date.now();
    if (this.state && validateState(this.state).length === 0) {
      const file = makeSaveFile(this.state, 0, null, now);
      file.saveId = `room-${meta.roomId}`;
      file.revision = meta.saveRevision + 1;
      file.createdAt = meta.createdAt;
      try {
        const body = JSON.stringify(file);
        if (new TextEncoder().encode(body).length > MAX_STORED_BYTES) throw new Error('snapshot too large');
        await ensureSchema(this.env.DB);
        // 最終状態だけを残し、途中の保存の控えは消す
        await this.env.DB.batch([
          this.env.DB.prepare(
            "INSERT INTO room_snapshots (room_id, kind, revision, body, created_at) VALUES (?, 'final', ?, ?, ?) ON CONFLICT(room_id, kind, revision) DO UPDATE SET body = excluded.body, created_at = excluded.created_at",
          ).bind(meta.roomId, file.revision, body, now),
          this.env.DB.prepare("DELETE FROM room_snapshots WHERE room_id = ? AND kind = 'save'").bind(meta.roomId),
        ]);
      } catch (e) {
        log('error', 'room_archive_failed', { roomId: meta.roomId, error: String(e) });
      }
    }
    meta.ended = true;
    this.broadcast({ t: 'error', code: 'room_closed', message: reason === 'idle' ? '長時間使われなかったためルームを終了しました' : 'ホストがルームを終了しました' });
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a) {
        this.closed.add(ws);
        a.gone = true;
        try {
          ws.serializeAttachment(a);
        } catch {
          // 無視
        }
      }
      try {
        ws.close(CLOSE.roomClosed, 'room closed');
      } catch {
        // 無視
      }
    }
    this.rts.clear();
    this.state = null;
    this.lastSent = null;
    this.clearCheckpoint();
    await this.ctx.storage.deleteAlarm();
    try {
      await this.env.DB.prepare("UPDATE rooms SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'open'").bind(now, meta.roomId).run();
    } catch (e) {
      log('error', 'room_end_d1_failed', { roomId: meta.roomId, error: String(e) });
    }
    this.auditLater({ kind: reason === 'idle' ? 'room_expire' : 'room_end', detail: { reason } });
  }

  private peers(): PeerInfo[] {
    const live = new Set([...this.seated().keys()].map((pid) => this.actorIdOf(pid)));
    const hostActor = this.meta?.hostActorId ?? this.meta?.hostId;
    if (this.state) {
      return this.state.players.map((p) => ({ id: p.id, name: p.name, color: p.color, connected: live.has(p.id), isHost: p.id === hostActor }));
    }
    return [...this.seated().entries()].map(([pid, ws], i) => ({
      id: pid,
      name: this.att(ws)?.name ?? pid,
      color: PLAYER_COLORS[i % PLAYER_COLORS.length]!,
      connected: true,
      isHost: this.isHost(pid),
    }));
  }

  private broadcastPeers(): void {
    this.broadcast({ t: 'peers', list: this.peers() });
  }

  // ───────────────────────── 操作 ─────────────────────────

  private ridCache(key: string): RidCache {
    let c = this.rids.get(key);
    if (!c) {
      c = new RidCache();
      this.rids.set(key, c);
    }
    return c;
  }

  private onAct(ws: WebSocket, a: Attachment, m: Extract<ClientMsg, { t: 'act' }>): void {
    const s = this.state;
    if (!s) {
      this.send(ws, { t: 'res', rid: m.rid, r: fail('ホストがゲームを開始するのを待っています') });
      return;
    }
    const isMove = m.a.type === 'move';
    // 移動は最新位置の上書きなので重複検出しない（キャッシュを移動で埋めないため）
    const cache = isMove ? null : this.ridCache(a.pid);
    const hit = cache?.get(m.rid);
    if (hit) {
      // 同じ requestId の再送: 適用せずに前回の結果を返す（設計書 17.6）
      this.send(ws, { t: 'res', rid: m.rid, r: hit });
      return;
    }
    const actorId = this.actorIdOf(a.pid);
    const host = this.isHost(a.pid);
    let r: ActionResult;
    if (s.paused) {
      r = fail('ホストの再接続を待っています（一時停止中）');
    } else if (HOST_ONLY.has(m.a.type) && !host) {
      r = fail('ホストだけが実行できる操作です');
      this.auditLater({ kind: 'action_rejected', playerId: a.pid, detail: { type: m.a.type, reason: 'host_only' } });
    } else if (LAYOUT_ACTIONS.has(m.a.type) && this.layoutHolder !== actorId) {
      r = fail('レイアウトを変更するには編集ロックを取得してください');
    } else if (m.a.type === 'buyEquipment' && m.a.autoPlace && this.layoutHolder !== null && this.layoutHolder !== actorId) {
      r = fail('他のプレイヤーがレイアウトを編集中です');
    } else {
      const phase = s.phase;
      try {
        r = applyAction(s, actorId, m.a, this.sim, Date.now() / 1000);
      } catch (e) {
        r = fail('サーバーでエラーが発生しました');
        log('error', 'action_exception', { roomId: this.meta?.roomId, type: m.a.type, error: String((e as Error)?.stack ?? e) });
        this.auditLater({ kind: 'action_exception', playerId: a.pid, detail: { type: m.a.type, error: String(e) } });
      }
      this.dirty = true;
      if (s.phase !== phase && (s.phase === 'closed' || s.phase === 'bankrupt')) this.checkpoint('phase');
    }
    cache?.set(m.rid, r);
    this.send(ws, { t: 'res', rid: m.rid, r });
    // 観測バージョンが大きく遅れているクライアントには全体を送り直す
    const rt = this.rts.get(ws);
    const now = Date.now();
    if (rt && m.v >= 0 && m.v < this.seq - BEHIND_SEQ && now - rt.lastFullAt > 5000) {
      rt.needFull = true;
      this.flush();
    }
  }

  private onHostInit(ws: WebSocket, a: Attachment, m: Extract<ClientMsg, { t: 'hostInit' }>): void {
    const meta = this.meta!;
    if (!this.isHost(a.pid)) {
      this.sendError(ws, 'host_only', 'ホストだけがキャリアを持ち込めます');
      return;
    }
    if (this.state) {
      this.sendError(ws, 'already_initialized', 'このルームはすでに開始しています');
      this.rt(ws).needFull = true;
      this.flush();
      return;
    }
    const checked = checkHostState(m.state);
    if (typeof checked === 'string') {
      this.sendError(ws, 'invalid_state', `持ち込んだキャリアを読み込めません: ${checked}`);
      this.auditLater({ kind: 'host_init_rejected', playerId: a.pid, detail: checked });
      return;
    }
    const s = checked;
    for (const p of s.players) {
      p.connected = false;
      p.lastMoveAt = 0;
    }
    s.paused = false;
    let hostPlayer = s.players.find((p) => p.isHost) ?? s.players[0];
    if (!hostPlayer) {
      hostPlayer = makePlayer(s, a.pid, a.name, true);
      s.players.push(hostPlayer);
    }
    hostPlayer.isHost = true;
    meta.hostActorId = hostPlayer.id;
    this.state = s;
    this.corrupt = false;
    this.sim = makeCtx();
    this.lastSent = clone(s);
    this.seq += 1;
    // すでに接続しているゲストを追加
    for (const [pid, sock] of this.seated()) {
      this.ensurePlayer(pid, this.att(sock)?.name ?? pid).connected = true;
      this.rt(sock).needFull = true;
    }
    this.dirty = true;
    // ホストの状態内IDが確定したので welcome を送り直す
    this.sendWelcome(ws, a);
    this.flush();
    this.broadcastPeers();
    this.checkpoint('hostInit');
    this.ensureLoop();
    this.scheduleAlarm();
    this.auditLater({ kind: 'host_init', playerId: a.pid, detail: { day: s.day, shop: s.shopName } });
  }

  private onLayoutLock(ws: WebSocket, a: Attachment, on: boolean): void {
    if (!this.state) {
      this.sendError(ws, 'not_ready', 'ゲームの開始を待っています');
      return;
    }
    const id = this.actorIdOf(a.pid);
    if (on) {
      if (this.layoutHolder === null || this.layoutHolder === id) {
        this.layoutHolder = id;
        this.broadcast({ t: 'layoutLock', holder: id });
      } else {
        this.sendError(ws, 'layout_locked', '他のプレイヤーがレイアウトを編集中です');
        this.send(ws, { t: 'layoutLock', holder: this.layoutHolder });
      }
    } else if (this.layoutHolder === id) {
      this.layoutHolder = null;
      this.broadcast({ t: 'layoutLock', holder: null });
    }
  }

  /** ホストの保存要求（設計書 16.4）。検証した確定状態を返し、D1 にも控えを置く */
  private async onSave(ws: WebSocket, a: Attachment, m: Extract<ClientMsg, { t: 'save' }>): Promise<void> {
    const meta = this.meta!;
    if (!this.isHost(a.pid)) {
      this.send(ws, { t: 'saved', rid: m.rid, ok: false, error: 'ホストだけが保存できます' });
      return;
    }
    const inflight = this.saving.get(m.rid);
    if (inflight) {
      this.send(ws, await inflight);
      return;
    }
    const cache = this.ridCache(`${a.pid}#save`);
    const hit = cache.get(m.rid);
    if (hit) {
      // 同じ保存要求の再送: もう一度保存せず、前回の内容を返す
      const revision = (hit.data as { revision?: number } | undefined)?.revision;
      const row =
        hit.ok && typeof revision === 'number'
          ? await this.env.DB.prepare("SELECT body FROM room_snapshots WHERE room_id = ? AND kind = 'save' AND revision = ?")
              .bind(meta.roomId, revision)
              .first<{ body: string }>()
          : null;
      if (row) {
        const file = JSON.parse(row.body) as { state: GameState; checksum: string };
        this.send(ws, { t: 'saved', rid: m.rid, ok: true, state: file.state, checksum: file.checksum });
      } else {
        this.send(ws, { t: 'saved', rid: m.rid, ok: false, error: hit.reason ?? '前回の保存結果が見つかりません' });
      }
      return;
    }
    const s = this.state;
    if (!s) {
      this.send(ws, { t: 'saved', rid: m.rid, ok: false, error: 'ゲームが開始されていません' });
      return;
    }
    const errs = preSaveCheck(s);
    if (errs.length > 0) {
      const error = `保存前チェックに失敗: ${errs[0]}`;
      cache.set(m.rid, fail(error));
      this.send(ws, { t: 'saved', rid: m.rid, ok: false, error });
      return;
    }
    // ここまでは同期処理なので、この時点の状態がそのまま保存される
    const now = Date.now();
    const file = makeSaveFile(s, 0, null, now);
    file.saveId = `room-${meta.roomId}`;
    file.revision = ++meta.saveRevision;
    file.createdAt = meta.createdAt;
    cache.set(m.rid, { ok: true, data: { revision: file.revision, checksum: file.checksum } });
    this.checkpoint('save');
    const job = (async (): Promise<string> => {
      try {
        const body = JSON.stringify(file);
        if (new TextEncoder().encode(body).length > MAX_STORED_BYTES) throw new Error('snapshot too large');
        await ensureSchema(this.env.DB);
        await this.env.DB.batch([
          this.env.DB.prepare("INSERT INTO room_snapshots (room_id, kind, revision, body, created_at) VALUES (?, 'save', ?, ?, ?)").bind(
            meta.roomId,
            file.revision,
            body,
            now,
          ),
          this.env.DB.prepare("DELETE FROM room_snapshots WHERE room_id = ? AND kind = 'save' AND revision <= ?").bind(meta.roomId, file.revision - KEEP_ROOM_SAVES),
        ]);
      } catch (e) {
        log('error', 'room_save_failed', { roomId: meta.roomId, error: String(e) });
        cache.set(m.rid, fail('クラウドへの保存に失敗しました'));
        return JSON.stringify({ t: 'saved', rid: m.rid, ok: false, error: 'クラウドへの保存に失敗しました' } satisfies ServerMsg);
      }
      this.auditLater({ kind: 'room_save', playerId: a.pid, detail: { revision: file.revision, day: file.meta.day } });
      return JSON.stringify({ t: 'saved', rid: m.rid, ok: true, state: file.state, checksum: file.checksum } satisfies ServerMsg);
    })();
    this.saving.set(m.rid, job);
    try {
      this.send(ws, await job);
    } finally {
      this.saving.delete(m.rid);
    }
  }

  // ───────────────────────── ループと配信 ─────────────────────────

  private ensureLoop(): void {
    const run = !!this.state && !!this.meta && !this.meta.ended && !this.state.paused && this.hostConnected();
    if (run && !this.loop) {
      this.lastTickAt = Date.now();
      this.acc = 0;
      this.loop = setInterval(() => this.tick(), TICK_MS);
      this.scheduleAlarm();
    } else if (!run && this.loop) {
      clearInterval(this.loop);
      this.loop = null;
      this.flush();
      if (this.checkpointDirty || this.dirty) this.checkpoint('stop');
      this.scheduleAlarm();
    }
  }

  get loopRunning(): boolean {
    return this.loop !== null;
  }

  /** テスト用: インスタンスの喪失を模擬するためにループだけを止める（状態は保存しない） */
  stopLoopForTest(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  /** 10Hz のティック。実時間の経過に合わせて step を回す（遅れは最大 0.5 秒分まで取り戻す） */
  tick(): void {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    this.acc += Math.min(1000, Math.max(0, now - this.lastTickAt)) / 1000;
    this.lastTickAt = now;
    const phase = s.phase;
    const version = s.version;
    try {
      let n = 0;
      while (this.acc >= STEP_DT - 1e-6 && n < 5) {
        step(s, STEP_DT, this.sim);
        this.acc -= STEP_DT;
        n++;
      }
      if (n === 5) this.acc = 0;
      this.tickErrors = 0;
    } catch (e) {
      this.tickErrors++;
      log('error', 'step_exception', { roomId: this.meta?.roomId, error: String((e as Error)?.stack ?? e) });
      if (this.tickErrors >= 10) {
        // 同じ例外が続く場合は推測で進めず、一時停止して確定状態を守る
        s.paused = true;
        this.flush();
        this.broadcast({ t: 'paused', reason: 'server_error' });
        this.ensureLoop();
        return;
      }
    }
    if (s.version !== version) this.dirty = true;
    this.tickCount++;
    if (s.phase !== phase && (s.phase === 'closed' || s.phase === 'bankrupt')) {
      this.flush();
      this.checkpoint('phase');
    } else if (this.tickCount % BROADCAST_EVERY_TICKS === 0) {
      this.flush();
    }
    if (this.tickCount % CHECKPOINT_EVERY_TICKS === 0) {
      if (this.checkpointDirty || this.dirty) this.checkpoint('periodic');
      this.closeSilentSockets(now);
    }
  }

  /**
   * 前回の配信からの差分を全員に送る。needFull の接続には全体（full）を送る。
   * full は必ず差分の配信後の状態（lastSent）なので、以後のパッチがそのまま当てはまる。
   */
  flush(): void {
    const s = this.state;
    if (!s) return;
    if (!this.lastSent) this.lastSent = clone(s);
    let patch: string | null = null;
    const ops = this.dirty || this.sim.events.length > 0 ? diff(this.lastSent, s) : [];
    const ev = this.sim.events.splice(0);
    this.dirty = false;
    if (ops.length > 0 || ev.length > 0) {
      const from = this.seq;
      this.seq += 1;
      this.lastSent = clone(s);
      const msg: Extract<ServerMsg, { t: 'patch' }> = { t: 'patch', from, to: this.seq, ops, ev };
      const now = Date.now();
      if (now - this.lastHashAt >= HASH_INTERVAL_MS) {
        msg.h = stateChecksum(this.lastSent);
        this.lastHashAt = now;
      }
      patch = JSON.stringify(msg);
      this.checkpointDirty = true;
    }
    let full: string | null = null;
    for (const ws of this.seated().values()) {
      const rt = this.rt(ws);
      if (rt.needFull) {
        full ??= JSON.stringify({ t: 'full', seq: this.seq, state: this.lastSent } satisfies ServerMsg);
        this.send(ws, full);
        rt.needFull = false;
        rt.lastFullAt = Date.now();
      } else if (patch) {
        this.send(ws, patch);
      }
    }
  }

  private scheduleAlarm(): void {
    const meta = this.meta;
    if (!meta || meta.ended) return;
    const now = Date.now();
    let at: number;
    if (this.loop) at = now + WATCHDOG_MS;
    else if (this.connectedCount() === 0) at = Math.max(now + 1000, meta.lastActivityAt + IDLE_TTL_MS);
    else at = now + IDLE_TTL_MS;
    // hello 待ちの接続があれば早めに起きて切る
    if (this.ctx.getWebSockets().some((ws) => this.att(ws)?.hello === false)) at = Math.min(at, now + HELLO_TIMEOUT_MS + 1000);
    void this.ctx.storage.setAlarm(at);
  }
}

// ───────────────────────── 持ち込み状態の検証 ─────────────────────────

/** ホストが持ち込んだキャリアを検証する。問題があれば理由を返す */
export function checkHostState(raw: unknown): GameState | string {
  if (!isObj(raw)) return '状態がオブジェクトではありません';
  let s = clone(raw) as Record<string, unknown>;
  try {
    if (s.schema !== SCHEMA_VERSION) s = migrate(s);
  } catch (e) {
    return (e as Error).message;
  }
  const errs = validateState(s);
  if (errs.length > 0) return errs.slice(0, 3).join(', ');
  const st = s as unknown as GameState;
  if (st.phase === 'bankrupt' || st.bankruptcy) return '破産したキャリアでは共同経営を始められません';
  if (st.day === 0 || st.tutorial?.kind === 'basics') return 'チュートリアル（練習の日）のデータでは共同経営を始められません';
  // チュートリアル（従業員の回など）はひとりプレイのみ。途中でも共同経営では行わない
  st.tutorial = null;
  if (st.players.length > 16) return 'プレイヤーが多すぎます';
  const ids = new Set<string>();
  for (const p of st.players as unknown[]) {
    if (!isObj(p) || typeof p.id !== 'string' || p.id.length > 64 || ids.has(p.id)) return 'プレイヤーのデータが壊れています';
    if (!isObj(p.pos) || typeof p.pos.x !== 'number' || typeof p.pos.z !== 'number' || !isObj(p.hand)) return 'プレイヤーのデータが壊れています';
    ids.add(p.id);
  }
  return st;
}
