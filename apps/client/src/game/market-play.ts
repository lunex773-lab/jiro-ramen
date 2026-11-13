// 共通市場の企業を端末で営業する（docs/MARKET_RANKING_PLAN.md。オーナーの判断 1: 端末で処理し、1日ごとにサーバーへ送る）。
// 日の始めにサーバーから「その日の条件」（客の取り合いの倍率など）をもらい、営業の終わり（閉店して精算したとき）にその日の結果を確定して送る
// （じろ7 5。前は「翌日の仕込みへ」を押したあとに送っていた）。送れるまで次の日の営業は始められない（判断 1d）。
// 送れなかった日は端末に「送信待ち」として残し、通信が戻ったら同じ本文を送り直す（同じ日の条件の ID なので、サーバーは二重に数えない）。
// 受け取られなかった日は、サーバーの前の日の状態からやり直す（判断 1b）。
// 営業の途中の状態はサーバーに「途中のセーブ」として保存でき（じろ7 4）、次に始めるときはそこから続ける。
// 会社の状態はサーバーにあり、端末のセーブのスロットには保存しない。

import { applyDeliveries, checksum, ensureStartingUnlocks, hasPrepSnapshot, takePrepSnapshot, type Action, type ActionResult, type CheckpointMeta, type CommitResult, type DayTicket, type DeliveryView, type GameState } from '@jiro/core';
import { Api, ApiError, type Auth } from '../net/api';
import { LocalHost } from './host';

/** 市場の営業では使えない操作（新しいキャリア・開発用のイベント・チュートリアル） */
const BLOCKED: ReadonlySet<Action['type']> = new Set<Action['type']>(['giveUp', 'debugEvent', 'tutorial']);

/** 市場の営業の進行役（ひとりプレイと同じ LocalHost。使えない操作だけ断る） */
export class MarketHost extends LocalHost {
  constructor(
    state: GameState,
    playerId: string,
    readonly session: MarketSession,
  ) {
    super(state, playerId);
  }

  override async act(a: Action): Promise<ActionResult> {
    if (a && BLOCKED.has(a.type)) return { ok: false, reason: '市場の営業では使えません' };
    if (a && a.type === 'openShop' && !this.session.ticket) {
      // その日の条件をまだもらっていない（前の日を送ったあと、0時の計算中だった など）: ここでもらう
      if (this.session.hasPending()) return { ok: false, reason: '前の日をサーバーへ送れていないため、まだ開店できません（送信待ち）' };
      const t = await this.session.startTicket();
      if (!t.ok && t.code === 'stale') {
        // サーバーの会社の状態が新しくなっている（企業間の貸し借りのお金が入った・0時の計算など）: 読み直す
        this.session.onStale?.();
        return { ok: false, reason: 'サーバーの会社の状態が新しくなったため、読み直します' };
      }
      if (!t.ok) return { ok: false, reason: t.code === 'sync_pending' || t.code === 'syncing' ? '0時の計算中です。終わってから開店できます' : t.message };
      prepareState(this.state, t.ticket);
    }
    return super.act(a);
  }
}

export interface MarketViewLite {
  mine: { state: GameState; progress: { stateVersion: number; lastProcessedGameDate: number }; checkpoint?: CheckpointMeta | null } | null;
  clock: { syncPending: boolean };
}

export type BeginResult =
  | { ok: true; state: GameState; ticket: DayTicket; resumed: CheckpointMeta | null; sentPending: CommitResult | null }
  | { ok: false; code: string; message: string };

