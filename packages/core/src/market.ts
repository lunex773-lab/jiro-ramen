// 共通市場（コミュニティ）の中身。MARKET_RANKING_PLAN.md（オーナーの判断 2026-11-04）。
// 1つの市場（コミュニティ）の中で、プレイヤー企業と AI 企業（合わせて2〜6社）が同じ街で客を取り合う。
//
// 時間: 各企業は自分のゲーム内日付を持つ。プレイヤーは端末で1日ずつ営業し、日の終わりにサーバーへ送る（commitDay）。
// JST の0時に期間を締め、いちばん進んだ企業の日付を同期目標にして、遅れた企業（AI 企業も）を自動営業で目標まで進める（runSync）。
// 自動営業は「店長の営業」（1日単位の計算。手動と同じ需要・容量・価格・在庫・給与・家賃・借入の式）で、日付ごとに全社そろえて計算する。
// 客の取り合いは、同じ日付の相手の店の見込み（ledger）で計算する（相手がまだその日付に着いていなければ、相手の今の見込み）。
// 乱数は各企業の状態の中の種だけを使う（同じ種と同じ操作の列なら同じ結果）。市場の権威はサーバー（apps/server の MarketRoom）。

import { BALANCE } from './data/balance';
import { EQUIPMENT, SEAT_PRICE } from './data/equipment';
import { AI_COMPANIES, MARKET_BRANCH_AREA_NAMES, MARKET_HOME_AREAS, type AiStrategy } from './data/market';
import { PROPERTIES, PROPERTY_CANDIDATES } from './data/properties';
import { STAGES } from './data/stages';
import { addDays, jstDateKey, jstMidnight, nextJstMidnight, type DateKey } from './jst';
import { createGame } from './state';
import type { GameState, Id, StoreEntry } from './types';
import { hashString } from './util';
import { lastCompanyDay, verifyCommit } from './verify';
import { applyAction, type Action, type ActionResult } from './sim/actions';
import { activeStore, recordCompanyDay, storeReport, withStore } from './sim/company';
import { expectedDailyArrivals } from './sim/customers';
import { bankruptcyCheck, checkGoals, declareBankruptcy, loanAvailable, payArrears, startNextDay, takeLoan } from './sim/day';
import { cash, finalProfit, totalDebt } from './sim/economy';
import { refreshCandidates } from './sim/employees';
import { receiveDeliveries } from './sim/inventory';
import { expansionInfo } from './sim/layout';
import { planManagerDay, runManagerDay, standaloneArrivals } from './sim/manager';
import { makeCtx } from './sim/notices';
import { openStoreProblem, runAbsentStores, storeStatus } from './sim/stores';

export const MARKET_SCHEMA = 2;

export type CompanyStatus = 'active' | 'bankrupt' | 'retired' | 'moved';
/** 仕様書 3.3 の synchronizationStatus */
export type SynchronizationStatus = 'idle' | 'playing' | 'syncing' | 'synced';

/** 企業の進行の状態（仕様書 3.3 の項目。marketId・companyId は市場と企業の id） */
export interface CompanyProgress {
  /** 営業が済んだ最後のゲーム内日付（0 = まだ1日も営業していない） */
  lastProcessedGameDate: number;
  /** 最後に同期が済んだ期間（JST の日付） */
  lastProcessedPeriod: DateKey | null;
  /** 今の（まだ同期していない）期間に手動で確定した日数 */
  manualProgressDays: number;
  /** 最後の同期で自動営業で補った日数 */
  autoSimulationDays: number;
  totalManualDays: number;
  totalAutoDays: number;
  synchronizationStatus: SynchronizationStatus;
  /** 最後に自動営業した計算式の版 */
  processingVersion: number;
  /** 状態の版（サーバーで状態が変わるたびに上がる。端末が古い状態から日を始めないように） */
  stateVersion: number;
}

/** 端末で営業中の日（日の始めにサーバーが渡した条件） */
export interface OpenDay {
  token: string;
  gameDate: number;
  /** この日を数える期間（日を始めたときのサーバーの時刻の JST の日付） */
  periodId: DateKey;
  startedAt: number;
  baseVersion: number;
  /** 店の id → 客の取り合いの倍率 */
  demand: Record<string, number>;
}

/** 確定した1日の記録（ランキングの集計のもと。サーバーが受け取った値・自動営業の値だけ） */
export interface CompanyDayRecord {
  gameDate: number;
  periodId: DateKey;
  source: 'manual' | 'auto';
  /** 上限を超えた・食い違いがあった日（順位から外す）。null なら問題なし */
  flags: string[] | null;
  netSales: number;
  operatingProfit: number;
  finalProfit: number;
  served: number;
  customers: number;
  satisfactionSum: number;
  satisfactionCount: number;
  /** その日の終わりのお金と負債（融資の残り＋未払金） */
  money: number;
  debt: number;
  stores: number;
}

export interface MarketCompany {
  id: Id;
  name: string;
  kind: 'player' | 'ai';
  /** プレイヤー企業の持ち主（サーバーが決める参加者の id）。AI は null */
  ownerId: string | null;
  strategy: AiStrategy | null;
  /** 本店の地域（MARKET_HOME_AREAS の id） */
  homeArea: string;
  /** 参加したゲーム内日付（この日から営業する） */
  joinedDay: number;
  status: CompanyStatus;
  /** 破産・撤退した日（ゲーム内日付）。null なら営業中 */
  bankruptDay: number | null;
  /** 会社と店舗（GameState）。日と日の間は「その日の仕込み」の状態（工事の日は精算済みの状態） */
  state: GameState;
  /** AI の記憶（最後に価格を変えた日など） */
  memory: { lastPriceDay: number };
  progress: CompanyProgress;
  openDay: OpenDay | null;
  /** 最後の日の確定（同じ token の送り直しに同じ答えを返す） */
  lastCommit: CommitResult & { token: string } | null;
  /** 確定した日の記録（集計がまだの分＋直近） */
  days: CompanyDayRecord[];
}

/** 意思決定の記録（AI 企業の理由・プレイヤーの操作・同期） */
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

