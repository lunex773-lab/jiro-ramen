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
import type { GameState, Id, MarketScope, StoreEntry } from './types';
import { hashString } from './util';
import { lastCompanyDay, verifyCommit } from './verify';
import { shiftGameDays } from './sim/rebase';
import { applyAction, type Action, type ActionResult } from './sim/actions';
import { activeStore, companyPolicyOf, recordCompanyDay, storeReport, withStore } from './sim/company';
import { withPlannedAds } from './sim/ads';
import { expectedDailyArrivals, priceRatio } from './sim/customers';
import { bankruptcyCheck, checkGoals, declareBankruptcy, loanAvailable, payArrears, rescueLoanAmount, startNextDay, takeLoan } from './sim/day';
import { cash, finalProfit, totalDebt } from './sim/economy';
import { refreshCandidates } from './sim/employees';
import { employeeSatisfaction, enterpriseValue, storeQuality } from './sim/metrics';
import { receiveDeliveries, runAutoOrder } from './sim/inventory';
import { expansionInfo } from './sim/layout';
import { planManagerDay, runManagerDay, standaloneArrivals } from './sim/manager';
import { makeCtx } from './sim/notices';
import { cleanStoreName, openStoreProblem, runAbsentStores, storeStatus } from './sim/stores';
import { locationLabel, locationProblem, MARKET_SCOPE_LABEL, MARKET_SCOPES } from './sim/location';
import { creditOp, creditsFor, exitCredits, flushCredits, settleCredits, type CompanyCredit, type CreditOp, type CreditResult, type PendingCredit } from './credit';

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
  /** 従業員満足度（0〜1。従業員がいなければ null）・店舗品質（0〜1）・その日の始めと終わりの企業価値（純資産。sim/metrics.ts） */
  employeeSat?: number | null;
  quality?: number;
  valueStart?: number;
  value?: number;
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
  /**
   * 市場の街（市区町村のコード5桁。出店マップ。オーナーの判断「市場は1つの街」）。全社の店はこの街の駅前・住宅街・郊外にある。
   * 前の市場にはない → null（場所の倍率 ×1）
   */
  cityCode?: string | null;
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
  /** 今自動営業している日付の、企業ごとの客の取り合いの倍率（同じ日付を何回かに分けて計算するときに同じ値を使う） */
  dayDemand?: { day: number; demand: Record<string, Record<string, number>> };
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
  /** 企業間の貸し借りの契約（じろ2: 改修設計書04。古い市場にはない） */
  credits?: CompanyCredit[];
  creditSeq?: number;
  /** 端末で営業中の会社に、営業が終わったら入れるお金 */
  pendingCredits?: PendingCredit[];
  /** 設定の変更の記録（新しいものが後ろ。最大50件。古い市場にはない） */
  settingsLog?: SettingsChange[];
}

/** 市場の設定の変更の記録（いつ・誰が・何を） */
export interface SettingsChange {
  at: number;
  /** 変えた人（作った人のプレイヤー id） */
  by: string;
  /** 変えたときの市場の日付 */
  day: number;
  changes: { key: string; from: string; to: string }[];
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
  placeInCity(m, c.state);
  m.companies.push(c);
  return c;
}

export const DEFAULT_SETTINGS = (now: number): CommunitySettings => ({
  description: '',
  visibility: 'invite',
  maxCompanies: B().defaultCompanies,
  periodDays: null,
  startsAt: now,
  endsAt: null,
  entry: 'grown',
  aiFill: true,
  cityCode: null,
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
    cityCode: typeof raw.cityCode === 'string' && !locationProblem(raw.cityCode) ? raw.cityCode : null,
  };
}

