// 純粋な関数の単体テスト: チェックポイントの直列化、requestId キャッシュ、メッセージ検証、バージョン比較、レート制限。

import { createGame, makeCtx, makeEmployee, step, type GameState } from '@jiro/core';
import { describe, expect, it } from 'vitest';
import { decodeCheckpoint, encodeCheckpoint, RidCache, type CheckpointData } from '../src/checkpoint';
import { parseAction, parseClientMsg } from '../src/protocol';
import { KeyedLimiter, TokenBucket } from '../src/ratelimit';
import { checkHostState } from '../src/room';
import { cleanName, normalizeRoomCode, randomRoomCode, ROOM_CODE_ALPHABET } from '../src/util';
import { compareVersions, isClientSupported, parseVersion } from '../src/version';

function bigState(): GameState {
  const s = createGame({ seed: 11, shopName: 'でかい店' });
  const ctx = makeCtx();
  for (let i = 0; i < 8; i++) {
    const e = makeEmployee(s, {
      id: `cand${i}`,
      profile: { name: `従業員${i}`, role: 'cook', skills: { speed: 0.5, cooking: 0.5, service: 0.5, hygiene: 0.5, movement: 0.5, reliability: 1 }, wage: 0, hireFee: 0, experience: 0 },
    });
    s.employees.push(e);
  }
  for (let i = 0; i < 300; i++) step(s, 0.1, ctx);
  return s;
}

describe('チェックポイント', () => {
  it('断片に分けて保存し、元どおりに復元できる', () => {
    const s = bigState();
    const rids = new RidCache();
    rids.set('a', { ok: true, data: 1 });
    const data: CheckpointData = { v: 1, seq: 42, savedAt: 1, state: s, rids: { p1: rids.entries() } };
    const enc = encodeCheckpoint(data, 1000);
    expect(enc.chunks.length).toBeGreaterThan(3);
    const dec = decodeCheckpoint(enc.chunks, enc.sum, enc.length);
    expect(dec.ok).toBe(true);
    if (!dec.ok) return;
    expect(dec.data.seq).toBe(42);
    expect(JSON.stringify(dec.data.state)).toBe(JSON.stringify(s));
    expect(dec.data.rids.p1).toEqual([['a', { ok: true, data: 1 }]]);
  });

  it('壊れた・欠けたチェックポイントは復元しない', () => {
    const s = createGame({ seed: 1 });
    const enc = encodeCheckpoint({ v: 1, seq: 1, savedAt: 1, state: s, rids: {} }, 500);
    const broken = [...enc.chunks];
    broken[1] = broken[1]!.replace(/\d/, (d) => String((Number(d) + 1) % 10));
    expect(decodeCheckpoint(broken, enc.sum, enc.length).ok).toBe(false);
    expect(decodeCheckpoint(enc.chunks.slice(1), enc.sum, enc.length).ok).toBe(false);
    // チェックサムは合っていても内容が不正なら拒否
    const bad = { ...s, money: 'x' } as unknown as GameState;
    const enc2 = encodeCheckpoint({ v: 1, seq: 1, savedAt: 1, state: bad, rids: {} });
    const r = decodeCheckpoint(enc2.chunks, enc2.sum, enc2.length);
    expect(r.ok).toBe(false);
  });
});

describe('requestId キャッシュ', () => {
  it('上限を超えたら古いものから捨てる', () => {
    const c = new RidCache(3);
    for (const k of ['a', 'b', 'c', 'd']) c.set(k, { ok: true });
    expect(c.get('a')).toBeUndefined();
    expect(c.get('d')).toEqual({ ok: true });
    expect(c.size).toBe(3);
  });

  it('大きな data は捨てて ok/reason だけ残す', () => {
    const c = new RidCache();
    c.set('x', { ok: false, reason: 'だめ', data: 'z'.repeat(2000) });
    expect(c.get('x')).toEqual({ ok: false, reason: 'だめ' });
  });
});

