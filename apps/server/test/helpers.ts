// テスト用の補助: API 呼び出し、WebSocket クライアント（パッチを当てて状態を追従するミラー付き）。

import { applyPatch, canonicalJson, stateChecksum, type ClientMsg, type GameState, type ServerMsg } from '@jiro/core';
import { SELF } from 'cloudflare:test';

export const BASE = 'https://jiro.test';
export const ORIGIN = 'http://localhost:5173';

let ipSeq = 0;
/** テストごとに別の接続元IPにして、HTTP のレート制限が他のテストに影響しないようにする */
export function freshIp(): string {
  ipSeq++;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

export interface CallOpts {
  method?: string;
  token?: string;
  body?: unknown;
  ip?: string;
  headers?: Record<string, string>;
}

export async function call(path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { 'CF-Connecting-IP': o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  let body: string | undefined;
  if (o.body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  }
  return SELF.fetch(`${BASE}${path}`, { method: o.method ?? (body !== undefined ? 'POST' : 'GET'), headers, body });
}

export async function callJson<T = Record<string, unknown>>(path: string, o: CallOpts = {}): Promise<{ status: number; body: T; res: Response }> {
  const res = await call(path, o);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, res };
}

export interface TestPlayer {
  playerId: string;
  token: string;
  name: string;
}

export async function newPlayer(name = 'テスター'): Promise<TestPlayer> {
  const r = await callJson<{ playerId: string; token: string }>('/api/v1/auth/anonymous', { body: { name } });
  if (r.status !== 201) throw new Error(`auth failed ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, name };
}

export interface RoomInfo {
  roomId: string;
  code: string;
  joinToken: string;
}

export async function createRoom(p: TestPlayer): Promise<RoomInfo> {
  const r = await callJson<RoomInfo>('/api/v1/session/create', { token: p.token, body: {} });
  if (r.status !== 200) throw new Error(`create failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function joinRoom(p: TestPlayer, code: string): Promise<{ roomId: string; joinToken: string; isHost: boolean }> {
  const r = await callJson<{ roomId: string; joinToken: string; isHost: boolean }>('/api/v1/session/join', { token: p.token, body: { code } });
  if (r.status !== 200) throw new Error(`join failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

type MsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** WebSocket クライアント。受信した full / patch を core の applyPatch で当てて「ミラー」を持つ */
export class WsClient {
  queue: ServerMsg[] = [];
  all: ServerMsg[] = [];
  closed: { code: number; reason: string } | null = null;
  /** クライアント側で追従している状態 */
  mirror: GameState | null = null;
  seq = -1;
  /** パッチの抜け（from が合わない）の回数 */
  gaps = 0;
  /** patch.h とミラーのチェックサムが合わなかった回数 */
  hashMismatches = 0;
  hashChecks = 0;
  /** seq → その時点のミラーの正規化JSON（recordSnapshots が true のとき） */
  snapshots = new Map<number, string>();
  recordSnapshots = false;
  private waiters: (() => void)[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMsg;
      this.track(msg);
      this.queue.push(msg);
      this.all.push(msg);
      this.wake();
    });
    ws.addEventListener('close', (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
      this.wake();
    });
  }

  static async open(roomId: string, joinToken: string, headers: Record<string, string> = {}): Promise<WsClient> {
    const res = await SELF.fetch(`${BASE}/api/v1/room/${roomId}/ws?token=${encodeURIComponent(joinToken)}`, {
      headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshIp(), ...headers },
    });
    const ws = res.webSocket;
    if (res.status !== 101 || !ws) throw new Error(`ws upgrade failed: ${res.status} ${await res.text()}`);
    ws.accept();
    return new WsClient(ws);
  }

  private track(msg: ServerMsg): void {
    if (msg.t === 'full') {
      this.mirror = JSON.parse(JSON.stringify(msg.state)) as GameState;
      this.seq = msg.seq;
      if (this.recordSnapshots) this.snapshots.set(this.seq, canonicalJson(this.mirror));
    } else if (msg.t === 'patch') {
      if (!this.mirror || msg.from !== this.seq) {
        this.gaps++;
        return;
      }
      this.mirror = applyPatch(this.mirror, JSON.parse(JSON.stringify(msg.ops)));
      this.seq = msg.to;
      if (msg.h) {
        this.hashChecks++;
        if (stateChecksum(this.mirror) !== msg.h) this.hashMismatches++;
      }
      if (this.recordSnapshots) this.snapshots.set(this.seq, canonicalJson(this.mirror));
    }
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private waitAny(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  send(m: ClientMsg | Record<string, unknown> | string): void {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  /** 条件に合う最初の未読メッセージを取り出す（なければ届くまで待つ） */
  async next<T extends ServerMsg['t']>(t: T, pred: (m: MsgOf<T>) => boolean = () => true, timeoutMs = 5000): Promise<MsgOf<T>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((m) => m.t === t && pred(m as MsgOf<T>));
      if (i >= 0) return this.queue.splice(i, 1)[0] as MsgOf<T>;
      const left = deadline - Date.now();
      if (left <= 0 || (this.closed && !(await this.waitAny(10)))) {
        throw new Error(`timeout waiting for ${t}; got: ${this.queue.map((m) => m.t).join(',')}; closed=${JSON.stringify(this.closed)}`);
      }
      if (!this.closed) await this.waitAny(left);
    }
  }

  /** 条件を満たすまで待つ（ミラーの変化など） */
  async until(cond: () => boolean, timeoutMs = 5000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!cond()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}`);
      await this.waitAny(Math.min(left, 200));
    }
  }

  async waitClose(timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    await this.until(() => this.closed !== null, timeoutMs, 'close');
    return this.closed!;
  }

  /** hello を送って welcome を待つ */
  async hello(name = 'テスター', clientVersion = '0.1.0'): Promise<MsgOf<'welcome'>> {
    this.send({ t: 'hello', name, protocol: 1, clientVersion });
    return this.next('welcome');
  }

  close(code = 1000): void {
    try {
      this.ws.close(code, 'bye');
    } catch {
      // 無視
    }
  }

  /** act を送って res を待つ */
  async act(rid: string, a: Record<string, unknown>, v = this.seq): Promise<MsgOf<'res'>> {
    this.send({ t: 'act', rid, a, v });
    return this.next('res', (m) => m.rid === rid);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let ridSeq = 0;
export function rid(prefix = 'r'): string {
  ridSeq++;
  return `${prefix}-${Date.now().toString(36)}-${ridSeq}`;
}
