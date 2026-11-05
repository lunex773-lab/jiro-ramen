// バックエンド（Cloudflare Workers）の HTTP API クライアント（設計書 18.1）。

import type { Action, ActionResult, CommitResult, DayTicket, GameState, SaveFile } from '@jiro/core';

const URL_KEY = 'jiro.serverUrl';
const AUTH_KEY = 'jiro.auth';

export function defaultServerUrl(): string {
  try {
    const saved = localStorage.getItem(URL_KEY);
    if (saved) return saved;
  } catch {
    // 無視
  }
  return (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
}

export function rememberServerUrl(url: string): void {
  try {
    localStorage.setItem(URL_KEY, url);
  } catch {
    // 無視
  }
}

export interface Auth {
  playerId: string;
  token: string;
  server: string;
}

/** 参加している市場（自分の会社の状態つき） */
export interface MyMarket {
  marketId: string;
  code: string;
  name: string;
  createdAt: number;
  isOwner: boolean;
  endsAt?: number | null;
  ended?: boolean;
  entry?: string;
  companyId?: string | null;
  companyName?: string | null;
  companyStatus?: string | null;
  /** ほかのプレイヤーの会社の数（市場を消すときの確認に出す） */
  otherCompanies?: number;
}

/** 公開のコミュニティ */
export interface PublicCommunity {
  marketId: string;
  name: string;
  description: string;
  entry: string;
  aiFill: boolean;
  maxCompanies: number;
  periodDays: number | null;
  endsAt: number | null;
  players: number;
  createdAt: number;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
  }
}

export class Api {
  constructor(public readonly base: string) {}

  static normalize(url: string): string {
    return url.trim().replace(/\/+$/, '');
  }

