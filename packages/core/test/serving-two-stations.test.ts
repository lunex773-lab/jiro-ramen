// 麺釜2台・盛り付け台2台のときの提供ミス（オーナーの報告 2026-11-13）。
// 前は台ごとに同じ注文の分の丼を並べて割り当てのない丼が余り、それに「そのまま」で盛ったトッピングや別の量の麺が
// ほかの注文に回って、提供ミス（コール違い・大と小の取り違え）が3割ほどになっていた。離れた2台目の麺釜でゆでた麺が上げられず、
// ゆですぎで捨てて提供が半分ほどに減ることもあった
import { describe, expect, it } from 'vitest';
import { addLot, applyAction, nextDay, type GameState, type SimCtx } from '../src';
import { addBot, newGame, runDay } from './helpers';

function twoStations(seed: number) {
  const { s, ctx } = newGame(seed);
  s.tutorial = null;
  s.money = 5_000_000;
  s.reputation = 4.3;
  for (let i = 0; i < 4; i++) addBot(s, 'cook', 0.7);
  addBot(s, 'server', 0.7);
  addBot(s, 'cleaner', 0.7);
  for (const t of ['noodle_boiler', 'assembly']) expect(applyAction(s, 'p1', { type: 'buyEquipment', equipType: t, autoPlace: true }, ctx).ok).toBe(true);
  return { s, ctx };
}

function playDays(s: GameState, ctx: SimCtx, days: number) {
  let served = 0;
  const mistakes: string[] = [];
  for (let d = 0; d < days; d++) {
    if (s.phase === 'closed') nextDay(s, ctx);
    // 豚・ヤサイなどの仕込み品は足りている前提（品切れのミスと分ける）
    for (const [id, q] of [['buta', 300], ['yasai', 40000], ['garlic', 4000], ['abura', 4000], ['tare', 20000]] as const) addLot(s, id, q, 1);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx, 3000);
    for (const ev of ctx.events) {
      if (ev.type !== 'served') continue;
      served++;
      if (ev.text) mistakes.push(ev.text);
    }
    ctx.events.length = 0;
  }
  return { served, mistakes };
}

describe('麺釜2台・盛り付け台2台（提供ミスの不具合）', () => {
  it('提供ミスがほとんど出ない（大と小の取り違えなし）', { timeout: 120_000 }, () => {
    const { s, ctx } = twoStations(11);
    const r = playDays(s, ctx, 3);
    expect(r.mistakes.filter((m) => m.includes('取り違え'))).toEqual([]);
    expect(r.mistakes.length / r.served).toBeLessThan(0.05);
    expect(r.served).toBeGreaterThan(25);
  });
});
