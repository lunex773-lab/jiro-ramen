// ランキングの種別のうち新しく作った数値（従業員満足度・店舗品質・企業価値。sim/metrics.ts。オーナーの判断 6）
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, employeeSatisfaction, enterpriseValue, storeQuality } from '../src';
import { addBot, newGame } from './helpers';

describe('従業員満足度・店舗品質・企業価値', () => {
  it('従業員満足度は従業員の満足度の平均。従業員がいなければ値なし（短期バイトは数えない）', () => {
    const { s } = newGame(1);
    expect(employeeSatisfaction(s)).toBeNull();
    const a = addBot(s, 'cook');
    const b = addBot(s, 'server');
    a.morale = 0.9;
    b.morale = 0.5;
    expect(employeeSatisfaction(s)).toBeCloseTo(0.7, 10);
    b.profile.temp = true;
    expect(employeeSatisfaction(s)).toBeCloseTo(0.9, 10);
  });

  it('店舗品質は 評判÷5・設備の状態・清潔さ の等しい重みの平均（0〜1）。汚れや傷みで下がる', () => {
    const { s } = newGame(2);
    const q0 = storeQuality(s);
    expect(q0).toBeGreaterThan(0);
    expect(q0).toBeLessThanOrEqual(1);
    for (const seat of s.seats) seat.dirt = 1;
    s.kitchenGrime = 1;
    const q1 = storeQuality(s);
    expect(q1).toBeLessThan(q0);
    for (const e of s.equipment) e.condition = 10;
    expect(storeQuality(s)).toBeLessThan(q1);
  });

  it('企業価値は純資産（借入で増えた現金は借入の残りと打ち消す。水増しできない）', () => {
    const { s, ctx } = newGame(3);
    const v0 = enterpriseValue(s);
    expect(v0).toBeGreaterThanOrEqual(BALANCE.initialMoney);
    s.phase = 'closed';
    expect(applyAction(s, 'p1', { type: 'takeLoan' }, ctx).ok).toBe(true);
    expect(s.money).toBe(BALANCE.initialMoney + BALANCE.loan.amount);
    expect(enterpriseValue(s)).toBe(v0);
    s.arrears.push({ id: 'x', amount: 10_000, reason: 't', sinceDay: 1, dueDay: 3 });
    expect(enterpriseValue(s)).toBe(v0 - 10_000);
  });
});

describe('気になる点（仕様書 7: 不自然な価格操作の検知。受け取りには影響しない）', () => {
  it('値段が定価から大きく離れていると記録に残す', async () => {
    const { watchPoints, MENU } = await import('../src');
    const { s } = newGame(4);
    expect(watchPoints(s)).toEqual([]);
    for (const m of Object.values(MENU)) s.prices[m.id] = 3000;
    expect(watchPoints(s)[0]).toContain('定価');
  });
});
