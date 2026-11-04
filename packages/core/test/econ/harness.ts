// 経済バランスの測定用シミュレーション（統合進化設計書 v2.1 §4.3）。
// 同じ初期条件・同じ乱数の種で、経営のしかたを変えたケースを自動で回し、日ごとの数値を記録する。
// プレイヤーの代わりに「全部の仕事をこなすボット」（給与0）を置く。ゲームの規則には手を入れない。

import {
  applyAction,
  BALANCE,
  EQUIPMENT,
  expansionInfo,
  MENU,
  refreshCandidates,
  SEAT_PRICE,
  STAGES,
  step,
  type DayReport,
  type EmployeeRole,
  type GameState,
  type SimCtx,
} from '../../src';
import { addSoloBot, autoRepair, newGame } from '../helpers';

export interface CasePolicy {
  id: string;
  name: string;
  /** 1日目の朝に1回 */
  setup?: (s: GameState, ctx: SimCtx) => void;
  /** 毎朝（仕込みの前） */
  morning?: (s: GameState, ctx: SimCtx, day: number) => void;
  /** 毎晩（精算のあと、翌日へ進む前） */
  evening?: (s: GameState, ctx: SimCtx, day: number) => void;
}

export interface DayRow {
  day: number;
  stage: number;
  sales: number;
  refunds: number;
  netSales: number;
  cogs: number;
  waste: number;
  wages: number;
  rent: number;
  utilities: number;
  upkeep: number;
  repairs: number;
  hiring: number;
  interest: number;
  /** ゲームの営業利益（利息・採用費を含めて引いたもの。day.ts の operatingProfit） */
  gameOp: number;
  /** 設計書 §4.2 の営業利益（利息を除く） */
  op: number;
  /** 設計書 §4.2 の最終利益（営業利益 − 利息） */
  net: number;
  purchases: number;
  capex: number;
  cashStart: number;
  cashEnd: number;
  cashDelta: number;
  debt: number;
  customers: number;
  served: number;
  lost: number;
  balked: number;
  stockouts: number;
  avgTicket: number;
  seats: number;
  staff: number;
  reputation: number;
  avgWait: number;
  bankrupt: boolean;
  stockoutItems: Record<string, number>;
}

function debtOf(s: GameState): number {
  return s.arrears.reduce((a, b) => a + b.amount, 0) + s.loans.reduce((a, b) => a + b.remaining, 0);
}

function rowOf(s: GameState, r: DayReport): DayRow {
  const netSales = r.sales - r.refunds;
  const op = netSales - r.cogs - r.waste - r.wages - r.rent - r.utilities - r.upkeep - r.repairs - r.hiring;
  return {
    day: r.day,
    stage: s.career.stage,
    sales: r.sales,
    refunds: r.refunds,
    netSales,
    cogs: r.cogs,
    waste: r.waste,
    wages: r.wages,
    rent: r.rent,
    utilities: r.utilities,
    upkeep: r.upkeep,
    repairs: r.repairs,
    hiring: r.hiring,
    interest: r.interest,
    gameOp: r.operatingProfit,
    op,
    net: op - r.interest,
    purchases: r.purchases,
    capex: r.capex,
    cashStart: r.cashStart,
    cashEnd: r.cashEnd,
    cashDelta: r.cashEnd - r.cashStart,
    debt: debtOf(s),
    customers: r.customers,
    served: r.served,
    lost: r.lost,
    balked: r.balked,
    stockouts: r.stockouts,
    avgTicket: r.served > 0 ? Math.round(netSales / r.served) : 0,
    seats: s.seats.filter((x) => x.installed).length,
    staff: s.employees.length - 1,
    reputation: r.reputation,
    avgWait: Math.round(r.avgWait * 10) / 10,
    bankrupt: s.phase === 'bankrupt',
    stockoutItems: { ...(r.stockoutItems ?? {}) },
  };
}

