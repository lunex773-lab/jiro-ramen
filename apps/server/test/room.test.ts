// 共同経営ルーム（GameRoom Durable Object）の WebSocket プロトコル。

import { canonicalJson, createGame, MAX_PLAYERS, stateChecksum, type GameState } from '@jiro/core';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_TTL_MS, type GameRoom } from '../src/room';
import { createRoom, joinRoom, newPlayer, rid, sleep, WsClient, type RoomInfo, type TestPlayer } from './helpers';

const opened: WsClient[] = [];
afterEach(async () => {
  for (const c of opened.splice(0)) c.close();
  await sleep(50);
});

async function open(roomId: string, joinToken: string): Promise<WsClient> {
  const c = await WsClient.open(roomId, joinToken);
  opened.push(c);
  return c;
}

function stub(roomId: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function inRoom<R>(roomId: string, fn: (room: GameRoom) => R | Promise<R>): Promise<R> {
  return runInDurableObject(stub(roomId), (inst: GameRoom) => fn(inst));
}

interface Started {
  host: TestPlayer;
  room: RoomInfo;
  hc: WsClient;
  hostActor: string;
}

/** ホストがルームを作り、新しいキャリアを持ち込んで開始する */
async function startRoom(state: GameState = createGame({ seed: 7, shopName: '共同屋' })): Promise<Started> {
  const host = await newPlayer('ホスト');
  const room = await createRoom(host);
  const hc = await open(room.roomId, room.joinToken);
  const w = await hc.hello('ホスト');
  expect(w).toMatchObject({ t: 'welcome', isHost: true, needInit: true, roomId: room.roomId, protocol: 1 });
  hc.send({ t: 'hostInit', state });
  const w2 = await hc.next('welcome');
  expect(w2.needInit).toBe(false);
  await hc.next('full');
  return { host, room, hc, hostActor: w2.playerId };
}

async function addGuest(room: RoomInfo, name: string): Promise<{ p: TestPlayer; c: WsClient; id: string }> {
  const p = await newPlayer(name);
  const j = await joinRoom(p, room.code);
  const c = await open(j.roomId, j.joinToken);
  const w = await c.hello(name);
  expect(w.isHost).toBe(false);
  await c.next('full');
  return { p, c, id: w.playerId };
}

const money = (roomId: string) => inRoom(roomId, (r) => r.state!.money);

describe('入室と初期化', () => {
  it('ホストに welcome（needInit）を送り、hostInit 後に welcome と full を送る', async () => {
    const st = createGame({ seed: 3, shopName: '初期化屋' });
    const { hc, hostActor, room } = await startRoom(st);
    // 単独プレイのキャリアのホストID（'p1'）がそのまま状態内のIDになる
    expect(hostActor).toBe('p1');
    const full = hc.all.find((m) => m.t === 'full');
    expect(full?.t === 'full' && full.state.shopName).toBe('初期化屋');
    expect(full?.t === 'full' && full.state.players[0]!.connected).toBe(true);
    expect(hc.all.some((m) => m.t === 'peers' && m.list.length === 1 && m.list[0]!.isHost)).toBe(true);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE room_id = ? AND kind = 'host_init'").bind(room.roomId).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it('壊れた状態の hostInit は拒否し、正しい状態なら受け付ける', async () => {
    const host = await newPlayer('ホスト');
    const room = await createRoom(host);
    const hc = await open(room.roomId, room.joinToken);
    await hc.hello();
    // 開始前の操作は受け付けない
    const early = await hc.act(rid(), { type: 'openShop' });
    expect(early.r.ok).toBe(false);

    hc.send({ t: 'hostInit', state: { foo: 1 } });
    expect((await hc.next('error')).code).toBe('invalid_state');
    const bad = createGame({ seed: 1 }) as unknown as Record<string, unknown>;
    bad.money = 'lots';
    hc.send({ t: 'hostInit', state: bad });
    expect((await hc.next('error')).code).toBe('invalid_state');
    const bankrupt = createGame({ seed: 1 });
    bankrupt.phase = 'bankrupt';
    hc.send({ t: 'hostInit', state: bankrupt });
    expect((await hc.next('error')).code).toBe('invalid_state');
    expect(await inRoom(room.roomId, (r) => r.state)).toBeNull();

    hc.send({ t: 'hostInit', state: createGame({ seed: 2 }) });
    await hc.next('full');
    // 2回目の hostInit は拒否（状態を上書きさせない）
    hc.send({ t: 'hostInit', state: createGame({ seed: 9, shopName: '乗っ取り' }) });
    expect((await hc.next('error')).code).toBe('already_initialized');
    expect(await inRoom(room.roomId, (r) => r.state!.shopName)).not.toBe('乗っ取り');
  });

  it('ゲストの hostInit は拒否する', async () => {
    const { room } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    g.c.send({ t: 'hostInit', state: createGame({ seed: 5 }) });
    expect((await g.c.next('error')).code).toBe('host_only');
  });

  it('hello の前のメッセージ・古いプロトコル・古いクライアントを拒否する', async () => {
    const { room } = await startRoom();
    const p = await newPlayer();
    const j = await joinRoom(p, room.code);
    const c1 = await open(room.roomId, j.joinToken);
    c1.send({ t: 'ping', ts: 1 });
    expect((await c1.next('error')).code).toBe('hello_required');
    c1.send({ t: 'hello', name: 'x', protocol: 99, clientVersion: '0.1.0' });
    expect((await c1.next('error')).code).toBe('protocol_mismatch');
    expect((await c1.waitClose()).code).toBe(4001);

    const c2 = await open(room.roomId, (await joinRoom(p, room.code)).joinToken);
    c2.send({ t: 'hello', name: 'x', protocol: 1, clientVersion: '0.0.9' });
    expect((await c2.next('error')).code).toBe('client_outdated');
    expect((await c2.waitClose()).code).toBe(4001);
  });

  it('不正な形式のメッセージはエラーを返すだけで状態に触れない', async () => {
    const { hc, room } = await startRoom();
    const before = await money(room.roomId);
    hc.send('not json');
    expect((await hc.next('error')).code).toBe('bad_json');
    hc.send({ t: 'act', rid: 'x', a: { type: 'orderStock', itemId: 'soy', packs: 'many', express: false }, v: 0 });
    expect((await hc.next('error')).code).toBe('bad_message');
    hc.send({ t: 'act', rid: 'y', a: { type: 'setAutoOrder', itemId: '__proto__', qty: 1 }, v: 0 });
    expect((await hc.next('error')).code).toBe('bad_message');
    hc.send({ t: 'act', rid: 'z'.repeat(100), a: { type: 'openShop' }, v: 0 });
    expect((await hc.next('error')).code).toBe('bad_message');
    hc.send({ t: 'nope' });
    expect((await hc.next('error')).code).toBe('bad_message');
    expect(await money(room.roomId)).toBe(before);
    expect(hc.closed).toBeNull();
  });
});

describe('参加人数', () => {
  it('4人まで参加でき、5人目は room_full で切断される', async () => {
    const { room, hc } = await startRoom();
    const guests = [];
    for (let i = 1; i < MAX_PLAYERS; i++) guests.push(await addGuest(room, `ゲスト${i}`));
    expect(await inRoom(room.roomId, (r) => r.connectedCount())).toBe(4);
    await hc.until(() => hc.all.some((m) => m.t === 'peers' && m.list.filter((x) => x.connected).length === 4), 3000, 'peers 4');

    const fifth = await newPlayer('5人目');
    const j = await joinRoom(fifth, room.code);
    const c = await open(room.roomId, j.joinToken);
    c.send({ t: 'hello', name: '5人目', protocol: 1, clientVersion: '0.1.0' });
    const err = await c.next('error');
    expect(err.code).toBe('room_full');
    expect((await c.waitClose()).code).toBe(4003);
    expect(await inRoom(room.roomId, (r) => r.connectedCount())).toBe(4);
    expect(await inRoom(room.roomId, (r) => r.state!.players.length)).toBe(4);

    // 1人抜ければ入れる
    guests[0]!.c.close();
    await hc.until(() => hc.all.some((m) => m.t === 'peers' && m.list.filter((x) => x.connected).length === 3), 3000, 'peers 3');
    const c2 = await open(room.roomId, (await joinRoom(fifth, room.code)).joinToken);
    const w = await c2.hello('5人目');
    expect(w.isHost).toBe(false);
    await c2.next('full');
  });

  it('同じプレイヤーが再接続すると古い接続を置き換え、席を二重に取らない', async () => {
    const { room } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const j = await joinRoom(g.p, room.code);
    const c2 = await open(room.roomId, j.joinToken);
    const w = await c2.hello('ゲスト');
    expect(w.playerId).toBe(g.id);
    const full = await c2.next('full');
    expect(full.state.players.filter((p) => p.id === g.id)).toHaveLength(1);
    expect((await g.c.next('error')).code).toBe('replaced');
    expect((await g.c.waitClose()).code).toBe(4000);
    expect(await inRoom(room.roomId, (r) => r.connectedCount())).toBe(2);
    expect(await inRoom(room.roomId, (r) => r.state!.players.find((p) => p.id === g.id)!.connected)).toBe(true);
  });
});

describe('操作要求', () => {
  it('同じ rid の再送は一度だけ適用する（二重購入を防ぐ）', async () => {
    const { hc, room } = await startRoom();
    const m0 = await money(room.roomId);
    const id = rid('order');
    const r1 = await hc.act(id, { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(r1.r.ok).toBe(true);
    const cost = r1.r.data as number;
    expect(cost).toBeGreaterThan(0);
    expect(await money(room.roomId)).toBe(m0 - cost);
    // 再接続後の再送などで同じ要求が届いても適用しない
    const r2 = await hc.act(id, { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(r2.r).toEqual(r1.r);
    expect(await money(room.roomId)).toBe(m0 - cost);
    expect(await inRoom(room.roomId, (r) => r.state!.deliveries.length)).toBe(1);
    // 別の rid なら別の注文
    const r3 = await hc.act(rid('order'), { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(r3.r.ok).toBe(true);
    expect(await money(room.roomId)).toBe(m0 - 2 * cost);
  });

  it('同じ rid の売却は一度だけ、別 rid の二重売却は在庫がないので失敗する（二重売上を防ぐ）', async () => {
    const { hc, room } = await startRoom();
    const target = await inRoom(room.roomId, (r) =>
      r.state!.equipment.find((e) => e.slots.every((x) => x === null) && e.bowlSlots.every((x) => x === null) && e.washing.length === 0 && !e.process && e.type !== 'soup_pot'),
    );
    expect(target).toBeDefined();
    const m0 = await money(room.roomId);
    const id = rid('sell');
    const r1 = await hc.act(id, { type: 'sellEquipment', equipmentId: target!.id });
    expect(r1.r.ok).toBe(true);
    const m1 = await money(room.roomId);
    expect(m1).toBeGreaterThan(m0);
    const r2 = await hc.act(id, { type: 'sellEquipment', equipmentId: target!.id });
    expect(r2.r).toEqual(r1.r);
    const r3 = await hc.act(rid('sell'), { type: 'sellEquipment', equipmentId: target!.id });
    expect(r3.r.ok).toBe(false);
    expect(await money(room.roomId)).toBe(m1);
  });

  it('2人が同時に最後の資金で購入しても一方だけが成功する', async () => {
    const { room } = await startRoom();
    const a = await addGuest(room, 'A');
    const b = await addGuest(room, 'B');
    // 1回分の発注しかできない資金にする
    await inRoom(room.roomId, (r) => {
      r.state!.money = 1000;
    });
    const ra = rid('a');
    const rb = rid('b');
    a.c.send({ t: 'act', rid: ra, a: { type: 'orderStock', itemId: 'soy', packs: 1, express: false }, v: 0 });
    b.c.send({ t: 'act', rid: rb, a: { type: 'orderStock', itemId: 'soy', packs: 1, express: false }, v: 0 });
    const [resA, resB] = await Promise.all([a.c.next('res', (m) => m.rid === ra), b.c.next('res', (m) => m.rid === rb)]);
    expect([resA.r.ok, resB.r.ok].filter(Boolean)).toHaveLength(1);
    const m = await money(room.roomId);
    expect(m).toBeGreaterThanOrEqual(0);
    expect(await inRoom(room.roomId, (r) => r.state!.deliveries.length)).toBe(1);
  });

  it('ホスト専用の操作はゲストからは拒否する', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const r = await g.c.act(rid(), { type: 'rename', name: '乗っ取り屋' });
    expect(r.r.ok).toBe(false);
    expect(r.r.reason).toMatch(/ホスト/);
    expect(await inRoom(room.roomId, (x) => x.state!.shopName)).toBe('共同屋');
    const ok = await hc.act(rid(), { type: 'rename', name: '本家' });
    expect(ok.r.ok).toBe(true);
    expect(await inRoom(room.roomId, (x) => x.state!.shopName)).toBe('本家');
  });

  it('ゲストの移動がホストに届くパッチに反映され、パッチの積み重ねと全体の再送が一致する', async () => {
    const { room, hc } = await startRoom();
    hc.recordSnapshots = true;
    const g = await addGuest(room, 'ゲスト');
    const me = g.c.mirror!.players.find((p) => p.id === g.id)!;
    const want = { x: me.pos.x, z: me.pos.z + 0.1 };
    const r = await g.c.act(rid('mv'), { type: 'move', x: want.x, z: want.z, yaw: 1 });
    expect(r.r.ok).toBe(true);
    const final = r.r.corrected ?? want;
    await hc.until(() => {
      const p = hc.mirror?.players.find((x) => x.id === g.id);
      return !!p && Math.abs(p.pos.x - final.x) < 1e-9 && Math.abs(p.pos.z - final.z) < 1e-9 && p.yaw === 1;
    }, 3000, 'move reflected');

    // シミュレーションをしばらく進めてから、ゲストに全体を送り直させる
    await sleep(2500);
    g.c.send({ t: 'resync' });
    const full = await g.c.next('full', (m) => m.seq > 0, 3000);
    await hc.until(() => hc.snapshots.has(full.seq), 3000, 'host reaches same seq');
    expect(hc.snapshots.get(full.seq)).toBe(canonicalJson(full.state));
    expect(hc.gaps).toBe(0);
    expect(hc.hashChecks).toBeGreaterThan(0);
    expect(hc.hashMismatches).toBe(0);
    // サーバーの状態とも一致する（パッチ配信時点の状態）
    const serverSeqState = await inRoom(room.roomId, (x) => {
      x.flush();
      return { seq: x.seq, sum: stateChecksum(x.state!) };
    });
    await hc.until(() => hc.seq >= serverSeqState.seq, 3000, 'host catches up');
    expect(stateChecksum(JSON.parse(hc.snapshots.get(serverSeqState.seq)!) as GameState)).toBe(serverSeqState.sum);
  });

  it('シミュレーションがサーバーで進み、イベントがパッチで届く', async () => {
    const { hc } = await startRoom();
    const t0 = hc.mirror!.t;
    const r = await hc.act(rid(), { type: 'openShop' });
    expect(r.r.ok).toBe(true);
    await hc.until(() => hc.mirror!.phase === 'open' && hc.mirror!.t > t0 + 0.5, 3000, 'sim advances');
    const patches = hc.all.filter((m) => m.t === 'patch');
    expect(patches.length).toBeGreaterThan(2);
    expect(patches.some((m) => m.t === 'patch' && m.ev.length > 0)).toBe(true);
  });
});

describe('切断と再接続', () => {
  it('ホストが切断すると一時停止し、再接続で状態を保ったまま再開する', async () => {
    const { room, hc, host, hostActor } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const r = await hc.act(rid(), { type: 'orderStock', itemId: 'soy', packs: 2, express: false });
    expect(r.r.ok).toBe(true);
    const m1 = await money(room.roomId);

    hc.close();
    const paused = await g.c.next('paused');
    expect(paused.reason).toBe('host_disconnected');
    await g.c.until(() => g.c.mirror!.paused === true, 3000, 'paused in state');
    const peers = await g.c.next('peers', (m) => m.list.some((p) => p.isHost && !p.connected));
    expect(peers.list.find((p) => p.id === hostActor)?.connected).toBe(false);
    expect(await inRoom(room.roomId, (x) => x.loopRunning)).toBe(false);
    // 一時停止中の操作は適用しない
    const blocked = await g.c.act(rid(), { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(blocked.r.ok).toBe(false);
    expect(await money(room.roomId)).toBe(m1);
    // ホスト切断時にチェックポイントが保存されている
    const cp = await inRoom(room.roomId, (x) => (x as unknown as { kvGet(k: string): string | null }).kvGet('checkpoint'));
    expect(JSON.parse(cp!).reason).toBe('host_disconnect');

    // ホストが同じコードで参加し直す（host:true のまま）
    const j = await joinRoom(host, room.code);
    expect(j.isHost).toBe(true);
    const hc2 = await open(room.roomId, j.joinToken);
    const w = await hc2.hello('ホスト');
    expect(w).toMatchObject({ isHost: true, needInit: false, playerId: hostActor });
    const full = await hc2.next('full');
    expect(full.state.paused).toBe(false);
    expect(full.state.money).toBe(m1);
    await g.c.next('resumed');
    expect(await inRoom(room.roomId, (x) => x.loopRunning)).toBe(true);
    const ok = await g.c.act(rid(), { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(ok.r.ok).toBe(true);
  });

  it('ゲストが再接続すると全体（full）を受け取り、持っていた物は戻されている', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const bowl = await inRoom(room.roomId, (r) => {
      // ゲストが丼を持っている状態にする
      const b = r.state!.bowls.find((x) => x.state === 'clean' && x.loc.at === 'rack')!;
      const p = r.state!.players.find((x) => x.id === g.id)!;
      b.loc = { at: 'hand', actorId: p.id };
      p.hand = { kind: 'clean', bowlIds: [b.id] };
      return b.id;
    });
    g.c.close();
    await hc.next('peers', (m) => m.list.some((p) => p.id === g.id && !p.connected));
    const after = await inRoom(room.roomId, (r) => ({
      hand: r.state!.players.find((x) => x.id === g.id)!.hand,
      loc: r.state!.bowls.find((x) => x.id === bowl)!.loc,
      connected: r.state!.players.find((x) => x.id === g.id)!.connected,
    }));
    expect(after.hand.kind).toBe('none');
    expect(after.loc.at).toBe('rack');
    expect(after.connected).toBe(false);

    const c2 = await open(room.roomId, (await joinRoom(g.p, room.code)).joinToken);
    const w = await c2.hello('ゲスト');
    expect(w.playerId).toBe(g.id);
    const full = await c2.next('full');
    expect(full.state.players.find((p) => p.id === g.id)?.connected).toBe(true);
    expect(full.state.players.filter((p) => p.id === g.id)).toHaveLength(1);
  });

  it('ホストが退出（leave）するとルームを終了し、最終状態を R2 に残す', async () => {
    const { room, host } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const res = await fetchLeave(host, room.roomId);
    expect(res.ended).toBe(true);
    const err = await g.c.next('error', (m) => m.code === 'room_closed');
    expect(err.message).toMatch(/終了/);
    expect((await g.c.waitClose()).code).toBe(4004);
    const list = await env.SAVES.list({ prefix: `rooms/${room.roomId}/` });
    expect(list.objects.length).toBe(1);
    // 終了したルームには接続できない
    const c = await open(room.roomId, room.joinToken);
    expect((await c.next('error')).code).toBe('room_closed');
  });
});

async function fetchLeave(p: TestPlayer, roomId: string): Promise<{ ok: boolean; ended: boolean }> {
  const { callJson } = await import('./helpers');
  const r = await callJson<{ ok: boolean; ended: boolean }>('/api/v1/session/leave', { token: p.token, body: { roomId } });
  return r.body;
}

describe('レイアウト編集の排他', () => {
  it('ロックを持つ人だけが配置を変更でき、切断でロックが外れる', async () => {
    const { room } = await startRoom();
    const a = await addGuest(room, 'A');
    const b = await addGuest(room, 'B');
    const eq = await inRoom(room.roomId, (r) => r.state!.equipment.find((e) => e.placed && e.type !== 'soup_pot')!);

    const noLock = await b.c.act(rid(), { type: 'store', equipmentId: eq.id });
    expect(noLock.r.ok).toBe(false);
    expect(noLock.r.reason).toMatch(/ロック/);

    a.c.send({ t: 'layoutLock', on: true });
    expect((await a.c.next('layoutLock', (m) => m.holder !== null)).holder).toBe(a.id);
    expect((await b.c.next('layoutLock', (m) => m.holder !== null)).holder).toBe(a.id);

    b.c.send({ t: 'layoutLock', on: true });
    expect((await b.c.next('error')).code).toBe('layout_locked');
    expect((await b.c.next('layoutLock', (m) => m.holder !== null)).holder).toBe(a.id);
    const placeB = await b.c.act(rid(), { type: 'place', equipmentId: eq.id, gx: eq.gx, gz: eq.gz, rot: eq.rot });
    expect(placeB.r.ok).toBe(false);
    expect(placeB.r.reason).toMatch(/ロック/);

    const placeA = await a.c.act(rid(), { type: 'place', equipmentId: eq.id, gx: eq.gx, gz: eq.gz, rot: eq.rot });
    expect(placeA.r.reason ?? '').not.toMatch(/ロック/);

    a.c.close();
    expect((await b.c.next('layoutLock', (m) => m.holder === null)).holder).toBeNull();
    b.c.send({ t: 'layoutLock', on: true });
    expect((await b.c.next('layoutLock', (m) => m.holder !== null)).holder).toBe(b.id);
  });
});

describe('保存', () => {
  it('ホストの保存要求で検証済みの状態を返し、R2 に控えを置く。同じ rid の再送では保存し直さない', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    g.c.send({ t: 'save', rid: 'guest-save' });
    const denied = await g.c.next('saved');
    expect(denied.ok).toBe(false);

    hc.send({ t: 'save', rid: 'save-1' });
    const saved = await hc.next('saved');
    expect(saved.ok).toBe(true);
    expect(saved.state).toBeDefined();
    expect(saved.checksum).toBe(stateChecksum(saved.state!));
    expect(saved.state!.players.every((p) => p.connected === false)).toBe(true);

    hc.send({ t: 'save', rid: 'save-1' });
    const again = await hc.next('saved');
    expect(again.ok).toBe(true);
    expect(again.checksum).toBe(saved.checksum);
    const list = await env.SAVES.list({ prefix: `rooms/${room.roomId}/` });
    expect(list.objects).toHaveLength(1);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE room_id = ? AND kind = 'room_save'").bind(room.roomId).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe('レート制限', () => {
  it('送信が多すぎる接続はエラーを送って切断する', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    for (let i = 0; i < 200; i++) g.c.send({ t: 'ping', ts: i });
    expect((await g.c.next('error', (m) => m.code === 'rate_limited')).code).toBe('rate_limited');
    expect((await g.c.waitClose()).code).toBe(4008);
    // 切断として扱われ、他のプレイヤーには影響しない
    await hc.next('peers', (m) => m.list.some((p) => p.id === g.id && !p.connected));
    const r = await hc.act(rid(), { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(r.r.ok).toBe(true);
  });
});

describe('永続化と復旧', () => {
  it('一時停止中のルームは休止（退避）でき、復帰時にチェックポイントから状態を戻す', async () => {
    const { room, hc, host } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const id = rid('order');
    const r1 = await g.c.act(id, { type: 'orderStock', itemId: 'soy', packs: 3, express: false });
    expect(r1.r.ok).toBe(true);
    const m1 = await money(room.roomId);
    // ホストが切断 → ループが止まり、チェックポイントが書かれる
    hc.close();
    await g.c.next('paused');
    expect(await inRoom(room.roomId, (r) => r.loopRunning)).toBe(false);

    // ループが止まっているので休止できる。WebSocket は休止状態で残る
    await inRoom(room.roomId, (r) => {
      (r as unknown as { marker: number }).marker = 1;
    });
    await evictDurableObject(stub(room.roomId));
    expect(g.c.closed).toBeNull();

    // ゲストの次のメッセージで新しいインスタンスが起動し、チェックポイントから復元する
    g.c.send({ t: 'resync' });
    const full = await g.c.next('full');
    expect(full.state.money).toBe(m1);
    expect(full.state.paused).toBe(true);
    expect(await inRoom(room.roomId, (r) => (r as unknown as { marker?: number }).marker)).toBeUndefined();
    // 重複検出も復元されている
    const r2 = await g.c.act(id, { type: 'orderStock', itemId: 'soy', packs: 3, express: false });
    expect(r2.r).toEqual(r1.r);

    // ホストが戻れば再開する
    const hc2 = await open(room.roomId, (await joinRoom(host, room.code)).joinToken);
    await hc2.hello('ホスト');
    const hf = await hc2.next('full');
    expect(hf.state.money).toBe(m1);
    expect(hf.state.paused).toBe(false);
    await g.c.next('resumed');
    expect(await inRoom(room.roomId, (r) => r.loopRunning)).toBe(true);
    expect(await money(room.roomId)).toBe(m1);
  });

  it('動作中のインスタンスが失われても、チェックポイントから復元してループを再開する', async () => {
    const { room, hc } = await startRoom();
    const id = rid('order');
    const r1 = await hc.act(id, { type: 'orderStock', itemId: 'soy', packs: 3, express: false });
    expect(r1.r.ok).toBe(true);
    const m1 = await money(room.roomId);
    await inRoom(room.roomId, (r) => {
      r.checkpoint('test');
      // インスタンスの喪失を模擬する（動作中のタイマーがあると退避できないため、先に止める）
      (r as unknown as { stopLoopForTest(): void }).stopLoopForTest();
    });
    await evictDurableObject(stub(room.roomId));
    hc.send({ t: 'resync' });
    const full = await hc.next('full');
    expect(full.state.money).toBe(m1);
    expect(full.state.deliveries).toHaveLength(1);
    const r2 = await hc.act(id, { type: 'orderStock', itemId: 'soy', packs: 3, express: false });
    expect(r2.r).toEqual(r1.r);
    expect(await money(room.roomId)).toBe(m1);
    expect(await inRoom(room.roomId, (r) => r.loopRunning)).toBe(true);
    const t = hc.mirror!.t;
    await hc.until(() => hc.mirror!.t > t + 0.3, 3000, 'sim resumes');
  });

  it('チェックポイントが壊れていたら推測で続行せず、ホストにキャリアを持ち込み直してもらう', async () => {
    const { room, hc, host } = await startRoom();
    hc.close();
    for (let i = 0; i < 50 && (await inRoom(room.roomId, (r) => r.loopRunning)); i++) await sleep(50);
    await inRoom(room.roomId, (r) => {
      (r as unknown as { sql: SqlStorage }).sql.exec("UPDATE checkpoint_chunks SET data = 'broken' WHERE idx = 0");
    });
    await evictDurableObject(stub(room.roomId));
    const hc2 = await open(room.roomId, (await joinRoom(host, room.code)).joinToken);
    const w = await hc2.hello('ホスト');
    expect(w.needInit).toBe(true);
    expect(await inRoom(room.roomId, (r) => r.corrupt)).toBe(true);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE room_id = ? AND kind = 'checkpoint_corrupt'").bind(room.roomId).first<{ n: number }>();
    expect(row?.n).toBe(1);
    hc2.send({ t: 'hostInit', state: createGame({ seed: 8 }) });
    await hc2.next('full');
    expect(await inRoom(room.roomId, (r) => r.corrupt)).toBe(false);
  });

  it('誰もいないまま期限が過ぎたルームはアラームで終了する', async () => {
    const { room, hc } = await startRoom();
    hc.close();
    await sleep(200);
    await inRoom(room.roomId, (r) => {
      r.meta!.lastActivityAt = Date.now() - IDLE_TTL_MS - 1000;
    });
    expect(await runDurableObjectAlarm(stub(room.roomId))).toBe(true);
    const row = await env.DB.prepare('SELECT status FROM rooms WHERE id = ?').bind(room.roomId).first<{ status: string }>();
    expect(row?.status).toBe('ended');
    expect(await inRoom(room.roomId, (r) => r.meta!.ended)).toBe(true);
    const list = await env.SAVES.list({ prefix: `rooms/${room.roomId}/` });
    expect(list.objects).toHaveLength(1);
  });
});
