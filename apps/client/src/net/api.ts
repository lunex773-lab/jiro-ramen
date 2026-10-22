// バックエンド（Cloudflare Workers）の HTTP API クライアント（設計書 18.1）。

import type { SaveFile } from '@jiro/core';

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

  wsUrl(roomId: string, joinToken: string): string {
    const u = new URL(`${this.base}/api/v1/room/${encodeURIComponent(roomId)}/ws`);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', joinToken);
    return u.toString();
  }
}
