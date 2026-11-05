// 出店の場所（日本地図の出店マップ。docs/STORE_MAP_PLAN.md）。
// 店ごとに市区町村のコード（5桁）を持ち、その人口で来客と家賃の倍率を少し変える（オーナーの判断「人口で少し変わる」）。
// 場所のない店（前のセーブの店・場所を決めていない1店目）は ×1（今までと同じ）。

import { BALANCE } from '../data/balance';
import { MUNICIPALITIES, PREFECTURES } from '../data/municipalities';
import { PROPERTIES, PROPERTY_CANDIDATES } from '../data/properties';
import type { StoreEntry } from '../types';

export interface LocationInfo {
  /** 市区町村のコード（5桁） */
  code: string;
  prefCode: string;
  prefName: string;
  name: string;
  population: number;
  /** 人口指数（−1〜1。0 が標準の人口） */
  index: number;
  demand: number;
  rent: number;
}

const L = () => BALANCE.location;

/** 人口指数（10万人で 0、1万人以下で −1、100万人以上で 1） */
export function populationIndex(population: number): number {
  const z = Math.log10(Math.max(1, population) / L().refPopulation);
  return Math.max(-1, Math.min(1, z));
}

/** 市区町村の情報（コードが表にないときは null） */
export function locationInfo(code: string | null | undefined): LocationInfo | null {
  if (!code) return null;
  const row = MUNICIPALITIES[code];
  if (!row) return null;
  const [prefCode, name, population] = row;
  const index = populationIndex(population);
  return {
    code,
    prefCode,
    prefName: PREFECTURES[prefCode] ?? '',
    name,
    population,
    index,
    demand: 1 + L().demandSpan * index,
    rent: 1 + L().rentSpan * index,
  };
}

/** 場所の表示名（「大阪府 大阪市」など。場所がなければ空） */
export function locationLabel(code: string | null | undefined): string {
  const l = locationInfo(code);
  return l ? `${l.prefName} ${l.name}` : '';
}

/** その場所に出店できない理由（できるなら null）。人口のない区域（北方領土など）には出店できない */
export function locationProblem(code: string | null | undefined): string | null {
  if (!code) return null;
  const l = locationInfo(code);
  if (!l) return '出店先の市区町村が見つかりません';
  if (l.population <= 0) return `${l.name}には出店できません（人口がいない区域です）`;
  return null;
}

/** 店の来客の倍率（立地 × 場所の人口） */
export function storeDemandMult(entry: StoreEntry | null | undefined): number {
  if (!entry) return 1;
  const prop = PROPERTIES[entry.propertyId] ?? PROPERTIES.home!;
  return prop.demand * (locationInfo(entry.location)?.demand ?? 1);
}

/** 店の家賃の倍率（立地 × 場所の人口） */
export function storeRentMult(entry: StoreEntry | null | undefined): number {
  if (!entry) return 1;
  const prop = PROPERTIES[entry.propertyId] ?? PROPERTIES.home!;
  return prop.rentMult * (locationInfo(entry.location)?.rent ?? 1);
}

/** その市区町村の出店候補地（駅前・住宅街・郊外の3か所。架空の物件） */
export function candidateSites(code: string): { propertyId: string; name: string; area: string }[] {
  const l = locationInfo(code);
  if (!l) return [];
  return PROPERTY_CANDIDATES.map((id) => {
    const p = PROPERTIES[id]!;
    return { propertyId: id, area: p.area, name: `${l.name} ${p.area}` };
  });
}