/** コミュニティの設定（仕様書 6.1。オーナーの判断: 企業の扱い・AI の有無は作る人が決める。上限2〜6社） */
export interface CommunitySettings {
  description: string;
  visibility: 'public' | 'invite';
  maxCompanies: number;
  /** 競争期間（日）。null = 無期限 */
  periodDays: number | null;
  /** 競争の開始・終了（UTC のミリ秒。JST の0時にそろえる）。endsAt が null なら無期限 */
  startsAt: number;
  endsAt: number | null;
  /** 'grown' = 育てた企業で参加できる、'fresh' = 新規の企業だけ */
  entry: 'grown' | 'fresh';
  /** 空いた枠を AI 企業で埋める */
  aiFill: boolean;
}

/** JST の期間ごとの同期（仕様書 3.4 の状態機械） */
export interface SyncRun {
  periodId: DateKey;
  status: 'closing' | 'syncing' | 'ranking' | 'done';
  /** 同期目標（いちばん進んだ企業の済んだ日付） */
  targetDate: number | null;
  startedAt: number;
  /** 営業中の日を待つ期限（期間の終わり＋30分） */
  closeDeadline: number;
  finishedAt: number | null;
  /** 自動営業した企業・日の数 */
  autoDays: number;
  /** 待ちきれずに無効にした日の数 */
  expiredDays: number;
}

export interface MarketState {
  schema: number;
  id: string;
  name: string;
  seed: number;
  createdAt: number;
  settings: CommunitySettings;
  /** 全社が営業済みの日付（仕様書 3.3 の commonMarketDate） */
  commonMarketDate: number;
  /** 手動の日があって、まだ同期していない期間（古い順） */
  pendingPeriods: DateKey[];
  sync: SyncRun | null;
  syncLog: SyncRun[];
  /** ゲーム内日付 → 「企業:店」→ その日の店の見込み（客の取り合いに使う。全社が通り過ぎた日付は捨てる） */
  ledger: Record<string, Record<string, number>>;
  companies: MarketCompany[];
  decisions: MarketDecision[];
  /** 全社がそろった日付ごとの企業の行（同期のときに足す） */
  history: MarketDayReport[];
}

const B = () => BALANCE.market;
const ctxOf = () => makeCtx();

// ───────────────────────── 作る・参加する ─────────────────────────

/** 企業の GameState を作る（市場用。資金30万円・8席から）。day の日の仕込みの状態 */
function newCompanyState(seed: number, name: string, day: number): GameState {
  const s = createGame({ seed, shopName: name, playerName: '店主' });
  s.tutorial = null;
  s.prepSnapshot = null;
  s.day = day;
  s.phase = 'prep';
  s.autoOrderMode = 'sales';
  s.company.ownerStoreId = s.company.activeStoreId;
  // 本店は参加した日から営業する（出店した店は準備の日数のあと）
  s.company.stores[0]!.openedDay = day - 1;
  return s;
}

function newProgress(lastDay: number): CompanyProgress {
  return {
    lastProcessedGameDate: lastDay,
    lastProcessedPeriod: null,
    manualProgressDays: 0,
    autoSimulationDays: 0,
    totalManualDays: 0,
    totalAutoDays: 0,
    synchronizationStatus: 'idle',
    processingVersion: B().autoSimVersion,
    stateVersion: 1,
  };
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
  const day = m.commonMarketDate + 1;
  const c: MarketCompany = {
    id,
    name,
    kind,
    ownerId,
    strategy,
    homeArea: nextHomeArea(m),
    joinedDay: day,
    status: 'active',
    bankruptDay: null,
    state: newCompanyState(companySeed(m, idx), name, day),
    memory: { lastPriceDay: -99 },
    progress: newProgress(day - 1),
    openDay: null,
    lastCommit: null,
    days: [],
  };
  if (strategy) c.state.company.stores[0]!.policy.priceMult = BALANCE.market.ai.basePrice[strategy] ?? 1;
  m.companies.push(c);
  return c;
}

export const DEFAULT_SETTINGS = (now: number): CommunitySettings => ({
  description: '',
  visibility: 'invite',
  maxCompanies: B().maxCompanies,
  periodDays: null,
  startsAt: now,
  endsAt: null,
  entry: 'grown',
  aiFill: true,
});

export interface CreateMarketOptions {
  id: string;
  name: string;
  seed: number;
  now?: number;
  settings?: Partial<CommunitySettings>;
  /** 最初のプレイヤー（作った人）。いなければ AI だけの市場 */
  creator?: { ownerId: string; companyName: string } | null;
}

/** 設定の値を範囲に収める */
export function normalizeSettings(raw: Partial<CommunitySettings>, now: number): CommunitySettings {
  const d = DEFAULT_SETTINGS(now);
  const max = Math.round(Number(raw.maxCompanies ?? d.maxCompanies));
  const periodDays = raw.periodDays === null || raw.periodDays === undefined ? null : Math.max(1, Math.round(Number(raw.periodDays)));
  const startsAt = typeof raw.startsAt === 'number' && Number.isFinite(raw.startsAt) ? raw.startsAt : now;
  return {
    description: typeof raw.description === 'string' ? raw.description.trim().slice(0, 200) : '',
    visibility: raw.visibility === 'public' ? 'public' : 'invite',
    maxCompanies: Number.isFinite(max) ? Math.min(B().maxCompanies, Math.max(B().minCompanies, max)) : d.maxCompanies,
    periodDays: periodDays !== null && Number.isFinite(periodDays) ? periodDays : null,
    startsAt,
    endsAt: periodDays !== null && Number.isFinite(periodDays) ? jstMidnight(jstDateKey(startsAt)) + periodDays * 86_400_000 : null,
    entry: raw.entry === 'fresh' ? 'fresh' : 'grown',
    aiFill: raw.aiFill !== false,
  };
}