/** 1つのケースを days 日まで回す */
export function runCase(policy: CasePolicy, days: number, seed = 777): { rows: DayRow[]; s: GameState } {
  const { s, ctx } = newGame(seed);
  addSoloBot(s, 0.65);
  policy.setup?.(s, ctx);
  const rows: DayRow[] = [];
  for (let d = 1; d <= days; d++) {
    if ((s.phase as string) === 'bankrupt') break;
    policy.morning?.(s, ctx, d);
    // 開店前の仕込み（最大60秒。プレイヤーが仕込んでから開店するのと同じ）
    for (let i = 0; i < 600 && s.phase === 'prep'; i++) step(s, 0.1, ctx);
    if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let guard = 0;
    while (s.phase !== 'closed' && (s.phase as string) !== 'bankrupt' && guard < 30000) {
      step(s, 0.1, ctx);
      autoRepair(s, ctx);
      guard += 1;
    }
    const r = s.history[s.history.length - 1];
    if (r && r.day === s.day) rows.push(rowOf(s, r));
    policy.evening?.(s, ctx, d);
    let res = applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    if (!res.ok && (s.phase as string) !== 'bankrupt') {
      // 払えないときはプレイヤーと同じく、未払金の支払い → 融資 → 設備の売却
      applyAction(s, 'p1', { type: 'payArrears' }, ctx);
      applyAction(s, 'p1', { type: 'takeLoan' }, ctx);
      applyAction(s, 'p1', { type: 'payArrears' }, ctx);
      res = applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    }
    if (!res.ok && (s.phase as string) !== 'bankrupt') break;
  }
  return { rows, s };
}

// ───────────────── 経営のしかた（設計書 §4.3 の10ケース） ─────────────────

export function hireCheapest(s: GameState, ctx: SimCtx, role?: EmployeeRole): boolean {
  if (!s.career.unlocked.includes('hiring')) return false;
  if (s.candidates.length === 0) refreshCandidates(s);
  const list = s.candidates.filter((c) => !role || c.profile.role === role).sort((a, b) => a.profile.wage - b.profile.wage);
  const c = list[0] ?? s.candidates[0];
  if (!c) return false;
  return applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok;
}

/** 仕込み担当を雇う（候補に仕込み担当がいなければ調理担当を雇って担当を仕込みに変える） */
function hirePrep(s: GameState, ctx: SimCtx): boolean {
  if (!s.career.unlocked.includes('hiring')) return false;
  if (s.candidates.length === 0) refreshCandidates(s);
  const list = s.candidates.filter((c) => c.profile.role === 'prep' || c.profile.role === 'cook').sort((a, b) => a.profile.wage - b.profile.wage);
  const c = list[0];
  if (!c) return false;
  if (!applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok) return false;
  const e = s.employees[s.employees.length - 1]!;
  if (e.profile.role !== 'prep') applyAction(s, 'p1', { type: 'setRole', employeeId: e.id, role: 'prep' }, ctx);
  return true;
}

function setAllPrices(s: GameState, ctx: SimCtx, mult: number): void {
  for (const m of Object.values(MENU)) applyAction(s, 'p1', { type: 'setPrice', menuId: m.id, price: Math.round((m.defaultPrice * mult) / 10) * 10 }, ctx);
}

function scaleAutoOrder(s: GameState, ctx: SimCtx, mult: number): void {
  for (const [itemId, qty] of Object.entries(s.autoOrder)) applyAction(s, 'p1', { type: 'setAutoOrder', itemId, qty: Math.round(qty * mult) }, ctx);
}

/** 拡張できれば拡張し、増えた席を買う（閉店後） */
function tryExpand(s: GameState, ctx: SimCtx, allowLoan: boolean): void {
  const info = expansionInfo(s);
  if (!info.next) return;
  if (!info.canExpand && allowLoan && s.loans.length === 0 && info.reason?.startsWith('資金が足りません') && s.money + BALANCE.loan.amount >= info.cost + info.next.minFundsAfter) {
    applyAction(s, 'p1', { type: 'takeLoan' }, ctx);
  }
  if (expansionInfo(s).canExpand) applyAction(s, 'p1', { type: 'expand' }, ctx);
}

function buySeats(s: GameState, ctx: SimCtx): void {
  const st = STAGES[s.career.stage]!;
  for (const seat of s.seats) {
    if (seat.installed || seat.index >= st.seats.length) continue;
    if (s.money < 40_000) break;
    applyAction(s, 'p1', { type: 'buySeat', seatIndex: seat.index }, ctx);
  }
}

