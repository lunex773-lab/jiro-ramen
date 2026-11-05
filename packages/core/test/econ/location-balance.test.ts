// 出店の場所（市区町村の人口）の釣り合い（docs/STORE_MAP_PLAN.md 4章。オーナーの判断「人口で少し変わる・どこでも利益の見込みは同じくらい」）。
// 店長の営業の計算（1日単位）で、同じ店を人口 約1万人・約10万人・約100万人の市区町村に置いたときの1日の営業利益を比べる。
import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  BALANCE,
  EQUIPMENT,
  locationInfo,
  MUNICIPALITIES,
  nextDay,
  PROPERTIES,
  runManagerDay,
  STAGES,
  storeRentMult,
  type DayReport,
  type GameState,
  type SimCtx,
} from '../../src';
import { addBot, clone, newGame, runDay } from '../helpers';

/** 人口が target にいちばん近い市区町村 */
function codeNear(target: number): string {
  let best = '';
  let d = Infinity;
  for (const [code, [, , pop]] of Object.entries(MUNICIPALITIES)) {
    const x = Math.abs(Math.log10(Math.max(1, pop)) - Math.log10(target));
    if (pop > 0 && x < d) {
      d = x;
      best = code;
    }
  }
  return best;
}

interface Case {
  propertyId: string;
  stage: number;
  staff: ('cook' | 'server')[];
}

function closeDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 店長と従業員の店を作り、10日営業して温める（閉店後の状態） */
function warm(seed: number, c: Case): { s: GameState; ctx: SimCtx } {
  const { s, ctx } = newGame(seed);
  s.money = 5_000_000;
  s.career.unlocked.push('stage2', 'stage3');
  const mgr = addBot(s, 'cook', 0.65, 7000);
  for (const r of c.staff) addBot(s, r, 0.65, 6000);
  applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: mgr.id }, ctx);
  applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx);
  closeDay(s, ctx);
  while (s.career.stage < c.stage) {
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    nextDay(s, ctx);
    runDay(s, ctx);
  }
  const st = STAGES[s.career.stage]!;
  for (const seat of s.seats) if (!seat.installed && seat.index < st.seats.length) applyAction(s, 'p1', { type: 'buySeat', seatIndex: seat.index }, ctx);
  if (c.stage > 0 && s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < 2) applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, ctx);
  for (let d = s.day; d < 10; d++) closeDay(s, ctx);
  activeStore(s).propertyId = c.propertyId;
  return { s, ctx };
}

const avg = (rs: DayReport[], f: (r: DayReport) => number) => rs.reduce((a, r) => a + f(r), 0) / Math.max(1, rs.length);

const PRICE_STEPS = [0.9, 1, 1.1, 1.2, 1.3];

/** その場所で、値段（定価の倍率）を変えて店長の営業を計算し、いちばん利益の出る値段の結果（上手な経営の見込み） */
function runAt(base: GameState, ctx: SimCtx, code: string | undefined, days = 20) {
  let best: ReturnType<typeof runAtPrice> | null = null;
  for (const pm of PRICE_STEPS) {
    const r = runAtPrice(base, ctx, code, pm, days);
    if (!best || r.op > best.op) best = r;
  }
  return best!;
}

function runAtPrice(base: GameState, ctx: SimCtx, code: string | undefined, priceMult: number, days: number) {
  const s = clone(base);
  activeStore(s).location = code;
  activeStore(s).policy.priceMult = priceMult;
  const from = s.day;
  const rs: DayReport[] = [];
  for (let d = from + 1; d <= from + days; d++) {
    s.day = d;
    rs.push(runManagerDay(s, activeStore(s), d, ctx));
  }
  return { op: avg(rs, (r) => r.operatingProfit), net: avg(rs, (r) => r.netSales ?? r.sales - r.refunds), rent: avg(rs, (r) => r.rent), served: avg(rs, (r) => r.served), priceMult };
}

const CASES: Case[] = [
  { propertyId: 'home', stage: 0, staff: [] },
  { propertyId: 'home', stage: 0, staff: ['cook'] },
  { propertyId: 'station', stage: 0, staff: ['cook'] },
  { propertyId: 'residential', stage: 0, staff: [] },
  { propertyId: 'roadside', stage: 1, staff: ['cook', 'server'] },
];
const SEEDS = [401, 402, 403];

