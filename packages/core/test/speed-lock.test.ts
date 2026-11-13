// イベントが起きたら倍速を解除（オーナーの判断 2026-11-13）。解除するイベントはオーナーが選んだもの:
// UFO・金色覚醒・横バウンス・クマ・YouTuber・テレビ取材・撮影や取材の許可の確認待ち。設定でオフ・解除したときの速さ（等倍 / 2倍）。
// 爆発・事件はいつも等倍
import { describe, expect, it } from 'vitest';
import { applyAction, eventSpeedLock, SLOW_EVENT_KEYS, speedLimit, speedLockReason } from '../src';
import { newGame, seatCustomer } from './helpers';

describe('決まったイベントが起きている間は倍速にできない', () => {
  it('解除するのは UFO・金色覚醒・横バウンス・クマ・YouTuber・テレビ取材・確認待ちだけ', () => {
    expect([...SLOW_EVENT_KEYS].sort()).toEqual(['bear', 'bounce', 'golden', 'request', 'tv', 'ufo', 'youtuber']);
    const { s, ctx } = newGame(301);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    seatCustomer(s, 0);
    expect(eventSpeedLock(s)).toBeNull();
    expect(speedLockReason(s, true)).toBeNull();
    const c = s.customers[0]!;
    // 解除するもの（店にいる間）
    for (const [kind, label] of [
      ['youtuber', 'YouTuber'],
      ['tv_performer', 'テレビ取材'],
      ['tv_camera', 'テレビ取材'],
      ['alien', '珍客イベント'],
      ['golden', '珍客イベント'],
      ['dancer', '珍客イベント'],
      ['bear', '珍客イベント'],
    ] as const) {
      c.special = { kind, eventId: 'e1' } as never;
      expect(eventSpeedLock(s), kind).toBe(label);
      expect(speedLockReason(s, true)).toContain(label);
      // 設定がオフなら倍速にできる
      expect(speedLockReason(s, false)).toBeNull();
    }
    // 帰ったら終わり
    c.state = 'left';
    expect(eventSpeedLock(s)).toBeNull();
    c.state = 'seated';
    // 解除しないもの: 覆面調査員・珍しいお客さん・鼻ほじり・口論・クレーム・SNS のバズ
    for (const kind of ['critic', 'couple_her', 'couple_him', 'ramen_lover', 'nosepicker', 'quarreler'] as const) {
      c.special = { kind, eventId: 'e1' } as never;
      expect(eventSpeedLock(s), kind).toBeNull();
    }
    c.special = null;
    c.state = 'complaint';
    expect(eventSpeedLock(s)).toBeNull();
    c.state = 'seated';
    s.events!.buzz = { id: 'b1', startT: s.openT, endT: s.openT + 100, mult: 2 } as never;
    expect(eventSpeedLock(s)).toBeNull();
    // 撮影・取材の許可の確認を待っている間は解除する
    s.events!.requests = [{ id: 'r1', kind: 'filming', subjectId: c.id, text: '', askedAt: s.t, timeoutAt: s.t + 30 }] as never;
    expect(eventSpeedLock(s)).toBe('確認を待っています');
    s.events!.requests = [];
    // 珍客イベント: UFO・金色覚醒・横バウンス・クマは解除、鼻ほじり・口論は解除しない
    for (const [kind, on] of [['ufo', true], ['golden', true], ['bounce', true], ['bear', true], ['nosepick', false], ['quarrel', false]] as const) {
      s.events!.chaos = { ...(s.events!.chaos ?? {}), active: [{ id: 'x', kind }] } as never;
      expect(eventSpeedLock(s) !== null, kind).toBe(on);
    }
  });

  it('閉店後は止めない', () => {
    const { s } = newGame(302);
    s.phase = 'closed';
    s.events!.requests = [{ id: 'r1' }] as never;
    expect(eventSpeedLock(s)).toBeNull();
  });

  // オーナーの指示 2026-11-13: 解除したときの速さを2倍にもできる
  it('2倍を選ぶと上限は×2（×1 はそのまま）。事故・事件はいつも等倍', () => {
    const { s, ctx } = newGame(303);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    seatCustomer(s, 0);
    const c = s.customers[0]!;
    c.special = { kind: 'youtuber', eventId: 'e1' } as never;
    expect(speedLimit(s, { on: true })).toMatchObject({ cap: 1, label: 'YouTuber', hard: false });
    const two = { on: true, speed: 2 };
    expect(speedLimit(s, two)).toMatchObject({ cap: 2, label: 'YouTuber' });
    expect(speedLimit(s, two)!.reason).toContain('×2');
    expect(speedLockReason(s, two)).toBeNull();
    // 事故の間は、設定に関係なく等倍（ボタンも押せない）
    s.events!.accident = { stage: 'fire' } as never;
    expect(speedLimit(s, { on: false })).toMatchObject({ cap: 1, hard: true });
    expect(speedLimit(s, two)).toMatchObject({ cap: 1, hard: true });
  });
});
