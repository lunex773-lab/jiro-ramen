// 共通市場の企業を端末で営業する（docs/MARKET_RANKING_PLAN.md。オーナーの判断 1: 端末で処理し、1日ごとにサーバーへ送る）。
// 日の始めにサーバーから「その日の条件」（客の取り合いの倍率など）をもらい、日の終わり（次の日へ）にその日の状態を送る。
// 送れるまで次の日は始められない（判断 1d）。受け取られなかった日は、サーバーの前の日の状態からやり直す（判断 1b）。
// 会社の状態はサーバーにあり、端末のセーブのスロットには保存しない。

import { ensureStartingUnlocks, hasPrepSnapshot, takePrepSnapshot, type Action, type ActionResult, type CommitResult, type DayTicket, type GameState } from '@jiro/core';
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

  override act(a: Action): Promise<ActionResult> {
    if (a && BLOCKED.has(a.type)) return Promise.resolve({ ok: false, reason: '市場の営業では使えません' });
    // その日の条件をもらう前（前の日をサーバーへ送れていない）は開店できない
    if (a && a.type === 'openShop' && !this.session.ticket) return Promise.resolve({ ok: false, reason: '前の日をサーバーへ送れていないため、まだ開店できません' });
    return super.act(a);
  }
}

export interface MarketViewLite {
  mine: { state: GameState; progress: { stateVersion: number; lastProcessedGameDate: number } } | null;
  clock: { syncPending: boolean };
}

export type BeginResult = { ok: true; state: GameState; ticket: DayTicket } | { ok: false; code: string; message: string };

function newToken(): string {
  const r = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `d-${r}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
}

export function errorCode(e: unknown): { code: string; message: string } {
  if (e instanceof ApiError) {
    const b = e.body as { code?: string; error?: string; message?: string } | null;
    return { code: b?.code ?? 'error', message: b?.error ?? b?.message ?? e.message };
  }
  return { code: 'network', message: (e as Error)?.message ?? String(e) };
}

export class MarketSession {
  ticket: DayTicket | null = null;
  version = 0;

  constructor(
    readonly api: Api,
    readonly auth: Auth,
    readonly marketId: string,
  ) {}

  /**
   * サーバーの会社の状態を読み、その日を始める（すでに始めた日があればその続き。その日は初めからやり直す）。
   * 状態が古ければ読み直してもう一度
   */
  async begin(): Promise<BeginResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const v = await this.api.viewMarket<MarketViewLite>(this.auth.token, this.marketId);
      if (!v.mine) return { ok: false, code: 'not_member', message: 'この市場に企業がありません' };
      const state = v.mine.state;
      this.version = v.mine.progress.stateVersion;
      const r = await this.startTicket();
      if (r.ok) {
        prepareState(state, r.ticket);
        return { ok: true, state, ticket: r.ticket };
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

  /** 1日の終わりの状態を送る */
  async commit(state: GameState): Promise<CommitResult | { ok: false; code: 'network'; reason: string }> {
    if (!this.ticket) return { ok: false, code: 'no_open_day', reason: '始めていない日です' };
    try {
      const r = await this.api.commitMarketDay(this.auth.token, this.marketId, this.ticket.token, state);
      if (r.ok && typeof r.stateVersion === 'number') {
        this.version = r.stateVersion;
        this.ticket = null;
      }
      return r;
    } catch (e) {
      const c = errorCode(e);
      if (c.code === 'network' || (e instanceof ApiError && e.status >= 500)) return { ok: false, code: 'network', reason: c.message };
      return { ok: false, reason: c.message };
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
