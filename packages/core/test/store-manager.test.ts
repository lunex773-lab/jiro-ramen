// 店長の役割（オーナーの指示 2026-11-11）: 営業のサポートに回りつつ、仕込み品が切れそうならすぐ仕込み、材料が閉店までに
// 足りなくなりそうなら当日便で先に仕入れ、閉店後にその日の営業の数字・曜日・翌日の営業時間と定休日から翌日の来客を予測して発注する
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  calendarDemand,
  emptyDayStats,
  forecastNextDay,
  forecastText,
  hoursDemandWeight,
  INGREDIENTS,
  managerExpressCheck,
  managerOrderTarget,
  rawOnHand,
  runAutoOrder,
  shortageBeforeClose,
  stockOf,
  type DayReport,
  type GameState,
  type StoreHours,
} from '../src';
import { activeStore } from '../src/sim/company';
import { addLot } from '../src/sim/inventory';
import { addBot, newGame } from './helpers';

const LUNCH: StoreHours = { sessions: [{ open: 660, close: 900 }], closedDays: [] };
const LUNCH_DINNER: StoreHours = { sessions: [{ open: 660, close: 900 }, { open: 1080, close: 1320 }], closedDays: [] };

/** 店長に発注を任せた店（1日目の閉店後。最近7日に同じような営業をした記録がある） */
function storeWithManager(seed = 31) {
  const { s, ctx } = newGame(seed);
  s.career.unlocked.push('hiring');
  const m = addBot(s, 'cook', 0.7, 7000);
  expect(applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: m.id }, ctx).ok).toBe(true);
  s.money = 1_000_000;
  activeStore(s).hours = LUNCH;
  s.todayHours = LUNCH;
  return { s, ctx, m };
}

/** 曜日・季節の多さに比例した来客の記録（ふつうの日に60人・48杯の店） */
function history(s: GameState, upToDay: number, opts: { hours?: StoreHours } = {}) {
  const w = hoursDemandWeight(opts.hours ?? LUNCH);
  s.history = [];
  for (let d = Math.max(1, upToDay - 9); d <= upToDay; d++) {
    const k = calendarDemand(d) * (w / hoursDemandWeight(LUNCH));
    const served = Math.round(48 * k);
    const r: DayReport = {
      ...emptyDayStats(),
      day: d,
      customers: Math.round(55 * k),
      balked: Math.round(5 * k),
      served,
      usedItems: { noodle: served * 300, moyashi: served * 200, pork_raw: served * 0.11, bones: 5000 * Math.ceil(served / 40) },
      operatingProfit: 0,
      netSales: 0,
      finalProfit: 0,
      cashStart: 0,
      cashEnd: 0,
      reputation: 3,
      reviews: 0,
      avgSatisfaction: 0,
      avgWait: 0,
      demandWeight: w,
    };
    s.history.push(r);
  }
  s.day = upToDay;
}

