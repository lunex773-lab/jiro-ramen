// じろ1 §8「経済バランス検証（必須）」の10パターン（docs/JIRO1_PLAN.md 6章 P5）。
// 細かいシミュレーション（0.1 秒刻み）で 90 日まで回し、1・7・30・90 日の収支を項目に分けて記録する。
// 店主は「全部の仕事をこなすボット」。慣れていない人に近い遅さ（能力 0.4）と、上手な人（0.65）で比べる。ゲームの規則には手を入れない。

import { activeStore, applyAction, BALANCE, EQUIPMENT, fillNewStore, marketHourly, minWageOf, refreshCandidates, type GameState, type SimCtx, type StoreHours } from '../../src';
import { addBot } from '../helpers';
import { buyPlaced, coverWithTemp, hireCheapest, runCase, salesMode, setAllPrices, type CasePolicy, type DayRow } from './harness';

/** 都市部: 東京都 新宿区（人口密度 約1.6万人/km²）、地方: 長野県 大町市（約45人/km²） */
export const CITY = '13104';
export const RURAL = '20212';

const H = (sessions: [number, number][]): StoreHours => ({ sessions: sessions.map(([o, c]) => ({ open: Math.round(o * 60), close: Math.round(c * 60) })), closedDays: [] });

const place = (code: string) => (s: GameState) => {
  activeStore(s).location = code;
};

/** 12席の店（最初から広い物件で始める。冷蔵庫は2台） */
const big = (code?: string) => (s: GameState) => {
  fillNewStore(s, 1);
  if (code) activeStore(s).location = code;
};

function secondFridge(s: GameState, ctx: SimCtx): void {
  if (s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < 2) applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, ctx);
}

/** 黒字になる前でもすぐ雇う（採用は1日目からできる）。いちばん安い候補 */
function hireNow(s: GameState, ctx: SimCtx, role: 'cook' | 'server'): void {
  if (s.candidates.length === 0) refreshCandidates(s);
  const c = [...s.candidates].filter((x) => x.profile.role === role).sort((a, b) => a.profile.wage - b.profile.wage)[0] ?? s.candidates[0];
  if (c) applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx);
}

/** 初めて黒字になったら調理担当を1人雇う（ふつうのプレイヤー） */
const hireCookAfterProfit = (s: GameState, ctx: SimCtx) => {
  if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
  coverWithTemp(s, ctx);
};

/** 12席: 調理担当と接客担当（黒字のあと） */
const hireTwoAfterProfit = (s: GameState, ctx: SimCtx) => {
  if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
  else if (s.employees.length < 3) hireCheapest(s, ctx, 'server');
  coverWithTemp(s, ctx);
};

/** 店の場所の相場の給料で、すぐ働く従業員（社員）を置く（従業員中心の店。日給 = 時給 × 4.5時間 × 1.15） */
function staffNow(s: GameState, role: 'cook' | 'server', skill: number) {
  const hourly = marketHourly(minWageOf(activeStore(s).location), role, skill, 0, 0.5);
  const daily = Math.round((hourly * BALANCE.staff.employment.fullShiftHours * 1.15) / 10) * 10;
  const e = addBot(s, role, skill, daily);
  // 遅刻・欠勤もある（ふつうの人。ボットの既定は勤怠が最大）
  e.profile.diligence = 0.7;
  e.profile.patience = 0.7;
  return e;
}

export interface Pattern {
  id: string;
  name: string;
  policy: CasePolicy;
  /** 店主の能力（働かない店は null） */
  skill: number | null;
}