/** 市場を作る。AI で埋める設定なら、上限の社数になるまで AI 企業を入れる */
export function createMarket(o: CreateMarketOptions): MarketState {
  const now = o.now ?? 0;
  const m: MarketState = {
    schema: MARKET_SCHEMA,
    id: o.id,
    name: o.name,
    seed: o.seed >>> 0,
    createdAt: now,
    settings: normalizeSettings(o.settings ?? {}, now),
    commonMarketDate: 0,
    pendingPeriods: [],
    sync: null,
    syncLog: [],
    ledger: {},
    companies: [],
    decisions: [],
    history: [],
  };
  if (o.creator) addCompany(m, 'player', cleanName(o.creator.companyName), o.creator.ownerId, null);
  if (m.settings.aiFill) {
    const ais = AI_COMPANIES.slice();
    while (m.companies.length < m.settings.maxCompanies && ais.length > 0) {
      const a = ais.shift()!;
      addCompany(m, 'ai', a.name, null, a.strategy);
    }
  }
  return m;
}

function cleanName(name: string): string {
  const n = name.trim().slice(0, 24);
  return n.length > 0 ? n : 'ラーメン まし屋';
}

export function activeCompanies(m: MarketState): MarketCompany[] {
  return m.companies.filter((c) => c.status === 'active');
}

export function playerCompany(m: MarketState, ownerId: string): MarketCompany | null {
  return m.companies.find((c) => c.kind === 'player' && c.ownerId === ownerId && c.status !== 'moved' && c.status !== 'retired') ?? null;
}

/** 参加できない理由（できるなら null） */
export function joinProblem(m: MarketState, ownerId: string): string | null {
  if (playerCompany(m, ownerId)) return null;
  const live = activeCompanies(m);
  const humans = live.filter((c) => c.kind === 'player').length;
  if (humans >= m.settings.maxCompanies) return `この市場は${m.settings.maxCompanies}社でいっぱいです`;
  if (live.length >= m.settings.maxCompanies && !live.some((c) => c.kind === 'ai')) return `この市場は${m.settings.maxCompanies}社でいっぱいです`;
  return null;
}

/**
 * 市場に参加する（すでに参加していればその企業を返す）。いっぱいなら、市場シェアがいちばん小さい AI 企業が市場から撤退する
 */
export function joinMarket(m: MarketState, ownerId: string, companyName: string): { ok: boolean; reason?: string; company?: MarketCompany } {
  const mine = playerCompany(m, ownerId);
  if (mine) return { ok: true, company: mine };
  const problem = joinProblem(m, ownerId);
  if (problem) return { ok: false, reason: problem };
  if (activeCompanies(m).length >= m.settings.maxCompanies) {
    const ai = activeCompanies(m)
      .filter((c) => c.kind === 'ai')
      .sort((a, b) => marketShare(m, a.id) - marketShare(m, b.id) || b.joinedDay - a.joinedDay)[0]!;
    ai.status = 'retired';
    ai.bankruptDay = ai.progress.lastProcessedGameDate;
    log(m, ai.id, `新しい企業の参加で市場から撤退しました（市場シェア ${(marketShare(m, ai.id) * 100).toFixed(1)}%）`);
  }
  const c = addCompany(m, 'player', cleanName(companyName), ownerId, null);
  log(m, c.id, `${c.name}が市場に参加しました（資金 ¥${c.state.money.toLocaleString('ja-JP')}・8席から。${c.joinedDay}日目から）`);
  return { ok: true, company: c };
}

function log(m: MarketState, companyId: Id, text: string, day?: number): void {
  const c = m.companies.find((x) => x.id === companyId);
  m.decisions.push({ day: day ?? (c ? c.progress.lastProcessedGameDate : m.commonMarketDate), companyId, text });
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

/**
 * 店の見込み（競合なしの来客の見込み。人/日）。manual: 端末で営業する日（プレイヤーがいる店は今の値段で）。
 * そうでなければ方針の値段（店長の営業・自動営業）。プレイヤーがいる店の値段は書き換えない
 */
export function storeAttractiveness(s: GameState, entry: StoreEntry, manual: boolean, day: number): number {
  if (entry.openedDay >= day) return 0;
  const isActive = entry.id === s.company.activeStoreId;
  if (isActive && manual) {
    if (s.closedForConstruction > 0) return 0;
    return expectedDailyArrivals(s, { events: false });
  }
  if (!isActive) return standaloneArrivals(s, entry);
  const keep = { ...s.prices };
  const v = standaloneArrivals(s, entry);
  s.prices = keep;
  return v;
}

const lkey = (c: MarketCompany, entry: StoreEntry) => `${c.id}:${entry.id}`;

/** その日付の店の見込みを記録する（同じ日付の相手と客を取り合うため） */
function recordLedger(m: MarketState, c: MarketCompany, day: number, manual: boolean): void {
  const row = (m.ledger[String(day)] ??= {});
  for (const k of Object.keys(row)) if (k.startsWith(`${c.id}:`)) delete row[k];
  for (const entry of c.state.company.stores) row[lkey(c, entry)] = storeAttractiveness(c.state, entry, manual, day);
}

/**
 * その企業の、日付 day の店ごとの客の取り合いの倍率。
 * ほかの企業は、その日付を通り過ぎていればその日付の記録、まだなら今の状態の見込み（まだ開いていない店は0）
 */
export function demandFor(m: MarketState, c: MarketCompany, day: number): Record<string, number> {
  const k = B().competition;
  const row = m.ledger[String(day)] ?? {};
  const own = new Map<string, { area: string; d: number }>();
  for (const entry of c.state.company.stores) own.set(entry.id, { area: storeArea(c, entry), d: row[lkey(c, entry)] ?? storeAttractiveness(c.state, entry, false, day) });
  const others = new Map<string, number>();
  for (const o of activeCompanies(m)) {
    if (o.id === c.id) continue;
    const passed = o.progress.lastProcessedGameDate >= day || (o.openDay?.gameDate === day);
    for (const entry of o.state.company.stores) {
      const recorded = row[lkey(o, entry)];
      const d = recorded !== undefined ? recorded : passed ? 0 : storeAttractiveness(o.state, entry, false, day);
      const area = storeArea(o, entry);
      others.set(area, (others.get(area) ?? 0) + d);
    }
  }
  const out: Record<string, number> = {};
  for (const [id, x] of own) out[id] = x.d > 0 ? x.d / (x.d + k * (others.get(x.area) ?? 0)) : 1;
  return out;
}

/** 全社の今の店の倍率（画面の説明・テスト用。各社の次の日付で） */
export function competitionFactors(m: MarketState): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of activeCompanies(m)) {
    const d = demandFor(m, c, c.progress.lastProcessedGameDate + 1);
    for (const [sid, v] of Object.entries(d)) out.set(`${c.id}:${sid}`, v);
  }
  return out;
}

