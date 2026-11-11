// じろ1 P3（docs/JIRO1_PLAN.md 5.3）: 行列 — 食券が先・店の外は2列・外で並ぶ間は我慢が減らない・閉店の時刻ですぐに解散しない
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, step, streetQueueSpot, STREET_QUEUE_ROWS, type Customer, type GameState, type SimCtx } from '../src';
import { DEFAULT_HOURS, utilitiesBaseOf } from '../src/sim/hours';
import { addBot, newGame } from './helpers';

/** 客が多く、席が足りずに外に行列ができる店（評判5・バズ中・人手は調理担当1人） */
function busyShop(seed: number): { s: GameState; ctx: SimCtx } {
  const g = newGame(seed);
  addBot(g.s, 'cook', 0.6);
  g.s.reputation = 5;
  expect(applyAction(g.s, 'p1', { type: 'openShop' }, g.ctx).ok).toBe(true);
  return g;
}

const ticketed = (c: Customer) => !!c.menuId;

describe('行列（食券が先・2列）', () => {
  it('店の外の行列は2列（隣の2人は同じ位置の前後の列）', () => {
    expect(STREET_QUEUE_ROWS).toBe(2);
    const a = streetQueueSpot(0);
    const b = streetQueueSpot(1);
    const c = streetQueueSpot(2);
    expect(b.x).toBeCloseTo(a.x);
    expect(b.z).not.toBeCloseTo(a.z);
    expect(c.x).toBeGreaterThan(a.x);
    expect(c.z).toBeCloseTo(a.z);
  });

  it('外に並ぶのは食券を買った客だけで、外で並んでいる間は我慢が減らず、待ち時間にも数えない', { timeout: 60_000 }, () => {
    const { s, ctx } = busyShop(71);
    let checked = 0;
    for (let i = 0; i < 9000 && s.phase === 'open'; i++) {
      step(s, 0.1, ctx);
      const queued = s.customers.filter((c) => c.state === 'queue');
      // 店の外の列には、食券を買った客しかいない（券売機の順番待ちは別の列）
      for (const c of queued) expect(ticketed(c)).toBe(true);
      expect(s.queue.every((id) => s.customers.find((c) => c.id === id)?.state === 'queue')).toBe(true);
      if (i % 200 === 0 && queued.length > 0) {
        const snap = queued.map((c) => ({ id: c.id, patience: c.patience, queueWait: c.queueWait }));
        step(s, 0.1, ctx);
        for (const x of snap) {
          const c = s.customers.find((y) => y.id === x.id);
          if (c?.state !== 'queue') continue;
          expect(c.patience).toBe(x.patience);
          expect(c.queueWait).toBe(x.queueWait);
          checked++;
        }
      }
    }
    // 外の行列ができて、我慢が減らないことを実際に確かめた
    expect(checked).toBeGreaterThan(0);
  });

  it('閉店の時刻に外で並んでいる客はすぐには帰らず、しばらく待つ。店は閉店後も提供を続け、その時間の光熱費がかかる', { timeout: 60_000 }, () => {
    const { s, ctx } = busyShop(73);
    let t = 0;
    while (s.phase === 'open' && t < 2000) {
      step(s, 0.1, ctx);
      t += 0.1;
    }
    expect(s.phase).toBe('closing');
    const waiting = s.customers.filter((c) => c.state === 'queue' && ticketed(c)).map((c) => c.id);
    expect(waiting.length).toBeGreaterThan(0);
    // 10秒（ゲーム内で約4分）たっても、食券を買って外で並んでいた客は帰っていない（中に入った人はいてもよい）
    for (let i = 0; i < 100; i++) step(s, 0.1, ctx);
    const gone = waiting.filter((id) => {
      const c = s.customers.find((x) => x.id === id);
      return !c || c.state === 'leaving';
    });
    expect(gone).toHaveLength(0);
    // 待つのは決まった時間まで。いつまでも待ち続けず、その日は終わる
    let u = 0;
    while (s.phase !== 'closed' && u < 1500) {
      step(s, 0.1, ctx);
      u += 0.1;
    }
    expect(s.phase).toBe('closed');
    const r = s.history[0]!;
    expect(r.afterHoursSec ?? 0).toBeGreaterThan(0);
    expect(r.utilities).toBeGreaterThan(utilitiesBaseOf(DEFAULT_HOURS, true));
    expect(BALANCE.customers.afterCloseWaitSec).toBeGreaterThan(0);
  });
});
