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
  type EventSlowConfig,
  type SpeedLimit,
  speedLimit,
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
  /** 店で珍しいことが起きている間は倍速を解除する（設定。どのイベントで・何倍に。オーナーの判断 2026-11-13） */
  slow: EventSlowConfig;
  /** 今の倍速の上限（なければ null） */
  speedLimit(): SpeedLimit | null;
  dispose(): void;
}

export class LocalHost implements GameHost {
  readonly mode = 'local' as const;
  readonly isHost = true;
  readonly conn: ConnState = 'local';
  readonly peers: PeerInfo[] = [];
  speed = 1;
  slow: EventSlowConfig = { on: true };
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
    // 爆発事故（発火してから焼け跡のあいだ）は倍速をやめて等速にする（オーナーの指示: 15秒の火事をそのまま体験してから爆発する）。
    // 発火がフレームの途中で始まっても倍速で進みすぎないよう、細かく区切って進める
    // 人を襲った日の事件の間（襲った瞬間から営業が終わるまで）も等速に戻す（オーナーの指示 2026-11-11）
    // 店で珍しいこと（珍客・YouTuber・テレビ取材・覆面調査員・SNS のバズ・クレームなど）が起きている間も、設定の速さ（等倍か2倍）まで下げる
    let real = Math.min(0.25, dtReal);
    while (real > 1e-9) {
      this.capSpeed();
      const r = Math.min(real, 0.05);
      step(this.state, r * this.speed, this.ctx);
      real -= r;
    }
    this.capSpeed();
    this.flush();
  }

  /** 上限より速ければ上限に下げる（上限より遅いときはそのまま。×1 は ×1 のまま） */
  private capSpeed(): void {
    if (this.speed === 1) return;
    const l = this.speedLimit();
    if (l && this.speed > l.cap) this.speed = l.cap;
  }

  speedLimit(): SpeedLimit | null {
    return speedLimit(this.state, this.slow);
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