/** 上手なプレイヤーの基本: 自動発注「売れ行きに合わせる」、すべての設備の定期メンテを予約（壊れる前に手入れする） */
export const salesMode = (s: GameState, ctx: SimCtx) => {
  applyAction(s, 'p1', { type: 'setAutoOrderMode', mode: 'sales' }, ctx);
  bookMaintenance(s, ctx);
};

function bookMaintenance(s: GameState, ctx: SimCtx): void {
  for (const e of s.equipment) if (!e.maintenanceBooked && (EQUIPMENT[e.type]?.repairCost ?? 0) > 0) applyAction(s, 'p1', { type: 'maintenance', equipmentId: e.id, on: true }, ctx);
}

function buyPlaced(s: GameState, ctx: SimCtx, type: string, keep: number, upTo = 1): boolean {
  const def = EQUIPMENT[type];
  if (!def || s.money < def.price + keep) return false;
  if (s.equipment.filter((e) => e.type === type).length >= upTo) return false;
  return applyAction(s, 'p1', { type: 'buyEquipment', equipType: type, autoPlace: true }, ctx).ok;
}

/**
 * 上手なプレイヤーの拡張: 工事費＋設備の移設＋増える席＋2台目の冷蔵庫＋運転資金がたまったら拡張し、
 * すぐに席と冷蔵庫をそろえる（12席で1日90杯を超えると、麺・豚肉・もやしが冷蔵庫1台（100kg）に入りきらない）。
 * 2台目の煮込み鍋・野菜ゆで釜は、拡張のあとの利益で買う
 */
/**
 * 雇った人が誰も来ない日（希望シフトの外・採用の2日後まで・休み）は、短期バイトの調理担当を1人呼ぶ
 * （Phase 3-4。オーナーの判断「短期バイトに意義を持たせる」。上手な経営のしかたの一つ）
 */
export function coverWithTemp(s: GameState, ctx: SimCtx): void {
  if (!s.career.unlocked.includes('hiring')) return;
  const working = s.employees.filter((e) => e.profile.name !== 'bot-cook' && !e.profile.temp && e.att?.shift);
  if (working.length === 0) applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx);
}

export function growCarefully(s: GameState, ctx: SimCtx): void {
  const info = expansionInfo(s);
  if (info.next && info.canExpand) {
    const seats = (info.next.seats.length - STAGES[s.career.stage]!.seats.length) * SEAT_PRICE;
    const fridge = s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < 2 ? (EQUIPMENT.fridge?.price ?? 0) : 0;
    if (s.money >= info.cost + info.next.minFundsAfter + seats + fridge) applyAction(s, 'p1', { type: 'expand' }, ctx);
  }
  if (s.career.stage < 1) return;
  const st = STAGES[s.career.stage]!;
  for (const seat of s.seats) {
    if (seat.installed || seat.index >= st.seats.length) continue;
    if (s.money < SEAT_PRICE + 20_000) break;
    applyAction(s, 'p1', { type: 'buySeat', seatIndex: seat.index }, ctx);
  }
  buyPlaced(s, ctx, 'fridge', 20_000, 2);
  buyPlaced(s, ctx, 'braise_pot', 100_000, 2);
  buyPlaced(s, ctx, 'veg_boiler', 100_000, 2);
  bookMaintenance(s, ctx);
}

