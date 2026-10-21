import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, cash, EQUIPMENT, fixedCosts, operatingProfit, STAGES, settleDay, nextDay } from '../src';
import { addBot, moneyFromTxns, newGame, runDay } from './helpers';

describe('経済', () => {
  it('同じキーの現金取引は一度しか適用されない（二重計上防止）', () => {
    const { s } = newGame();
    const m = s.money;
    expect(cash(s, 'sale', 1000, 'x', 'sale:o1:0')).toBe(true);
    expect(cash(s, 'sale', 1000, 'x', 'sale:o1:0')).toBe(false);
    expect(s.money).toBe(m + 1000);
  });

  it('資金不足の任意支出は失敗し、資金はマイナスにならない', () => {
    const { s, ctx } = newGame();
    s.money = 6000;
    const r = applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'trash' }, ctx);
    expect(r.ok).toBe(true);
    const r2 = applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'sink' }, ctx);
    expect(r2.ok).toBe(false);
    expect(s.money).toBe(6000 - EQUIPMENT.trash!.price);
  });

  it('設備購入で資金が価格分だけ減り、損益ではなく投資として記録される', () => {
    const { s, ctx } = newGame();
    const m = s.money;
    applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'locker' }, ctx);
    expect(s.money).toBe(m - EQUIPMENT.locker!.price);
    expect(s.today.capex).toBe(EQUIPMENT.locker!.price);
    expect(operatingProfit(s.today)).toBe(0);
  });

  it('食材の購入は現金だけ減り、使用時に原価になる（二重計上しない）', () => {
    const { s, ctx } = newGame();
    const m = s.money;
    const r = applyAction(s, 'p1', { type: 'orderStock', itemId: 'moyashi', packs: 1, express: false }, ctx);
    expect(r.ok).toBe(true);
    expect(s.money).toBeLessThan(m);
    expect(s.today.cogs).toBe(0);
    expect(operatingProfit(s.today)).toBe(0);
  });

  it('1日の精算: 家賃・給与・維持費が一度ずつ支払われ、取引の合計と資金が一致する', () => {
    const { s, ctx } = newGame(11);
    const start = s.money;
    const bot = addBot(s, 'cook', 0.8, 15_000);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.phase).toBe('closed');
    const rentTx = s.transactions.filter((t) => t.type === 'rent');
    const wageTx = s.transactions.filter((t) => t.type === 'wage');
    expect(rentTx).toHaveLength(1);
    expect(rentTx[0]!.amount).toBe(-STAGES[0]!.rent);
    expect(wageTx).toHaveLength(1);
    expect(wageTx[0]!.amount).toBe(-bot.profile.wage);
    expect(s.money).toBe(start + moneyFromTxns(s));
    const rep = s.history[0]!;
    // 営業利益 = 売上 - 原価 - 廃棄 - 人件費 - 家賃 - ...
    expect(rep.operatingProfit).toBe(rep.sales - rep.refunds - rep.cogs - rep.waste - rep.wages - rep.rent - rep.upkeep - rep.utilities - rep.repairs - rep.hiring - rep.interest);
    expect(rep.wages).toBe(bot.profile.wage);
  });

  it('払えない固定費は未払金になり、期限を過ぎて救済手段もなければ破産する', () => {
    const { s, ctx } = newGame(12);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.arrivalAcc = -1e9;
    s.money = 0;
    // 設備を全部手放した状態（救済手段なし）
    s.equipment = [];
    s.reputation = 1;
    s.phase = 'closing';
    settleDay(s, ctx);
    expect(s.arrears.length).toBeGreaterThan(0);
    expect(s.notices.some((n) => n.code === 'fin:arrears' || n.code === 'fin:overdue')).toBe(true);
    // 猶予日数が過ぎるまで日を進める
    const isBankrupt = () => (s.phase as string) === 'bankrupt';
    for (let i = 0; i < BALANCE.arrearsGraceDays + 2 && !isBankrupt(); i++) {
      const r = nextDay(s, ctx);
      if (isBankrupt()) break;
      expect(r.ok).toBe(true);
      s.phase = 'closing';
      settleDay(s, ctx);
    }
    expect(s.phase).toBe('bankrupt');
    expect(s.bankruptcy).not.toBeNull();
    expect(s.bankruptcy!.debt).toBeGreaterThan(0);
  });

  it('救済手段（設備売却・融資）があるうちは破産せず、次の日に進めずに警告する', () => {
    const { s, ctx } = newGame(13);
    s.money = 0;
    s.arrears.push({ id: 'a1', amount: 50_000, reason: 'テスト', sinceDay: 1, dueDay: 0 });
    s.phase = 'closed';
    const r = nextDay(s, ctx);
    expect(r.ok).toBe(false);
    expect(s.phase).toBe('closed');
    expect(s.bankruptcy).toBeNull();
    // 融資を受けて払えば進める
    expect(applyAction(s, 'p1', { type: 'takeLoan' }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'payArrears' }, ctx).ok).toBe(true);
    expect(s.arrears).toHaveLength(0);
    expect(nextDay(s, ctx).ok).toBe(true);
  });

  it('翌営業日の予測支出が計算できる', () => {
    const { s } = newGame();
    const fc = fixedCosts(s);
    expect(fc.rent).toBe(STAGES[0]!.rent);
    expect(fc.total).toBe(fc.rent + fc.wages + fc.upkeep + fc.utilities + fc.loans);
  });
});
