// 出店のときの見込み（じろ2: 改修設計書03 §5）。想定人口・想定客数・家賃・仕入れ値の水準・地域の物価・競合の数・値段の許容度・
// 予想売上・予想利益・初期投資・投資回収の見込みを出す。見込みは今の店の来客と最近の日報から計算した目安で、実際とは違う
// （オーナーの判断: 利益は保証しない）。過密（同じ場所・同じ市区町村に店が多い）なら注意を出す
import { BALANCE } from '../data/balance';
import { PROPERTIES } from '../data/properties';
import { STAGES } from '../data/stages';
import type { GameState, StoreEntry } from '../types';
import { activeStore } from './company';
import { expectedDailyArrivals } from './customers';
import { locationInfo, siteStats, storeDemandMult, storePurchaseMult, storeRentMult } from './location';
import { minWageOf } from './wages';

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
  initialCost: number;
  /** 投資回収の見込み（日。利益が出ない見込みなら null） */
  paybackDays: number | null;
  /** 過密の注意（なければ null） */
  crowded: string | null;
}

/** 見込みの注意（画面に必ず出す） */
export const FORECAST_DISCLAIMER = '見込みは今の店の来客と最近の日報から計算した目安です。実際の来客・売上・利益は、評判・値段・人手・競合の動きで変わります（利益は保証されません）';

/** 最近の日報の客単価（純売上 ÷ 杯数）と原価率。なければ目安 */
function recentEconomics(s: GameState): { ticket: number; cogsRate: number; servedRate: number } {
  const rows = s.history.filter((r) => r.served > 0).slice(-7);
  const served = rows.reduce((a, r) => a + r.served, 0);
  const sales = rows.reduce((a, r) => a + (r.sales - r.refunds), 0);
  const cogs = rows.reduce((a, r) => a + r.cogs + r.waste, 0);
  const visits = rows.reduce((a, r) => a + r.customers + r.balked, 0);
  return {
    ticket: served > 0 ? sales / served : 1_000,
    cogsRate: sales > 0 ? Math.min(0.7, cogs / sales) : 0.35,
    servedRate: visits > 0 ? Math.min(1, served / visits) : 0.85,
  };
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
  const eco = recentEconomics(s);
  const served = customers * eco.servedRate;
  const sales = Math.round(served * eco.ticket);
  const rent = Math.round((STAGES[p.stage]?.rent ?? 0) * storeRentMult(cand));
  // 人件費の目安: その都道府県の最低賃金で、店長（社員）1人の仕込みから閉店まで（1.3倍）と、アルバイト1人の4時間
  const minWage = minWageOf(code);
  const wages = Math.round(BALANCE.staff.employment.fullShiftHours * minWage * 1.3 + 4 * minWage);
  const profit = Math.round(sales * (1 - eco.cogsRate) - rent - wages - BALANCE.utilitiesBase);
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
    customers,
    rent,
    purchaseLevel: storePurchaseMult(cand),
    priceIndex: l?.priceIndex ?? 100,
    tolerance: l?.tolerance ?? 1,
    rivalsSame,
    rivalsNear,
    sales,
    profit,
    initialCost: p.initialCost,
    paybackDays: profit > 0 ? Math.ceil(p.initialCost / profit) : null,
    crowded,
  };
}
