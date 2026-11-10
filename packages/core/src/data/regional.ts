// 都道府県の経済の数字（じろ1 5.5・5.7。docs/JIRO1_PLAN.md）。公的な統計から作った表（手で直さない。直すときは出典の表から作り直す）。
// - 最低賃金: 厚生労働省「令和8年度 地域別最低賃金 答申状況」（2026年9月3日公表）。minWage = 令和8年度の答申された改定額（円/時）、
//   minWagePrev = 改定前（令和7年度）、minWageFrom = 発効日（予定）。全国加重平均 1,177円（改定前 1,121円）
// - 物価: 総務省統計局「小売物価統計調査（構造編）2025年 消費者物価地域差指数」（全国平均 = 100）。priceIndex = 総合、foodIndex = 食料
// - 所得: 内閣府「県民経済計算（平成23年度〜令和5年度）」1人当たり県民所得 令和5年度（2023年度。円）

export interface PrefectureEconomy {
  /** 地域別最低賃金（令和8年度、円/時） */
  minWage: number;
  /** 改定前の地域別最低賃金（令和7年度、円/時） */
  minWagePrev: number;
  /** 令和8年度の額の発効日（予定） */
  minWageFrom: string;
  /** 消費者物価地域差指数（総合、全国平均 = 100） */
  priceIndex: number;
  /** 消費者物価地域差指数（食料、全国平均 = 100） */
  foodIndex: number;
  /** 1人当たり県民所得（円） */
  incomePerCapita: number;
}

