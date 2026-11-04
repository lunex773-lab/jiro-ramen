import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, cash, EQUIPMENT, fixedCosts, operatingProfit, reportFinalProfit, STAGES, settleDay, nextDay } from '../src';
import { addBot, addSoloBot, moneyFromTxns, newGame, runDay } from './helpers';

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

describe('入力の検証', () => {
  it('自動発注は仕入れできる食材だけ、担当設定は既知の仕事だけ受け付ける', () => {
    const { s, ctx } = newGame();
    expect(applyAction(s, 'p1', { type: 'setAutoOrder', itemId: 'xyz', qty: 1 }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setAutoOrder', itemId: 'yasai', qty: 1 }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setAutoOrder', itemId: '__proto__', qty: 1 }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setAutoOrder', itemId: 'moyashi', qty: 4000 }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'setPrice', menuId: 'toString', price: 1000 }, ctx).ok).toBe(false);
  });
});

describe('日報の会計（統合進化設計書 v2.1 §4.2）', () => {
  it('夜の自動発注や閉店後の買い物もその日の日報に入り、期末の現金が翌日の期首の現金と一致する。日報の増減の合計が実際の資金の増減', () => {
    const { s, ctx } = newGame(31);
    addSoloBot(s);
    const start = s.money;
    for (let d = 1; d <= 4; d++) {
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      // 閉店後に丼を買う（設備投資）
      if (d === 2) expect(applyAction(s, 'p1', { type: 'buyBowls' }, ctx).ok).toBe(true);
      expect(nextDay(s, ctx).ok).toBe(true);
    }
    const reps = s.history;
    for (let i = 1; i < reps.length; i++) expect(reps[i]!.cashStart).toBe(reps[i - 1]!.cashEnd);
    // 夜の自動発注が仕入れとして入っている
    expect(reps.slice(0, 3).some((r) => r.purchases > 0)).toBe(true);
    expect(reps[1]!.capex).toBeGreaterThan(0);
    const sumDelta = reps.reduce((a, r) => a + (r.cashEnd - r.cashStart), 0);
    expect(sumDelta).toBe(reps[reps.length - 1]!.cashEnd - start);
    // 現金の増減 = 純売上 − 現金で払った費用 − 仕入れ − 投資（融資・未払金なし）
    for (const r of reps.slice(0, 3)) {
      const paid = r.wages + r.rent + r.upkeep + r.utilities + r.repairs + r.hiring + r.interest;
      expect(r.cashEnd - r.cashStart).toBe(r.sales - r.refunds - paid - r.purchases - r.capex);
    }
  });

  it('営業利益に利息を含めず、最終利益 = 営業利益 − 利息。古い日報（最終利益がない）は営業利益をそのまま最終利益とみなす', () => {
    const { s, ctx } = newGame(32);
    addSoloBot(s);
    s.reputation = 3;
    expect(applyAction(s, 'p1', { type: 'takeLoan' }, ctx).ok).toBe(true);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    const r = s.history[s.history.length - 1]!;
    expect(r.interest).toBeGreaterThan(0);
    expect(r.operatingProfit).toBe(r.sales - r.refunds - r.cogs - r.waste - r.wages - r.rent - r.upkeep - r.utilities - r.repairs - r.hiring);
    expect(r.finalProfit).toBe(r.operatingProfit - r.interest);
    expect(r.netSales).toBe(r.sales - r.refunds);
    expect(reportFinalProfit({ operatingProfit: -1234 })).toBe(-1234);
  });
});