function newToken(): string {
  const r = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `d-${r}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
}

export function errorCode(e: unknown): { code: string; message: string } {
  // サーバーに届かなかった（通信が切れている・サーバーが落ちている）: 送り直せば届くかもしれない
  if (e instanceof ApiError && e.status === 0) return { code: 'network', message: e.message };
  if (e instanceof ApiError) {
    const b = e.body as { code?: string; error?: string; message?: string } | null;
    return { code: b?.code ?? b?.error ?? 'error', message: b?.message ?? b?.error ?? e.message };
  }
  return { code: 'network', message: (e as Error)?.message ?? String(e) };
}

/** 端末に残す送信待ち（その日の条件の ID・営業日・送る本文） */
interface PendingCommit {
  token: string;
  gameDate: number;
  body: string;
  savedAt: number;
}

export type CommitOutcome = CommitResult | { ok: false; code: 'network'; reason: string };

export class MarketSession {
  ticket: DayTicket | null = null;
  version = 0;
  /** 最後に保存した途中のセーブの版（0 = まだ） */
  cpRev = 0;
  /** 途中のセーブを止めた理由（ほかの端末で進んでいるなど） */
  cpBlocked: string | null = null;
  /** 確定した最後の営業日 */
  committedDay: number | null = null;
  /** サーバーの会社の状態が端末より新しいとわかったとき（読み直す。App が入れる） */
  onStale: (() => void) | null = null;
  /** 企業間の貸し借りのお金を入れた・断ったとき（知らせる。App が入れる） */
  onCredit: ((r: { amount: number; memo: string; applied: boolean }[]) => void) | null = null;
  private creditSyncing = false;

  constructor(
    readonly api: Api,
    readonly auth: Auth,
    readonly marketId: string,
  ) {}

  private get pendingKey(): string {
    return `jiro.market.pending.${this.marketId}`;
  }

  /** 送信待ちの日（なければ null） */
  pending(): PendingCommit | null {
    try {
      const v = localStorage.getItem(this.pendingKey);
      if (!v) return null;
      const p = JSON.parse(v) as PendingCommit;
      return typeof p.token === 'string' && typeof p.body === 'string' ? p : null;
    } catch {
      return null;
    }
  }

  hasPending(): boolean {
    return this.pending() !== null;
  }

  private setPending(p: PendingCommit | null): void {
    try {
      if (p) localStorage.setItem(this.pendingKey, JSON.stringify(p));
      else localStorage.removeItem(this.pendingKey);
    } catch {
      // 保存できない端末（プライベートブラウズなど）: 送信待ちは画面を開いている間だけ
    }
  }

  /**
   * サーバーの会社の状態を読み、その日を始める（すでに始めた日があればその続き）。
   * 送信待ちの日があれば、先に送る（送れなければ始めない）。途中のセーブがあれば、そこから続ける。状態が古ければ読み直してもう一度
   */
  async begin(): Promise<BeginResult> {
    let sentPending: CommitResult | null = null;
    if (this.hasPending()) {
      const r = await this.flushPending();
      if (!r.ok && r.code === 'network') return { ok: false, code: 'pending', message: `送信待ちの日があります。通信できるところで、もう一度始めてください（${r.reason}）` };
      sentPending = r as CommitResult;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await this.api.viewMarket<MarketViewLite>(this.auth.token, this.marketId);
      if (!v.mine) return { ok: false, code: 'not_member', message: 'この市場に企業がありません' };
      let state = v.mine.state;
      this.version = v.mine.progress.stateVersion;
      this.committedDay = state.phase === 'closed' && state.finalizedDay === state.day ? state.day : null;
      const r = await this.startTicket();
      if (r.ok) {
        // 途中のセーブ（同じ日の続き）があれば、そこから
        let resumed: CheckpointMeta | null = null;
        const cp = v.mine.checkpoint;
        this.cpRev = cp?.rev ?? 0;
        if (cp && cp.token === r.ticket.token && cp.baseVersion === this.version) {
          const loaded = await this.loadCheckpoint();
          if (loaded) {
            state = loaded.state;
            resumed = loaded.meta;
          }
        }
        prepareState(state, r.ticket);
        return { ok: true, state, ticket: r.ticket, resumed, sentPending };
      }
      if (r.code !== 'stale') return r;
    }
    return { ok: false, code: 'stale', message: '会社の状態を読み直せませんでした' };
  }

  /** その日の条件をもらう */
  async startTicket(): Promise<{ ok: true; ticket: DayTicket } | { ok: false; code: string; message: string }> {
    try {
      const r = await this.api.startMarketDay(this.auth.token, this.marketId, newToken(), this.version);
      this.ticket = r.ticket;
      return { ok: true, ticket: r.ticket };
    } catch (e) {
      return { ok: false, ...errorCode(e) };
    }
  }

  /**
   * その日の結果を送る（営業の終わり・破産の日）。送る前に端末へ送信待ちとして残し、確定の返事が来たら消す（じろ7 5-5）。
   * 通信できなければ送信待ちのまま（あとで flushPending で同じ本文を送り直す）
   */
  async commit(state: GameState): Promise<CommitOutcome> {
    if (!this.ticket) return { ok: false, code: 'no_open_day', reason: '始めていない日です' };
    const p: PendingCommit = { token: this.ticket.token, gameDate: this.ticket.gameDate, body: Api.commitBody(this.ticket.token, state), savedAt: Date.now() };
    this.setPending(p);
    return this.send(p);
  }

  /** 送信待ちの日を送り直す（なければ ok） */
  async flushPending(): Promise<CommitOutcome> {
    const p = this.pending();
    if (!p) return { ok: true };
    return this.send(p);
  }

  private async send(p: PendingCommit): Promise<CommitOutcome> {
    try {
      const r = await this.api.commitMarketDayText(this.auth.token, this.marketId, p.body);
      // 受け取った・受け取らなかった（確かめた結果・期限切れ）のどちらも、サーバーが答えたので送信待ちを消す
      this.setPending(null);
      if (r.ok && typeof r.stateVersion === 'number') {
        this.version = r.stateVersion;
        if (this.ticket?.token === p.token) this.ticket = null;
        this.committedDay = p.gameDate;
        this.cpRev = 0;
      }
      return r;
    } catch (e) {
      const c = errorCode(e);
      if (c.code === 'network' || (e instanceof ApiError && e.status >= 500)) return { ok: false, code: 'network', reason: c.message };
      // 形が不正などの答え: 送り直しても同じなので消す
      this.setPending(null);
      return { ok: false, reason: c.message };
    }
  }

  /**
   * 営業の途中のセーブ（じろ7 4）。今の日の条件の続きとして、版を1つ進めて送る。
   * 保存が確かめられたら（サーバーが答えたら）true。ほかの端末で進んでいる・その日が確定したなどで断られたら、自動の保存を止める
   */
  async saveCheckpoint(state: GameState): Promise<{ ok: true; savedAt: number } | { ok: false; code: string; message: string }> {
    if (this.cpBlocked) return { ok: false, code: 'blocked', message: this.cpBlocked };
    if (!this.ticket) return { ok: false, code: 'no_open_day', message: 'まだその日を始めていません' };
    const stateText = JSON.stringify(state);
    const rev = this.cpRev + 1;
    try {
      const r = await this.api.saveCheckpoint(this.auth.token, this.marketId, { rev, baseVersion: this.version, token: this.ticket.token, sum: checksum(stateText), stateText });
      this.cpRev = r.rev;
      return { ok: true, savedAt: r.savedAt };
    } catch (e) {
      const c = errorCode(e);
      if (c.code === 'old_rev' || c.code === 'stale') this.cpBlocked = c.message;
      return { ok: false, ...c };
    }
  }

  /**
   * 企業間の貸し借りの届け物を受け取り、端末の状態に入れて返事をする（すぐ反映。オーナーの判断 2026-11-13）。
   * その日を始めている間（サーバーがこの会社のお金を動かせない間）だけ。inbox を渡せば、それを入れる（操作の答えに入っていたもの）
   */
  async syncCredits(state: GameState, inbox?: DeliveryView[]): Promise<void> {
    if (!this.ticket || this.creditSyncing) return;
    this.creditSyncing = true;
    try {
      const items = inbox ?? (await this.api.creditInbox(this.auth.token, this.marketId)).inbox ?? [];
      if (items.length === 0) return;
      const acks = applyDeliveries(state, items);
      state.version = (state.version ?? 0) + 1;
      await this.api.creditAck(this.auth.token, this.marketId, acks.map((a) => ({ id: a.id, applied: a.applied })));
      const shown = acks.filter((a) => a.amount !== 0);
      if (shown.length > 0) this.onCredit?.(shown);
    } catch {
      // 通信できないときは、次の受け取りで送り直す（同じ届け物は二度入れない）
    } finally {
      this.creditSyncing = false;
    }
  }

  /** 続きの途中のセーブを読む（チェックサムが合わなければ使わない） */
  async loadCheckpoint(): Promise<{ state: GameState; meta: CheckpointMeta } | null> {
    try {
      const r = await this.api.loadCheckpoint(this.auth.token, this.marketId);
      if (!r.ok || !r.meta || typeof r.stateText !== 'string') return null;
      if (checksum(r.stateText) !== r.meta.sum) return null;
      this.cpRev = r.meta.rev;
      return { state: JSON.parse(r.stateText) as GameState, meta: r.meta };
    } catch {
      return null;
    }
  }
}

/** サーバーの条件を、端末の状態に入れる（客の取り合いの倍率・爆発事故のリセット用の控え） */
export function prepareState(s: GameState, t: DayTicket): void {
  s.marketDemand = { ...t.demand };
  s.tutorial = null;
  // 市場の会社には従業員のチュートリアルの案内を出さない（案内済みにしておく）
  s.career.staffTutorialOffered = true;
  // 前の版で作られた状態を今の規則に直す（仕込み担当 → 接客担当など）
  ensureStartingUnlocks(s);
  if (s.phase === 'prep' && !hasPrepSnapshot(s)) takePrepSnapshot(s);
}
