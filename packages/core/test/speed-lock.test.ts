// イベントが起きたら等倍（オーナーの判断 2026-11-13）: 珍しいことが起きている間は倍速にできない（設定でオフ）。爆発・事件はいつも
import { describe, expect, it } from 'vitest';
import { applyAction, eventSpeedLock, speedLockReason } from '../src';
import { newGame, seatCustomer } from './helpers';

describe('珍しいことが起きている間は倍速にできない', () => {
  it('何もなければ倍速にできる。珍しいお客さん・クレーム・SNS のバズ・確認待ち・珍客イベントの間はできない（設定がオンのとき）', () => {
    const { s, ctx } = newGame(301);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    seatCustomer(s, 0);
    expect(eventSpeedLock(s)).toBeNull();
    expect(speedLockReason(s, true)).toBeNull();
    const c = s.customers[0]!;
    // 珍しいお客さん（店にいる間）
    c.special = { kind: 'ramen_lover', eventId: 'e1' } as never;
    expect(eventSpeedLock(s)).toBe('珍しいお客さん');
    expect(speedLockReason(s, true)).toContain('珍しいお客さん');
    // 設定がオフなら倍速にできる
    expect(speedLockReason(s, false)).toBeNull();
    // 帰ったら終わり
    c.state = 'left';
    expect(eventSpeedLock(s)).toBeNull();
    // クレーム
    c.state = 'complaint';
    c.special = null;
    expect(eventSpeedLock(s)).toBe('クレーム');
    c.state = 'seated';
    // SNS のバズ（続いている間）
    s.events!.buzz = { id: 'b1', startT: s.openT, endT: s.openT + 100, mult: 2 } as never;
    expect(eventSpeedLock(s)).toBe('SNS のバズ');
    s.openT += 101;
    expect(eventSpeedLock(s)).toBeNull();
    // 撮影・取材の許可の確認を待っている間
    s.events!.requests = [{ id: 'r1', kind: 'filming', subjectId: c.id, text: '', askedAt: s.t, timeoutAt: s.t + 30 }] as never;
    expect(eventSpeedLock(s)).toBe('確認を待っています');
    s.events!.requests = [];
    // 珍客イベント
    s.events!.chaos = { ...(s.events!.chaos ?? {}), active: [{ id: 'x' }] } as never;
    expect(eventSpeedLock(s)).toBe('珍客イベント');
  });

  it('閉店後は止めない', () => {
    const { s } = newGame(302);
    s.phase = 'closed';
    s.events!.requests = [{ id: 'r1' }] as never;
    expect(eventSpeedLock(s)).toBeNull();
  });
});
