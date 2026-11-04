// オンライン市場（統合進化設計書 v2.1 Phase 3+4）。
// 1つの市場の中で、プレイヤー企業と AI 企業（合わせて最大6社）が同じ街で客を取り合う。
// 各企業は GameState（会社と店舗）をそのまま使い、すべての店を「店長の営業」（1日単位の計算。店主が回す本店を含む）で進める。
// 市場がするのは、同じ地域の店どうしの客の取り合い・市場の日の進行・市場シェア・AI 企業の意思決定・物件の取り合い。
// 乱数は各企業の状態の中の種だけを使う（同じ種と同じ操作の列なら同じ結果）。市場の権威はサーバー（apps/server の MarketRoom）。

import { BALANCE } from './data/balance';
import { EQUIPMENT, SEAT_PRICE } from './data/equipment';
import { AI_COMPANIES, MARKET_BRANCH_AREA_NAMES, MARKET_HOME_AREAS, type AiStrategy } from './data/market';
import { PROPERTIES, PROPERTY_CANDIDATES } from './data/properties';
import { STAGES } from './data/stages';
import { createGame } from './state';
import type { GameState, Id, StoreEntry } from './types';
import { hashString } from './util';
import { applyAction, type Action, type ActionResult } from './sim/actions';
import { recordCompanyDay, withStore } from './sim/company';
import { bankruptcyCheck, checkGoals, declareBankruptcy, loanAvailable, payArrears, takeLoan } from './sim/day';
import { cash } from './sim/economy';
import { refreshCandidates } from './sim/employees';
import { expansionInfo } from './sim/layout';
import { planManagerDay, runManagerDay, standaloneArrivals } from './sim/manager';
import { makeCtx } from './sim/notices';
import { openStoreProblem, storeStatus } from './sim/stores';

export const MARKET_SCHEMA = 1;

export interface MarketCompany {
  id: Id;
  name: string;
  kind: 'player' | 'ai';
  /** プレイヤー企業の持ち主（サーバーが決める参加者の id）。AI は null */
  ownerId: string | null;
  strategy: AiStrategy | null;
  /** 本店の地域（MARKET_HOME_AREAS の id） */
  homeArea: string;
  joinedDay: number;
  /** 破産した日（市場から消えた）。null なら営業中 */
  bankruptDay: number | null;
  /** 会社と店舗（GameState。プレイヤーがいる店はない。すべての店を店長か店主が営業する） */
  state: GameState;
  /** AI の記憶（最後に価格を変えた日など） */
  memory: { lastPriceDay: number };
}

/** 意思決定の記録（AI 企業の理由・プレイヤーの操作） */
export interface MarketDecision {
  day: number;
  companyId: Id;
  text: string;
}

export interface MarketCompanyLine {
  id: Id;
  name: string;
  kind: 'player' | 'ai';
  netSales: number;
  operatingProfit: number;
  money: number;
  stores: number;
  /** 直近 shareDays 日の純売上の割合（0〜1。市場の合計が0なら0） */
  share: number;
  bankrupt: boolean;
}

export interface MarketDayReport {
  day: number;
  companies: MarketCompanyLine[];
}

export interface MarketState {
  schema: number;
  id: string;
  name: string;
  seed: number;
  /** 次に進める市場の日（この日の営業はまだ） */
  day: number;
  companies: MarketCompany[];
  decisions: MarketDecision[];
  history: MarketDayReport[];
}

const B = () => BALANCE.market;
const ctxOf = () => makeCtx();

// ───────────────────────── 作る・参加する ─────────────────────────

/** 企業の GameState を作る（市場用。資金30万円・8席から。店主が本店を回す） */
function newCompanyState(seed: number, name: string, day: number): GameState {
  const s = createGame({ seed, shopName: name, playerName: '店主' });
  s.phase = 'closed';
  s.tutorial = null;
  s.prepSnapshot = null;
  s.day = day;
  s.autoOrderMode = 'sales';
  s.company.ownerStoreId = s.company.stores[0]!.id;
  // 本店は参加した日から営業する（出店した店は準備の日数のあと）
  s.company.stores[0]!.openedDay = day - 1;
  return s;
}

function companySeed(m: MarketState, index: number): number {
  return (hashString(`${m.seed}:${index}:${m.companies.length}`) ^ m.seed) >>> 0;
}

