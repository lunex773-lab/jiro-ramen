// 自動営業（オンライン市場の0時の計算・店長の営業）の日のあとの在庫と常連（オーナーの報告した不具合の回帰テスト）
import { describe, expect, it } from 'vitest';
import { autoPlayDay, createMarket, jstMidnight, playerCompany, startDay, type GameState } from '../src';
import { autoOrderTarget, shelfLifeCap, stockOf } from '../src/sim/inventory';
import { clone } from './helpers';

function company(): { s: GameState; demand: Record<string, number> } {
  const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;
  const m = createMarket({ id: 'a', name: 'a', seed: 1, now: T0, creator: { ownerId: 'u1', companyName: 'x' } });
  const c = playerCompany(m, 'u1')!;
  const t = startDay(m, 'u1', T0, 't1', c.progress.stateVersion);
  if (!t.ok) throw new Error(t.reason);
  return { s: clone(c.state), demand: t.ticket.demand };
}

describe('自動営業の日のあと', () => {
  it('翌朝便の自動発注をするので、次の朝に仕入れの食材が目安までそろっている（前は発注せず在庫が減っていった）', () => {
    const { s, demand } = company();
    for (let d = 0; d < 5; d++) {
      autoPlayDay(s, s.day, demand, { allowLoan: false });
      expect(s.phase).toBe('prep');
      for (const item of ['noodle', 'bones', 'moyashi']) {
        // 保存期間のうちに使い切れない分は頼まない（じろ2）ので、目安と保存期間の上限の小さいほうまで。
        // 新規参入の保護（じろ2）で開店からの数日は客が増えていくため、朝に計算し直した目安（前の日の売れ行きを入れる）より少し少ないことがある
        expect(stockOf(s, item), `${s.day}日目の朝の ${item}`).toBeGreaterThanOrEqual(Math.min(autoOrderTarget(s, item), shelfLifeCap(s, item)) * 0.85);
      }
    }
  });

  it('店が開いている日は常連が通い続け、自動営業が続いても離れない（前は6日目から離れて、いなくなった）', () => {
    const { s, demand } = company();
    for (let i = 0; i < 12; i++) {
      s.regulars.push({
        id: `r${i}`,
        name: `常連${i}さん`,
        traits: s.regulars[0]?.traits ?? ({} as GameState['regulars'][number]['traits']),
        appearance: undefined as unknown as GameState['regulars'][number]['appearance'],
        visits: 3,
        favoriteMenu: 'small',
        favoriteCall: { yasai: 1, ninniku: 1, abura: 1, karame: 1 },
        satisfactionSum: 2.4,
        lastVisitDay: s.day - 1,
        loyalty: 0.5,
        rating: 0.8,
      } as GameState['regulars'][number]);
    }
    for (let d = 0; d < 20; d++) autoPlayDay(s, s.day, demand, { allowLoan: false });
    expect(s.regulars.length).toBe(12);
    expect(Math.min(...s.regulars.map((r) => r.loyalty))).toBeCloseTo(0.5, 5);
  });
});
