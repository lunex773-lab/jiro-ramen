// ゲームバランスの数値。実在店舗の市場価格ではなくゲーム調整用の仮値（設計書 14.2）。
// コード中に数値を直書きせず、ここを参照する。

export const BALANCE = {
  initialMoney: 300_000,

  /** 営業時間（sim秒）。表示上は openHour〜closeHour に写像する */
  openDuration: 540,
  openHour: 11,
  closeHour: 15,

  /** 光熱費等: 1日の基本料金と1杯あたりの追加 */
  utilitiesBase: 2_500,
  utilitiesPerBowl: 25,

  /** 支払いの猶予日数（これを超えた未払いは期限超過） */
  arrearsGraceDays: 3,
  /** 資金注意の閾値（固定費の何日分） */
  cautionDaysOfFixedCost: 3,

  /** 緊急融資 */
  loan: {
    amount: 200_000,
    dailyRate: 0.004,
    days: 30,
    minReputation: 1.5,
  },

  /** 設備売却時の買取率 */
  resaleRate: 0.4,
  /** 解雇時の費用（日給の倍率） */
  severanceDays: 1,

  /** 来客 */
  customers: {
    /** 評判3.0・ピーク時の1秒あたり来店数 */
    baseRate: 0.06,
    /** 評判による倍率の指数 */
    reputationExponent: 1.6,
    /** 価格基準（この平均価格で価格倍率1.0） */
    referencePrice: 1_000,
    maxCustomers: 60,
    walkSpeed: 1.25,
    ticketTime: 3,
    /** 標準の食事時間（秒）。量・食事速度で増減 */
    eatTimeBase: 55,
    /** 店外行列の長さに対する入店意欲の減衰 */
    balkPerQueue: 0.06,
    patienceBase: 150,
  },

  /** 調理 */
  cooking: {
    /** 理想のゆで時間（秒）。極太麺 */
    noodleIdeal: 25,
    /** この差以内なら最高品質 */
    noodlePerfectWindow: 4,
    /** この差で品質0.25 */
    noodleBadWindow: 16,
    /** 放置でゆですぎ扱いになり自動で品質が落ち続ける */
    soupPerBowlSmall: 0.35,
    soupPerBowlLarge: 0.4,
    soupServeTemp: 92,
    /** 丼の温度低下（℃/秒） */
    heatLossPerSec: 0.25,
    /** 提供温度の下限（これ未満は品質減点） */
    minServeTemp: 70,
    yasaiPerLevel: 180,
    ninnikuPerLevel: 12,
    aburaPerLevel: 25,
    ichimiPerLevel: 1.5,
    tarePerLevel: 30,
  },

  /** 清掃 */
  cleaning: {
    /** 客1人あたりカウンターの汚れ増加 */
    counterDirtPerCustomer: 0.25,
    /** 厨房の汚れ増加（1杯あたり） */
    kitchenGrimePerBowl: 0.006,
    /** 床汚れの発生確率（客1人あたり） */
    floorDirtChance: 0.18,
    spillChance: 0.03,
    wipeTime: 2.5,
    mopTime: 3,
    washTime: 2.5,
    kitchenScrubTime: 6,
    trashPerWaste: 1,
    trashPerBowl: 0.15,
    lostItemChance: 0.05,
    /** マナーの良い客が丼を上げてカウンターを拭く確率の係数 */
    mannersFactor: 0.6,
  },

  /** 評判 */
  reputation: {
    initial: 2.6,
    /** 1日のレビュー平均を評判へ反映する重み（レビュー数で増える） */
    weightPerReview: 0.015,
    maxWeight: 0.25,
    regularThreshold: 0.72,
  },

  /** 従業員 */
  staff: {
    wageMin: 12_000,
    wageMax: 20_000,
    hireFeeMin: 20_000,
    hireFeeMax: 50_000,
    candidatesPerDay: 4,
    baseWalkSpeed: 1.9,
    /** 経験値による能力上昇（1日あたり） */
    experiencePerDay: 0.01,
  },

  player: {
    walkSpeed: 2.7,
    reach: 1.35,
    radius: 0.22,
    /** サーバー検証で許容する速度の上振れ */
    speedTolerance: 1.35,
  },
} as const;

export type Balance = typeof BALANCE;