// ───────────────────────── 日の始めと終わり（端末で営業する日） ─────────────────────────

export interface DayTicket {
  token: string;
  companyId: Id;
  gameDate: number;
  periodId: DateKey;
  startedAt: number;
  baseVersion: number;
  demand: Record<string, number>;
  /** 同じ日の続き（端末が送り直した・つながり直した） */
  resumed: boolean;
}

export type StartDayCode = 'not_member' | 'inactive' | 'syncing' | 'sync_pending' | 'stale';

export interface CommitResult {
  ok: boolean;
  code?: 'no_open_day' | 'expired' | 'rejected' | 'syncing';
  reason?: string;
  reject?: string[];
  flags?: string[];
  gameDate?: number;
  stateVersion?: number;
  bankrupt?: boolean;
  duplicate?: boolean;
}

/** 0時を過ぎて、まだ同期していない期間がある（同期が済むまで新しい日は始められない） */
export function syncPending(m: MarketState, now: number): boolean {
  if (m.sync && m.sync.status !== 'done') return true;
  const today = jstDateKey(now);
  return m.pendingPeriods.some((p) => p < today);
}

/** 営業中の日を待つ期限（その期間の終わり＋30分） */
export function closeDeadline(periodId: DateKey): number {
  return jstMidnight(addDays(periodId, 1)) + B().closeGraceMs;
}

/**
 * 端末で1日を始める（その日の条件を渡す）。同じ日がすでに始まっていれば、その条件を返す（つながり直し）。
 * baseVersion: 端末が持っている状態の版（サーバーの版と違えば、先に状態を読み直してもらう）
 */
export function startDay(
  m: MarketState,
  ownerId: string,
  now: number,
  token: string,
  baseVersion: number,
): { ok: true; ticket: DayTicket } | { ok: false; code: StartDayCode; reason: string } {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, code: 'not_member', reason: 'この市場に参加していません' };
  if (c.status !== 'active') return { ok: false, code: 'inactive', reason: c.status === 'bankrupt' ? '破産しています' : '営業していません' };
  if (c.openDay) return { ok: true, ticket: ticketOf(c, c.openDay, true) };
  if (syncPending(m, now)) {
    return m.sync && m.sync.status !== 'done' && m.sync.status !== 'closing'
      ? { ok: false, code: 'syncing', reason: '0時の計算中です。終わるまでお待ちください' }
      : { ok: false, code: 'sync_pending', reason: '0時を過ぎたので、計算が済むまで新しい日は始められません' };
  }
  if (baseVersion !== c.progress.stateVersion) return { ok: false, code: 'stale', reason: '会社の状態が新しくなっています。読み直してください' };
  const day = c.progress.lastProcessedGameDate + 1;
  c.state.company.ownerStoreId = c.state.company.activeStoreId;
  recordLedger(m, c, day, true);
  const demand = demandFor(m, c, day);
  const periodId = jstDateKey(now);
  c.openDay = { token, gameDate: day, periodId, startedAt: now, baseVersion, demand };
  c.progress.synchronizationStatus = 'playing';
  if (!m.pendingPeriods.includes(periodId)) {
    m.pendingPeriods.push(periodId);
    m.pendingPeriods.sort();
  }
  return { ok: true, ticket: ticketOf(c, c.openDay, false) };
}

function ticketOf(c: MarketCompany, o: OpenDay, resumed: boolean): DayTicket {
  return { token: o.token, companyId: c.id, gameDate: o.gameDate, periodId: o.periodId, startedAt: o.startedAt, baseVersion: o.baseVersion, demand: { ...o.demand }, resumed };
}

/** 端末の状態を、サーバーに置く形に整える（爆発事故の控えは端末で作り直すので置かない） */
function sanitize(next: GameState, demand: Record<string, number>): GameState {
  next.prepSnapshot = null;
  next.marketDemand = { ...demand };
  next.company.ownerStoreId = next.company.activeStoreId;
  return next;
}

function dayRecord(s: GameState, day: number, periodId: DateKey, source: 'manual' | 'auto', flags: string[] | null): CompanyDayRecord {
  const cr = s.company.history.find((x) => x.day === day);
  let customers = 0;
  let satisfactionSum = 0;
  let satisfactionCount = 0;
  for (const entry of s.company.stores) {
    const r = storeReport(s, entry, day);
    if (!r) continue;
    customers += r.customers;
    satisfactionSum += r.satisfactionSum;
    satisfactionCount += r.satisfactionCount;
  }
  return {
    gameDate: day,
    periodId,
    source,
    flags: flags && flags.length > 0 ? flags : null,
    netSales: cr?.netSales ?? 0,
    operatingProfit: cr?.operatingProfit ?? 0,
    finalProfit: cr?.finalProfit ?? 0,
    served: cr?.served ?? 0,
    customers,
    satisfactionSum,
    satisfactionCount,
    money: s.money,
    debt: totalDebt(s),
    stores: s.company.stores.length,
  };
}

/**
 * 端末から届いた1日の終わりの状態を確かめて受け取る（verify.ts）。
 * つながらない日は受け取らず（前日に戻す）、上限を超える日は受け取って順位から外す。同じ token の送り直しには同じ答え
 */
