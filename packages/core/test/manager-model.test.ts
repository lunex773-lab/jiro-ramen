// 店長の営業（1日単位の計算）と細かいシミュレーションの差を確かめる（統合進化設計書 v2.1 Phase 2-4、リスク R5）。
// 同じ店（席・店長と従業員・冷蔵庫・評判・価格）を、細かいシミュレーションで回した平均と、店長の営業で計算した平均を比べる。
import { describe, expect, it } from 'vitest';
import { activeStore, applyAction, EQUIPMENT, nextDay, runManagerDay, STAGES, type DayReport, type GameState, type SimCtx } from '../src';
import { addBot, newGame, runDay } from './helpers';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface Config {
  seed: number;
  stage: number;
  staff: ('cook' | 'server' | 'prep' | 'cleaner')[];
  fridges: number;
}

/** 店長（社員・能力0.65）と従業員の店を作る。プレイヤーは何もしない */
function setup(c: Config): { s: GameState; ctx: SimCtx } {
  const { s, ctx } = newGame(c.seed);
  s.money = 5_000_000;
  s.career.unlocked.push('hiring', 'stage2', 'stage3');
  const mgr = addBot(s, 'cook', 0.65, 7000);
  for (const r of c.staff) addBot(s, r, 0.65, 6000);
  applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: mgr.id }, ctx);
  applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx);
  return { s, ctx };
}

function closeDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 拡張と設備をそろえる（閉店後） */
function grow(s: GameState, ctx: SimCtx, c: Config): void {
  while (s.career.stage < c.stage) {
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    nextDay(s, ctx);
    runDay(s, ctx);
  }
  const st = STAGES[s.career.stage]!;
  for (const seat of s.seats) if (!seat.installed && seat.index < st.seats.length) applyAction(s, 'p1', { type: 'buySeat', seatIndex: seat.index }, ctx);
  while (s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < c.fridges) {
    if (!applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, ctx).ok) break;
  }
  for (const e of s.equipment) if (!e.maintenanceBooked && (EQUIPMENT[e.type]?.repairCost ?? 0) > 0) applyAction(s, 'p1', { type: 'maintenance', equipmentId: e.id, on: true }, ctx);
}

const avg = (rs: DayReport[], f: (r: DayReport) => number) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);

/** 細かいシミュレーションの days 日分と、同じ店（warm 日目の閉店後の状態）からの店長の営業の days 日分 */
export function compare(c: Config, warm = 10, days = 10) {
  const { s, ctx } = setup(c);
  closeDay(s, ctx);
  grow(s, ctx, c);
  for (let d = s.day; d < warm; d++) closeDay(s, ctx);
  const base = clone(s);
  const from = s.day;
  for (let i = 0; i < days; i++) closeDay(s, ctx);
  const detailed = s.history.filter((r) => r.day > from);
  // 同じ状態から、店長の営業で同じ日数を計算する（プレイヤーがいる店のまま式だけ使う）
  const m = base;
  const model: DayReport[] = [];
  for (let d = from + 1; d <= from + days; d++) {
    m.day = d;
    model.push(runManagerDay(m, activeStore(m), d, ctx));
  }
  const sum = (rs: DayReport[]) => ({
    served: avg(rs, (r) => r.served),
    netSales: avg(rs, (r) => r.netSales ?? r.sales - r.refunds),
    op: avg(rs, (r) => r.operatingProfit),
    cogsWaste: avg(rs, (r) => r.cogs + r.waste),
    wages: avg(rs, (r) => r.wages),
    repairs: avg(rs, (r) => r.repairs),
    utilities: avg(rs, (r) => r.utilities),
    rep: rs[rs.length - 1]?.reputation ?? 0,
  });
  return { detailed: sum(detailed), model: sum(model) };
}

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= Math.abs(b) * tol;

describe('店長の営業と細かいシミュレーションの差（Phase 2-4）', () => {
  it.skipIf(!process.env.MODEL_DUMP)('（測定用）差を書き出す', { timeout: 600_000 }, async () => {
    const { writeFileSync } = await import('node:fs');
    const out: unknown[] = [];
    for (const c of [
      { seed: 301, stage: 0, staff: ['cook'], fridges: 1 },
      { seed: 302, stage: 0, staff: ['cook'], fridges: 1 },
      { seed: 303, stage: 1, staff: ['cook', 'server'], fridges: 2 },
      { seed: 304, stage: 1, staff: ['cook', 'server'], fridges: 2 },
      { seed: 305, stage: 0, staff: [], fridges: 1 },
    ] as Config[]) out.push({ c, ...compare(c) });
    writeFileSync(process.env.MODEL_DUMP!, JSON.stringify(out, null, 1));
  });

  it('8席・店長＋調理担当: 提供数・純売上は±15%、営業利益は±30%以内', { timeout: 180_000 }, () => {
    const r = compare({ seed: 301, stage: 0, staff: ['cook'], fridges: 1 });
    expect(near(r.model.served, r.detailed.served, 0.15)).toBe(true);
    expect(near(r.model.netSales, r.detailed.netSales, 0.15)).toBe(true);
    expect(near(r.model.op, r.detailed.op, 0.3)).toBe(true);
  });

  it('12席・店長＋調理＋接客・冷蔵庫2台: 提供数・純売上は±15%、営業利益は±30%以内', { timeout: 180_000 }, () => {
    const r = compare({ seed: 303, stage: 1, staff: ['cook', 'server'], fridges: 2 });
    expect(near(r.model.served, r.detailed.served, 0.15)).toBe(true);
    expect(near(r.model.netSales, r.detailed.netSales, 0.15)).toBe(true);
    expect(near(r.model.op, r.detailed.op, 0.3)).toBe(true);
  });
});
