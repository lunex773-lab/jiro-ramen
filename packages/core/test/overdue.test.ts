// 期限を過ぎた未払金を払えず次の日に進めないときの数字（画面の選択肢のもと。オーナーの指示 2026-11-12）
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, nextDay, overdueShortfall } from '../src';
import { addSoloBot, newGame, runDay } from './helpers';

describe('期限を過ぎた未払金', () => {
  it('払えない分・借りれば足りる融資の額・設備を売った額を出す。融資を受けて払うと次の日に進める', () => {
    const { s, ctx } = newGame(61);
    addSoloBot(s);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.phase).toBe('closed');
    expect(overdueShortfall(s)).toBeNull();
    s.money = 1_000;
    s.arrears.push({ id: 'ar-x', amount: 120_000, reason: 'テスト', sinceDay: s.day - 3, dueDay: s.day - 1 });
    const f = overdueShortfall(s)!;
    expect(f.overdue).toBe(120_000);
    expect(f.shortfall).toBe(119_000);
    expect(f.loanPick % BALANCE.loan.step).toBe(0);
    expect(f.loanPick).toBeGreaterThanOrEqual(119_000);
    expect(f.sellable).toBeGreaterThan(0);
    // そのままでは進めない（破産にもならない: 融資と設備の売却で払える）
    const r = nextDay(s, ctx);
    expect(r.ok).toBe(false);
    expect(s.phase).toBe('closed');
    // 融資を受けて払うと進める
    expect(applyAction(s, 'p1', { type: 'takeLoan', amount: f.loanPick }, ctx).ok).toBe(true);
    applyAction(s, 'p1', { type: 'payArrears' }, ctx);
    expect(overdueShortfall(s)).toBeNull();
    expect(nextDay(s, ctx).ok).toBe(true);
  });
});