export function commitDay(m: MarketState, ownerId: string, now: number, token: string, next: GameState): CommitResult {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, code: 'no_open_day', reason: 'この市場に参加していません' };
  if (c.lastCommit && c.lastCommit.token === token) {
    const { token: _t, ...r } = c.lastCommit;
    return { ...r, duplicate: true };
  }
  const o = c.openDay;
  if (!o || o.token !== token) return { ok: false, code: 'no_open_day', reason: '始めていない日です。もう一度日を始めてください' };
  const done = (r: CommitResult): CommitResult => {
    c.lastCommit = { ...r, token };
    return r;
  };
  if (now > closeDeadline(o.periodId)) {
    c.openDay = null;
    c.progress.synchronizationStatus = 'idle';
    log(m, c.id, `${o.gameDate}日目は0時から30分を過ぎても届かなかったため無効になりました`, o.gameDate);
    return done({ ok: false, code: 'expired', reason: '0時から30分を過ぎたため、この日は無効になりました。前の日の状態からやり直してください' });
  }
  const v = verifyCommit(c.state, next, { gameDate: o.gameDate, demand: o.demand });
  if (v.reject.length > 0) {
    c.openDay = null;
    c.progress.synchronizationStatus = 'idle';
    return done({ ok: false, code: 'rejected', reason: '前の日の状態から説明できない変化があるため、この日は受け取れません。前の日の状態からやり直してください', reject: v.reject });
  }
  c.state = sanitize(next, o.demand);
  c.openDay = null;
  c.progress.stateVersion += 1;
  c.progress.synchronizationStatus = 'idle';
  if (v.bankrupt) {
    c.status = 'bankrupt';
    c.bankruptDay = o.gameDate;
    log(m, c.id, `${c.name}は資金が尽きて破産し、市場から消えました`, o.gameDate);
    return done({ ok: true, gameDate: o.gameDate, stateVersion: c.progress.stateVersion, bankrupt: true, flags: v.flags });
  }
  c.progress.lastProcessedGameDate = o.gameDate;
  c.progress.manualProgressDays += 1;
  c.progress.totalManualDays += 1;
  c.days.push(dayRecord(c.state, o.gameDate, o.periodId, 'manual', v.flags));
  if (!m.pendingPeriods.includes(o.periodId)) {
    m.pendingPeriods.push(o.periodId);
    m.pendingPeriods.sort();
  }
  return done({ ok: true, gameDate: o.gameDate, stateVersion: c.progress.stateVersion, flags: v.flags.length > 0 ? v.flags : undefined });
}

// ───────────────────────── 自動営業（1日単位の計算） ─────────────────────────

/** 融資の利息と返済（会社のもの。プレイヤーがいる店のその日の日報に入れる。ひとりプレイの精算と同じ） */
function settleLoans(s: GameState, day: number): void {
  const r = storeReport(s, activeStore(s), day);
  for (const loan of s.loans) {
    const interest = Math.round(loan.remaining * loan.dailyRate);
    const principal = Math.min(loan.remaining, loan.dailyPayment);
    const pay = (amount: number, type: 'interest' | 'loanRepay', memo: string, key: string) => {
      const now = Math.min(amount, Math.max(0, s.money));
      if (now > 0) cash(s, type, -now, memo, key);
      if (amount - now > 0) s.arrears.push({ id: `${key}:ar`, amount: amount - now, reason: memo, sinceDay: day, dueDay: day + BALANCE.arrearsGraceDays });
    };
    pay(interest, 'interest', '融資の利息', `auto:int:${loan.id}:${day}`);
    pay(principal, 'loanRepay', '融資の返済', `auto:rep:${loan.id}:${day}`);
    loan.remaining -= principal;
    if (r) {
      r.interest += interest;
      r.finalProfit = finalProfit(r);
      r.cashEnd = s.money;
    }
  }
  s.loans = s.loans.filter((l) => l.remaining > 0);
}

export interface AutoDayOptions {
  /** 期限を過ぎた未払金を払えないとき、緊急の融資を受けてよいか */
  allowLoan: boolean;
}

/**
 * 1社の1日を自動営業で進める（全店を店長の営業で。店主はプレイヤーがいる店を回す）。
 * s は day の日の仕込みの状態（工事の日なら精算済み）。終わると day+1 の日の仕込みの状態になる。
 * 手動の nextDay と同じ順序（未払金 → ほかの店 → 会社の日報 → 次の日の朝）で、同じ朝の規則（startNextDay）を使う
 */
export function autoPlayDay(s: GameState, day: number, demand: Record<string, number>, opts: AutoDayOptions): { bankrupt: boolean; loan: boolean; reason?: string } {
  const ctx = ctxOf();
  s.marketDemand = { ...demand };
  s.company.ownerStoreId = s.company.activeStoreId;
  s.day = day;
  const active = activeStore(s);
  if (!storeReport(s, active, day)) {
    s.phase = 'closed';
    payArrears(s, ctx);
    // プレイヤーがいる店の手動の値段・発注の設定は残す（自動営業の日は方針の値段で営業する）
    const keepPrices = { ...s.prices };
    const keepMode = s.autoOrderMode;
    if (active.openedDay < day) runManagerDay(s, active, day, ctx, { demandMult: demand[active.id] ?? 1 });
    s.prices = keepPrices;
    s.autoOrderMode = keepMode;
    settleLoans(s, day);
    s.career.daysPlayed += 1;
    checkGoals(s, ctx);
  }
  s.phase = 'closed';
  // 次の日へ進む前の支払い（手動の nextDay と同じ順序: 期限を過ぎた未払金を払い、払えなければ融資、それでもだめなら破産）
  payArrears(s, ctx);
  let bc = bankruptcyCheck(s);
  let loan = false;
  if (bc.overdue > 0 && opts.allowLoan && loanAvailable(s)) {
    takeLoan(s, ctx);
    payArrears(s, ctx);
    bc = bankruptcyCheck(s);
    loan = true;
  }
  if (bc.overdue > 0) {
    const reason = `期限を過ぎた未払金 ¥${bc.overdue.toLocaleString('ja-JP')} を支払えない`;
    declareBankruptcy(s, ctx, reason);
    return { bankrupt: true, loan, reason };
  }
  runAbsentStores(s, ctx, day);
  recordCompanyDay(s, day);
  startNextDay(s, ctx, false);
  return { bankrupt: false, loan };
}