export const CASES: CasePolicy[] = [
  { id: 'c1_solo', name: '1. 最小限の設備・一人営業' },
  {
    id: 'c2_basic_staff',
    name: '2. 基本的な従業員を1人（調理）',
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  // 価格は毎朝（あとから解放されたメニューも同じ倍率にする）
  { id: 'c3_high_price', name: '3. 高価格（定価の1.3倍）', morning: (s, ctx) => setAllPrices(s, ctx, 1.3) },
  { id: 'c4_low_price', name: '4. 低価格（定価の0.8倍）', morning: (s, ctx) => setAllPrices(s, ctx, 0.8) },
  {
    id: 'c5_more_staff',
    name: '5. 従業員を増やす（調理＋接客の2人）',
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.employees.length < 3) hireCheapest(s, ctx, 'server');
    },
  },
  {
    id: 'c6_overstaff',
    name: '6. 人件費が過剰（5人）',
    morning: (s, ctx) => {
      if (s.employees.length < 6) hireCheapest(s, ctx);
    },
  },
  { id: 'c7_overstock', name: '7. 食材を過剰に仕入れる（自動発注の3倍）', setup: (s, ctx) => scaleAutoOrder(s, ctx, 3) },
  { id: 'c8_understock', name: '8. 仕入れ不足（自動発注の0.4倍・品切れ）', setup: (s, ctx) => scaleAutoOrder(s, ctx, 0.4) },
  {
    id: 'c9_expand',
    name: '9. 資金がたまったら店舗を拡張する',
    evening: (s, ctx) => {
      tryExpand(s, ctx, false);
      buySeats(s, ctx);
    },
  },
  {
    id: 'c10_loan_expand',
    name: '10. 融資を使って早めに拡張する',
    evening: (s, ctx) => {
      tryExpand(s, ctx, true);
      buySeats(s, ctx);
    },
  },
  // ── 投資の効果を測る比較用（仕入れを売れ行きに合わせる、ふつうのプレイヤー） ──
  { id: 'c11_smart_solo', name: '11. 一人営業＋自動発注「売れ行きに合わせる」（投資の比較の基準）', setup: salesMode },
  {
    id: 'c12_smart_cook',
    name: '12. 11＋調理担当を1人',
    setup: salesMode,
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  {
    id: 'c13_smart_sign',
    name: '13. 11＋黄色い大看板（10日目以降、資金に余裕があれば）',
    setup: salesMode,
    evening: (s, ctx, d) => {
      if (d >= 10) buyPlaced(s, ctx, 'sign', 150_000);
    },
  },
  {
    id: 'c14_smart_growth',
    name: '14. 11＋調理担当＋拡張（資金がたまったら）＋拡張後に接客担当',
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.career.stage >= 1 && s.employees.length < 3) hireCheapest(s, ctx, 'server');
    },
    setup: salesMode,
    evening: (s, ctx) => {
      tryExpand(s, ctx, false);
      buySeats(s, ctx);
    },
  },
  // ── 価格の戦略（調理担当がいて杯数を出せる店） ──
  {
    id: 'c15_low_price_cook',
    name: '15. 低価格（0.8倍）＋調理担当＋売れ行きに合わせる（高回転）',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, 0.8);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  {
    id: 'c16_high_price_cook',
    name: '16. 高価格（1.3倍）＋調理担当＋売れ行きに合わせる',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, 1.3);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  {
    id: 'c17_growth_full',
    name: '17. 上手な成長: 調理担当＋余裕をもって拡張＋席・2台目の煮込み鍋・業務用冷蔵庫＋接客担当（従業員が来ない日は短期バイト）',
    setup: salesMode,
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.career.stage >= 1 && s.employees.length < 3) hireCheapest(s, ctx, 'server');
      coverWithTemp(s, ctx);
    },
    evening: (s, ctx) => growCarefully(s, ctx),
  },
  {
    id: 'c18_growth_prep',
    name: '18. 17の接客担当の代わりに、拡張後は仕込み担当を雇う（資金に余裕ができたら接客担当も）',
    setup: salesMode,
    morning: (s, ctx) => {
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.career.stage >= 1 && s.employees.length < 3) hirePrep(s, ctx);
      else if (s.career.stage >= 1 && s.employees.length < 4 && s.money >= 400_000) hireCheapest(s, ctx, 'server');
    },
    evening: (s, ctx) => growCarefully(s, ctx),
  },
  // ── 価格の戦略の比べ方を細かく（調理担当がいる店） ──
  {
    id: 'c19_price090_cook',
    name: '19. やや安い（0.9倍）＋調理担当＋売れ行きに合わせる',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, 0.9);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  {
    id: 'c20_price115_cook',
    name: '20. やや高い（1.15倍）＋調理担当＋売れ行きに合わせる',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, 1.15);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
    },
  },
  // ── 拡張したあとの価格（17 と同じ成長のしかた） ──
  {
    id: 'c21_growth_low',
    name: '21. 17＋拡張したら安く（0.85倍）して客を呼ぶ',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, s.career.stage >= 1 ? 0.85 : 1);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.career.stage >= 1 && s.employees.length < 3) hireCheapest(s, ctx, 'server');
    },
    evening: (s, ctx) => growCarefully(s, ctx),
  },
  {
    id: 'c22_growth_high',
    name: '22. 17＋拡張したら高く（1.2倍）する',
    setup: salesMode,
    morning: (s, ctx) => {
      setAllPrices(s, ctx, s.career.stage >= 1 ? 1.2 : 1);
      if (s.employees.length < 2) hireCheapest(s, ctx, 'cook');
      else if (s.career.stage >= 1 && s.employees.length < 3) hireCheapest(s, ctx, 'server');
    },
    evening: (s, ctx) => growCarefully(s, ctx),
  },
];