/** 会社の店をすべて市場の街に置く（市場は1つの街。作るとき・入るとき・育てた会社を持ってきたとき） */
export function placeInCity(m: MarketState, s: GameState): void {
  const city = m.settings.cityCode;
  if (!city) return;
  for (const st of s.company.stores) st.location = city;
  // 出店の範囲ははじめ市場の街の中だけ（じろ1 Q13。市場の成績で広がる）
  s.company.marketRange = { city, scope: 'city' };
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
export function joinMarket(m: MarketState, ownerId: string, companyName: string, now?: number): { ok: boolean; reason?: string; company?: MarketCompany } {
  const mine = playerCompany(m, ownerId);
  if (mine) return { ok: true, company: mine };
  if (now !== undefined && isEnded(m, now)) return { ok: false, reason: 'この市場の競争期間は終わっています' };
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

/** 作った人があとから変えられる設定（オーナーの指示。期間・街・参加の種類・値段の決まりは途中で変えない） */
export interface MarketSettingsPatch {
  name?: string;
  description?: string;
  visibility?: 'public' | 'invite';
  aiFill?: boolean;
  maxCompanies?: number;
}

/**
 * 市場の設定を変える（作った人かどうかはサーバーが確かめる）。会社の数の上限は、参加しているプレイヤーの会社の数より下げられない。
 * 上限を下げて会社が多すぎるときは、市場シェアがいちばん小さい AI 企業から撤退する。AI で埋める設定で空きがあれば、AI 企業が参加する
 * （次の営業日から）。AI で埋めるのをやめても、今いる AI 企業はそのまま
 */
export function updateMarketSettings(m: MarketState, patch: MarketSettingsPatch, meta?: { by: string; now: number }): { ok: boolean; reason?: string; changed: string[] } {
  const changed: string[] = [];
  const st = m.settings;
  const before = settingsText(m);
  if (patch.name !== undefined) {
    const name = String(patch.name).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
    if (name.length === 0) return { ok: false, reason: '市場の名前を入れてください', changed };
    if (name !== m.name) {
      m.name = name;
      changed.push('name');
    }
  }
  if (patch.description !== undefined) {
    const d = String(patch.description).trim().slice(0, 200);
    if (d !== st.description) {
      st.description = d;
      changed.push('description');
    }
  }
  if (patch.visibility !== undefined) {
    const v = patch.visibility === 'public' ? 'public' : 'invite';
    if (v !== st.visibility) {
      st.visibility = v;
      changed.push('visibility');
    }
  }
  let max = st.maxCompanies;
  if (patch.maxCompanies !== undefined) {
    max = Math.round(Number(patch.maxCompanies));
    if (!Number.isFinite(max) || max < B().minCompanies || max > B().maxCompanies) return { ok: false, reason: `会社の数の上限は${B().minCompanies}〜${B().maxCompanies}社です`, changed };
    const humans = activeCompanies(m).filter((c) => c.kind === 'player').length;
    if (max < humans) return { ok: false, reason: `参加しているプレイヤーの会社（${humans}社）より少なくはできません`, changed };
  }
  const aiFill = patch.aiFill === undefined ? st.aiFill : patch.aiFill !== false;
  if (aiFill !== st.aiFill) {
    st.aiFill = aiFill;
    changed.push('aiFill');
  }
  if (max !== st.maxCompanies) {
    st.maxCompanies = max;
    changed.push('maxCompanies');
  }
  // 多すぎる AI 企業は撤退する（市場シェアの小さい順）
  while (activeCompanies(m).length > st.maxCompanies) {
    const ai = activeCompanies(m)
      .filter((c) => c.kind === 'ai')
      .sort((a, b) => marketShare(m, a.id) - marketShare(m, b.id) || b.joinedDay - a.joinedDay)[0];
    if (!ai) break;
    ai.status = 'retired';
    ai.bankruptDay = ai.progress.lastProcessedGameDate;
    log(m, ai.id, `市場の会社の数の上限が${st.maxCompanies}社になり、市場から撤退しました`);
  }
  // AI で埋める: 空いた枠に、まだいない AI 企業が参加する
  if (st.aiFill && (changed.includes('aiFill') || changed.includes('maxCompanies'))) {
    const used = new Set(activeCompanies(m).map((c) => c.name));
    for (const a of AI_COMPANIES) {
      if (activeCompanies(m).length >= st.maxCompanies) break;
      if (used.has(a.name)) continue;
      const c = addCompany(m, 'ai', a.name, null, a.strategy);
      log(m, c.id, `${c.name}が市場に参加しました（${c.joinedDay}日目から）`);
    }
  }
  // 変更の記録（いつ・誰が・何を。じろ2: 改修設計書04）
  if (changed.length > 0 && meta) {
    const after = settingsText(m);
    const changes = changed.map((key) => ({ key, from: before[key] ?? '', to: after[key] ?? '' }));
    (m.settingsLog ??= []).push({ at: meta.now, by: meta.by, day: m.commonMarketDate, changes });
    if (m.settingsLog.length > 50) m.settingsLog.splice(0, m.settingsLog.length - 50);
  }
  return { ok: true, changed };
}

/** 設定の項目の名前（変更の確認・記録に出す） */
export const SETTINGS_LABEL: Record<string, string> = {
  name: '市場の名前',
  description: '説明',
  visibility: '公開',
  aiFill: '空いた枠を AI 企業で埋める',
  maxCompanies: '会社の数の上限',
};

/** 設定の今の値（記録用の文字） */
export function settingsText(m: Pick<MarketState, 'name' | 'settings'>): Record<string, string> {
  const st = m.settings;
  return {
    name: m.name,
    description: st.description || '（なし）',
    visibility: st.visibility === 'public' ? '公開' : '招待コードだけ',
    aiFill: st.aiFill ? '埋める' : '埋めない',
    maxCompanies: `${st.maxCompanies}社`,
  };
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

/** 市場の店の市区町村（場所のない店は市場の街） */
export function storeLocationIn(m: MarketState, entry: StoreEntry): string {
  return entry.location ?? m.settings.cityCode ?? '';
}

/**
 * その出店先の、空いている物件の数。物件は市区町村ごと（じろ1 Q11: 市場の店も街の外に出せる）。location を省くと市場の街
 */
export function freeSlots(m: MarketState, propertyId: string, location?: string | null): number {
  const total = B().branchSlots[propertyId] ?? 0;
  const at = location ?? m.settings.cityCode ?? '';
  let used = 0;
  for (const c of activeCompanies(m)) used += c.state.company.stores.filter((x) => x.propertyId === propertyId && storeLocationIn(m, x) === at).length;
  return Math.max(0, total - used);
}

// ───────────────────────── 出店の範囲（じろ1 Q13） ─────────────────────────

export interface MarketRangeCheck {
  key: 'cityStores' | 'share' | 'cityFull' | 'stores' | 'profit' | 'rank';
  label: string;
  ok: boolean;
}

/** その会社の出店の範囲と、次の範囲へ広がる条件の様子（読むだけ）。街のない市場は null */
export function marketRangeChecks(m: MarketState, c: MarketCompany): { scope: MarketScope; next: MarketScope | null; checks: MarketRangeCheck[]; ready: boolean; either?: boolean } | null {
  const city = m.settings.cityCode;
  if (!city) return null;
  const R = B().range;
  const scope = c.state.company.marketRange?.city === city ? c.state.company.marketRange.scope : 'city';
  const next = MARKET_SCOPES[MARKET_SCOPES.indexOf(scope) + 1] ?? null;
  if (!next) return { scope, next: null, checks: [], ready: false };
  const live = activeCompanies(m);
  const avg = live.length > 0 ? 1 / live.length : 1;
  const share = marketShare(m, c.id);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const stores = c.state.company.stores;
  const hist = c.state.company.history;
  const opLast = (n: number) => hist.slice(-n).reduce((a, r) => a + r.operatingProfit, 0);
  if (next === 'prefecture') {
    const inCity = stores.filter((x) => storeLocationIn(m, x) === city).length;
    const full = PROPERTY_CANDIDATES.every((pid) => freeSlots(m, pid, city) <= 0);
    const checks: MarketRangeCheck[] = [
      { key: 'cityStores', label: `市場の街に${R.prefectureCityStores}店以上（今 ${inCity}店）`, ok: inCity >= R.prefectureCityStores },
      { key: 'share', label: `市場シェアが平均以上（今 ${pct(share)}・平均 ${pct(avg)}）`, ok: share >= avg - 1e-9 && share > 0 },
      { key: 'cityFull', label: 'または、市場の街の物件が満室', ok: full },
    ];
    return { scope, next, checks, ready: (checks[0]!.ok && checks[1]!.ok) || full, either: true };
  }
  if (next === 'region') {
    const need = avg * R.regionShareOfAvg;
    const op = opLast(7);
    const checks: MarketRangeCheck[] = [
      { key: 'stores', label: `店が${R.regionStores}店以上（今 ${stores.length}店）`, ok: stores.length >= R.regionStores },
      { key: 'share', label: `市場シェアが${pct(need)}以上（今 ${pct(share)}）`, ok: share >= need - 1e-9 },
      { key: 'profit', label: `直近7日の営業利益（全店）が黒字（今 ${op >= 0 ? '' : '−'}¥${Math.abs(Math.round(op)).toLocaleString('ja-JP')}）`, ok: hist.length >= 7 && op > 0 },
    ];
    return { scope, next, checks, ready: checks.every((x) => x.ok) };
  }
  const top = live.every((o) => o.id === c.id || marketShare(m, o.id) <= share);
  const op = opLast(30);
  const checks: MarketRangeCheck[] = [
    { key: 'stores', label: `店が${R.nationalStores}店以上（今 ${stores.length}店）`, ok: stores.length >= R.nationalStores },
    { key: 'rank', label: `市場シェアが1位（今 ${pct(share)}）`, ok: top && share > 0 },
    { key: 'profit', label: `直近30日の営業利益（全店）が黒字（今 ${op >= 0 ? '' : '−'}¥${Math.abs(Math.round(op)).toLocaleString('ja-JP')}）`, ok: hist.length >= 7 && op > 0 },
  ];
  return { scope, next, checks, ready: checks.every((x) => x.ok) };
}

/**
 * 出店の範囲を、条件を満たしていれば広げる（一度広がった範囲は戻らない）。市場のサーバーだけが決める（端末から届いた値は使わない）
 */
export function refreshMarketRange(m: MarketState, c: MarketCompany, day = m.commonMarketDate): void {
  const city = m.settings.cityCode;
  if (!city) return;
  const cur = c.state.company.marketRange;
  if (!cur || cur.city !== city) c.state.company.marketRange = { city, scope: 'city' };
  // AI 企業は市場の街の中だけ
  if (c.kind === 'ai') return;
  for (let i = 0; i < 3; i++) {
    const r = marketRangeChecks(m, c);
    if (!r || !r.next || !r.ready) break;
    c.state.company.marketRange = { city, scope: r.next };
    log(m, c.id, `出店の範囲が「${MARKET_SCOPE_LABEL[r.next]}」に広がりました`, day);
  }
}

/** 客を取り合う単位: 同じ市区町村の同じ地域（本店は企業の本店の商店街、ほかは物件の種類） */
/**
 * 店の見込み（競合なしの来客の見込み。人/日）。manual: 端末で営業する日（プレイヤーがいる店は今の値段で）。
 * そうでなければ方針の値段（店長の営業・自動営業）。プレイヤーがいる店の値段は書き換えない
 */
export function storeAttractiveness(s: GameState, entry: StoreEntry, manual: boolean, day: number): number {
  if (entry.openedDay >= day) return 0;
  const isActive = entry.id === s.company.activeStoreId;
  if (isActive && manual) {
    if (s.closedForConstruction > 0) return 0;
    return withPlannedAds(s, entry, () => expectedDailyArrivals(s, { events: false }));
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
  type Site = { id: string; company: Id; loc: string; area: string; opened: number; d: number };
  const site = (o: MarketCompany, entry: StoreEntry, d: number): Site => ({ id: entry.id, company: o.id, loc: storeLocationIn(m, entry), area: storeArea(o, entry), opened: entry.openedDay, d: d * entryNovelty(entry.openedDay, day) });
  const own: Site[] = c.state.company.stores.map((entry) => site(c, entry, row[lkey(c, entry)] ?? storeAttractiveness(c.state, entry, false, day)));
  const others: Site[] = [];
  for (const o of activeCompanies(m)) {
    if (o.id === c.id) continue;
    const passed = o.progress.lastProcessedGameDate >= day || (o.openDay?.gameDate === day);
    for (const entry of o.state.company.stores) {
      const recorded = row[lkey(o, entry)];
      const d = recorded !== undefined ? recorded : passed ? 0 : storeAttractiveness(o.state, entry, false, day);
      if (d > 0) others.push(site(o, entry, d));
    }
  }
  const out: Record<string, number> = {};
  for (const x of own) {
    if (x.d <= 0) {
      out[x.id] = 1;
      continue;
    }
    // 取り合う相手: ほかの会社の店と、同じ会社のほかの店（近いほど強く。新しい店は段階的に）
    let rivals = 0;
    for (const y of [...others, ...own]) {
      if (y === x || y.d <= 0) continue;
      const w = siteWeight(x.loc, x.area, y.loc, y.area);
      if (w > 0) rivals += w * entryRamp(Math.max(x.opened, y.opened), day) * y.d;
    }
    out[x.id] = x.d / (x.d + k * rivals);
  }
  return out;
}

/** 2つの店の取り合いの近さ（同じ市区町村の同じ場所 = 1、同じ市区町村の別の場所 = nearShare、ほかの市区町村 = 0） */
export function siteWeight(locA: string, areaA: string, locB: string, areaB: string): number {
  if (locA !== locB) return 0;
  return areaA === areaB ? 1 : B().nearShare;
}

/** 新店の話題性: 開店から noveltyDays 日は取り合いの重みが noveltyMult 倍 → 1 倍（じろ2） */
export function entryNovelty(openedDay: number, day: number): number {
  const E = B().entry;
  const age = day - openedDay;
  if (age > E.noveltyDays) return 1;
  return 1 + (E.noveltyMult - 1) * Math.max(0, Math.min(1, (E.noveltyDays - age + 1) / E.noveltyDays));
}

/** 新しい店とほかの店の取り合いの強さ: 新しいほうの店の開店から rampDays 日かけて 0 → 1（じろ2） */
export function entryRamp(newerOpenedDay: number, day: number): number {
  return Math.max(0, Math.min(1, (day - newerOpenedDay) / B().entry.rampDays));
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
  /** 監査記録に残す気になる点（受け取りには影響しない。仕様書 7「不自然な価格操作の検知」など） */
  watch?: string[];
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
  // 競争期間が終わった市場は、0時の同期をしない（営業は続けられる。オーナーの判断 16）
  if (!isEnded(m, now) && !m.pendingPeriods.includes(periodId)) {
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

function dayRecord(s: GameState, day: number, periodId: DateKey, source: 'manual' | 'auto', flags: string[] | null, valueStart: number): CompanyDayRecord {
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
    employeeSat: employeeSatisfaction(s),
    quality: storeQuality(s),
    valueStart,
    value: enterpriseValue(s),
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
    // 営業が終わった: 営業中に待っていたお金（企業間の返済など）を入れる
    if (!c.openDay) flushCredits(m, c, now);
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
  const valueStart = enterpriseValue(c.state);
  // 出店の範囲は市場のサーバーが決める（端末から届いた値は使わない）
  const range = c.state.company.marketRange;
  // サーバーが決める値（企業間の貸し借りの残り・債務不履行）は端末から届いた値を使わない
  const blocked = c.state.creditBlocked;
  const book = c.state.companyCredit;
  c.state = sanitize(next, o.demand);
  if (range) c.state.company.marketRange = range;
  else delete c.state.company.marketRange;
  if (blocked) c.state.creditBlocked = blocked;
  else delete c.state.creditBlocked;
  if (book) c.state.companyCredit = book;
  else delete c.state.companyCredit;
  // 端末の経営メニューで屋号を変えていれば、市場の会社の名前も合わせる
  c.name = cleanStoreName(c.state.shopName) || c.name;
  c.state.shopName = c.name;
  c.openDay = null;
  c.progress.stateVersion += 1;
  c.progress.synchronizationStatus = 'idle';
  if (v.bankrupt) {
    c.status = 'bankrupt';
    c.bankruptDay = o.gameDate;
    log(m, c.id, `${c.name}は資金が尽きて破産し、市場から消えました`, o.gameDate);
    exitCredits(m, c, now, '破産した');
    return done({ ok: true, gameDate: o.gameDate, stateVersion: c.progress.stateVersion, bankrupt: true, flags: v.flags });
  }
  c.progress.lastProcessedGameDate = o.gameDate;
  c.progress.manualProgressDays += 1;
  c.progress.totalManualDays += 1;
  c.days.push(dayRecord(c.state, o.gameDate, o.periodId, 'manual', v.flags, valueStart));
  refreshMarketRange(m, c, o.gameDate);
  if (isEnded(m, jstMidnight(o.periodId))) {
    // 終わった市場の日は集計しない（記録は直近だけ残す）
    if (c.days.length > B().keepDayRecords) c.days.splice(0, c.days.length - B().keepDayRecords);
  } else if (!m.pendingPeriods.includes(o.periodId)) {
    m.pendingPeriods.push(o.periodId);
    m.pendingPeriods.sort();
  }
  const watch = watchPoints(c.state);
  return done({ ok: true, gameDate: o.gameDate, stateVersion: c.progress.stateVersion, flags: v.flags.length > 0 ? v.flags : undefined, watch: watch.length > 0 ? watch : undefined });
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
  /** 閉店後（次の日の朝の前）の経営の判断（AI 企業の判断・方針による拡張）。ひとりプレイの「閉店後に決める」と同じ時点 */
  evening?: (s: GameState) => void;
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
    // 翌朝便の自動発注（手動の営業の精算と同じ。プレイヤーの発注の設定で）。以前は自動営業の日に発注しなかったため、
    // 自動営業のあとの朝に納品がなく、在庫が減ったまま・仕込んだ品が期限切れでなくなった状態で営業を始めていた（オーナーの報告）
    if (active.openedDay < day) runAutoOrder(s, ctx);
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
    takeLoan(s, ctx, rescueLoanAmount(s, bc.overdue));
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
  opts.evening?.(s);
  s.day = day;
  s.phase = 'closed';
  startNextDay(s, ctx, false);
  return { bankrupt: false, loan };
}

/** 自動営業で、日付 day を、group の企業について全社そろえて進める */
/**
 * 同じ日付の遅れた企業を自動営業する（limit 社まで。残りは次の呼び出しで）。客の取り合いの倍率は、その日付の最初の呼び出しで
 * 全社分を計算して同期の状態に置き、続きの呼び出しでも同じ値を使う（一度に計算したときと同じ結果）。営業した社数を返す
 */
function autoPlayDate(m: MarketState, day: number, group: MarketCompany[], periodId: DateKey, limit = Infinity): number {
  const run = m.sync;
  let demand = run?.dayDemand && run.dayDemand.day === day ? run.dayDemand.demand : null;
  if (!demand) {
    for (const c of group) recordLedger(m, c, day, false);
    demand = Object.fromEntries(group.map((c) => [c.id, demandFor(m, c, day)]));
    if (run) run.dayDemand = { day, demand };
  }
  const demands = new Map(group.map((c) => [c.id, demand[c.id] ?? demandFor(m, c, day)]));
  const todo = group.slice(0, Math.max(1, limit));
  for (const c of todo) {
    // 借入は、AI 企業はいつでも、プレイヤー企業は方針で許可したときだけ（仕様書 4.3: 重大な借入は許可されない限り自動でしない）
    const pol = companyPolicyOf(c.state);
    // 閉店後の判断: AI 企業の判断、プレイヤー企業は方針で許可していれば本店の拡張（AI 企業と同じ条件）
    const evening = c.kind === 'ai' ? () => aiDecide(m, c, day) : pol.allowExpansion ? () => autoExpand(m, c, '自動経営の方針で') : undefined;
    const valueStart = enterpriseValue(c.state);
    const r = autoPlayDay(c.state, day, demands.get(c.id)!, { allowLoan: c.kind === 'ai' || pol.allowLoan, evening });
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
    c.days.push(dayRecord(c.state, day, periodId, 'auto', null, valueStart));
    refreshMarketRange(m, c, day);
  }
  return todo.length;
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
      // 1回の呼び出しで budget 社・日まで（25社の市場でも1回の CPU 時間が増えないように、同じ日付の会社も分ける）
      const n = autoPlayDate(m, day, group, periodId, budget - used);
      used += n;
      run.autoDays += n;
      if (used >= budget) return { status: 'more', periodId };
    }
    const from = m.commonMarketDate + 1;
    m.commonMarketDate = Math.max(m.commonMarketDate, target);
    for (let d = from; d <= m.commonMarketDate; d++) m.history.push(marketDayLine(m, d));
    if (m.history.length > 60) m.history.splice(0, m.history.length - 60);
    for (const key of Object.keys(m.ledger)) if (Number(key) <= m.commonMarketDate) delete m.ledger[key];
    // 企業間の貸し借り: 利息・期限の日の自動の返済・延滞・不履行（全社がそろい、端末で営業中の会社はない）
    settleCredits(m, now, isEnded(m, now));
    delete run.dayDemand;
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

/**
 * 気になる点（受け取りやランキングには影響しない。監査記録に残して、誤検知と正当な経営を人が見分けられるようにする。仕様書 7）。
 * 値段が定価から大きく離れている（平均で定価の0.6倍未満・2倍超）
 */
export function watchPoints(s: GameState): string[] {
  const out: string[] = [];
  const r = priceRatio(s);
  if (r < 0.6 || r > 2) out.push(`値段が定価から大きく離れている（平均で定価の${Math.round(r * 100)}%）`);
  return out;
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
  /** 従業員満足度の合計と日数・店舗品質の合計と日数（上限を超えた日は数えない）・期間の始めと終わりの企業価値 */
  empSatSum: number;
  empSatDays: number;
  qualitySum: number;
  qualityDays: number;
  valueStart: number;
  valueEnd: number;
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
      empSatSum: ok.reduce((a, r) => a + (typeof r.employeeSat === 'number' ? r.employeeSat : 0), 0),
      empSatDays: ok.filter((r) => typeof r.employeeSat === 'number').length,
      qualitySum: ok.reduce((a, r) => a + (r.quality ?? 0), 0),
      qualityDays: ok.filter((r) => typeof r.quality === 'number').length,
      valueStart: rs[0]!.valueStart ?? rs[0]!.money - rs[0]!.debt,
      valueEnd: last.value ?? last.money - last.debt,
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

// ───────────────────────── コミュニティの終わり・会社の移動（仕様書 6.2） ─────────────────────────

/** 競争期間が終わったか（無期限なら終わらない） */
export function isEnded(m: MarketState, now: number): boolean {
  return m.settings.endsAt !== null && now >= m.settings.endsAt;
}

/** 別の市場へ持っていく会社（育てた会社で参加する。オーナーの判断 15） */
export interface ExportedCompany {
  name: string;
  state: GameState;
  fromMarketId: string;
  fromCompanyId: Id;
}

/**
 * 終わった市場から会社を出す（別のコミュニティへ移す）。会社は「移った」になり、この市場では営業しない（記録は残す）。
 * 移す先で受け取れなかったときは restoreCompany で戻す
 */
export function exportCompany(m: MarketState, ownerId: string, now: number): { ok: boolean; reason?: string; company?: ExportedCompany } {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, reason: 'この市場に会社がありません' };
  if (c.status !== 'active') return { ok: false, reason: '営業している会社だけ移せます' };
  if (!isEnded(m, now)) return { ok: false, reason: '競争期間が終わってから、別のコミュニティへ移せます' };
  if (c.openDay) return { ok: false, reason: '端末で営業中です' };
  c.status = 'moved';
  c.bankruptDay = c.progress.lastProcessedGameDate;
  log(m, c.id, `${c.name}は別のコミュニティへ移りました`);
  return { ok: true, company: { name: c.name, state: JSON.parse(JSON.stringify(c.state)) as GameState, fromMarketId: m.id, fromCompanyId: c.id } };
}

/** 移す先で受け取れなかった会社を、元の市場に戻す */
export function restoreCompany(m: MarketState, ownerId: string): boolean {
  const c = m.companies.find((x) => x.kind === 'player' && x.ownerId === ownerId && x.status === 'moved');
  if (!c) return false;
  c.status = 'active';
  c.bankruptDay = null;
  return true;
}

/**
 * 育てた会社で市場に入る（「育てた企業で参加できる」市場だけ）。お金・店・従業員・在庫・評判はそのままで、
 * 会社の暦をこの市場の次の日付にずらす（オーナーの判断 15）
 */
export function importCompany(m: MarketState, ownerId: string, exp: ExportedCompany, now: number): { ok: boolean; reason?: string; company?: MarketCompany } {
  if (m.settings.entry !== 'grown') return { ok: false, reason: 'この市場は新規の企業だけが参加できます' };
  if (isEnded(m, now)) return { ok: false, reason: 'この市場の競争期間は終わっています' };
  if (playerCompany(m, ownerId)) return { ok: false, reason: 'この市場にはもう会社があります' };
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
  const s = exp.state;
  const day = m.commonMarketDate + 1;
  const delta = day - (lastCompanyDay(s) + 1);
  shiftGameDays(s, delta);
  s.prepSnapshot = null;
  s.marketDemand = null;
  s.company.ownerStoreId = s.company.activeStoreId;
  const idx = m.companies.length;
  const c: MarketCompany = {
    id: `c${idx + 1}`,
    name: cleanName(exp.name),
    kind: 'player',
    ownerId,
    strategy: null,
    homeArea: nextHomeArea(m),
    joinedDay: day,
    status: 'active',
    bankruptDay: null,
    state: s,
    memory: { lastPriceDay: -99 },
    progress: newProgress(day - 1),
    openDay: null,
    lastCommit: null,
    days: [],
  };
  placeInCity(m, c.state);
  m.companies.push(c);
  log(m, c.id, `${c.name}が育てた会社で参加しました（資金 ¥${s.money.toLocaleString('ja-JP')}・${s.company.stores.length}店。${day}日目から）`);
  return { ok: true, company: c };
}

/**
 * 会社を引退させる（記録と順位は残る。1人が持てる会社の数から外れる）。じろ2（改修設計書04。オーナーの判断「引退として抜ける」）:
 * 競争中でも自分から抜けられる。店は市場から消え、同じ会社では戻れない（新しい会社なら入り直せる）。
 * 企業間の借金は現金から返せるだけ返し、残りは貸し手の損。返事待ちの申し込みは取り消す
 */
export function retireCompany(m: MarketState, ownerId: string, now: number): { ok: boolean; reason?: string } {
  const c = m.companies.find((x) => x.kind === 'player' && x.ownerId === ownerId && (x.status === 'active' || x.status === 'bankrupt'));
  if (!c) return { ok: false, reason: 'この市場に会社がありません' };
  if (c.status === 'active' && syncPending(m, now)) return { ok: false, reason: '0時の計算中です。終わるまでお待ちください' };
  // 端末で営業中の日は取り消す（その日は数えない）
  if (c.openDay) {
    c.openDay = null;
    c.progress.synchronizationStatus = 'idle';
  }
  const wasActive = c.status === 'active';
  c.status = 'retired';
  if (wasActive) c.bankruptDay = c.progress.lastProcessedGameDate;
  exitCredits(m, c, now, wasActive ? '市場を抜けた' : '破産した');
  log(m, c.id, wasActive && !isEnded(m, now) ? `${c.name}は市場を抜けて引退しました（記録と順位は残ります。店は市場から消えました）` : `${c.name}は引退しました（記録は残ります）`);
  return { ok: true };
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
  'setStoreHours',
  'autoShifts',
  'setCompanyPolicy',
  'setRestDays',
  'setShift',
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
  'promoteLeader',
  'setPrepTarget',
  'takeLoan',
  'payArrears',
  'setAutoOrderMode',
  'setAutoOrderItem',
  'rename',
  'renameStore',
]);

/** プレイヤー企業の操作を適用する（市場の規則の確認のあと、ひとりプレイと同じ core の操作で）。状態の版を上げる */
export function marketAction(m: MarketState, ownerId: string, a: Action, now = 0): ActionResult {
  const c = playerCompany(m, ownerId);
  if (!c) return { ok: false, reason: 'この市場に参加していません' };
  if (c.status !== 'active') return { ok: false, reason: '破産しています' };
  // 端末で営業中の日があっても、市場の画面から変えられる（オーナーの指示 2026-11-11）。営業中の日は、端末で続けるときに
  // サーバーの今の状態から初めてやり直すので、ここで変えたことはその日に入る（状態の版を上げる）
  if (syncPending(m, now)) return { ok: false, reason: '0時の計算中です。終わるまでお待ちください' };
  if (!a || typeof a !== 'object' || !MARKET_ACTIONS.has(a.type)) return { ok: false, reason: '市場では使えない操作です' };
  refreshMarketRange(m, c);
  if (a.type === 'buyEquipment' && a.autoPlace !== true) return { ok: false, reason: '市場では設備は自動で置きます' };
  if (a.type === 'openStore') {
    // 市場の店も、ひとりの経営と同じ範囲（本店 = 市場の街から）に出せる（じろ1 Q11）。場所を指定しなければ市場の街
    const location = a.location ?? m.settings.cityCode ?? undefined;
    const bad = locationProblem(location);
    if (bad) return { ok: false, reason: bad };
    if (freeSlots(m, a.propertyId, location) <= 0) return { ok: false, reason: `${areaName(a.propertyId)}の物件は空いていません（ほかの企業が出店しています）` };
    a = { ...a, location };
  }
  const phase = c.state.phase;
  c.state.phase = 'closed';
  const r = applyAction(c.state, 'p1', a, ctxOf());
  c.state.phase = phase;
  if (!r.ok) return r;
  c.progress.stateVersion += 1;
  if (a.type === 'rename' || a.type === 'renameStore') c.name = c.state.shopName;
  if (a.type === 'openStore') {
    const st = c.state.company.stores[c.state.company.stores.length - 1]!;
    st.openedDay = c.progress.lastProcessedGameDate;
    log(m, c.id, `${areaName(a.propertyId)}に出店しました（${st.name}）`);
  }
  return r;
}

/** 企業間の貸し借りの操作（申し込む・承認する・断る・取り消す・前倒しで返す）。サーバーだけが呼ぶ */
export function marketCredit(m: MarketState, ownerId: string, op: CreditOp, now: number): CreditResult {
  const me = playerCompany(m, ownerId);
  if (!me) return { ok: false, reason: 'この市場に参加していません' };
  return creditOp(m, { me, now, syncing: syncPending(m, now), ended: isEnded(m, now) }, op);
}

// ───────────────────────── AI 企業 ─────────────────────────

function act(c: MarketCompany, a: Action, city?: string | null): boolean {
  if (a.type === 'openStore' && city) a = { ...a, location: city };
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
  autoExpand(m, c, '資金がたまったので');
  // 4) 出店
  const order: Record<AiStrategy, string[]> = { budget: ['residential', 'roadside', 'station'], standard: ['roadside', 'residential', 'station'], premium: ['station', 'roadside', 'residential'] };
  // AI 企業は市場の街の中だけに、決まった数まで出す
  if (s.company.stores.length < BALANCE.company.aiMaxStores) {
    for (const pid of order[strategy]) {
      const prop = PROPERTIES[pid];
      if (!prop || !PROPERTY_CANDIDATES.includes(pid) || freeSlots(m, pid) <= 0) continue;
      if (s.company.stores.some((x) => x.propertyId === pid)) continue;
      if (s.money < prop.initialCost + BALANCE.company.minFundsAfterOpen + reserve) break;
      // 店長: 今の本店の調理担当を社員にして任せる（いなければ見送る）
      const cook = s.employees.filter((e) => e.profile.role === 'cook').sort((a, b) => b.profile.skills.cooking - a.profile.skills.cooking)[0];
      if (!cook) break;
      if (cook.profile.employment !== 'full') act(c, { type: 'promote', employeeId: cook.id });
      if (openStoreProblem(s, pid, cook.id, m.settings.cityCode ?? null)) break;
      if (act(c, { type: 'openStore', propertyId: pid, managerId: cook.id }, m.settings.cityCode)) {
        const st = s.company.stores[s.company.stores.length - 1]!;
        st.openedDay = day;
        st.policy.priceMult = base;
        log(m, c.id, `${areaName(pid)}に出店しました（${st.name}・初期費用 ¥${prop.initialCost.toLocaleString('ja-JP')}。${prop.description}）`);
      }
      break;
    }
  }
}

/**
 * 本店の12席への拡張（工事費＋席＋冷蔵庫＋工事後の手元資金＋余裕がたまったら）と、拡張したあとの席・2台目の冷蔵庫。
 * AI 企業の判断と、プレイヤー企業の自動経営の方針（拡張を許可したとき）で同じ条件を使う
 */
function autoExpand(m: MarketState, c: MarketCompany, why: string): void {
  const s = c.state;
  const A = BALANCE.market.ai;
  const reserve = A.reserve;
  const home = s.company.stores[0]!;
  if (home.id !== s.company.activeStoreId) return;
  const info = expansionInfo(s);
  if (info.next && info.next.id === 1 && info.canExpand) {
    const seats = (info.next.seats.length - STAGES[s.career.stage]!.seats.length) * SEAT_PRICE;
    const fridge = EQUIPMENT.fridge?.price ?? 0;
    if (s.money >= info.cost + info.next.minFundsAfter + seats + fridge + A.expandReserve && act(c, { type: 'expand' })) {
      log(m, c.id, `${why}本店を12席に拡張しました（工事費 ¥${info.cost.toLocaleString('ja-JP')}）`);
    }
  }
  if (s.career.stage >= 1) {
    for (const seat of s.seats) if (!seat.installed && seat.index < STAGES[s.career.stage]!.seats.length && s.money > SEAT_PRICE + reserve) act(c, { type: 'buySeat', seatIndex: seat.index });
    if (s.equipment.filter((e) => EQUIPMENT[e.type]?.role === 'fridge').length < 2 && s.money > (EQUIPMENT.fridge?.price ?? 0) + reserve && act(c, { type: 'buyEquipment', equipType: 'fridge', autoPlace: true })) {
      log(m, c.id, '12席で冷蔵庫が足りないので2台目を買いました');
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
  /** 企業間の借金で債務不履行になっている（新しく貸せない） */
  defaulted?: boolean;
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
  mine: {
    companyId: Id;
    state: GameState;
    progress: CompanyProgress;
    openDay: OpenDay | null;
    lastCommit: CommitResult | null;
    days: CompanyDayRecord[];
    range?: ReturnType<typeof marketRangeChecks>;
    /** 自分が貸し手・借り手の企業間の契約（新しい順） */
    credits?: CompanyCredit[];
  } | null;
  /** 設定の変更の記録（新しい順） */
  settingsLog?: SettingsChange[];
  /** 出店先の地域ごとの空いている物件の数（市場の街） */
  freeSlots: Record<string, number>;
  /** 全社の店の場所と物件（市区町村ごとの空きを数える。じろ1 Q11） */
  sites: { location: string; propertyId: string }[];
  /** 見ている人のこの市場での会社の状態（移った・引退した会社も。参加していなければ null） */
  myStatus: CompanyStatus | null;
  /** 競争期間が終わった（0時の同期とランキングはない。営業は続けられる） */
  ended?: boolean;
  /** 同期の状態（進行中・直近） */
  sync: SyncRun | null;
  lastSync: SyncRun | null;
  /** 0時の同期の記録（新しい順・最大30件。仕様書 8.4 の競争履歴） */
  syncLog: SyncRun[];
  pendingPeriods: DateKey[];
}

export function marketView(m: MarketState, ownerId: string | null, now?: number): MarketView {
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
          const loc = storeLocationIn(m, entry);
          const where = loc && loc !== m.settings.cityCode ? `${locationLabel(loc)} ` : '';
          return { name: entry.name, area: `${where}${areaName(storeArea(c, entry))}`, seats: STAGES[st.stage]?.seats.length ?? 8, reputation: Math.round(st.reputation * 100) / 100 };
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
        defaulted: !!c.state.creditBlocked,
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
      ? {
          companyId: me.id,
          state: me.state,
          progress: me.progress,
          openDay: me.openDay,
          lastCommit: me.lastCommit ? (({ token: _t, ...r }) => r)(me.lastCommit) : null,
          days: me.days.slice(-30),
          range: marketRangeChecks(m, me),
          credits: creditsFor(m, me.id),
        }
      : null,
    settingsLog: (m.settingsLog ?? []).slice().reverse(),
    freeSlots: free,
    sites: live.flatMap((c) => c.state.company.stores.filter((x) => x.propertyId !== 'home').map((x) => ({ location: storeLocationIn(m, x), propertyId: x.propertyId }))),
    myStatus: me?.status ?? (ownerId ? ([...m.companies].reverse().find((c) => c.kind === 'player' && c.ownerId === ownerId)?.status ?? null) : null),
    ended: now !== undefined ? isEnded(m, now) : undefined,
    sync: m.sync && m.sync.status !== 'done' ? m.sync : null,
    lastSync: m.syncLog[m.syncLog.length - 1] ?? null,
    syncLog: m.syncLog.slice(-30).reverse(),
    pendingPeriods: [...m.pendingPeriods],
  };
}

/** 次の同期（JST の0時）の時刻。同期がなければ次の0時 */
export function nextMidnight(now: number): number {
  return nextJstMidnight(now);
}
