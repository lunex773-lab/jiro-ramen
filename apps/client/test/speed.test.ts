import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, createGame, makeCtx, nextDay, step, type GameState } from '@jiro/core';
import { LocalHost } from '../src/game/host';

/** 2日目の営業中（爆発事故は2日目から起きる） */
function openDay2(): GameState {
  const s = createGame({ seed: 9 });
  const ctx = makeCtx();
  s.tutorial = null;
  applyAction(s, s.players[0]!.id, { type: 'openShop' }, ctx);
  for (let i = 0; i < 20000 && s.phase !== 'closed'; i++) step(s, 0.1, ctx);
  expect(nextDay(s, ctx).ok).toBe(true);
  applyAction(s, s.players[0]!.id, { type: 'openShop' }, ctx);
  return s;
}

describe('爆発事故の間は倍速にしない（オーナーの指示: 発火したら倍速をやめ、15秒の火事を体験してから爆発する）', () => {
  it('倍速で営業中に発火すると等速に戻り、発火から爆発まで実時間で15秒かかる。事故の間は倍速にできない', () => {
    const s = openDay2();
    const host = new LocalHost(s, s.players[0]!.id);
    host.speed = 3;
    expect(host.speedLocked).toBe(false);
    expect(applyAction(s, s.players[0]!.id, { type: 'debugEvent', kind: 'explosion' }, makeCtx()).ok).toBe(true);
    // 1/60 秒ずつ進める（画面の1フレーム）
    let real = 0;
    do {
      host.tick(1 / 60);
      real += 1 / 60;
    } while (s.events?.accident?.stage !== 'warning' && real < 30);
    expect(s.events?.accident?.stage).toBe('warning');
    expect(host.speed).toBe(1);
    expect(host.speedLocked).toBe(true);
    // 事故の間に倍速にしても、次のフレームで等速に戻る
    host.speed = 3;
    const startT = s.events!.accident!.t;
    let warnReal = 0;
    while (s.events?.accident?.stage === 'warning' && warnReal < 60) {
      host.tick(1 / 60);
      warnReal += 1 / 60;
      if (warnReal > 1) host.speed = 2;
    }
    expect(s.events?.accident?.stage).toBe('destroyed');
    // 発火から爆発までは実時間でほぼ15秒（倍速なら5〜7.5秒で終わってしまう）
    expect(warnReal + startT).toBeGreaterThan(BALANCE.events.explosion.warningSec - 0.2);
    expect(warnReal + startT).toBeLessThan(BALANCE.events.explosion.warningSec + 0.2);
    host.tick(1 / 60);
    expect(host.speed).toBe(1);
  });

  it('事故がなければ今までどおり倍速で進む', () => {
    const s = openDay2();
    const host = new LocalHost(s, s.players[0]!.id);
    host.speed = 3;
    const t0 = s.t;
    for (let i = 0; i < 60; i++) host.tick(1 / 60);
    expect(s.t - t0).toBeCloseTo(3, 1);
    expect(host.speed).toBe(3);
  });
});
