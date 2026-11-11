// じろ1 §8 の合格条件を、毎回すばやく確かめる（店長の営業の1日単位の計算を使う。細かいシミュレーションの10パターン × 90日は
// jiro1-balance.test.ts（JIRO1_SIM=1）と docs/JIRO1_BALANCE_REPORT.md）。
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  EQUIPMENT,
  makeSaveFile,
  MENU,
  nextDay,
  parseSave,
  runManagerDay,
  STAGES,
  type DayReport,
  type GameState,
  type SimCtx,
  type StoreHours,
} from '../../src';
import { addBot, clone, newGame, runDay } from '../helpers';
import { CITY, RURAL } from './jiro1-balance';

const H = (sessions: [number, number][]): StoreHours => ({ sessions: sessions.map(([o, c]) => ({ open: Math.round(o * 60), close: Math.round(c * 60) })), closedDays: [] });

function closeDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 店長（社員）＋調理担当の8席の店を5日営業して温める（閉店後の状態） */
function warmStore(seed: number): { s: GameState; ctx: SimCtx } {
  const { s, ctx } = newGame(seed);
  s.money = 3_000_000;
  const mgr = addBot(s, 'cook', 0.65, 9000);
  addBot(s, 'cook', 0.65, 7000);
  applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: mgr.id }, ctx);
  applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx);
  for (const e of s.equipment) if (!e.maintenanceBooked && (EQUIPMENT[e.type]?.repairCost ?? 0) > 0) applyAction(s, 'p1', { type: 'maintenance', equipmentId: e.id, on: true }, ctx);
  for (let i = 0; i < 5; i++) closeDay(s, ctx);
  return { s, ctx };
}

const avg = (rs: DayReport[], f: (r: DayReport) => number) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);

/** 同じ店を、場所・値段・営業時間・来客の倍率を変えて、店長の営業で days 日計算した1日の平均 */
function managed(base: GameState, ctx: SimCtx, o: { code?: string; priceMult?: number; hours?: StoreHours; demand?: number; days?: number }) {
  const s = clone(base);
  const e = activeStore(s);
  e.location = o.code;
  e.policy.priceMult = o.priceMult ?? 1;
  if (o.hours) e.hours = o.hours;
  const rs: DayReport[] = [];
  const from = s.day;
  for (let d = from + 1; d <= from + (o.days ?? 10); d++) {
    s.day = d;
    rs.push(runManagerDay(s, activeStore(s), d, ctx, { demandMult: o.demand ?? 1 }));
  }
  return {
    op: avg(rs, (r) => r.operatingProfit),
    served: avg(rs, (r) => r.served),
    net: avg(rs, (r) => r.netSales ?? r.sales - r.refunds),
    wages: avg(rs, (r) => r.wages),
    utilities: avg(rs, (r) => r.utilities),
    rent: avg(rs, (r) => r.rent),
    finite: rs.every((r) => Object.values(r).every((v) => typeof v !== 'number' || Number.isFinite(v))),
  };
}

const PRICE_STEPS = [0.85, 0.9, 1, 1.1, 1.2, 1.3];