function nextHomeArea(m: MarketState): string {
  const n = m.companies.length;
  return MARKET_HOME_AREAS[n % MARKET_HOME_AREAS.length]!.id;
}

function addCompany(m: MarketState, kind: 'player' | 'ai', name: string, ownerId: string | null, strategy: AiStrategy | null): MarketCompany {
  const idx = m.companies.length;
  const id = `c${idx + 1}`;
  const c: MarketCompany = {
    id,
    name,
    kind,
    ownerId,
    strategy,
    homeArea: nextHomeArea(m),
    joinedDay: m.day,
    bankruptDay: null,
    state: newCompanyState(companySeed(m, idx), name, m.day),
    memory: { lastPriceDay: -99 },
  };
  if (strategy) c.state.company.stores[0]!.policy.priceMult = BALANCE.market.ai.basePrice[strategy] ?? 1;
  m.companies.push(c);
  return c;
}

export interface CreateMarketOptions {
  id: string;
  name: string;
  seed: number;
  /** 最初のプレイヤー（作った人）。いなければ AI だけの市場 */
  creator?: { ownerId: string; companyName: string } | null;
}

/** 市場を作る。プレイヤーと合わせて最大6社になるまで AI 企業を入れる */
export function createMarket(o: CreateMarketOptions): MarketState {
  const m: MarketState = { schema: MARKET_SCHEMA, id: o.id, name: o.name, seed: o.seed >>> 0, day: 1, companies: [], decisions: [], history: [] };
  if (o.creator) addCompany(m, 'player', cleanName(o.creator.companyName), o.creator.ownerId, null);
  const ais = AI_COMPANIES.slice();
  while (m.companies.length < B().maxCompanies && ais.length > 0) {
    const a = ais.shift()!;
    addCompany(m, 'ai', a.name, null, a.strategy);
  }
  return m;
}

function cleanName(name: string): string {
  const n = name.trim().slice(0, 24);
  return n.length > 0 ? n : 'ラーメン まし屋';
}

export function activeCompanies(m: MarketState): MarketCompany[] {
  return m.companies.filter((c) => c.bankruptDay === null);
}

export function playerCompany(m: MarketState, ownerId: string): MarketCompany | null {
  return m.companies.find((c) => c.kind === 'player' && c.ownerId === ownerId) ?? null;
}

/** 参加できない理由（できるなら null） */
export function joinProblem(m: MarketState, ownerId: string): string | null {
  if (playerCompany(m, ownerId)) return null;
  const players = m.companies.filter((c) => c.kind === 'player').length;
  if (players >= B().maxPlayers) return `プレイヤー企業は${B().maxPlayers}社までです`;
  const live = activeCompanies(m).length;
  const ais = activeCompanies(m).filter((c) => c.kind === 'ai').length;
  if (live >= B().maxCompanies && ais <= B().minAi) return `この市場は${B().maxCompanies}社でいっぱいです`;
  return null;
}

/**
 * 市場に参加する（すでに参加していればその企業を返す）。6社でいっぱいなら、市場シェアがいちばん小さい AI 企業が市場から撤退する
 */
export function joinMarket(m: MarketState, ownerId: string, companyName: string): { ok: boolean; reason?: string; company?: MarketCompany } {
  const mine = playerCompany(m, ownerId);
  if (mine) return { ok: true, company: mine };
  const problem = joinProblem(m, ownerId);
  if (problem) return { ok: false, reason: problem };
  if (activeCompanies(m).length >= B().maxCompanies) {
    const ai = activeCompanies(m)
      .filter((c) => c.kind === 'ai')
      .sort((a, b) => marketShare(m, a.id) - marketShare(m, b.id) || b.joinedDay - a.joinedDay)[0]!;
    ai.bankruptDay = m.day;
    log(m, ai.id, `新しい企業の参加で市場から撤退しました（市場シェア ${(marketShare(m, ai.id) * 100).toFixed(1)}%）`);
  }
  const c = addCompany(m, 'player', cleanName(companyName), ownerId, null);
  log(m, c.id, `${c.name}が市場に参加しました（資金 ¥${c.state.money.toLocaleString('ja-JP')}・8席から）`);
  return { ok: true, company: c };
}

function log(m: MarketState, companyId: Id, text: string): void {
  m.decisions.push({ day: m.day, companyId, text });
  if (m.decisions.length > 300) m.decisions.splice(0, m.decisions.length - 300);
}

// ───────────────────────── 地域と客の取り合い ─────────────────────────

