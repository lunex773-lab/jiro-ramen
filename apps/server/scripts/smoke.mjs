// ローカル（wrangler dev）または本番の Worker に対する手動の疎通確認。
//
// 使い方:
//   npx wrangler d1 migrations apply jiro-db --local   # 初回だけ
//   npx wrangler dev                                    # 別のターミナルで起動（http://localhost:8787）
//   node scripts/smoke.mjs [http://localhost:8787]
//
// @jiro/core は TypeScript のままなので、esbuild でその場で束ねてから読み込む（createGame を使うため）。
// Node 22 の組み込み WebSocket を使う。

import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = (process.argv[2] ?? process.env.SMOKE_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const coreEntry = fileURLToPath(new URL('../../../packages/core/src/index.ts', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'jiro-smoke-'));
const outfile = join(dir, 'core.mjs');
await build({ entryPoints: [coreEntry], bundle: true, format: 'esm', platform: 'neutral', outfile, logLevel: 'warning' });
const core = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

const ok = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
};

async function api(path, { token, body, method } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: method ?? (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

class Client {
  constructor(url) {
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      this.queue.push(JSON.parse(String(ev.data)));
      for (const w of this.waiters.splice(0)) w();
    };
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  async next(t, pred = () => true, timeout = 5000) {
    const end = Date.now() + timeout;
    for (;;) {
      const i = this.queue.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return this.queue.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`timeout waiting for ${t}`);
      await new Promise((r) => {
        this.waiters.push(r);
        setTimeout(r, 200);
      });
    }
  }
}

const wsUrl = (roomId, token) => {
  const u = new URL(`${BASE}/api/v1/room/${roomId}/ws`);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.searchParams.set('token', token);
  return u.toString();
};

const ver = await api('/api/v1/game-version');
ok(ver.status === 200 && ver.body.protocol === core.PROTOCOL_VERSION, `game-version ${JSON.stringify(ver.body)}`);

const host = (await api('/api/v1/auth/anonymous', { body: { name: 'スモーク店主' } })).body;
const guest = (await api('/api/v1/auth/anonymous', { body: { name: 'スモーク客' } })).body;
ok(host.token && guest.token, 'anonymous auth');

const room = (await api('/api/v1/session/create', { token: host.token, body: {} })).body;
ok(room.code?.length === 6, `room created code=${room.code}`);
const joined = (await api('/api/v1/session/join', { token: guest.token, body: { code: room.code } })).body;
ok(joined.roomId === room.roomId, 'guest joined by code');

const hc = new Client(wsUrl(room.roomId, room.joinToken));
await hc.opened;
hc.send({ t: 'hello', name: 'スモーク店主', protocol: core.PROTOCOL_VERSION, clientVersion: ver.body.gameVersion });
const w1 = await hc.next('welcome');
ok(w1.isHost && w1.needInit, 'host welcome needInit');
hc.send({ t: 'hostInit', state: core.createGame({ seed: 1, shopName: 'スモーク屋' }) });
const w2 = await hc.next('welcome');
const full = await hc.next('full');
ok(full.state.shopName === 'スモーク屋', `hostInit accepted (host actor ${w2.playerId})`);

const gc = new Client(wsUrl(joined.roomId, joined.joinToken));
await gc.opened;
gc.send({ t: 'hello', name: 'スモーク客', protocol: core.PROTOCOL_VERSION, clientVersion: ver.body.gameVersion });
const gw = await gc.next('welcome');
await gc.next('full');
ok(!gw.isHost, 'guest welcome + full');

const m0 = full.state.money;
const rid = `smoke-${Date.now()}`;
const order = { type: 'orderStock', itemId: 'soy', packs: 1, express: false };
gc.send({ t: 'act', rid, a: order, v: 0 });
const r1 = await gc.next('res', (m) => m.rid === rid);
gc.send({ t: 'act', rid, a: order, v: 0 });
const r2 = await gc.next('res', (m) => m.rid === rid);
ok(r1.r.ok && JSON.stringify(r1.r) === JSON.stringify(r2.r), `orderStock applied, duplicate rid returned cached result (cost ${r1.r.data})`);

let state = full.state;
let seq = full.seq;
const deadline = Date.now() + 5000;
while (state.money !== m0 - r1.r.data && Date.now() < deadline) {
  const p = await hc.next('patch');
  if (p.from !== seq) throw new Error('patch gap');
  state = core.applyPatch(state, p.ops);
  seq = p.to;
}
ok(state.money === m0 - r1.r.data, `host mirror sees money ${m0} → ${state.money} via patches (seq ${seq})`);

hc.send({ t: 'save', rid: 'smoke-save' });
const saved = await hc.next('saved');
ok(saved.ok && core.stateChecksum(saved.state) === saved.checksum, 'host save verified');

const leave = await api('/api/v1/session/leave', { token: host.token, body: { roomId: room.roomId } });
ok(leave.body?.ended === true, 'host leave ended room');
const closed = await gc.next('error', (m) => m.code === 'room_closed');
ok(!!closed, 'guest notified room_closed');
hc.ws.close();
gc.ws.close();
console.log('smoke test passed');
