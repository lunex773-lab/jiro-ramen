// ゲームの進行役（GameHost）。描画・UI は必ずこのインターフェース越しに状態を読み、操作を要求する。
// シングルプレイは LocalHost（ブラウザ内でシミュレーション）、共同経営は RemoteHost（WebSocket）。
// 通信方式を差し替えてもゲーム本体のロジックは変わらない（設計書 2.3）。

import {
  applyAction,
  makeCtx,
  step,
  type Action,
  type ActionResult,
  type GameEvent,
  type GameState,
  type PeerInfo,
  type SimCtx,
} from '@jiro/core';

export type ConnState = 'local' | 'connecting' | 'online' | 'reconnecting' | 'paused' | 'closed';

export interface GameHost {
  readonly mode: 'local' | 'remote';
  readonly playerId: string;
  /** 最新の確定状態（ローカルでは本体、リモートでは複製） */
  readonly state: GameState;
  readonly isHost: boolean;
  readonly conn: ConnState;
  readonly peers: PeerInfo[];
  /** 共同経営の参加コード（ひとりプレイではなし） */
  readonly roomCode?: string;
  /** 操作を要求する */
  act(a: Action): Promise<ActionResult>;
  /** 自分の位置を送る（移動は頻度が高いので専用） */
  move(x: number, z: number, yaw: number): void;
  /** 毎フレーム呼ぶ（ローカルはシミュレーションを進める） */
  tick(dtReal: number): void;
  /** 発生したイベント（効果音・通知用）を受け取る */
  onEvents(cb: (ev: GameEvent[]) => void): () => void;
  onStatus(cb: () => void): () => void;
  /** 速度倍率（シングルプレイのみ） */
  speed: number;
  dispose(): void;
}

export class LocalHost implements GameHost {
  readonly mode = 'local' as const;
  readonly isHost = true;
  readonly conn: ConnState = 'local';
  readonly peers: PeerInfo[] = [];
  speed = 1;
  private ctx: SimCtx = makeCtx();
  private eventCbs = new Set<(ev: GameEvent[]) => void>();
  private statusCbs = new Set<() => void>();
  private moveAcc = 0;

  constructor(
    public state: GameState,
    public readonly playerId: string,
  ) {}

  private flush(): void {
    if (this.ctx.events.length === 0) return;
    const ev = this.ctx.events;
    this.ctx.events = [];
    for (const cb of this.eventCbs) cb(ev);
  }

  act(a: Action): Promise<ActionResult> {
    const r = applyAction(this.state, this.playerId, a, this.ctx, performance.now() / 1000);
    this.flush();
    for (const cb of this.statusCbs) cb();
    return Promise.resolve(r);
  }

  move(x: number, z: number, yaw: number): void {
    // ローカルでもサーバーと同じ検証を通す（衝突判定・速度上限）
    applyAction(this.state, this.playerId, { type: 'move', x, z, yaw }, this.ctx, performance.now() / 1000);
    this.moveAcc++;
  }

  tick(dtReal: number): void {
    const dt = Math.min(0.25, dtReal) * this.speed;
    step(this.state, dt, this.ctx);
    this.flush();
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
    this.eventCbs.clear();
    this.statusCbs.clear();
  }
}