/** 店の地域（本店は企業の本店の地域、ほかは物件の地域） */
export function storeArea(c: MarketCompany, entry: StoreEntry): string {
  return entry.propertyId === 'home' ? c.homeArea : entry.propertyId;
}

export function areaName(id: string): string {
  return MARKET_HOME_AREAS.find((a) => a.id === id)?.name ?? MARKET_BRANCH_AREA_NAMES[id] ?? id;
}

/** その出店先の地域の、空いている物件の数 */
export function freeSlots(m: MarketState, propertyId: string): number {
  const total = B().branchSlots[propertyId] ?? 0;
  let used = 0;
  for (const c of activeCompanies(m)) used += c.state.company.stores.filter((x) => x.propertyId === propertyId).length;
  return Math.max(0, total - used);
}

/** 客の取り合いの倍率を店ごとに計算する（同じ地域の店どうし） */
export function competitionFactors(m: MarketState): Map<string, number> {
  const k = B().competition;
  const groups = new Map<string, { key: string; d: number }[]>();
  for (const c of activeCompanies(m)) {
    for (const entry of c.state.company.stores) {
      const d = standaloneArrivals(c.state, entry);
      const area = storeArea(c, entry);
      const g = groups.get(area) ?? [];
      g.push({ key: `${c.id}:${entry.id}`, d });
      groups.set(area, g);
    }
  }
  const out = new Map<string, number>();
  for (const g of groups.values()) {
    const total = g.reduce((a, x) => a + x.d, 0);
    for (const x of g) out.set(x.key, x.d > 0 ? x.d / (x.d + k * (total - x.d)) : 1);
  }
  return out;
}

// ───────────────────────── 市場の1日 ─────────────────────────

/** 融資の利息と返済（会社のもの。その日の1店舗目の日報に入れる） */
function settleLoans(s: GameState, day: number): void {
  const home = s.company.stores[0]!;
  const hist = home.snapshot ? home.snapshot.history : s.history;
  const r = hist.find((x) => x.day === day);
  for (const loan of s.loans) {
    const interest = Math.round(loan.remaining * loan.dailyRate);
    const principal = Math.min(loan.remaining, loan.dailyPayment);
    const pay = (amount: number, type: 'interest' | 'loanRepay', memo: string, key: string) => {
      const now = Math.min(amount, Math.max(0, s.money));
      if (now > 0) cash(s, type, -now, memo, key);
      if (amount - now > 0) s.arrears.push({ id: `${key}:ar`, amount: amount - now, reason: memo, sinceDay: day, dueDay: day + BALANCE.arrearsGraceDays });
    };
    pay(interest, 'interest', '融資の利息', `m:int:${loan.id}:${day}`);
    pay(principal, 'loanRepay', '融資の返済', `m:rep:${loan.id}:${day}`);
    loan.remaining -= principal;
    if (r) {
      r.interest += interest;
      r.finalProfit = (r.finalProfit ?? r.operatingProfit) - interest;
      r.cashEnd = s.money;
    }
  }
  s.loans = s.loans.filter((l) => l.remaining > 0);
}

/** 市場の1日を進める（すべての企業のすべての店の営業・会社の日報・AI の意思決定・市場シェア） */
export function advanceMarketDay(m: MarketState): void {
  const day = m.day;
  const ctx = ctxOf();
  const live = activeCompanies(m);
  for (const c of live) {
    const s = c.state;
    s.day = day;
    s.phase = 'closed';
    payArrears(s, ctx);
    if (s.career.unlocked.includes('hiring')) refreshCandidates(s);
  }
  const factors = competitionFactors(m);
  for (const c of live) {
    const s = c.state;
    for (const entry of s.company.stores) {
      if (entry.openedDay >= day) continue;
      runManagerDay(s, entry, day, ctx, { demandMult: factors.get(`${c.id}:${entry.id}`) ?? 1 });
    }
    settleLoans(s, day);
    recordCompanyDay(s, day);
    s.career.daysPlayed += 1;
    checkGoals(s, ctx);
  }
  // 支払いの期限を過ぎた未払金を払えなければ、融資を受け、それでも足りなければ破産（市場から消える）
  for (const c of live) {
    const s = c.state;
    s.day = day + 1;
    payArrears(s, ctx);
    let bc = bankruptcyCheck(s);
    if (bc.overdue > 0 && loanAvailable(s)) {
      takeLoan(s, ctx);
      payArrears(s, ctx);
      bc = bankruptcyCheck(s);
      log(m, c.id, '支払いの期限を過ぎた未払金があり、緊急融資を受けました');
    }
    if (bc.overdue > 0 && s.money < bc.overdue) {
      declareBankruptcy(s, ctx, `期限を過ぎた未払金 ¥${bc.overdue.toLocaleString('ja-JP')} を支払えない`);
      c.bankruptDay = day;
      log(m, c.id, `${c.name}は資金が尽きて破産し、市場から消えました`);
    }
  }
  for (const c of activeCompanies(m)) if (c.kind === 'ai') aiDecide(m, c, day);
  m.history.push(marketDayLine(m, day));
  if (m.history.length > 60) m.history.splice(0, m.history.length - 60);
  m.day = day + 1;
  for (const c of activeCompanies(m)) c.state.day = m.day;
}

