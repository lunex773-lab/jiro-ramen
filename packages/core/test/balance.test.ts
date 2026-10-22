import { describe, expect, it } from 'vitest';
import { applyAction, refreshCandidates, step, type GameState } from '../src';
import { addSoloBot, newGame, runDay } from './helpers';
import { resaleValue } from '../src';

/** 何日か営業して、日ごとの結果を返す */
function playDays(s: GameState, ctx: ReturnType<typeof newGame>['ctx'], days: number, onMorning?: (d: number) => void) {
  const rows: string[] = [];
  for (let d = 0; d < days && s.phase !== 'bankrupt'; d++) {
    onMorning?.(d);
    // 開店前に1分間仕込みをする（プレイヤーと同じ）
    for (let i = 0; i < 600 && s.phase === 'prep'; i++) step(s, 0.1, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    const r = s.history[s.history.length - 1]!;
    rows.push(`day${r.day} served=${r.served}/${r.customers} lost=${r.lost} sales=${r.sales} cogs=${r.cogs} waste=${r.waste} rent=${r.rent} upkeep=${r.upkeep} util=${r.utilities} repairs=${r.repairs} wages=${r.wages} hiring=${r.hiring} refunds=${r.refunds} compl=${r.complaints} remakes=${r.remakes} mist=${r.mistakes} stockouts=${r.stockouts} op=${r.operatingProfit} cash=${r.cashEnd} rep=${r.reputation} sat=${r.avgSatisfaction.toFixed(2)} brk=${r.breakdowns}`);
    const res = applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    if (!res.ok && s.phase !== 'bankrupt') rows.push(`  nextDay blocked: ${res.reason}`);
  }
  return rows;
}

describe('経済バランス（長期シミュレーション）', { timeout: 120_000 }, () => {
  it('一人で手際よく回す店は10日で資金を減らさない', () => {
    const { s, ctx } = newGame(201);
    // プレイヤーの代わりの給与0ボット（一人営業）
    addSoloBot(s, 0.65);
    const rows = playDays(s, ctx, 10);
    console.log(['[solo]', ...rows].join('\n'));
    expect(s.phase).not.toBe('bankrupt');
    expect(s.money).toBeGreaterThan(250_000);
  });

  it('何もしない店は、救済手段（設備の売却・融資）を使い果たすと破産する', () => {
    const { s, ctx } = newGame(202);
    const rows = playDays(s, ctx, 200, () => {
      // 次の日に進めないときは、プレイヤーと同じく融資→設備売却で支払う
      if (s.phase !== 'closed') return;
      applyAction(s, 'p1', { type: 'takeLoan' }, ctx);
      const e = [...s.equipment].sort((a, b) => resaleValue(b) - resaleValue(a))[0];
      if (e) applyAction(s, 'p1', { type: 'sellEquipment', equipmentId: e.id }, ctx);
      applyAction(s, 'p1', { type: 'payArrears' }, ctx);
      applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    });
    console.log(['[idle]', ...rows.slice(-4)].join('\n'));
    expect(s.phase).toBe('bankrupt');
  });

  it('評判が上がったら従業員を雇って拡大できる', () => {
    const { s, ctx } = newGame(203);
    addSoloBot(s, 0.65);
    const rows = playDays(s, ctx, 20, (d) => {
      if (d === 6 && s.career.unlocked.includes('hiring')) {
        refreshCandidates(s);
        const c = s.candidates.sort((a, b) => a.profile.wage - b.profile.wage)[0];
        if (c) applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx);
      }
    });
    console.log(['[grow]', ...rows].join('\n'));
    expect(s.phase).not.toBe('bankrupt');
  });
});