function measure() {
  const small = codeNear(10_000);
  const mid = codeNear(100_000);
  const big = codeNear(1_000_000);
  const rows: { case: string; z: number; op: number; net: number; rent: number; served: number; priceMult: number }[] = [];
  for (const c of CASES) {
    for (const seed of SEEDS) {
      const { s, ctx } = warm(seed, c);
      for (const code of [small, mid, big]) {
        const r = runAt(s, ctx, code);
        rows.push({ case: `${c.propertyId}/${c.stage}/${c.staff.join('+') || '—'}`, z: locationInfo(code)!.index, ...r });
      }
    }
  }
  return { small, mid, big, rows };
}

describe('出店の場所の釣り合い（人口で少し変わる）', () => {
  it.skipIf(!process.env.LOCATION_DUMP)('（測定用）人口ごとの営業利益と、利益を同じにする家賃の幅を書き出す', { timeout: 900_000 }, async () => {
    const { writeFileSync } = await import('node:fs');
    const m = measure();
    // 家賃の幅: 来客の差で増えた（減った）利益を、家賃で打ち消す幅（z = ±1 の平均）
    const byCase = new Map<string, { z: number; op: number; rent: number }[]>();
    for (const r of m.rows) {
      if (!byCase.has(r.case)) byCase.set(r.case, []);
      byCase.get(r.case)!.push(r);
    }
    const spans: Record<string, number> = {};
    for (const [k, rs] of byCase) {
      const at = (z: number) => rs.filter((r) => Math.abs(r.z - z) < 0.2);
      const mean = (xs: { op: number }[]) => xs.reduce((a, x) => a + x.op, 0) / Math.max(1, xs.length);
      const rent0 = at(0).reduce((a, x) => a + x.rent, 0) / Math.max(1, at(0).length);
      const dUp = mean(at(1)) - mean(at(0));
      const dDown = mean(at(0)) - mean(at(-1));
      spans[k] = rent0 > 0 ? (dUp + dDown) / 2 / rent0 : 0;
    }
    writeFileSync(process.env.LOCATION_DUMP!, JSON.stringify({ codes: { small: m.small, mid: m.mid, big: m.big }, balance: BALANCE.location, spans, rows: m.rows }, null, 1));
  });

  it('人口のいちばん多い・少ない市区町村でも、1日の営業利益の見込みは標準（10万人）から大きく変わらない', { timeout: 900_000 }, () => {
    const m = measure();
    const byCase = new Map<string, { z: number; op: number }[]>();
    for (const r of m.rows) {
      if (!byCase.has(r.case)) byCase.set(r.case, []);
      byCase.get(r.case)!.push(r);
    }
    for (const [k, rs] of byCase) {
      const mean = (z: number) => {
        const xs = rs.filter((r) => Math.abs(r.z - z) < 0.2);
        return xs.reduce((a, x) => a + x.op, 0) / Math.max(1, xs.length);
      };
      const base = mean(0);
      for (const z of [-1, 1]) {
        // 利益の差は、標準の店の1日の家賃の半分まで（または営業利益の15%まで）
        const tol = Math.max(Math.abs(base) * 0.15, STAGES[0]!.rent * 0.5);
        expect(Math.abs(mean(z) - base), `${k} z=${z}: ${Math.round(mean(z))} vs ${Math.round(base)}`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('家賃と来客の倍率は人口指数に比例し、場所のない店は今までと同じ', () => {
    const big = locationInfo(codeNear(2_000_000))!;
    const small = locationInfo(codeNear(3_000))!;
    expect(big.index).toBe(1);
    expect(small.index).toBe(-1);
    expect(big.demand).toBeCloseTo(1 + BALANCE.location.demandSpan, 6);
    expect(small.rent).toBeCloseTo(1 - BALANCE.location.rentSpan, 6);
    const { s } = newGame(1);
    const e = activeStore(s);
    expect(storeRentMult(e)).toBe(PROPERTIES.home!.rentMult);
  });
});
