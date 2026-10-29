// 共同経営での営業中のイベントと爆発事故（設計書 E のマルチプレイ時の仕様）。

import { createGame, takePrepSnapshot, type GameState } from '@jiro/core';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameRoom } from '../src/room';
import { createRoom, joinRoom, newPlayer, rid, sleep, WsClient, type RoomInfo } from './helpers';

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

function inRoom<R>(roomId: string, fn: (room: GameRoom) => R | Promise<R>): Promise<R> {
  return runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(roomId)), (inst: GameRoom) => fn(inst));
}

/** 2日目の仕込み中のキャリア（2日目から事故が起きる） */
function day2Career(): GameState {
  const s = createGame({ seed: 11, shopName: '共同屋' });
  s.day = 2;
  takePrepSnapshot(s);
  return s;
}

async function startRoom(): Promise<{ room: RoomInfo; hc: WsClient }> {
  const host = await newPlayer('ホスト');
  const room = await createRoom(host);
  const hc = await open(room.roomId, room.joinToken);
  await hc.hello('ホスト');
  hc.send({ t: 'hostInit', state: day2Career() });
  await hc.next('welcome');
  await hc.next('full');
  return { room, hc };
}

async function addGuest(room: RoomInfo, name: string): Promise<WsClient> {
  const p = await newPlayer(name);
  const j = await joinRoom(p, room.code);
  const c = await open(j.roomId, j.joinToken);
  await c.hello(name);
  await c.next('full');
  return c;
}

/** サーバーの状態を、開店して爆発した直後（目覚めたあと）にする */
async function destroyShop(roomId: string): Promise<string> {
  return inRoom(roomId, (r) => {
    const s = r.state!;
    s.phase = 'open';
    s.openT = 200;
    s.t = 200;
    s.money += 12_345; // 当日の売上の代わり（リセットで消えること）
    s.events!.accident = { id: 'ev-test', day: s.day, stage: 'destroyed', t: 60, sourceId: null, pos: { x: 2, z: 2 } };
    (r as unknown as { dirty: boolean }).dirty = true;
    r.flush();
    return 'ev-test';
  });
}

describe('共同経営の爆発事故', () => {
  it('仕込み開始時点の控えは配信しない（サーバーだけが持つ）', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    expect(await inRoom(room.roomId, (r) => r.state!.prepSnapshot?.day)).toBe(2);
    expect(hc.mirror!.prepSnapshot).toBeUndefined();
    expect(g.mirror!.prepSnapshot).toBeUndefined();
    expect(JSON.stringify(hc.all)).not.toContain('prepSnapshot');
  });

  it('全員が同じ事故の状態を受け取る', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const id = await destroyShop(room.roomId);
    for (const c of [hc, g]) await c.until(() => c.mirror?.events?.accident?.id === id && c.mirror.events.accident.stage === 'destroyed', 3000, 'accident synced');
    // 壊滅している間は営業の操作は受け付けない
    const r = await g.act(rid(), { type: 'orderStock', itemId: 'soy', packs: 1, express: false });
    expect(r.r.ok).toBe(false);
  });

  it('リセットはホストだけ。同時に届いても復元は1回だけで、全員に通知される', async () => {
    const { room, hc } = await startRoom();
    const g = await addGuest(room, 'ゲスト');
    const before = await inRoom(room.roomId, (r) => r.state!.money);
    const id = await destroyShop(room.roomId);
    for (const c of [hc, g]) await c.until(() => c.mirror?.events?.accident?.id === id, 3000, 'accident synced');
    // ゲストは戻せない
    const rg = await g.act(rid('g'), { type: 'accidentReset', accidentId: id });
    expect(rg.r.ok).toBe(false);
    expect(rg.r.reason).toMatch(/ホスト/);
    // ホストから2つ同時に届いても、1回だけ戻す
    const r1 = rid('a');
    const r2 = rid('b');
    hc.send({ t: 'act', rid: r1, a: { type: 'accidentReset', accidentId: id }, v: hc.seq });
    hc.send({ t: 'act', rid: r2, a: { type: 'accidentReset', accidentId: id }, v: hc.seq });
    const [a, b] = await Promise.all([hc.next('res', (m) => m.rid === r1), hc.next('res', (m) => m.rid === r2)]);
    expect([a.r.ok, b.r.ok].filter(Boolean)).toHaveLength(1);
    const after = await inRoom(room.roomId, (r) => ({ money: r.state!.money, resets: r.state!.events!.resets, phase: r.state!.phase, accident: r.state!.events!.accident }));
    expect(after).toEqual({ money: before, resets: 1, phase: 'prep', accident: null });
    // 全員に届く（状態と通知）
    for (const c of [hc, g]) {
      await c.until(() => c.mirror?.events?.resets === 1, 3000, 'reset synced');
      expect(c.mirror!.phase).toBe('prep');
      expect(c.mirror!.events!.accident).toBeNull();
      expect(c.mirror!.notices.some((n) => n.code === 'accident' && n.text.includes('リセット'))).toBe(true);
      expect(c.mirror!.money).toBe(before);
    }
    // 仕込みの開始時点に戻ったところでルームを保存している
    const reason = await inRoom(room.roomId, (r) => JSON.parse((r as unknown as { kvGet(k: string): string | null }).kvGet('checkpoint')!).reason as string);
    expect(reason).toBe('phase');
  });

  it('テスト用の強制発生（debugEvent）はサーバーが受け付けない', async () => {
    const { room, hc } = await startRoom();
    hc.send({ t: 'act', rid: rid(), a: { type: 'debugEvent', kind: 'explosion' }, v: hc.seq });
    expect((await hc.next('error')).code).toBe('bad_message');
    expect(await inRoom(room.roomId, (r) => r.state!.events!.forced)).toEqual([]);
  });
});