  private async req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    } catch (e) {
      throw new ApiError(`サーバーに接続できません（${(e as Error).message}）`, 0, null);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = (body as { error?: string; message?: string } | null)?.error ?? (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new ApiError(msg, res.status, body);
    }
    return body as T;
  }

  version(): Promise<{ gameVersion: string; minClientVersion: string; protocol: number }> {
    return this.req('/api/v1/game-version');
  }

  async auth(name: string): Promise<Auth> {
    // 同じサーバーの認証情報があれば使い回す
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) {
        const a = JSON.parse(raw) as Auth;
        if (a.server === this.base && a.token) {
          try {
            await this.req('/api/v1/profile', { token: a.token });
            return a;
          } catch (e) {
            if (!(e instanceof ApiError) || e.status !== 401) throw e;
          }
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) throw e;
    }
    const r = await this.req<{ playerId: string; token: string }>('/api/v1/auth/anonymous', { method: 'POST', body: JSON.stringify({ name }) });
    const a: Auth = { ...r, server: this.base };
    try {
      localStorage.setItem(AUTH_KEY, JSON.stringify(a));
    } catch {
      // 無視
    }
    return a;
  }

  createRoom(token: string): Promise<{ roomId: string; code: string; joinToken: string }> {
    return this.req('/api/v1/session/create', { method: 'POST', token, body: '{}' });
  }

  joinRoom(token: string, code: string): Promise<{ roomId: string; joinToken: string; code?: string }> {
    return this.req('/api/v1/session/join', { method: 'POST', token, body: JSON.stringify({ code: code.trim().toUpperCase() }) });
  }

  leaveRoom(token: string, roomId: string): Promise<unknown> {
    return this.req('/api/v1/session/leave', { method: 'POST', token, body: JSON.stringify({ roomId }) });
  }

  uploadSave(token: string, slot: number, save: SaveFile, baseRevision: number | null): Promise<{ revision: number }> {
    return this.req('/api/v1/save', { method: 'POST', token, body: JSON.stringify({ slot, save, baseRevision }) });
  }

  downloadSave(token: string, slot: number): Promise<{ save: SaveFile; revision: number }> {
    return this.req(`/api/v1/save/${slot}`, { token });
  }

  // ── 共通市場（docs/MARKET_RANKING_PLAN.md） ──

  createMarket(token: string, name: string, companyName: string, settings?: Record<string, unknown>): Promise<{ marketId: string; code: string; name: string }> {
    return this.req('/api/v1/market/create', { method: 'POST', token, body: JSON.stringify({ name, companyName, settings }) });
  }

  /**
   * 市場に入る。to: 招待コード、または公開の市場の id。bring: 終わった市場の自分の会社を持っていく（育てた企業で参加できる市場だけ）
   */
  joinMarket(token: string, to: { code: string } | { marketId: string }, companyName: string, bring?: { marketId: string; companyId: string }): Promise<{ marketId: string; companyId: string | null }> {
    const target = 'code' in to ? { code: to.code.trim().toUpperCase() } : { marketId: to.marketId };
    return this.req('/api/v1/market/join', { method: 'POST', token, body: JSON.stringify({ ...target, companyName, ...(bring ? { bring } : {}) }) });
  }

  listMarkets(token: string): Promise<{ markets: MyMarket[] }> {
    return this.req('/api/v1/markets', { token });
  }

  /** 公開のコミュニティの一覧（終わる前・空きのあるもの） */
  publicCommunities(token: string): Promise<{ communities: PublicCommunity[] }> {
    return this.req('/api/v1/communities', { token });
  }

  /** 自分が作った市場を消す（ほかの人の会社も消える。称号は残る） */
  deleteMarket(token: string, marketId: string): Promise<{ ok: boolean }> {
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}`, { method: 'DELETE', token });
  }

  /** 会社を引退させる（終わった市場・破産した会社） */
  retireCompany(token: string, marketId: string): Promise<{ ok: boolean }> {
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}/retire`, { method: 'POST', token, body: '{}' });
  }

  viewMarket<T>(token: string, marketId: string): Promise<T> {
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}`, { token });
  }

  actMarket(token: string, marketId: string, cid: string, action: Action): Promise<ActionResult & { duplicate?: boolean }> {
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}/act`, { method: 'POST', token, body: JSON.stringify({ cid, action }) });
  }

  /** 端末で1日を始める（その日の条件をもらう）。baseVersion: 端末が持っている会社の状態の版 */
  startMarketDay(token: string, marketId: string, dayToken: string, baseVersion: number): Promise<{ ok: boolean; ticket: DayTicket }> {
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}/day/start`, { method: 'POST', token, body: JSON.stringify({ token: dayToken, baseVersion }) });
  }

  /** 1日の終わりの状態を送る（爆発事故の控えは送らない。サーバーが確かめて受け取る） */
  commitMarketDay(token: string, marketId: string, dayToken: string, state: GameState): Promise<CommitResult & { companyId: string | null }> {
    const body = JSON.stringify({ token: dayToken, state }, (k, v: unknown) => (k === 'prepSnapshot' ? null : v));
    return this.req(`/api/v1/market/${encodeURIComponent(marketId)}/day/commit`, { method: 'POST', token, body });
  }

  /** ランキング（board: community / fresh / grown、scope: week / month / year / total、metric: overall など） */
  rankings<T>(token: string, q: { board: string; scope: string; metric: string; marketId?: string; date?: string }): Promise<T> {
    const p = new URLSearchParams({ board: q.board, scope: q.scope, metric: q.metric });
    if (q.marketId) p.set('marketId', q.marketId);
    if (q.date) p.set('date', q.date);
    return this.req(`/api/v1/rankings?${p.toString()}`, { token });
  }

  /** 自分の称号（報酬） */
  rewards<T>(token: string): Promise<T> {
    return this.req('/api/v1/rewards', { token });
  }

  wsUrl(roomId: string, joinToken: string): string {
    const u = new URL(`${this.base}/api/v1/room/${encodeURIComponent(roomId)}/ws`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', joinToken);
    return u.toString();
  }
}
