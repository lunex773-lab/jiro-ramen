// 出店の場所（日本地図の出店マップ。docs/STORE_MAP_PLAN.md）と地域の経済（じろ1 5.5・5.6。docs/JIRO1_PLAN.md）。
// 店ごとに市区町村のコード（5桁）を持ち、人口・人口密度・都道府県の物価と所得から、来客・家賃・仕入れ値・値段の許容度を少し変える
// （オーナーの判断「少し差がある」: どこでも慣れていない人が1〜2週間で黒字にできる範囲で、場所ごとに得意・不得意が出る）。
// 場所のない店（前のセーブの店・場所を決めていない1店目）は ×1（今までと同じ）。

import { BALANCE } from '../data/balance';
import { MUNICIPALITY_AREA_KM2 } from '../data/areas';
import { MUNICIPALITIES, PREFECTURES } from '../data/municipalities';
import { PROPERTIES, PROPERTY_CANDIDATES } from '../data/properties';
import { NATIONAL_ECONOMY, PREFECTURE_ECONOMY } from '../data/regional';
import type { GameState, MarketScope, StoreEntry } from '../types';

/** 地方と都道府県（出店の範囲。出店マップの地方と同じ） */
export const REGION_PREFS: Readonly<Record<string, readonly string[]>> = {
  北海道: ['01'],
  東北: ['02', '03', '04', '05', '06', '07'],
  関東: ['08', '09', '10', '11', '12', '13', '14'],
  中部: ['15', '16', '17', '18', '19', '20', '21', '22', '23'],
  近畿: ['24', '25', '26', '27', '28', '29', '30'],
  中国: ['31', '32', '33', '34', '35'],
  四国: ['36', '37', '38', '39'],
  '九州・沖縄': ['40', '41', '42', '43', '44', '45', '46', '47'],
};

/** 都道府県のコード（2桁）の地方 */
export function regionOfPref(pref: string): string {
  return Object.entries(REGION_PREFS).find(([, list]) => list.includes(pref))?.[0] ?? '';
}

export interface LocationInfo {
  /** 市区町村のコード（5桁） */
  code: string;
  prefCode: string;
  prefName: string;
  /** 地方（関東・近畿など） */
  region: string;
  name: string;
  population: number;
  /** 人口指数（−1〜1。0 が標準の人口） */
  index: number;
  /** 面積（km²。地図の形から） */
  areaKm2: number;
  /** 人口密度（人/km²） */
  density: number;
  /** 人口密度の指数（−1〜1。1,000人/km² で 0） */
  densityIndex: number;
  /** 1人当たり県民所得の全国との比 */
  incomeRatio: number;
  /** 消費者物価地域差指数（総合・食料。全国 = 100） */
  priceIndex: number;
  foodIndex: number;
  /** 来客の倍率 */
  demand: number;
  /** 家賃の倍率 */
  rent: number;
  /** 仕入れ値の倍率 */
  purchase: number;
  /** 地域の購買力（所得・物価・人口密度から。1 = 全国の標準） */
  buyingPower: number;
  /** 値段の許容度（定価のこの倍率までなら高いとは感じない。1以上。都会・高所得ほど高い） */
  tolerance: number;
  /** 基準より高いときの敏感さの倍率（1以上。田舎・所得が低いほど大きい） */
  priceSensitivity: number;
  /** 量の多いメニュー（大・豚の多い品）の好まれ方の増え方（0以上。所得が低いほど大きい） */
  portionLove: number;
  /** 高い品の選ばれやすさ（メニューを選ぶときの値段の効き方を弱める割合。0以上。所得が高いほど大きい） */
  premiumLove: number;
}

const L = () => BALANCE.location;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 人口指数（10万人で 0、1万人以下で −1、100万人以上で 1） */
export function populationIndex(population: number): number {
  const z = Math.log10(Math.max(1, population) / L().refPopulation);
  return clamp(z, -1, 1);
}

/** 人口密度の指数（1,000人/km² で 0、約2万人で 1、約50人で −1） */
export function densityIndex(density: number): number {
  return clamp(Math.log10(Math.max(0.01, density) / L().refDensity) / L().densityLogSpan, -1, 1);
}