/** 市場の日 target まで進める（target の前日まで営業が済む）。進めた日数を返す */
export function advanceMarketTo(m: MarketState, target: number, maxDays = B().maxCatchUpDays): number {
  let n = 0;
  while (m.day < target && n < maxDays) {
    advanceMarketDay(m);
    n += 1;
  }
  return n;
}

/** その企業の市場シェア（直近 shareDays 日の純売上の割合。市場の合計が0なら0） */
export function marketShare(m: MarketState, companyId: Id, upToDay = m.day - 1): number {
  const from = upToDay - B().shareDays + 1;
  let mine = 0;
  let total = 0;
  for (const c of m.companies) {
    let sum = 0;
    for (const r of c.state.company.history) if (r.day >= from && r.day <= upToDay) sum += r.netSales;
    total += sum;
    if (c.id === companyId) mine = sum;
  }
  return total > 0 ? mine / total : 0;
}

function marketDayLine(m: MarketState, day: number): MarketDayReport {
  return {
    day,
    companies: m.companies.map((c) => {
      const r = c.state.company.history.find((x) => x.day === day);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        netSales: r?.netSales ?? 0,
        operatingProfit: r?.operatingProfit ?? 0,
        money: c.state.money,
        stores: c.state.company.stores.length,
        share: marketShare(m, c.id, day),
        bankrupt: c.bankruptDay !== null,
      };
    }),
  };
}

// ───────────────────────── プレイヤーの操作 ─────────────────────────

/** 市場で使える経営の操作（店の中で動く操作・日を進める操作は使えない。日は市場の時計で進む） */
export const MARKET_ACTIONS: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'setStorePolicy',
  'assignManager',
  'transferEmployee',
  'openStore',
  'expand',
  'buySeat',
  'buyEquipment',
  'sellEquipment',
  'maintenance',
  'hire',
  'fire',
  'setRole',
  'promote',
  'takeLoan',
  'payArrears',
  'setAutoOrderMode',
  'rename',
]);

/** プレイヤー企業の操作を適用する（市場の規則の確認のあと、ひとりプレイと同じ core の操作で） */
export function marketAction(m: MarketState, ownerId: string, a: Action): ActionResult {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, reason: 'この市場に参加していません' };
  if (c.bankruptDay !== null) return { ok: false, reason: '破産しています' };
  if (!a || typeof a !== 'object' || !MARKET_ACTIONS.has(a.type)) return { ok: false, reason: '市場では使えない操作です' };
  if (a.type === 'buyEquipment' && a.autoPlace !== true) return { ok: false, reason: '市場では設備は自動で置きます' };
  if (a.type === 'openStore' && freeSlots(m, a.propertyId) <= 0) return { ok: false, reason: `${areaName(a.propertyId)}の物件は空いていません（ほかの企業が出店しています）` };
  if (a.type === 'rename' && typeof a.name === 'string') {
    const r = applyAction(c.state, 'p1', a, ctxOf());
    if (r.ok) c.name = c.state.shopName;
    return r;
  }
  c.state.phase = 'closed';
  const r = applyAction(c.state, 'p1', a, ctxOf());
  if (r.ok && a.type === 'openStore') {
    const st = c.state.company.stores[c.state.company.stores.length - 1]!;
    st.openedDay = m.day - 1;
    log(m, c.id, `${areaName(a.propertyId)}に出店しました（${st.name}）`);
  }
  if (r.ok && a.type === 'expand') log(m, c.id, `本店を${STAGES[c.state.career.stage]?.name ?? ''}に拡張しました`);
  return r;
}