/** 自動営業で、日付 day を、group の企業について全社そろえて進める */
function autoPlayDate(m: MarketState, day: number, group: MarketCompany[], periodId: DateKey): void {
  for (const c of group) recordLedger(m, c, day, false);
  const demands = new Map(group.map((c) => [c.id, demandFor(m, c, day)]));
  for (const c of group) {
    const r = autoPlayDay(c.state, day, demands.get(c.id)!, { allowLoan: true });
    c.progress.stateVersion += 1;
    c.progress.processingVersion = B().autoSimVersion;
    if (r.loan) log(m, c.id, '支払いの期限を過ぎた未払金があり、緊急融資を受けました', day);
    if (r.bankrupt) {
      c.status = 'bankrupt';
      c.bankruptDay = day;
      log(m, c.id, `${c.name}は資金が尽きて破産し、市場から消えました`, day);
      continue;
    }
    c.progress.lastProcessedGameDate = day;
    c.progress.autoSimulationDays += 1;
    c.progress.totalAutoDays += 1;
    c.days.push(dayRecord(c.state, day, periodId, 'auto', null));
  }
  for (const c of group) if (c.kind === 'ai' && c.status === 'active') aiDecide(m, c, day);
}

// ───────────────────────── 0時の同期（仕様書 3.4） ─────────────────────────

export type SyncStep =
  | { status: 'idle' }
  /** 営業中の日を待っている（until まで） */
  | { status: 'waiting'; until: number; periodId: DateKey }
  /** 続きがある（すぐにもう一度呼ぶ） */
  | { status: 'more'; periodId: DateKey }
  /** 全社がそろった。ランキングを書いてから finishSync を呼ぶ */
  | { status: 'ranking'; periodId: DateKey };

/** 次に同期する期間（なければ null） */
export function nextSyncPeriod(m: MarketState, now: number): DateKey | null {
  if (m.sync && m.sync.status !== 'done') return m.sync.periodId;
  const today = jstDateKey(now);
  return m.pendingPeriods.find((p) => p < today) ?? null;
}

/** 次に同期を始める時刻（なければ null）。期間の終わり（JST の0時） */
export function nextSyncAt(m: MarketState, now: number): number | null {
  if (m.sync && m.sync.status !== 'done') return now;
  const p = m.pendingPeriods[0];
  if (!p) return null;
  return Math.max(now, jstMidnight(addDays(p, 1)));
}

/**
 * 同期を進める（何度呼んでも同じ結果。途中で止まっても続きから）。budget: この呼び出しで自動営業する企業・日の数
 */
export function runSync(m: MarketState, now: number, budget: number = B().syncBudget): SyncStep {
  const periodId = nextSyncPeriod(m, now);
  if (!periodId) return { status: 'idle' };
  if (!m.sync || m.sync.status === 'done' || m.sync.periodId !== periodId) {
    m.sync = { periodId, status: 'closing', targetDate: null, startedAt: now, closeDeadline: closeDeadline(periodId), finishedAt: null, autoDays: 0, expiredDays: 0 };
  }
  const run = m.sync;
  if (run.status === 'closing') {
    const open = activeCompanies(m).filter((c) => c.openDay && c.openDay.periodId <= periodId);
    if (open.length > 0 && now < run.closeDeadline) return { status: 'waiting', until: run.closeDeadline, periodId };
    for (const c of open) {
      log(m, c.id, `${c.openDay!.gameDate}日目は0時から30分を過ぎても届かなかったため無効になりました`, c.openDay!.gameDate);
      c.openDay = null;
      run.expiredDays += 1;
    }
    const live = activeCompanies(m);
    run.targetDate = live.length > 0 ? Math.max(...live.map((c) => c.progress.lastProcessedGameDate)) : m.commonMarketDate;
    for (const c of live) {
      c.progress.autoSimulationDays = 0;
      c.progress.synchronizationStatus = 'syncing';
    }
    run.status = 'syncing';
  }
  if (run.status === 'syncing') {
    const target = run.targetDate ?? m.commonMarketDate;
    let used = 0;
    for (;;) {
      const lag = activeCompanies(m).filter((c) => c.progress.lastProcessedGameDate < target);
      if (lag.length === 0) break;
      const day = Math.min(...lag.map((c) => c.progress.lastProcessedGameDate)) + 1;
      const group = lag.filter((c) => c.progress.lastProcessedGameDate === day - 1);
      autoPlayDate(m, day, group, periodId);
      used += group.length;
      run.autoDays += group.length;
      if (used >= budget) return { status: 'more', periodId };
    }
    const from = m.commonMarketDate + 1;
    m.commonMarketDate = Math.max(m.commonMarketDate, target);
    for (let d = from; d <= m.commonMarketDate; d++) m.history.push(marketDayLine(m, d));
    if (m.history.length > 60) m.history.splice(0, m.history.length - 60);
    for (const key of Object.keys(m.ledger)) if (Number(key) <= m.commonMarketDate) delete m.ledger[key];
    run.status = 'ranking';
  }
  return { status: 'ranking', periodId };
}

/** ランキングを書き終えたあとに、同期を終える（新しい期間を始める） */
export function finishSync(m: MarketState, now: number): void {
  const run = m.sync;
  if (!run || run.status !== 'ranking') return;
  for (const c of m.companies) {
    if (c.status === 'active') c.progress.synchronizationStatus = 'synced';
    c.progress.lastProcessedPeriod = run.periodId;
    c.progress.manualProgressDays = 0;
    const keep = B().keepDayRecords;
    c.days = c.days.filter((r, i) => r.periodId > run.periodId || i >= c.days.length - keep);
  }
  m.pendingPeriods = m.pendingPeriods.filter((p) => p !== run.periodId);
  run.status = 'done';
  run.finishedAt = now;
  m.syncLog.push({ ...run });
  if (m.syncLog.length > 60) m.syncLog.splice(0, m.syncLog.length - 60);
}

/** 期間ごとの企業の集計（ランキングのもと。上限を超えた日は数えない） */
export interface CompanyPeriodSummary {
  companyId: Id;
  name: string;
  kind: 'player' | 'ai';
  ownerId: string | null;
  periodId: DateKey;
  days: number;
  manualDays: number;
  autoDays: number;
  flaggedDays: number;
  netSales: number;
  operatingProfit: number;
  finalProfit: number;
  served: number;
  customers: number;
  satisfactionSum: number;
  satisfactionCount: number;
  /** 同じ期間の市場全体の純売上（市場シェアの分母） */
  marketNetSales: number;
  moneyEnd: number;
  debtEnd: number;
  stores: number;
}

