// 出店のときの見込み（じろ2: 改修設計書03 §5）。想定人口・想定客数・家賃・仕入れ値の水準・地域の物価・競合の数・値段の許容度・
// 予想売上・予想利益・初期投資・投資回収の見込みを出す。見込みは今の店の来客と最近の日報から計算した目安で、実際とは違う
// （オーナーの判断: 利益は保証しない）。過密（同じ場所・同じ市区町村に店が多い）なら注意を出す
import { BALANCE } from '../data/balance';
import { PROPERTIES } from '../data/properties';
import { STAGES } from '../data/stages';
import type { GameState, StoreEntry } from '../types';
import type { DayReport } from '../types';
import { activeStore, DEFAULT_POLICY, takeStore } from './company';
import { expectedDailyArrivals } from './customers';
import { locationInfo, siteStats, storeDemandMult, storePurchaseMult, storeRentMult } from './location';
import { generateCandidate, makeEmployee } from './employees';
import { runManagerDay } from './manager';
import { makeCtx } from './notices';
import { fullTimeWageFor, initNewHire } from './staff';
import { fillNewStore } from '../state';
import { clamp } from '../util';

export interface SiteForecast {
  population: number;
  daytimePopulation: number | null;
  dayNightRatio: number | null;
  retail: number | null;
  food: number | null;
  traffic: string;
  /** 想定客数（人/日。競合を入れた見込み） */
  customers: number;
  /** 家賃（円/日） */
  rent: number;
  /** 仕入れ値の水準（全国 = 1） */
  purchaseLevel: number;
  /** 地域の物価（全国 = 100） */
  priceIndex: number;
  /** 値段の許容度（定価のこの倍率まで高いと感じない） */
  tolerance: number;
  /** 競合の数（同じ場所・同じ市区町村の別の場所。自分の店も入れる） */
  rivalsSame: number;
  rivalsNear: number;
  /** 予想売上・予想利益（円/日） */
  sales: number;
  profit: number;
  /** 1日に出せる杯数の見込みと、席・人手で決まる上限（店長＋接客担当のアルバイト1人の目安） */
  served: number;
  capacity: number;
  initialCost: number;
  /** 投資回収の見込み（日。利益が出ない見込みなら null） */
  paybackDays: number | null;
  /** 過密の注意（なければ null） */
  crowded: string | null;
}

/** 見込みの注意（画面に必ず出す） */
export const FORECAST_DISCLAIMER = '見込みは、店長（社員）＋接客担当のアルバイト1人・定価で営業したときの店長の営業の計算（席と人手の上限・給与・家賃・維持費・光熱費・修理を入れる）で、出店から3週目の1日の平均の目安です。実際の来客・売上・利益は、評判・値段・人手・競合の動きで変わります（利益は保証されません）';

/**
 * 出店したときの1日の見込みを、店長の営業（runManagerDay）でそのまま計算する。今の状態の写しの上に、その物件の新しい店
 * （初期の設備・席・在庫、評判は出店のときと同じ引き継ぎ）と、店長（社員・能力0.65）＋接客担当のアルバイト1人（能力0.6・毎日出られる）を作り、
 * 定価・方針の初期値で3週間営業し、3週目の平均（開いた日だけ）を返す。元の状態は変えない（写しで計算する）
 */
const FORECAST_DAYS = 21;
type ModelResult = { sales: number; profit: number; served: number; capacity: number; arrivals: number };
/** 同じ日・同じ場所の見込みは覚えておく（地図を開くたびに3週間分を計算しない） */
const forecastCache = new Map<string, ModelResult>();

function modelForecast(s: GameState, code: string, propertyId: string, demandMult: number): ModelResult {
  const key = `${s.day}:${code}:${propertyId}:${demandMult.toFixed(4)}:${s.reputation.toFixed(2)}:${s.company.stores.length}:${Object.values(s.prices).join(',')}`;
  const hit = forecastCache.get(key);
  if (hit) return hit;
  const out = modelForecastRun(s, code, propertyId, demandMult);
  if (forecastCache.size > 200) forecastCache.clear();
  forecastCache.set(key, out);
  return out;
}