describe('メッセージ検証', () => {
  it('正しい操作だけを受け付け、余計なキーは落とす', () => {
    expect(parseAction({ type: 'orderStock', itemId: 'soy', packs: 2, express: true, evil: 1 })).toEqual({ type: 'orderStock', itemId: 'soy', packs: 2, express: true });
    expect(parseAction({ type: 'orderStock', itemId: 'soy', packs: 0, express: true })).toBeNull();
    expect(parseAction({ type: 'move', x: Number.NaN, z: 0, yaw: 0 })).toBeNull();
    expect(parseAction({ type: 'place', equipmentId: 'e1', gx: 1.5, gz: 0, rot: 0 })).toBeNull();
    expect(parseAction({ type: 'place', equipmentId: 'e1', gx: 1, gz: 0, rot: 4 })).toBeNull();
    expect(parseAction({ type: 'setAutoOrder', itemId: 'not_food', qty: 1 })).toBeNull();
    expect(parseAction({ type: 'setAutoOrder', itemId: 'toString', qty: 1 })).toBeNull();
    expect(parseAction({ type: 'setPriority', employeeId: 'e1', kind: 'constructor', value: 1 })).toBeNull();
    expect(parseAction({ type: 'interact', targetId: 'e1', verb: 'use', args: { a: { nested: 1 } } })).toBeNull();
    expect(parseAction({ type: 'hack' })).toBeNull();
    expect(parseAction({ type: 'giveUp' })).toEqual({ type: 'giveUp' });
  });

  it('クライアントメッセージの形を検証する', () => {
    expect(parseClientMsg({ t: 'hello', name: 'a', protocol: 1, clientVersion: '0.1.0' })).toMatchObject({ t: 'hello' });
    expect(typeof parseClientMsg({ t: 'act', rid: 'bad rid!', a: { type: 'openShop' }, v: 0 })).toBe('string');
    expect(parseClientMsg({ t: 'act', rid: 'ok-1', a: { type: 'openShop' } })).toEqual({ t: 'act', rid: 'ok-1', a: { type: 'openShop' }, v: 0 });
    expect(typeof parseClientMsg({ t: 'layoutLock', on: 'yes' })).toBe('string');
    expect(typeof parseClientMsg([])).toBe('string');
  });

  it('持ち込み状態を検証する', () => {
    expect(typeof checkHostState(createGame({ seed: 1 }))).toBe('object');
    expect(typeof checkHostState({})).toBe('string');
    const dup = createGame({ seed: 1 });
    dup.players.push({ ...dup.players[0]! });
    expect(checkHostState(dup)).toMatch(/プレイヤー/);
  });
});

describe('補助関数', () => {
  it('バージョンを比較する', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('v2')).toEqual([2, 0, 0]);
    expect(parseVersion('abc')).toBeNull();
    expect(compareVersions([0, 1, 10], [0, 1, 9])).toBeGreaterThan(0);
    expect(isClientSupported('0.1.0', '0.1.0')).toBe(true);
    expect(isClientSupported('0.2.0-beta', '0.1.5')).toBe(true);
    expect(isClientSupported('0.0.9', '0.1.0')).toBe(false);
    expect(isClientSupported('garbage', '0.1.0')).toBe(false);
  });

  it('参加コードを生成・正規化する', () => {
    for (let i = 0; i < 50; i++) {
      const c = randomRoomCode();
      expect(c).toHaveLength(6);
      for (const ch of c) expect(ROOM_CODE_ALPHABET).toContain(ch);
    }
    expect(normalizeRoomCode(' ab-cd ef ')).toBe('ABCDEF');
    expect(normalizeRoomCode('ABCDE0')).toBeNull();
    expect(normalizeRoomCode(123)).toBeNull();
  });

  it('名前を検証する', () => {
    expect(cleanName(' 店主 ')).toBe('店主');
    expect(cleanName('a‮b')).toBeNull();
    expect(cleanName('')).toBeNull();
  });

  it('トークンバケットは時間とともに回復する', () => {
    const b = new TokenBucket(2, 1, 0);
    expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(true);
    expect(b.take(1, 0)).toBe(false);
    expect(b.retryAfter(1, 0)).toBe(1);
    expect(b.take(1, 1000)).toBe(true);
    const k = new KeyedLimiter(1, 1, 2);
    expect(k.check('a', 1, 0)).toBe(0);
    expect(k.check('a', 1, 0)).toBeGreaterThan(0);
    expect(k.check('b', 1, 0)).toBe(0);
    k.check('c', 1, 0);
    // キー数の上限を超えると古いキーから捨てる（'a' は新しいバケットになる）
    expect(k.check('a', 1, 0)).toBe(0);
  });
});