export function periodSummary(m: MarketState, periodId: DateKey): CompanyPeriodSummary[] {
  const out: CompanyPeriodSummary[] = [];
  let market = 0;
  for (const c of m.companies) {
    const rs = c.days.filter((r) => r.periodId === periodId);
    if (rs.length === 0) continue;
    const ok = rs.filter((r) => !r.flags);
    const last = rs[rs.length - 1]!;
    const sum = (k: keyof CompanyDayRecord) => ok.reduce((a, r) => a + (r[k] as number), 0);
    const line: CompanyPeriodSummary = {
      companyId: c.id,
      name: c.name,
      kind: c.kind,
      ownerId: c.ownerId,
      periodId,
      days: ok.length,
      manualDays: ok.filter((r) => r.source === 'manual').length,
      autoDays: ok.filter((r) => r.source === 'auto').length,
      flaggedDays: rs.length - ok.length,
      netSales: sum('netSales'),
      operatingProfit: sum('operatingProfit'),
      finalProfit: sum('finalProfit'),
      served: sum('served'),
      customers: sum('customers'),
      satisfactionSum: sum('satisfactionSum'),
      satisfactionCount: sum('satisfactionCount'),
      marketNetSales: 0,
      moneyEnd: last.money,
      debtEnd: last.debt,
      stores: last.stores,
    };
    market += line.netSales;
    out.push(line);
  }
  for (const x of out) x.marketNetSales = market;
  return out;
}

/** その企業の市場シェア（直近 shareDays 日の純売上の割合。市場の合計が0なら0） */
export function marketShare(m: MarketState, companyId: Id, upToDay = m.commonMarketDate): number {
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
    companies: m.companies
      .filter((c) => c.joinedDay <= day && c.status !== 'moved')
      .map((c) => {
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
          bankrupt: c.status === 'bankrupt' || c.status === 'retired',
        };
      }),
  };
}

// ───────────────────────── 古い市場の移行 ─────────────────────────

/**
 * 古い市場（schema 1: サーバーの時計で全社一斉に進む）を新しい形にする。企業・店舗・お金・従業員はそのまま。
 * 全社が同じ日付まで済んでいるので、その日付を全社が営業済みの日付にする
 */
export function migrateMarket(raw: Record<string, unknown>, now: number): MarketState | null {
  if (raw.schema === MARKET_SCHEMA) return raw as unknown as MarketState;
  if (raw.schema !== 1 || !Array.isArray(raw.companies)) return null;
  const day = typeof raw.day === 'number' ? raw.day : 1;
  const done = day - 1;
  const ctx = ctxOf();
  const companies = (raw.companies as Record<string, unknown>[]).map((c) => {
    const s = c.state as GameState;
    // 日と日の間の「閉店後」から、その日の仕込みの状態へ（届いた荷物を受け取る）
    s.day = day;
    if (s.phase === 'closed') {
      receiveDeliveries(s, ctx, true);
      s.phase = 'prep';
    }
    s.prepSnapshot = null;
    s.company.ownerStoreId = s.company.activeStoreId;
    const bankrupt = c.bankruptDay !== null && c.bankruptDay !== undefined;
    const mc: MarketCompany = {
      id: String(c.id),
      name: String(c.name),
      kind: c.kind === 'ai' ? 'ai' : 'player',
      ownerId: typeof c.ownerId === 'string' ? c.ownerId : null,
      strategy: (c.strategy as AiStrategy | null) ?? null,
      homeArea: String(c.homeArea),
      joinedDay: typeof c.joinedDay === 'number' ? c.joinedDay : 1,
      status: bankrupt ? (c.kind === 'ai' ? 'retired' : 'bankrupt') : 'active',
      bankruptDay: bankrupt ? (c.bankruptDay as number) : null,
      state: s,
      memory: (c.memory as { lastPriceDay: number }) ?? { lastPriceDay: -99 },
      progress: newProgress(done),
      openDay: null,
      lastCommit: null,
      days: [],
    };
    return mc;
  });
  return {
    schema: MARKET_SCHEMA,
    id: String(raw.id),
    name: String(raw.name),
    seed: Number(raw.seed) >>> 0,
    createdAt: now,
    settings: DEFAULT_SETTINGS(now),
    commonMarketDate: done,
    pendingPeriods: [],
    sync: null,
    syncLog: [],
    ledger: {},
    companies,
    decisions: Array.isArray(raw.decisions) ? (raw.decisions as MarketDecision[]) : [],
    history: Array.isArray(raw.history) ? (raw.history as MarketDayReport[]) : [],
  };
}

// ───────────────────────── プレイヤーの操作（サーバーで適用する経営の操作） ─────────────────────────

/**
 * サーバーで適用できる経営の操作（端末で営業していない間に、市場の画面から変えるもの）。
 * 店の中で動く操作・日を進める操作は使えない（日は端末の営業と0時の同期で進む）
 */
