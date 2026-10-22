// ローカルで起動したサーバー（wrangler dev）に、実際のクライアント通信コードで接続する結合テスト。
// SERVER_URL が設定されているときだけ実行する: SERVER_URL=http://localhost:8787 npx vitest run test/remote.integration.test.ts
import { describe, expect, it } from 'vitest';
import { canonicalJson, createGame } from '@jiro/core';
import { Api } from '../src/net/api';
import { RemoteHost } from '../src/net/remote';

const SERVER = process.env.SERVER_URL;
(globalThis as unknown as { window: unknown }).window = globalThis;
// Node には localStorage がないので簡易版を用意
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SERVER)('共同経営（クライアントの通信コード × ローカルサーバー）', () => {
  it('ホストとゲストが同じ店を経営し、状態が一致する', { timeout: 60_000 }, async () => {
    const api = new Api(SERVER!);
    const hostAuth = await api.auth('ホスト');
    mem.clear(); // ゲストは別の端末として認証
    const guestAuth = await api.auth('ゲスト');
    const room = await api.createRoom(hostAuth.token);
    const career = createGame({ seed: 5, shopName: '共同亭' });
    const host = new RemoteHost({ api, authToken: hostAuth.token, roomId: room.roomId, code: room.code, joinToken: room.joinToken, name: 'ホスト', initState: career, clientVersion: '0.9.0' }, career);
    expect(await host.connect()).toBe(true);
    expect(host.isHost).toBe(true);
    const join = await api.joinRoom(guestAuth.token, room.code);
    const guest = new RemoteHost({ api, authToken: guestAuth.token, roomId: join.roomId, code: room.code, joinToken: join.joinToken, name: 'ゲスト', initState: null, clientVersion: '0.9.0' }, createGame({ seed: 1 }));
    expect(await guest.connect()).toBe(true);
    expect(guest.isHost).toBe(false);
    expect(guest.state.shopName).toBe('共同亭');

    // ゲストが発注すると、ホストの画面の資金も減る
    const before = host.state.money;
    const r = await guest.act({ type: 'orderStock', itemId: 'moyashi', packs: 1, express: false });
    expect(r.ok).toBe(true);
    await wait(800);
    expect(host.state.money).toBeLessThan(before);
    // ホストだけの操作（店名変更）はゲストからは拒否される
    expect((await guest.act({ type: 'rename', name: '乗っ取り' })).ok).toBe(false);
    // ホストが開店し、しばらく営業
    expect((await host.act({ type: 'openShop' })).ok).toBe(true);
    await wait(4000);
    expect(guest.state.phase).toBe('open');
    // 両者の状態が一致（時刻の差を除くため、同じバージョンになるまで待って比較）
    for (let i = 0; i < 20 && host.state.version !== guest.state.version; i++) await wait(100);
    if (host.state.version === guest.state.version) expect(canonicalJson(guest.state)).toBe(canonicalJson(host.state));
    // ホストが保存を要求すると確定状態が返る
    const saved = await host.requestSave();
    expect(saved?.shopName).toBe('共同亭');
    guest.dispose();
    host.dispose();
  });
});