/** じろ1 §8 の10パターン（＋上手な人の比較 2 つ） */
export const PATTERNS: Pattern[] = [
  {
    id: 'p1_city_small',
    name: '1. 都市部の小規模店舗（新宿区・8席・店主＋黒字のあと調理担当）',
    skill: 0.4,
    policy: { id: 'p1', name: '', init: place(CITY), setup: salesMode, morning: hireCookAfterProfit },
  },
  {
    id: 'p2_city_large',
    name: '2. 都市部の大型店舗（新宿区・12席・店主＋黒字のあと調理と接客）',
    skill: 0.4,
    policy: { id: 'p2', name: '', init: big(CITY), setup: (s, ctx) => (salesMode(s, ctx), secondFridge(s, ctx)), morning: hireTwoAfterProfit },
  },
  {
    id: 'p2h_city_large_hire',
    name: '2h. 都市部の大型店舗で、最初から調理と接客を雇う（新宿区・12席・1日目に採用。2の比べ）',
    skill: 0.4,
    policy: {
      id: 'p2h',
      name: '',
      init: big(CITY),
      setup: (s, ctx) => (salesMode(s, ctx), secondFridge(s, ctx)),
      morning: (s, ctx) => {
        // 採用は1日目からできる（オーナーの判断 2026-11-05）。店主のボットも s.employees にいるので、2人目が調理・3人目が接客
        if (s.employees.length < 2) hireNow(s, ctx, 'cook');
        else if (s.employees.length < 3) hireNow(s, ctx, 'server');
        coverWithTemp(s, ctx);
      },
    },
  },
  {
    id: 'p3_rural_small',
    name: '3. 地方の小規模店舗（大町市・8席・店主＋黒字のあと調理担当）',
    skill: 0.4,
    policy: { id: 'p3', name: '', init: place(RURAL), setup: salesMode, morning: hireCookAfterProfit },
  },
  {
    id: 'p4_rural_large',
    name: '4. 地方の大型店舗（大町市・12席・店主＋黒字のあと調理と接客）',
    skill: 0.4,
    policy: { id: 'p4', name: '', init: big(RURAL), setup: (s, ctx) => (salesMode(s, ctx), secondFridge(s, ctx)), morning: hireTwoAfterProfit },
  },
  {
    id: 'p5_short_hours',
    name: '5. 営業時間が短い店舗（11:30〜14:00 の2時間半・8席・店主一人）',
    skill: 0.4,
    policy: {
      id: 'p5',
      name: '',
      setup: (s, ctx) => {
        salesMode(s, ctx);
        applyAction(s, 'p1', { type: 'setStoreHours', storeId: activeStore(s).id, hours: H([[11.5, 14]]) }, ctx);
      },
    },
  },
  {
    id: 'p6_long_hours',
    name: '6. 長時間営業店舗（11〜15時と17:30〜22時の8時間半・8席・店主＋黒字のあと調理担当）',
    skill: 0.4,
    policy: {
      id: 'p6',
      name: '',
      setup: (s, ctx) => {
        salesMode(s, ctx);
        applyAction(s, 'p1', { type: 'setStoreHours', storeId: activeStore(s).id, hours: H([[11, 15], [17.5, 22]]) }, ctx);
      },
      morning: hireCookAfterProfit,
    },
  },
  {
    id: 'p7_high_price',
    name: '7. 高価格帯店舗（定価の1.3倍・8席・店主＋黒字のあと調理担当）',
    skill: 0.4,
    policy: { id: 'p7', name: '', setup: salesMode, morning: (s, ctx) => (setAllPrices(s, ctx, 1.3), hireCookAfterProfit(s, ctx)) },
  },
  {
    id: 'p8_low_price',
    name: '8. 低価格帯店舗（定価の0.85倍・8席・店主＋黒字のあと調理担当）',
    skill: 0.4,
    policy: { id: 'p8', name: '', setup: salesMode, morning: (s, ctx) => (setAllPrices(s, ctx, 0.85), hireCookAfterProfit(s, ctx)) },
  },
  {
    id: 'p9_staff_store',
    name: '9. 従業員中心の店舗（店主は働かない。店長（調理）＋調理＋接客の社員3人・8席）',
    skill: null,
    policy: {
      id: 'p9',
      name: '',
      setup: (s, ctx) => {
        salesMode(s, ctx);
        // 調理担当の1人を店長（社員）にする。店長は担当に関係なく店の仕事を何でもする
        const mgr = staffNow(s, 'cook', 0.55);
        staffNow(s, 'cook', 0.5);
        staffNow(s, 'server', 0.5);
        applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: mgr.id }, ctx);
      },
    },
  },
  {
    id: 'p10_owner_works',
    name: '10. プレイヤーが自ら働く店舗（店主一人・8席・雇わない）',
    skill: 0.4,
    policy: { id: 'p10', name: '', setup: salesMode },
  },
  // 上手な人（能力0.65）の比較: 難易度を保つ（上手な人の利益は今と同じくらい。じろ1 Q7）
  {
    id: 'p10s_owner_skilled',
    name: '10s. 上手な店主が一人で働く（能力0.65・8席・雇わない）',
    skill: 0.65,
    policy: { id: 'p10s', name: '', setup: salesMode },
  },
  {
    id: 'p1s_city_small_skilled',
    name: '1s. 上手な店主の都市部の小規模店舗（新宿区・能力0.65）',
    skill: 0.65,
    policy: { id: 'p1s', name: '', init: place(CITY), setup: salesMode, morning: hireCookAfterProfit },
  },
];

/** 項目（じろ1 §8 の最低限の項目） */
export interface Totals {
  days: number;
  sales: number;
  refunds: number;
  netSales: number;
  cogs: number;
  waste: number;
  wages: number;
  rent: number;
  utilities: number;
  upkeep: number;
  /** その他経費（修理費・採用費・広告費） */
  other: number;
  operatingProfit: number;
  interest: number;
  finalProfit: number;
  cash: number;
  debt: number;
  served: number;
  customers: number;
}

/** 1日目から n 日目までの合計（現金・負債は n 日目の終わり） */
export function totalsUpTo(rows: DayRow[], n: number): Totals | null {
  const rs = rows.filter((r) => r.day <= n);
  if (rs.length === 0) return null;
  const sum = (f: (r: DayRow) => number) => rs.reduce((a, r) => a + f(r), 0);
  const last = rs[rs.length - 1]!;
  const op = sum((r) => r.gameOp);
  const fixed = sum((r) => r.cogs + r.waste + r.wages + r.rent + r.utilities + r.upkeep);
  return {
    days: rs.length,
    sales: sum((r) => r.sales),
    refunds: sum((r) => r.refunds),
    netSales: sum((r) => r.netSales),
    cogs: sum((r) => r.cogs),
    waste: sum((r) => r.waste),
    wages: sum((r) => r.wages),
    rent: sum((r) => r.rent),
    utilities: sum((r) => r.utilities),
    upkeep: sum((r) => r.upkeep),
    other: sum((r) => r.netSales) - fixed - op,
    operatingProfit: op,
    interest: sum((r) => r.interest),
    finalProfit: op - sum((r) => r.interest),
    cash: last.cashEnd,
    debt: last.debt,
    served: sum((r) => r.served),
    customers: sum((r) => r.customers),
  };
}

/** 初めて「その日までの7日の営業利益の合計」が黒字になった日（なければ null） */
export function firstProfitableWeek(rows: DayRow[]): number | null {
  for (let i = 6; i < rows.length; i++) {
    const w = rows.slice(i - 6, i + 1).reduce((a, r) => a + r.gameOp, 0);
    if (w > 0) return rows[i]!.day;
  }
  return null;
}

export function runPattern(p: Pattern, days: number, seed: number) {
  const { rows, s } = runCase(p.policy, days, seed, p.skill === null ? { owner: false } : { skill: p.skill });
  return { rows, s };
}