export const MARKET_ACTIONS: ReadonlySet<Action['type']> = new Set<Action['type']>([
  'setStorePolicy',
  'assignManager',
  'transferEmployee',
  'openStore',
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

/** プレイヤー企業の操作を適用する（市場の規則の確認のあと、ひとりプレイと同じ core の操作で）。状態の版を上げる */
export function marketAction(m: MarketState, ownerId: string, a: Action, now = 0): ActionResult {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, reason: 'この市場に参加していません' };
  if (c.status !== 'active') return { ok: false, reason: '破産しています' };
  if (c.openDay) return { ok: false, reason: '端末で営業中です。営業の画面から操作してください' };
  if (syncPending(m, now)) return { ok: false, reason: '0時の計算中です。終わるまでお待ちください' };
  if (!a || typeof a !== 'object' || !MARKET_ACTIONS.has(a.type)) return { ok: false, reason: '市場では使えない操作です' };
  if (a.type === 'buyEquipment' && a.autoPlace !== true) return { ok: false, reason: '市場では設備は自動で置きます' };
  if (a.type === 'openStore' && freeSlots(m, a.propertyId) <= 0) return { ok: false, reason: `${areaName(a.propertyId)}の物件は空いていません（ほかの企業が出店しています）` };
  const phase = c.state.phase;
  c.state.phase = 'closed';
  const r = applyAction(c.state, 'p1', a, ctxOf());
  c.state.phase = phase;
  if (!r.ok) return r;
  c.progress.stateVersion += 1;
  if (a.type === 'rename') c.name = c.state.shopName;
  if (a.type === 'openStore') {
    const st = c.state.company.stores[c.state.company.stores.length - 1]!;
    st.openedDay = c.progress.lastProcessedGameDate;
    log(m, c.id, `${areaName(a.propertyId)}に出店しました（${st.name}）`);
  }
  return r;
}

// ───────────────────────── AI 企業 ─────────────────────────

function act(c: MarketCompany, a: Action): boolean {
  const phase = c.state.phase;
  c.state.phase = 'closed';
  const ok = applyAction(c.state, 'p1', a, ctxOf()).ok;
  c.state.phase = phase;
  return ok;
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

/** 市場の企業の一覧（全社がそろった最後の日の行。シェアの高い順） */
export function marketStandings(m: MarketState): MarketCompanyLine[] {
  const last = m.history[m.history.length - 1];
  const lines = last
    ? last.companies
    : m.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, netSales: 0, operatingProfit: 0, money: c.state.money, stores: c.state.company.stores.length, share: 0, bankrupt: c.status !== 'active' }));
  return [...lines].sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || b.share - a.share || b.money - a.money);
}

/** 市場の画面に出す、ほかの企業の様子（お金の細かい中身は出さない） */
export interface MarketCompanyView {
  id: Id;
  name: string;
  kind: 'player' | 'ai';
  strategy: string | null;
  homeArea: string;
  stores: { name: string; area: string; seats: number; reputation: number }[];
  share: number;
  /** 全社がそろった最後の日の純売上・営業利益 */
  netSales: number;
  operatingProfit: number;
  bankrupt: boolean;
  status: CompanyStatus;
  mine: boolean;
  /** その企業の営業が済んだ日付と、今の期間に手動で進めた日数 */
  lastDay: number;
  manualDays: number;
  /** 端末で営業中 */
  playing: boolean;
  synchronizationStatus: SynchronizationStatus;
}

/** プレイヤー1人に見せる市場（自分の企業だけ中身ごと） */
export interface MarketView {
  id: string;
  name: string;
  settings: CommunitySettings;
  /** 全社が営業済みの日付（0 ならまだ1日も営業していない） */
  day: number;
  commonMarketDate: number;
  /** いちばん進んだ企業の日付（次の同期の目標の見込み） */
  leaderDay: number;
  companies: MarketCompanyView[];
  decisions: MarketDecision[];
  history: MarketDayReport[];
  /** 自分の企業（参加していなければ null） */
  mine: { companyId: Id; state: GameState; progress: CompanyProgress; openDay: OpenDay | null; lastCommit: CommitResult | null; days: CompanyDayRecord[] } | null;
  /** 出店先の地域ごとの空いている物件の数 */
  freeSlots: Record<string, number>;
  /** 同期の状態（進行中・直近） */
  sync: SyncRun | null;
  lastSync: SyncRun | null;
  pendingPeriods: DateKey[];
}

export function marketView(m: MarketState, ownerId: string | null): MarketView {
  const last = m.history[m.history.length - 1];
  const me = ownerId ? playerCompany(m, ownerId) : null;
  const companies = m.companies
    .filter((c) => c.status !== 'moved')
    .map((c): MarketCompanyView => {
      const line = last?.companies.find((x) => x.id === c.id);
      return {
        id: c.id,
        name: c.name,
        kind: c.kind,
        strategy: c.strategy,
        homeArea: areaName(c.homeArea),
        stores: c.state.company.stores.map((entry) => {
          const st = storeStatus(c.state, entry);
          return { name: entry.name, area: areaName(storeArea(c, entry)), seats: STAGES[st.stage]?.seats.length ?? 8, reputation: Math.round(st.reputation * 100) / 100 };
        }),
        share: marketShare(m, c.id),
        netSales: line?.netSales ?? 0,
        operatingProfit: line?.operatingProfit ?? 0,
        bankrupt: c.status === 'bankrupt' || c.status === 'retired',
        status: c.status,
        mine: c === me,
        lastDay: c.progress.lastProcessedGameDate,
        manualDays: c.progress.manualProgressDays,
        playing: c.openDay !== null,
        synchronizationStatus: c.progress.synchronizationStatus,
      };
    });
  companies.sort((a, b) => Number(a.bankrupt) - Number(b.bankrupt) || b.share - a.share);
  const free: Record<string, number> = {};
  for (const pid of PROPERTY_CANDIDATES) free[pid] = freeSlots(m, pid);
  const live = activeCompanies(m);
  return {
    id: m.id,
    name: m.name,
    settings: m.settings,
    day: m.commonMarketDate,
    commonMarketDate: m.commonMarketDate,
    leaderDay: live.length > 0 ? Math.max(...live.map((c) => c.progress.lastProcessedGameDate)) : m.commonMarketDate,
    companies,
    decisions: m.decisions.slice(-60),
    history: m.history.slice(-30),
    mine: me
      ? { companyId: me.id, state: me.state, progress: me.progress, openDay: me.openDay, lastCommit: me.lastCommit ? (({ token: _t, ...r }) => r)(me.lastCommit) : null, days: me.days.slice(-30) }
      : null,
    freeSlots: free,
    sync: m.sync && m.sync.status !== 'done' ? m.sync : null,
    lastSync: m.syncLog[m.syncLog.length - 1] ?? null,
    pendingPeriods: [...m.pendingPeriods],
  };
}

/** 次の同期（JST の0時）の時刻。同期がなければ次の0時 */
export function nextMidnight(now: number): number {
  return nextJstMidnight(now);
}
