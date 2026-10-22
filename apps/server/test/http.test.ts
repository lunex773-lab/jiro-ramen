// HTTP API: 認証・CORS・ゲームバージョン・プロフィール・入力検証・レート制限。

import { PROTOCOL_VERSION } from '@jiro/core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, callJson, freshIp, newPlayer, ORIGIN } from './helpers';

describe('匿名認証', () => {
  it('アカウントを作成し、トークンはハッシュだけが保存される', async () => {
    const r = await callJson<{ playerId: string; token: string }>('/api/v1/auth/anonymous', { body: { name: '  ジロリアン ' } });
    expect(r.status).toBe(201);
    expect(r.body.playerId).toMatch(/^p_[A-Za-z0-9_-]{22}$/);
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare('SELECT * FROM players WHERE id = ?').bind(r.body.playerId).first<Record<string, unknown>>();
    expect(row?.name).toBe('ジロリアン');
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(r.body.token);
    const audit = await env.DB.prepare("SELECT kind FROM audit_log WHERE player_id = ? AND kind = 'player_create'").bind(r.body.playerId).first();
    expect(audit).not.toBeNull();
  });

  it('トークンで認証でき、不正なトークンは 401', async () => {
    const p = await newPlayer('店主A');
    const ok = await callJson<{ playerId: string; name: string; slots: unknown[] }>('/api/v1/profile', { token: p.token });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ playerId: p.playerId, name: '店主A', slots: [] });

    const bad = await callJson<{ error: string; code: string }>('/api/v1/profile', { token: 'A'.repeat(43) });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('unauthorized');
    // クライアントは error をそのまま表示するので日本語のメッセージが入っている
    expect(bad.body.error).toMatch(/トークン/);
    expect((await call('/api/v1/profile')).status).toBe(401);
    expect((await call('/api/v1/profile', { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect((await call('/api/v1/save/1', { token: `${p.token}x` })).status).toBe(401);
  });

  it('名前と本文を検証する', async () => {
    expect((await call('/api/v1/auth/anonymous', { body: { name: '' } })).status).toBe(400);
    expect((await call('/api/v1/auth/anonymous', { body: { name: 'あ'.repeat(21) } })).status).toBe(400);
    expect((await call('/api/v1/auth/anonymous', { body: { name: 'a\u0000b' } })).status).toBe(400);
    expect((await call('/api/v1/auth/anonymous', { body: { name: 42 } })).status).toBe(400);
    expect((await call('/api/v1/auth/anonymous', { body: '{not json' })).status).toBe(400);
    expect((await call('/api/v1/auth/anonymous', { body: { name: 'x' }, headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    const big = await call('/api/v1/auth/anonymous', { body: { name: 'x', pad: 'y'.repeat(5000) } });
    expect(big.status).toBe(413);
  });
});

describe('ゲームバージョン', () => {
  it('バージョンとプロトコルを返す', async () => {
    const r = await callJson('/api/v1/game-version');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ gameVersion: '0.1.0', minClientVersion: '0.1.0', protocol: PROTOCOL_VERSION });
  });
});

describe('CORS', () => {
  it('許可したオリジンにだけ CORS ヘッダーを返す', async () => {
    const ok = await call('/api/v1/game-version', { headers: { Origin: ORIGIN } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Vary')).toContain('Origin');

    const pages = await call('/api/v1/game-version', { headers: { Origin: 'https://lunex773-lab.github.io' } });
    expect(pages.headers.get('Access-Control-Allow-Origin')).toBe('https://lunex773-lab.github.io');

    const evil = await call('/api/v1/game-version', { headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('プリフライトに応答する', async () => {
    const r = await call('/api/v1/save', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(r.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);
    expect(r.headers.get('Access-Control-Allow-Methods')).toMatch(/DELETE/);
  });

  it('エラー応答にも CORS ヘッダーが付く（ブラウザがエラー内容を読める）', async () => {
    const r = await call('/api/v1/profile', { headers: { Origin: ORIGIN } });
    expect(r.status).toBe(401);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });
});

describe('ルーティング', () => {
  it('未知のパスは 404、メソッド違いは 405', async () => {
    expect((await call('/api/v1/nope')).status).toBe(404);
    const p = await newPlayer();
    expect((await call('/api/v1/profile', { token: p.token, method: 'DELETE' })).status).toBe(405);
  });
});

describe('レート制限', () => {
  it('同じIPからのアカウント作成が多すぎると 429', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await call('/api/v1/auth/anonymous', { ip, body: { name: `bot${i}` } })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    const r = await call('/api/v1/auth/anonymous', { ip, body: { name: 'late' } });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('Retry-After'))).toBeGreaterThan(0);
    // 別のIPには影響しない
    expect((await call('/api/v1/auth/anonymous', { body: { name: 'other' } })).status).toBe(201);
  });
});
