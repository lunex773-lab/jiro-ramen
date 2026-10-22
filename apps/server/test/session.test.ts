// ルームの作成・参加・退出と、WebSocket 接続時のトークン検証。

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signJoinToken } from '../src/auth';
import { ROOM_CODE_ALPHABET } from '../src/util';
import { BASE, call, callJson, createRoom, freshIp, joinRoom, newPlayer, WsClient } from './helpers';
import { SELF } from 'cloudflare:test';

describe('セッション API', () => {
  it('ルームを作成すると紛らわしい文字のない6文字のコードと joinToken が返る', async () => {
    const host = await newPlayer('ホスト');
    const r = await createRoom(host);
    expect(r.roomId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.code).toHaveLength(6);
    for (const ch of r.code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    expect(r.code).not.toMatch(/[01OIL]/);
    expect(r.joinToken.split('.')).toHaveLength(2);
    const row = await env.DB.prepare('SELECT code, host_id, status FROM rooms WHERE id = ?').bind(r.roomId).first();
    expect(row).toEqual({ code: r.code, host_id: host.playerId, status: 'open' });
  });

  it('コードで参加できる。ホスト本人が再参加すると host:true のまま', async () => {
    const host = await newPlayer('ホスト');
    const guest = await newPlayer('ゲスト');
    const room = await createRoom(host);
    const g = await joinRoom(guest, room.code.toLowerCase());
    expect(g).toMatchObject({ roomId: room.roomId, isHost: false });
    const h = await joinRoom(host, room.code);
    expect(h).toMatchObject({ roomId: room.roomId, isHost: true });
    const members = await env.DB.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').bind(room.roomId).first<{ n: number }>();
    expect(members?.n).toBe(2);
  });

  it('存在しないコードは 404、形式違いは 400', async () => {
    const p = await newPlayer();
    const r = await callJson<{ error: string; code: string }>('/api/v1/session/join', { token: p.token, body: { code: 'ZZZZZZ' } });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('room_not_found');
    expect(r.body.error).toMatch(/ルーム/);
    expect((await call('/api/v1/session/join', { token: p.token, body: { code: 'ABC' } })).status).toBe(400);
    expect((await call('/api/v1/session/join', { token: p.token, body: { code: 'O0O0O0' } })).status).toBe(400);
    expect((await call('/api/v1/session/join', { token: p.token, body: {} })).status).toBe(400);
    expect((await call('/api/v1/session/create', { body: {} })).status).toBe(401);
  });

  it('参加していないルームからは退出できない', async () => {
    const host = await newPlayer();
    const other = await newPlayer();
    const room = await createRoom(host);
    expect((await call('/api/v1/session/leave', { token: other.token, body: { roomId: room.roomId } })).status).toBe(404);
    expect((await call('/api/v1/session/leave', { token: other.token, body: { roomId: 'x' } })).status).toBe(400);
  });

  it('ホストが退出するとルームは終了し、以後は参加できない', async () => {
    const host = await newPlayer();
    const room = await createRoom(host);
    const r = await callJson<{ ok: boolean; ended: boolean }>('/api/v1/session/leave', { token: host.token, body: { roomId: room.roomId } });
    expect(r.body).toEqual({ ok: true, ended: true });
    const row = await env.DB.prepare('SELECT status, ended_at FROM rooms WHERE id = ?').bind(room.roomId).first<{ status: string; ended_at: number }>();
    expect(row?.status).toBe('ended');
    expect(row?.ended_at).toBeGreaterThan(0);
    const g = await newPlayer();
    expect((await call('/api/v1/session/join', { token: g.token, body: { code: room.code } })).status).toBe(404);
  });
});

describe('WebSocket の接続検証', () => {
  it('不正・期限切れ・別ルームのトークンは 401', async () => {
    const host = await newPlayer();
    const room = await createRoom(host);
    const other = await createRoom(host);
    const ws = (token: string, roomId = room.roomId) =>
      SELF.fetch(`${BASE}/api/v1/room/${roomId}/ws?token=${encodeURIComponent(token)}`, { headers: { Upgrade: 'websocket', 'CF-Connecting-IP': freshIp() } });
    expect((await ws('garbage')).status).toBe(401);
    expect((await ws(`${room.joinToken}x`)).status).toBe(401);
    expect((await ws(other.joinToken)).status).toBe(401);
    const expired = await signJoinToken(env, { roomId: room.roomId, playerId: host.playerId, name: 'x', host: true }, Math.floor(Date.now() / 1000) - 3600);
    expect((await ws(expired.token)).status).toBe(401);
    // 署名鍵が違うトークン
    const forged = await signJoinToken({ ...env, SESSION_SECRET: 'another-secret-another-secret-another-secret' }, { roomId: room.roomId, playerId: host.playerId, name: 'x', host: true });
    expect((await ws(forged.token)).status).toBe(401);
    // Upgrade なしは 426
    expect((await call(`/api/v1/room/${room.roomId}/ws?token=${encodeURIComponent(room.joinToken)}`)).status).toBe(426);
    // 正しいトークンなら 101
    const okRes = await ws(room.joinToken);
    expect(okRes.status).toBe(101);
    okRes.webSocket?.accept();
    okRes.webSocket?.close();
  });

  it('クライアントが付けた身元ヘッダーは無視される（なりすまし防止）', async () => {
    const host = await newPlayer('本物のホスト');
    const guest = await newPlayer('ゲスト');
    const room = await createRoom(host);
    const g = await joinRoom(guest, room.code);
    const c = await WsClient.open(room.roomId, g.joinToken, { 'X-Jiro-Player-Id': host.playerId, 'X-Jiro-Player-Name': 'fake' });
    const w = await c.hello();
    expect(w.isHost).toBe(false);
    expect(w.playerId).toBe(guest.playerId);
    c.close();
  });

  it('許可していないオリジンからの WebSocket は 403', async () => {
    const host = await newPlayer();
    const room = await createRoom(host);
    const r = await SELF.fetch(`${BASE}/api/v1/room/${room.roomId}/ws?token=${encodeURIComponent(room.joinToken)}`, {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example', 'CF-Connecting-IP': freshIp() },
    });
    expect(r.status).toBe(403);
  });
});