// ───────────────────────── AI 企業 ─────────────────────────

function act(c: MarketCompany, a: Action): boolean {
  c.state.phase = 'closed';
  return applyAction(c.state, 'p1', a, ctxOf()).ok;
}

/** 店の従業員（店長を除く）の担当ごとの人数 */
function staffCount(c: MarketCompany, entry: StoreEntry, role: string): number {
  return storeStatus(c.state, entry).employees.filter((e) => e.id !== entry.managerId && e.profile.role === role).length;
}

/** いちばん安い候補を雇って、その店へ送る（本店以外なら異動） */
function aiHire(m: MarketCompany, entry: StoreEntry, role: 'cook' | 'server'): boolean {
  const s = m.state;
  if (!s.career.unlocked.includes('hiring')) return false;
  if (s.candidates.length === 0) refreshCandidates(s);
  const cand = [...s.candidates].sort((a, b) => (a.profile.role === role ? 0 : 1) - (b.profile.role === role ? 0 : 1) || a.profile.wage - b.profile.wage)[0];
  if (!cand) return false;
  if (!act(m, { type: 'hire', candidateId: cand.id })) return false;
  const e = s.employees[s.employees.length - 1]!;
  if (e.profile.role !== role) act(m, { type: 'setRole', employeeId: e.id, role });
  if (entry.id !== s.company.activeStoreId) act(m, { type: 'transferEmployee', employeeId: e.id, toStoreId: entry.id });
  return true;
}

/**
 * AI 企業の1日の意思決定（ルールベース。プレイヤーと同じ操作・同じ経済の規則で）。理由を記録する。
 * 1) 価格: 戦略の基準から、客を逃していれば値上げ、空いていれば値下げ（3日に1回まで）
 * 2) 人: 1人目の調理担当（店主の手伝い）、拡張したら接客担当
 * 3) 拡張: 12席の工事＋席＋冷蔵庫＋手元資金がたまったら
 * 4) 出店: 出店の条件を満たし、初期費用＋手元資金がたまったら、戦略に合う地域へ（店長は調理担当を社員にして任せる）
 */