describe('店長の翌日の予測', () => {
  it('最近の営業の数字を曜日でならし、あすの曜日を掛ける（土曜の前は多め・月曜の前は少なめ）', () => {
    const { s } = storeWithManager();
    // 5日目（金曜）の閉店後 → 6日目（土曜）
    history(s, 5);
    const sat = forecastNextDay(s)!;
    expect(sat.closed).toBe(false);
    expect(sat.day).toBe(6);
    expect(sat.bowls).toBeCloseTo(48 * calendarDemand(6), -1);
    // 7日目（日曜）の閉店後 → 8日目（月曜）
    history(s, 7);
    const mon = forecastNextDay(s)!;
    expect(mon.bowls).toBeLessThan(sat.bowls);
    expect(mon.customers).toBeCloseTo(60 * calendarDemand(8), -1);
    expect(forecastText(mon)).toContain('来客 約');
  });

  it('あすの営業時間が長くなれば、その時間の客の多さの分だけ多く見込む（昼だけ → 昼と夜）', () => {
    const { s } = storeWithManager();
    history(s, 5);
    const before = forecastNextDay(s)!;
    activeStore(s).hours = LUNCH_DINNER;
    const after = forecastNextDay(s)!;
    expect(after.bowls / before.bowls).toBeCloseTo(hoursDemandWeight(LUNCH_DINNER) / hoursDemandWeight(LUNCH), 1);
  });

  it('あすが定休日なら翌朝便を頼まず、定休日の夜に次の営業日の分を頼む', () => {
    const { s, ctx } = storeWithManager();
    history(s, 5);
    activeStore(s).hours = { ...LUNCH, closedDays: [5] }; // 土曜休み
    const f = forecastNextDay(s)!;
    expect(f.closed).toBe(true);
    expect(forecastText(f)).toContain('定休日');
    s.inventory = [];
    const before = s.money;
    runAutoOrder(s, ctx);
    expect(s.money).toBe(before);
    expect(s.today.managerOrder?.forecast?.closed).toBe(true);
    // 土曜（定休日）の夜 → 日曜の分を頼む
    s.day = 6;
    const sun = forecastNextDay(s)!;
    expect(sun.closed).toBe(false);
    runAutoOrder(s, ctx);
    expect(s.money).toBeLessThan(before);
  });

  it('発注の目安は予測の杯数 × 1杯あたりの使用量 × 余裕。目安0（発注しない）の食材は頼まない', () => {
    const { s } = storeWithManager();
    history(s, 5);
    const f = forecastNextDay(s)!;
    const noodle = managerOrderTarget(s, 'noodle', f);
    expect(noodle).toBeCloseTo(300 * f.bowls * 1.35, -2);
    s.autoOrder.noodle = 0;
    expect(managerOrderTarget(s, 'noodle', f)).toBe(0);
  });
});

describe('店長の当日便', () => {
  function openWithLowMoyashi() {
    const { s, ctx, m } = storeWithManager(32);
    history(s, 5);
    s.day = 6;
    s.phase = 'open';
    s.openT = 0.3 * 240 * 2.25;
    s.t = s.openT + 100;
    m.presentToday = true;
    m.commute = null;
    s.inventory = s.inventory.filter((l) => l.itemId !== 'moyashi' && l.itemId !== 'yasai');
    addLot(s, 'moyashi', 1000, 0.12);
    s.today.usedItems = { moyashi: 3000 };
    return { s, ctx, m };
  }

  it('閉店までに足りなくなりそうな材料（もやし）を、当日便で先に仕入れる（3割高）', () => {
    const { s, ctx } = openWithLowMoyashi();
    expect(shortageBeforeClose(s, 'moyashi')).toBeGreaterThan(0);
    const before = s.money;
    managerExpressCheck(s, 10, ctx);
    const x = s.today.managerExpress!;
    expect(x.items.moyashi).toBeGreaterThan(0);
    expect(before - s.money).toBe(x.spent);
    expect(s.deliveries.some((d) => d.itemId === 'moyashi' && d.arriveAt !== null)).toBe(true);
    // 届く予定の分を数えるので、続けて頼みすぎない
    expect(shortageBeforeClose(s, 'moyashi')).toBe(0);
    managerExpressCheck(s, 10, ctx);
    expect(s.today.managerExpress!.items.moyashi).toBe(x.items.moyashi);
    expect(s.notices.some((n) => n.code === 'mgrExpress:moyashi')).toBe(true);
    void INGREDIENTS;
  });

  it('ゆでたヤサイが十分にあれば、もやしが少なくても頼まない（仕込んだ分も材料として数える）', () => {
    const { s, ctx } = openWithLowMoyashi();
    addLot(s, 'yasai', 20_000, 0.1);
    expect(rawOnHand(s, 'moyashi')).toBeGreaterThan(20_000);
    managerExpressCheck(s, 10, ctx);
    expect(s.today.managerExpress).toBeUndefined();
  });

  it('「自分の設定で」にした店・店長が休憩中の店では、店長は当日便を頼まない', () => {
    const a = openWithLowMoyashi();
    activeStore(a.s).policy.orderBy = 'self';
    managerExpressCheck(a.s, 10, a.ctx);
    expect(a.s.today.managerExpress).toBeUndefined();
    const b = openWithLowMoyashi();
    b.m.presentToday = false;
    managerExpressCheck(b.s, 10, b.ctx);
    expect(b.s.today.managerExpress).toBeUndefined();
    expect(stockOf(b.s, 'moyashi')).toBe(1000);
  });
});