/** 市区町村の情報（コードが表にないときは null） */
export function locationInfo(code: string | null | undefined): LocationInfo | null {
  if (!code) return null;
  const row = MUNICIPALITIES[code];
  if (!row) return null;
  const [prefCode, name, population] = row;
  const index = populationIndex(population);
  const areaKm2 = MUNICIPALITY_AREA_KM2[code] ?? 0;
  const density = areaKm2 > 0 ? population / areaKm2 : 0;
  const D = areaKm2 > 0 ? densityIndex(density) : 0;
  const eco = PREFECTURE_ECONOMY[prefCode];
  const incomeRatio = eco ? eco.incomePerCapita / NATIONAL_ECONOMY.incomePerCapita : 1;
  const priceIndex = eco?.priceIndex ?? 100;
  const foodIndex = eco?.foodIndex ?? 100;
  const P = L();
  // 購買力: 所得の比^0.2 × 物価^0.5 ×（1 + 0.04 × 密度の指数）。都会・高所得は高い値段でも来て、田舎・低所得は高いと離れやすい
  const power = Math.pow(incomeRatio, P.powerIncomeExp) * Math.pow(priceIndex / 100, P.powerPriceExp) * (1 + P.powerDensity * D);
  return {
    code,
    prefCode,
    prefName: PREFECTURES[prefCode] ?? '',
    region: regionOfPref(prefCode),
    name,
    population,
    index,
    areaKm2,
    density,
    densityIndex: D,
    incomeRatio,
    priceIndex,
    foodIndex,
    demand: 1 + P.demandSpan * index + P.densityDemandSpan * D,
    rent: (1 + P.rentSpan * index + P.densityRentSpan * D) * Math.pow(priceIndex / 100, P.rentPriceExp),
    purchase: foodIndex / 100,
    buyingPower: power,
    tolerance: clamp(power, 1, P.toleranceMax),
    priceSensitivity: 1 + P.lowPowerSensitivity * clamp(1 - power, 0, P.lowPowerMax),
    portionLove: P.lowPowerPortion * clamp(1 - power, 0, P.lowPowerMax),
    premiumLove: P.highPowerPremium * clamp(power - 1, 0, P.toleranceMax - 1),
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

/** 店の来客の倍率（立地 × 場所の人口と人口密度） */
export function storeDemandMult(entry: StoreEntry | null | undefined): number {
  if (!entry) return 1;
  const prop = PROPERTIES[entry.propertyId] ?? PROPERTIES.home!;
  return prop.demand * (locationInfo(entry.location)?.demand ?? 1);
}

/** 店の家賃の倍率（立地 × 場所の人口・人口密度・物価） */
export function storeRentMult(entry: StoreEntry | null | undefined): number {
  if (!entry) return 1;
  const prop = PROPERTIES[entry.propertyId] ?? PROPERTIES.home!;
  return prop.rentMult * (locationInfo(entry.location)?.rent ?? 1);
}

/** 店の仕入れ値の倍率（都道府県の食料の物価。場所がなければ 1） */
export function storePurchaseMult(entry: StoreEntry | null | undefined): number {
  return locationInfo(entry?.location)?.purchase ?? 1;
}

/** 店の値段の感じ方（許容度・敏感さ・量の好み。場所がなければ今までと同じ） */
export interface PriceFeel {
  tolerance: number;
  sensitivity: number;
  portionLove: number;
  premiumLove: number;
}
const NEUTRAL_FEEL: PriceFeel = { tolerance: 1, sensitivity: 1, portionLove: 0, premiumLove: 0 };

export function storePriceFeel(entry: StoreEntry | null | undefined): PriceFeel {
  const l = locationInfo(entry?.location);
  return l ? { tolerance: l.tolerance, sensitivity: l.priceSensitivity, portionLove: l.portionLove, premiumLove: l.premiumLove } : NEUTRAL_FEEL;
}

/** 今いる店（プレイヤーがいる店・店長の計算中の店）の仕入れ値の倍率 */
export function purchaseMultOf(s: GameState): number {
  const base = BALANCE.purchaseCostMult ?? 1;
  return base * (s.company ? storePurchaseMult(s.company.stores.find((x) => x.id === s.company.activeStoreId)) : 1);
}

/** 今いる店の値段の感じ方 */
export function priceFeelOf(s: GameState): PriceFeel {
  return s.company ? storePriceFeel(s.company.stores.find((x) => x.id === s.company.activeStoreId)) : NEUTRAL_FEEL;
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

// ───────────────────────── 出店の範囲（じろ1 5.6。Q3「上限なし・11店目から全国」） ─────────────────────────

export type StoreScope = 'prefecture' | 'region' | 'national';

/** n 店目（2〜）を出せる範囲: 2〜5店目は本店と同じ都道府県、6〜10店目は同じ地方、11店目から全国 */
export function scopeForNth(n: number): StoreScope {
  const R = BALANCE.company.range;
  return n <= R.prefectureUpTo ? 'prefecture' : n <= R.regionUpTo ? 'region' : 'national';
}

export const SCOPE_LABEL: Record<StoreScope, string> = { prefecture: '本店と同じ都道府県', region: '本店と同じ地方', national: '全国' };

/** オンライン市場の出店の範囲の名前（じろ1 Q13） */
export const MARKET_SCOPE_LABEL: Record<MarketScope, string> = { city: '市場の街', prefecture: '同じ都道府県', region: '同じ地方', national: '全国' };
export const MARKET_SCOPES: readonly MarketScope[] = ['city', 'prefecture', 'region', 'national'];

/** 次に出す店を出せる範囲の説明（「3店目: 本店と同じ都道府県」・市場では「出店の範囲: 市場の街」） */
export function rangeTitle(s: GameState): string {
  const n = (s.company?.stores.length ?? 1) + 1;
  const mr = s.company?.marketRange;
  return mr ? `${n}店目・出店の範囲: ${MARKET_SCOPE_LABEL[mr.scope]}` : `${n}店目: ${SCOPE_LABEL[scopeForNth(n)]}`;
}

/** 本店（1店目）の場所 */
export function homeLocation(s: GameState): string | null {
  const home = s.company?.stores.find((x) => x.propertyId === 'home') ?? s.company?.stores[0];
  return home?.location ?? null;
}

/**
 * 次に出す店を、その都道府県（2桁）に出せない理由（出せるなら null）。範囲の外の地域を地図で薄くするのに使う
 */
export function prefRangeProblem(s: GameState, prefCode: string): string | null {
  // オンライン市場: 市場の成績で広がる範囲（じろ1 Q13）
  const mr = s.company?.marketRange;
  if (mr) {
    const cityPref = mr.city.slice(0, 2);
    const cityName = PREFECTURES[cityPref] ?? '';
    if (mr.scope === 'national') return null;
    if (mr.scope === 'region') return regionOfPref(prefCode) === regionOfPref(cityPref) ? null : `出店の範囲は${regionOfPref(cityPref)}地方の中まで（市場の成績で全国へ広がります）`;
    if (prefCode !== cityPref) return mr.scope === 'city' ? '出店の範囲は市場の街の中だけ（市場の成績で同じ都道府県へ広がります）' : `出店の範囲は${cityName}の中まで（市場の成績で${regionOfPref(cityPref)}地方へ広がります）`;
    return null;
  }
  const n = (s.company?.stores.length ?? 1) + 1;
  const scope = scopeForNth(n);
  if (scope === 'national') return null;
  const home = homeLocation(s);
  if (!home) return '先に本店の場所を決めてください（経営 → 「🗾 地図で決める」）';
  const homePref = home.slice(0, 2);
  const R = BALANCE.company.range;
  if (scope === 'prefecture' && prefCode !== homePref) return `${n}店目は${PREFECTURES[homePref] ?? '本店の都道府県'}の中だけ（${R.prefectureUpTo + 1}店目から${regionOfPref(homePref)}地方、${R.regionUpTo + 1}店目から全国）`;
  if (scope === 'region' && regionOfPref(prefCode) !== regionOfPref(homePref)) return `${n}店目は${regionOfPref(homePref)}地方の中だけ（${R.regionUpTo + 1}店目から全国）`;
  return null;
}

/** 次に出す店を、その市区町村に出せない理由（範囲。出せるなら null） */
export function storeRangeProblem(s: GameState, location: string | null | undefined): string | null {
  if (!location) return '出店先の場所を選んでください';
  const mr = s.company?.marketRange;
  if (mr && mr.scope === 'city' && location !== mr.city) return '出店の範囲は市場の街の中だけ（市場の成績で同じ都道府県へ広がります）';
  return prefRangeProblem(s, location.slice(0, 2));
}

// ───────────────────────── 店の周り（じろ1 5.10） ─────────────────────────

/** 店の周りの見た目: 都会（高い建物）・駅前（高架）・街（中くらい）・住宅街（家と塀）・郊外（広い道・駐車場）・田舎（田畑と山） */
export type Surroundings = 'metro' | 'station' | 'town' | 'residential' | 'suburb' | 'rural';

/** 店の周りの見た目を、場所の人口密度と物件（駅前・住宅街・郊外）から決める。場所のない店は今までの「街」 */
export function surroundingsOf(entry: StoreEntry | null | undefined): Surroundings {
  const l = locationInfo(entry?.location);
  if (!l) return 'town';
  const D = l.densityIndex;
  const pid = entry?.propertyId ?? 'home';
  if (D <= -0.45) return 'rural';
  if (pid === 'station') return D >= 0.55 ? 'metro' : 'station';
  if (D >= 0.55) return pid === 'residential' ? 'town' : 'metro';
  if (pid === 'residential') return 'residential';
  if (pid === 'roadside') return 'suburb';
  return D >= 0 ? 'town' : 'suburb';
}