export function aiDecide(m: MarketState, c: MarketCompany, day: number): void {
  const s = c.state;
  const A = BALANCE.market.ai;
  const strategy = c.strategy ?? 'standard';
  const base = A.basePrice[strategy] ?? 1;
  const reserve = A.reserve;
  // 1) 価格（店ごと）
  if (day - c.memory.lastPriceDay >= A.priceEveryDays) {
    for (const entry of s.company.stores) {
      const r = storeStatusReport(c, entry, day);
      if (!r || r.served === 0) continue;
      const cap = withStore(s, entry, () => planManagerDay(s, entry).capacity.total);
      const lostShare = (r.lost + r.balked) / Math.max(1, r.customers + r.balked);
      const pm = entry.policy.priceMult;
      let next = pm;
      let why = '';
      if (lostShare > A.lostRaise && pm < Math.min(A.priceMax, base + 0.15)) {
        next = Math.round((pm + A.priceStep) * 100) / 100;
        why = `客の${Math.round(lostShare * 100)}%が入れずに帰ったので値上げ`;
      } else if (r.served < cap * A.idleCut && pm > Math.max(A.priceMin, base - 0.1)) {
        next = Math.round((pm - A.priceStep) * 100) / 100;
        why = `空席が多い（${r.served}杯／${Math.round(cap)}杯）ので値下げ`;
      }
      if (next !== pm) {
        entry.policy.priceMult = next;
        c.memory.lastPriceDay = day;
        log(m, c.id, `${entry.name}: ${why}（定価の${Math.round(next * 100)}%）`);
      }
    }
  }
  // 2) 人（店が手いっぱいのときだけ雇う。空席が多いのに雇うと人件費で損をする）
  const home = s.company.stores[0]!;
  const hr = storeStatusReport(c, home, day);
  const homeCap = withStore(s, home, () => planManagerDay(s, home).capacity.total);
  const busy = !!hr && hr.served > 0 && (hr.served >= homeCap * A.busyShare || (hr.lost + hr.balked) / Math.max(1, hr.customers + hr.balked) > A.lostRaise);
  if (day >= A.hireFromDay && s.money > reserve && busy) {
    if (staffCount(c, home, 'cook') === 0 && aiHire(c, home, 'cook')) log(m, c.id, `本店が手いっぱい（${hr!.served}杯／${Math.round(homeCap)}杯）なので、店主の手伝いに調理担当を1人雇いました`);
    else if (storeStatus(s, home).stage >= 1 && staffCount(c, home, 'server') === 0 && s.money > reserve + 50_000 && aiHire(c, home, 'server')) log(m, c.id, '拡張した本店に接客担当を雇いました');
  }
  for (const entry of s.company.stores.slice(1)) {
    if (entry.snapshot && entry.snapshot.closedForConstruction > 0) continue;
    if (staffCount(c, entry, 'cook') === 0 && s.money > reserve && aiHire(c, entry, 'cook')) log(m, c.id, `${entry.name}に調理担当を雇いました`);
  }
  // 3) 拡張（本店。プレイヤーがいる店の扱いの本店を12席に）
  const info = expansionInfo(s);
  if (info.next && info.next.id === 1 && info.canExpand) {
    const seats = (info.next.seats.length - STAGES[s.career.stage]!.seats.length) * SEAT_PRICE;
    const fridge = EQUIPMENT.fridge?.price ?? 0;
    if (s.money >= info.cost + info.next.minFundsAfter + seats + fridge + A.expandReserve && act(c, { type: 'expand' })) {
      log(m, c.id, `資金がたまったので本店を12席に拡張しました（工事費 ¥${info.cost.toLocaleString('ja-JP')}）`);
    }
  }
  if (s.career.stage >= 1 && home.snapshot === null) {
    for (const seat of s.seats) if (!seat.installed && seat.index < STAGES[s.career.stage]!.seats.length && s.money > SEAT_PRICE + reserve) act(c, { type: 'buySeat', seatIndex: seat.index });
    if (s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < 2 && s.money > (EQUIPMENT.fridge?.price ?? 0) + reserve && act(c, { type: 'buyEquipment', equipType: 'fridge', autoPlace: true })) {
      log(m, c.id, '12席で冷蔵庫が足りないので2台目を買いました');
    }
  }
  // 4) 出店
  const order: Record<AiStrategy, string[]> = { budget: ['residential', 'roadside', 'station'], standard: ['roadside', 'residential', 'station'], premium: ['station', 'roadside', 'residential'] };
  if (s.company.stores.length < BALANCE.company.maxStores) {
    for (const pid of order[strategy]) {
      const prop = PROPERTIES[pid];
      if (!prop || !PROPERTY_CANDIDATES.includes(pid) || freeSlots(m, pid) <= 0) continue;
      if (s.company.stores.some((x) => x.propertyId === pid)) continue;
      if (s.money < prop.initialCost + BALANCE.company.minFundsAfterOpen + reserve) break;
      // 店長: 今の本店の調理担当を社員にして任せる（いなければ見送る）
      const cook = s.employees.filter((e) => e.profile.role === 'cook').sort((a, b) => b.profile.skills.cooking - a.profile.skills.cooking)[0];
      if (!cook) break;
      if (cook.profile.employment !== 'full') act(c, { type: 'promote', employeeId: cook.id });
      if (openStoreProblem(s, pid, cook.id)) break;
      if (act(c, { type: 'openStore', propertyId: pid, managerId: cook.id })) {
        const st = s.company.stores[s.company.stores.length - 1]!;
        st.openedDay = day;
        st.policy.priceMult = base;
        log(m, c.id, `${areaName(pid)}に出店しました（${st.name}・初期費用 ¥${prop.initialCost.toLocaleString('ja-JP')}。${prop.description}）`);
      }
      break;
    }
  }
}

/** その店のその日の日報（会社の日報の行ではなく、店の日報） */
function storeStatusReport(c: MarketCompany, entry: StoreEntry, day: number) {
  const hist = entry.snapshot ? entry.snapshot.history : c.state.history;
  return hist.find((x) => x.day === day) ?? null;
}

// ───────────────────────── 見せる形 ─────────────────────────

/** 市場の企業の一覧（直近の日の行。シェアの高い順） */
export function marketStandings(m: MarketState): MarketCompanyLine[] {
  const last = m.history[m.history.length - 1];
  const lines = last ? last.companies : m.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, netSales: 0, operatingProfit: 0, money: c.state.money, stores: c.state.company.stores.length, share: 0, bankrupt: c.bankruptDay !== null }));
  return [...lines].sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || b.share - a.share || b.money - a.money);
}