function modelForecastRun(s: GameState, code: string, propertyId: string, demandMult: number): ModelResult {
  const p = PROPERTIES[propertyId] ?? PROPERTIES.home!;
  const t = JSON.parse(JSON.stringify(s)) as GameState;
  const prices = { ...t.prices };
  const fromRep = t.reputation;
  // 仮の店長とアルバイト（候補の作り方で作り、能力と雇い方を目安にそろえる）
  const mk = (skill: number, role: 'cook' | 'server') => {
    const c = generateCandidate(t);
    c.profile.role = role;
    c.profile.skills = { speed: skill, cooking: skill, service: skill, hygiene: skill, movement: skill };
    return makeEmployee(t, c);
  };
  const mgr = mk(0.65, 'cook');
  mgr.profile.employment = 'full';
  // 店長の日給は、アルバイトを社員にしたときと同じ決め方
  mgr.profile.wage = fullTimeWageFor(mgr);
  const part = mk(0.6, 'server');
  part.profile.wishDays = [true, true, true, true, true, true, true];
  initNewHire(part);
  takeStore(t);
  fillNewStore(t, p.stage);
  t.prices = prices;
  t.autoOrderMode = 'sales';
  t.employees = [mgr, part];
  for (const e of t.employees) e.presentToday = false;
  const R = BALANCE.reputation.initial;
  t.reputation = clamp(R + (fromRep - R) * BALANCE.company.brandCarry, 1, 5);
  t.arrears = [];
  t.loans = [];
  t.money = Math.max(t.money, 10_000_000);
  t.phase = 'closed';
  const entry: StoreEntry = { id: '_forecast', name: '', propertyId, location: code, openedDay: t.day - 1, managerId: mgr.id, policy: { ...DEFAULT_POLICY }, snapshot: null };
  t.company.stores = [entry];
  t.company.activeStoreId = entry.id;
  t.company.history = [];
  const ctx = makeCtx();
  // 3週間営業して、慣れた3週目（評判が近づき、店員の疲れ・休みも入る）の平均を見込みにする
  const reps: DayReport[] = [];
  let capacity = 0;
  for (let d = 1; d <= FORECAST_DAYS; d++) {
    t.day += 1;
    const r = runManagerDay(t, entry, t.day, ctx, { demandMult });
    if (r.managed === 'manager' && d > FORECAST_DAYS - 7) reps.push(r);
  }
  // 席・人手の上限（読むだけ）
  capacity = Math.round(Math.max(0, ...reps.map((r) => r.served)));
  const avg = (f: (r: DayReport) => number) => (reps.length > 0 ? reps.reduce((a, r) => a + f(r), 0) / reps.length : 0);
  return { sales: Math.round(avg((r) => r.netSales ?? r.sales - r.refunds)), profit: Math.round(avg((r) => r.operatingProfit)), served: Math.round(avg((r) => r.served)), capacity, arrivals: Math.round(avg((r) => r.customers + r.balked)) };
}

/**
 * 出店の見込み。others: ほかの会社の店の場所（共通市場。ひとりの経営では空）。自分の会社の店も取り合いに入れる（同じ会社の食い合い）
 */
export function siteForecast(s: GameState, code: string, propertyId: string, others: { location: string; propertyId: string }[] = [], includeOwn = true): SiteForecast {
  const p = PROPERTIES[propertyId] ?? PROPERTIES.home!;
  const l = locationInfo(code);
  const st = siteStats(code, propertyId);
  const cand: StoreEntry = { ...activeStore(s), id: '_candidate', propertyId, location: code };
  const here = activeStore(s);
  // 想定客数: 今の店の見込み（評判・値段を入れた来客）を、場所の倍率の比で置きかえる
  const base = expectedDailyArrivals(s, { events: false });
  const raw = (base / Math.max(0.05, storeDemandMult(here))) * storeDemandMult(cand);
  const mine = includeOwn ? s.company.stores.filter((x) => x.location).map((x) => ({ location: x.location!, propertyId: x.propertyId })) : [];
  const all = [...mine, ...others];
  const rivalsSame = all.filter((x) => x.location === code && x.propertyId === propertyId).length;
  const rivalsNear = all.filter((x) => x.location === code && x.propertyId !== propertyId).length;
  const k = BALANCE.market.competition;
  // 同じくらいの店と取り合うとして（新店の話題性・段階的な取り合いは入れない。慣れたあとの見込み）
  const customers = Math.round(raw / (1 + k * (rivalsSame + BALANCE.market.nearShare * rivalsNear)));
  const rent = Math.round((STAGES[p.stage]?.rent ?? 0) * storeRentMult(cand));
  // 売上・利益は、店長の営業と同じ計算で出す（じろ6 の調査: 前の見込みは席と人手の上限を考えず、駅前などで実際と大きくずれていた）
  const m = modelForecast(s, code, propertyId, raw > 0 ? customers / raw : 1);
  const sales = m.sales;
  const profit = m.profit;
  // 想定客数も同じ計算の来店の見込み（その物件の広さ・新しい店の評判・競合を入れる）
  const visitors = m.arrivals > 0 ? m.arrivals : customers;
  const E = BALANCE.market.entry;
  const crowded =
    rivalsSame >= E.crowdedSite
      ? `過密: この場所にはもう${rivalsSame}店あります（客の取り合いが強い）`
      : rivalsSame + rivalsNear >= E.crowdedCity
        ? `過密: この市区町村にはもう${rivalsSame + rivalsNear}店あります`
        : null;
  return {
    population: l?.population ?? 0,
    daytimePopulation: st.daytimePopulation,
    dayNightRatio: st.dayNightRatio,
    retail: st.retail,
    food: st.food,
    traffic: st.trafficLabel,
    customers: visitors,
    rent,
    purchaseLevel: storePurchaseMult(cand),
    priceIndex: l?.priceIndex ?? 100,
    tolerance: l?.tolerance ?? 1,
    rivalsSame,
    rivalsNear,
    sales,
    profit,
    served: m.served,
    capacity: m.capacity,
    initialCost: p.initialCost,
    paybackDays: profit > 0 ? Math.ceil(p.initialCost / profit) : null,
    crowded,
  };
}
