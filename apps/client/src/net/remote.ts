// 共同経営の通信アダプター（RemoteHost）。
// サーバー（Durable Object）が確定した状態をパッチで受け取り、操作は requestId 付きで送る。
// 再送しても同じ requestId なのでサーバーで二重適用されない（設計書 17.6）。

import {
  applyPatch,
  PROTOCOL_VERSION,
  stateChecksum,
  type Action,
  type ActionResult,
  type ClientMsg,
  type GameEvent,
  type GameState,
  type PeerInfo,
  type ServerMsg,
} from '@jiro/core';
import type { ConnState, GameHost } from '../game/host';
import type { Api } from './api';

interface Pending {
  msg: ClientMsg;
  resolve: (r: ActionResult) => void;
  timer: number;
}

function rid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

export interface RemoteOptions {
  api: Api;
  authToken: string;
  roomId: string;
  code: string;
  joinToken: string;
  name: string;
  /** ホストが持ち込むキャリア（ホストのみ） */
  initState: GameState | null;
  clientVersion: string;
}

export class RemoteHost implements GameHost {
  readonly mode = 'remote' as const;
  playerId = '';
  isHost = false;
  conn: ConnState = 'connecting';
  peers: PeerInfo[] = [];
  speed = 1;
  state: GameState;
  layoutHolder: string | null = null;
  lastError = '';
  private ws: WebSocket | null = null;
  private seq = -1;
  private pending = new Map<string, Pending>();
  private eventCbs = new Set<(ev: GameEvent[]) => void>();
  private statusCbs = new Set<() => void>();
  private closedByUser = false;
  private retries = 0;
  private saveWaiters = new Map<string, (st: GameState | null) => void>();
  private hashAcc = 0;
  private joinToken: string;
  private readyResolve: ((ok: boolean) => void) | null = null;

  constructor(private opts: RemoteOptions, placeholder: GameState) {
    this.state = placeholder;
    this.joinToken = opts.joinToken;
  }

  /** 接続して最初の全体状態を受け取るまで待つ */
  connect(): Promise<boolean> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
      this.open();
      window.setTimeout(() => {
        if (this.readyResolve) {
          this.readyResolve(false);
          this.readyResolve = null;
        }
      }, 15000);
    });
  }

  private open(): void {
    const url = this.opts.api.wsUrl(this.opts.roomId, this.joinToken);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.send({ t: 'hello', name: this.opts.name, protocol: PROTOCOL_VERSION, clientVersion: this.opts.clientVersion });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      this.ws = null;
      // 4001=バージョン違い 4003=満員 4004=ルーム終了: 再接続しない
      if ([4001, 4003, 4004].includes(ev.code)) this.closedByUser = true;
      if (this.closedByUser) {
        this.setConn('closed');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose で処理
    };
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    this.retries += 1;
    if (this.retries > 8) {
      this.setConn('closed');
      this.readyResolve?.(false);
      this.readyResolve = null;
      return;
    }
    this.setConn('reconnecting');
    const delay = Math.min(10000, 500 * 2 ** this.retries);
    window.setTimeout(async () => {
      // 参加トークンの期限切れに備えて取り直す
      try {
        const r = await this.opts.api.joinRoom(this.opts.authToken, this.opts.code);
        this.joinToken = r.joinToken;
      } catch {
        // そのまま古いトークンで試す
      }
      this.open();
    }, delay);
  }

  private setConn(c: ConnState): void {
    if (this.conn === c) return;
    this.conn = c;
    for (const cb of this.statusCbs) cb();
  }

  private send(m: ClientMsg): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.playerId = msg.playerId;
        this.isHost = msg.isHost;
        if (msg.needInit && msg.isHost && this.opts.initState) this.send({ t: 'hostInit', state: this.opts.initState });
        break;
      case 'full':
        this.state = msg.state;
        this.seq = msg.seq;
        this.setConn(this.state.paused ? 'paused' : 'online');
        // 再接続時: 未確定の操作を同じ requestId で再送（サーバーで重複は無視される）
        for (const p of this.pending.values()) this.send(p.msg);
        if (this.readyResolve) {
          this.readyResolve(true);
          this.readyResolve = null;
        }
        break;
      case 'patch':
        if (msg.from !== this.seq) {
          this.send({ t: 'resync' });
          return;
        }
        try {
          this.state = applyPatch(this.state, msg.ops);
          this.seq = msg.to;
        } catch {
          this.send({ t: 'resync' });
          return;
        }
        if (msg.ev.length > 0) for (const cb of this.eventCbs) cb(msg.ev);
        if (msg.h) {
          // 状態の最終一致を確認（ずれていたら全体を取り直す）
          this.hashAcc++;
          if (stateChecksum(this.state) !== msg.h) this.send({ t: 'resync' });
        }
        break;
      case 'res': {
        const p = this.pending.get(msg.rid);
        if (p) {
          window.clearTimeout(p.timer);
          this.pending.delete(msg.rid);
          p.resolve(msg.r);
        }
        break;
      }
      case 'peers':
        this.peers = msg.list;
        for (const cb of this.statusCbs) cb();
        break;
      case 'paused':
        this.setConn('paused');
        break;
      case 'resumed':
        this.setConn('online');
        break;
      case 'saved': {
        const w = this.saveWaiters.get(msg.rid);
        if (w) {
          this.saveWaiters.delete(msg.rid);
          w(msg.ok && msg.state ? msg.state : null);
        }
        break;
      }
      case 'layoutLock':
        this.layoutHolder = msg.holder;
        for (const cb of this.statusCbs) cb();
        break;
      case 'error':
        this.lastError = msg.message;
        // 再接続しても回復しない理由のときは再試行しない
        if (['room_full', 'unauthorized', 'room_closed', 'client_outdated', 'protocol_mismatch'].includes(msg.code)) {
          this.closedByUser = true;
          this.readyResolve?.(false);
          this.readyResolve = null;
        }
        for (const cb of this.statusCbs) cb();
        break;
      case 'pong':
        break;
    }
  }

  act(a: Action): Promise<ActionResult> {
    return new Promise((resolve) => {
      const id = rid();
      const msg: ClientMsg = { t: 'act', rid: id, a, v: this.seq };
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: '通信がタイムアウトしました' });
      }, 10000);
      this.pending.set(id, { msg, resolve, timer });
      this.send(msg);
    });
  }

  move(x: number, z: number, yaw: number): void {
    // 移動は結果を待たない（確定位置はパッチで届く）
    this.send({ t: 'act', rid: rid(), a: { type: 'move', x, z, yaw }, v: this.seq });
  }

  tick(_dt: number): void {
    // 状態はサーバーが進める
  }

  requestSave(): Promise<GameState | null> {
    return new Promise((resolve) => {
      const id = rid();
      this.saveWaiters.set(id, resolve);
      if (!this.send({ t: 'save', rid: id })) {
        this.saveWaiters.delete(id);
        resolve(null);
      }
      window.setTimeout(() => {
        if (this.saveWaiters.has(id)) {
          this.saveWaiters.delete(id);
          resolve(null);
        }
      }, 10000);
    });
  }

  setLayoutLock(on: boolean): void {
    this.send({ t: 'layoutLock', on });
  }

  onEvents(cb: (ev: GameEvent[]) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onStatus(cb: () => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  dispose(): void {
    this.closedByUser = true;
    this.ws?.close();
    for (const p of this.pending.values()) window.clearTimeout(p.timer);
    this.pending.clear();
    this.eventCbs.clear();
    this.statusCbs.clear();
    void this.opts.api.leaveRoom(this.opts.authToken, this.opts.roomId).catch(() => undefined);
  }
}
