import { describe, expect, it } from 'vitest';
import { applyAction, GUEST_ACTIONS, isHostOnly, makePlayer, type ActionType } from '../src';
import { newGame, seatCustomer } from './helpers';

describe('共同経営の権限（第2版 2-1・2-3）', () => {
  it('ゲストは経営の操作ができず、状態は変わらない。店の業務はできる', () => {
    const { s, ctx } = newGame(3);
    const guest = makePlayer(s, 'g1', 'ゲスト', false);
    s.players.push(guest);
    const money = s.money;
    for (const a of [
      { type: 'openShop' },
      { type: 'orderStock', itemId: 'soy', packs: 1, express: false },
      { type: 'buyBowls' },
      { type: 'setPrice', menuId: 'small', price: 1200 },
      { type: 'takeLoan' },
    ] as const) {
      const r = applyAction(s, 'g1', a, ctx);
      expect(r.ok, a.type).toBe(false);
      expect(r.reason).toMatch(/ホスト/);
    }
    expect(s.money).toBe(money);
    expect(s.phase).toBe('prep');
    expect(s.deliveries).toEqual([]);
    // 業務: 歩く・席に対する作業
    expect(applyAction(s, 'g1', { type: 'move', x: guest.pos.x, z: guest.pos.z + 0.1, yaw: 0 }, ctx, 1).ok).toBe(true);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    const o = seatCustomer(s, 0);
    guest.pos = { x: 1.6, z: 2.85 };
    expect(applyAction(s, 'g1', { type: 'interact', targetId: o.seatId, verb: 'ask_call' }, ctx).ok).toBe(true);
  });

  it('ゲストの操作は 歩く・作業・作業をやめる・武器を使う だけで、それ以外（新しい操作も）はホストのみ', () => {
    // 武器を使う（FPS 式。2026-11-13）は、前の「襲う」（作業の一つ）と同じくゲストもできる。武器を持てるのはホストだけ（武器庫の扉）
    expect([...GUEST_ACTIONS].sort()).toEqual(['cancelWork', 'interact', 'move', 'useWeapon']);
    for (const t of ['openShop', 'nextDay', 'hire', 'place', 'accidentReset', 'setPrice'] as ActionType[]) expect(isHostOnly(t)).toBe(true);
  });
});