// ───────────────── 集計 ─────────────────

export interface Summary {
  id: string;
  name: string;
  days: number;
  at: Record<string, { day: number; cash: number; debt: number; stage: number; staff: number; seats: number; rep: number } | null>;
  /** 期間ごとの1日平均 */
  avg: Record<string, Record<string, number>>;
  bankruptDay: number | null;
  expandDays: number[];
}

const PERIODS: [string, number, number][] = [
  ['d1', 1, 1],
  ['d1_7', 1, 7],
  ['d8_30', 8, 30],
  ['d31_90', 31, 90],
];

export function summarize(policy: CasePolicy, rows: DayRow[]): Summary {
  const avg: Summary['avg'] = {};
  for (const [key, from, to] of PERIODS) {
    const rs = rows.filter((r) => r.day >= from && r.day <= to);
    if (rs.length === 0) continue;
    const mean = (f: (r: DayRow) => number) => Math.round(rs.reduce((a, r) => a + f(r), 0) / rs.length);
    const sales = mean((r) => r.netSales);
    const op = mean((r) => r.op);
    const cogsWaste = rs.reduce((a, r) => a + r.cogs + r.waste, 0);
    avg[key] = {
      days: rs.length,
      netSales: sales,
      cogs: mean((r) => r.cogs),
      waste: mean((r) => r.waste),
      wages: mean((r) => r.wages),
      rent: mean((r) => r.rent),
      utilities: mean((r) => r.utilities),
      upkeep: mean((r) => r.upkeep),
      repairs: mean((r) => r.repairs),
      hiring: mean((r) => r.hiring),
      interest: mean((r) => r.interest),
      op,
      net: mean((r) => r.net),
      marginPct: sales > 0 ? Math.round((op / sales) * 1000) / 10 : 0,
      cashDelta: mean((r) => r.cashDelta),
      customers: mean((r) => r.customers),
      served: mean((r) => r.served),
      lost: mean((r) => r.lost + r.balked),
      avgTicket: mean((r) => r.avgTicket),
      stockoutsPerDay: Math.round((rs.reduce((a, r) => a + r.stockouts, 0) / rs.length) * 10) / 10,
      wastePct: cogsWaste > 0 ? Math.round((rs.reduce((a, r) => a + r.waste, 0) / cogsWaste) * 1000) / 10 : 0,
      servedPerSeat: Math.round((rs.reduce((a, r) => a + r.served / Math.max(1, r.seats), 0) / rs.length) * 10) / 10,
      avgWait: Math.round((rs.reduce((a, r) => a + r.avgWait, 0) / rs.length) * 10) / 10,
    };
  }
  const at: Summary['at'] = {};
  for (const d of [1, 7, 30, 90]) {
    const r = rows.find((x) => x.day === d);
    at[`day${d}`] = r ? { day: d, cash: r.cashEnd, debt: r.debt, stage: r.stage, staff: r.staff, seats: r.seats, rep: r.reputation } : null;
  }
  const bankrupt = rows.find((r) => r.bankrupt);
  const expandDays: number[] = [];
  for (let i = 1; i < rows.length; i++) if (rows[i]!.stage > rows[i - 1]!.stage) expandDays.push(rows[i]!.day);
  return { id: policy.id, name: policy.name, days: rows.length, at, avg, bankruptDay: bankrupt ? bankrupt.day : null, expandDays };
}

export const EXPANSION_COSTS = STAGES.map((st) => ({ id: st.id, name: st.name, construction: st.constructionCost, minFundsAfter: st.minFundsAfter, rent: st.rent, seats: st.seats.length, relocationPerItem: st.relocationPerItem, closureDays: st.closureDays, unlock: st.unlock ?? null }));
export const EQUIPMENT_PRICES = Object.values(EQUIPMENT).map((e) => ({ id: e.id, name: e.name, price: e.price, upkeep: e.upkeep }));