/** 都道府県のコード（2桁）→ 経済の数字 */
export const PREFECTURE_ECONOMY: Readonly<Record<string, PrefectureEconomy>> = {
  '01': { minWage: 1131, minWagePrev: 1075, minWageFrom: '2026-10-01', priceIndex: 102.4, foodIndex: 102.5, incomePerCapita: 3000000 },
  '02': { minWage: 1090, minWagePrev: 1029, minWageFrom: '2026-10-29', priceIndex: 97.9, foodIndex: 97.1, incomePerCapita: 2879000 },
  '03': { minWage: 1090, minWagePrev: 1031, minWageFrom: '2026-12-01', priceIndex: 100.0, foodIndex: 99.3, incomePerCapita: 2835000 },
  '04': { minWage: 1098, minWagePrev: 1038, minWageFrom: '2026-10-01', priceIndex: 100.2, foodIndex: 99.6, incomePerCapita: 3054000 },
  '05': { minWage: 1090, minWagePrev: 1031, minWageFrom: '2026-10-14', priceIndex: 98.6, foodIndex: 99.5, incomePerCapita: 2889000 },
  '06': { minWage: 1092, minWagePrev: 1032, minWageFrom: '2026-10-30', priceIndex: 100.1, foodIndex: 101.3, incomePerCapita: 3271000 },
  '07': { minWage: 1094, minWagePrev: 1033, minWageFrom: '2026-10-16', priceIndex: 99.0, foodIndex: 99.4, incomePerCapita: 3215000 },
  '08': { minWage: 1136, minWagePrev: 1074, minWageFrom: '2026-10-18', priceIndex: 97.5, foodIndex: 97.2, incomePerCapita: 3526000 },
  '09': { minWage: 1125, minWagePrev: 1068, minWageFrom: '2026-10-01', priceIndex: 97.3, foodIndex: 98.2, incomePerCapita: 3550000 },
  '10': { minWage: 1120, minWagePrev: 1063, minWageFrom: '2026-10-03', priceIndex: 96.2, foodIndex: 95.5, incomePerCapita: 3523000 },
  '11': { minWage: 1196, minWagePrev: 1141, minWageFrom: '2026-10-01', priceIndex: 100.2, foodIndex: 98.1, incomePerCapita: 3286000 },
  '12': { minWage: 1195, minWagePrev: 1140, minWageFrom: '2026-10-01', priceIndex: 100.5, foodIndex: 99.1, incomePerCapita: 3275000 },
  '13': { minWage: 1280, minWagePrev: 1226, minWageFrom: '2026-10-01', priceIndex: 104.2, foodIndex: 102.9, incomePerCapita: 6368000 },
  '14': { minWage: 1279, minWagePrev: 1225, minWageFrom: '2026-10-01', priceIndex: 103.3, foodIndex: 102.8, incomePerCapita: 3349000 },
  '15': { minWage: 1108, minWagePrev: 1050, minWageFrom: '2026-10-01', priceIndex: 97.8, foodIndex: 98.1, incomePerCapita: 3156000 },
  '16': { minWage: 1119, minWagePrev: 1062, minWageFrom: '2026-10-01', priceIndex: 98.7, foodIndex: 101.0, incomePerCapita: 3504000 },
  '17': { minWage: 1113, minWagePrev: 1054, minWageFrom: '2026-10-03', priceIndex: 99.4, foodIndex: 102.4, incomePerCapita: 3081000 },
  '18': { minWage: 1112, minWagePrev: 1053, minWageFrom: '2026-10-04', priceIndex: 99.3, foodIndex: 102.2, incomePerCapita: 3642000 },
  '19': { minWage: 1113, minWagePrev: 1052, minWageFrom: '2026-11-01', priceIndex: 97.7, foodIndex: 98.0, incomePerCapita: 3259000 },
  '20': { minWage: 1117, minWagePrev: 1061, minWageFrom: '2026-10-02', priceIndex: 96.9, foodIndex: 95.0, incomePerCapita: 3164000 },
  '21': { minWage: 1121, minWagePrev: 1065, minWageFrom: '2026-10-01', priceIndex: 97.2, foodIndex: 97.5, incomePerCapita: 3264000 },
  '22': { minWage: 1154, minWagePrev: 1097, minWageFrom: '2026-10-15', priceIndex: 98.2, foodIndex: 97.5, incomePerCapita: 3822000 },
  '23': { minWage: 1195, minWagePrev: 1140, minWageFrom: '2026-10-01', priceIndex: 98.0, foodIndex: 97.4, incomePerCapita: 4150000 },
  '24': { minWage: 1143, minWagePrev: 1087, minWageFrom: '2026-10-01', priceIndex: 98.1, foodIndex: 98.7, incomePerCapita: 3444000 },
  '25': { minWage: 1136, minWagePrev: 1080, minWageFrom: '2026-10-03', priceIndex: 97.7, foodIndex: 97.4, incomePerCapita: 3461000 },
  '26': { minWage: 1180, minWagePrev: 1122, minWageFrom: '2026-11-16', priceIndex: 101.1, foodIndex: 101.1, incomePerCapita: 3216000 },
  '27': { minWage: 1231, minWagePrev: 1177, minWageFrom: '2026-10-01', priceIndex: 99.9, foodIndex: 99.1, incomePerCapita: 3450000 },
  '28': { minWage: 1172, minWagePrev: 1116, minWageFrom: '2026-10-01', priceIndex: 99.4, foodIndex: 99.8, incomePerCapita: 3277000 },
  '29': { minWage: 1107, minWagePrev: 1051, minWageFrom: '2026-10-04', priceIndex: 97.8, foodIndex: 97.8, incomePerCapita: 2898000 },
  '30': { minWage: 1101, minWagePrev: 1045, minWageFrom: '2026-10-03', priceIndex: 97.7, foodIndex: 98.1, incomePerCapita: 3456000 },
  '31': { minWage: 1090, minWagePrev: 1030, minWageFrom: '2026-10-03', priceIndex: 99.1, foodIndex: 102.2, incomePerCapita: 2611000 },
  '32': { minWage: 1092, minWagePrev: 1033, minWageFrom: '2026-10-10', priceIndex: 99.8, foodIndex: 102.5, incomePerCapita: 3350000 },
  '33': { minWage: 1104, minWagePrev: 1047, minWageFrom: '2026-10-02', priceIndex: 97.7, foodIndex: 101.1, incomePerCapita: 3034000 },
  '34': { minWage: 1141, minWagePrev: 1085, minWageFrom: '2026-10-11', priceIndex: 98.8, foodIndex: 101.8, incomePerCapita: 3316000 },
  '35': { minWage: 1101, minWagePrev: 1043, minWageFrom: '2026-10-08', priceIndex: 99.6, foodIndex: 102.6, incomePerCapita: 3336000 },
  '36': { minWage: 1103, minWagePrev: 1046, minWageFrom: '2026-11-01', priceIndex: 98.9, foodIndex: 101.2, incomePerCapita: 3388000 },
  '37': { minWage: 1092, minWagePrev: 1036, minWageFrom: '2026-10-01', priceIndex: 98.7, foodIndex: 100.9, incomePerCapita: 3111000 },
  '38': { minWage: 1093, minWagePrev: 1033, minWageFrom: '2026-11-01', priceIndex: 99.2, foodIndex: 100.7, incomePerCapita: 2865000 },
  '39': { minWage: 1086, minWagePrev: 1023, minWageFrom: '2026-10-29', priceIndex: 99.9, foodIndex: 101.4, incomePerCapita: 2749000 },
  '40': { minWage: 1114, minWagePrev: 1057, minWageFrom: '2026-10-04', priceIndex: 98.5, foodIndex: 99.2, incomePerCapita: 2974000 },
  '41': { minWage: 1095, minWagePrev: 1030, minWageFrom: '2026-11-15', priceIndex: 98.5, foodIndex: 99.9, incomePerCapita: 3044000 },
  '42': { minWage: 1087, minWagePrev: 1031, minWageFrom: '2026-11-02', priceIndex: 99.6, foodIndex: 101.5, incomePerCapita: 2782000 },
  '43': { minWage: 1092, minWagePrev: 1034, minWageFrom: '2026-12-01', priceIndex: 99.8, foodIndex: 103.3, incomePerCapita: 2928000 },
  '44': { minWage: 1096, minWagePrev: 1035, minWageFrom: '2026-11-01', priceIndex: 97.4, foodIndex: 99.0, incomePerCapita: 3042000 },
  '45': { minWage: 1085, minWagePrev: 1023, minWageFrom: '2026-10-24', priceIndex: 98.0, foodIndex: 98.6, incomePerCapita: 2695000 },
  '46': { minWage: 1090, minWagePrev: 1026, minWageFrom: '2026-10-25', priceIndex: 96.4, foodIndex: 99.0, incomePerCapita: 2936000 },
  '47': { minWage: 1086, minWagePrev: 1023, minWageFrom: '2026-12-02', priceIndex: 100.4, foodIndex: 106.6, incomePerCapita: 2315000 },
};

/** 全国の目安（最低賃金の全国加重平均・1人当たり県民所得の全県計） */
export const NATIONAL_ECONOMY = { minWage: 1_177, minWagePrev: 1_121, priceIndex: 100, foodIndex: 100, incomePerCapita: 3_639_000 } as const;