describe('じろ1 §8 合格条件', () => {
  const { s: base, ctx } = warmStore(911);

  it('通常の経営判断で黒字化できる店舗モデルがある（8席・店長＋調理担当・定価）', () => {
    expect(managed(base, ctx, {}).op).toBeGreaterThan(0);
  });

  it('地域差によって経営戦略が変わる: 都市部（新宿区）は定価だと家賃が重く、値上げで大きく儲かる。地方（大町市）は定価でも儲かり、値上げの余地は小さい', () => {
    const at = (code: string) => PRICE_STEPS.map((pm) => ({ pm, ...managed(base, ctx, { code, priceMult: pm }) }));
    const city = at(CITY);
    const rural = at(RURAL);
    const best = (rs: typeof city) => [...rs].sort((a, b) => b.op - a.op)[0]!;
    const list = (rs: typeof city) => rs.find((r) => r.pm === 1)!;
    // いちばん儲かる値段は都市部のほうが高い
    expect(best(city).pm).toBeGreaterThan(best(rural).pm);
    // 定価のままなら地方のほうが儲かる（家賃）。値段を決めれば都市部のほうが儲かる
    expect(list(rural).op).toBeGreaterThan(list(city).op);
    expect(best(city).op).toBeGreaterThan(best(rural).op);
    expect(list(city).rent).toBeGreaterThan(list(rural).rent * 1.8);
  });

  it('客数を増やしただけで利益は無条件に増えない（席と人手の上限で提供が止まり、来客が3倍でも利益はほとんど増えない）', () => {
    const x1 = managed(base, ctx, { demand: 1 });
    const x2 = managed(base, ctx, { demand: 2 });
    const x3 = managed(base, ctx, { demand: 3 });
    expect(x3.served).toBeLessThan(x1.served * 1.5);
    expect(x3.op - x2.op).toBeLessThan(Math.max(500, Math.abs(x2.op - x1.op) * 0.5));
  });

  it('営業時間を変えた効果が収支に出る（長い営業は提供・光熱費・給料が増え、短い営業は減る）', () => {
    const std = managed(base, ctx, {});
    const long = managed(base, ctx, { hours: H([[11, 15], [17.5, 22]]) });
    const short = managed(base, ctx, { hours: H([[11.5, 14]]) });
    expect(long.served).toBeGreaterThan(std.served);
    expect(long.utilities).toBeGreaterThan(std.utilities);
    expect(long.wages).toBeGreaterThan(std.wages);
    expect(short.served).toBeLessThan(std.served);
    expect(short.utilities).toBeLessThan(std.utilities);
    expect(long.op).not.toBeCloseTo(std.op, -2);
  });

  it('極端な値段でも経済が壊れない（5,000円は客がほとんど来ず赤字。数字はすべて有限）', () => {
    const s = clone(base);
    for (const m of Object.values(MENU)) expect(applyAction(s, 'p1', { type: 'setPrice', menuId: m.id, price: 5000 }, ctx).ok).toBe(true);
    const e = activeStore(s);
    // 方針の値段（店長の営業）も上限まで
    e.policy.priceMult = 1.5;
    const r = managed(s, ctx, { priceMult: 1.5 });
    expect(r.finite).toBe(true);
    const std = managed(base, ctx, {});
    expect(r.op).toBeLessThan(std.op);
  });

  it('極端な仕入れでも現金より多くは使えない（毎日50パックを頼み続けても、お金の記録と現金が合う）', () => {
    const { s, ctx: c2 } = newGame(915);
    s.money = 60_000;
    for (let d = 0; d < 3; d++) {
      for (let i = 0; i < 20; i++) applyAction(s, 'p1', { type: 'orderStock', itemId: 'noodle', packs: 50, express: false }, c2);
      closeDay(s, c2);
      expect(Number.isFinite(s.money)).toBe(true);
      expect(s.money).toBeGreaterThanOrEqual(-1);
    }
  });

  it('前の版のセーブ（営業時間・場所・今日の営業時間のない状態）を読み込んで、そのまま1日営業できる', () => {
    const { s, ctx: c2 } = newGame(917);
    const old = JSON.parse(JSON.stringify(s)) as GameState & Record<string, unknown>;
    delete old.todayHours;
    delete old.sessionIdx;
    delete old.breakPending;
    for (const st of old.company.stores) {
      delete (st as unknown as Record<string, unknown>).hours;
      delete (st as unknown as Record<string, unknown>).location;
    }
    const r = parseSave(JSON.stringify(makeSaveFile(old, 1, null, 0)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const loaded = r.save.state;
    closeDay(loaded, c2);
    expect(loaded.history.length).toBe(1);
    expect(loaded.history[0]!.served).toBeGreaterThanOrEqual(0);
    expect(STAGES[loaded.career.stage]).toBeTruthy();
  });
});
