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
    baseRate: 0.08,
    /** 評判による倍率の指数 */
    reputationExponent: 1.6,
    /** 価格基準（この平均価格で価格倍率1.0） */
    referencePrice: 1_000,
    maxCustomers: 60,
    walkSpeed: 1.25,
    ticketTime: 2,
    /** 標準の食事時間（秒）。量・食事速度で増減 */
    eatTimeBase: 22,
    /** 店外行列の長さに対する入店意欲の減衰 */
    balkPerQueue: 0.06,
    patienceBase: 150,
  },

  /** 調理 */
  cooking: {
    /** 理想のゆで時間（秒）。極太麺 */
    noodleIdeal: 18,
    /** この差以内なら最高品質 */
    noodlePerfectWindow: 3,
    /** この差で品質0.25 */
    noodleBadWindow: 12,
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
    /** これ未満ならカウンターはきれい。これ以上汚れている席は、拭いてからでないと丼を下げられない
     *（先に丼を下げると空いた席に次の客が座り、拭けなくなるため） */
    counterCleanBelow: 0.05,
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
  /**
   * 従業員。1営業日 = 昼の4時間営業（11〜15時）なので、日給は4時間勤務の額にしている。
   * 設計書 14.2 の仮値（日給12,000〜20,000円＝終日勤務相当）から変更（docs/BALANCE.md 参照）。
   */
  staff: {
    wageMin: 6_000,
    wageMax: 10_000,
    hireFeeMin: 10_000,
    hireFeeMax: 25_000,
    candidatesPerDay: 4,
    baseWalkSpeed: 1.9,
    /** 経験値による能力上昇（1日あたり） */
    experiencePerDay: 0.01,
  },

  /**
   * 営業中のイベント（docs/SALES_IMPROVEMENT_IMPLEMENTATION_PLAN.md）。確率・時間はすべて初期のバランス案で、実測した値ではない。
   * 抽選はイベント専用の乱数で行う。チュートリアル中はどのイベントも起きない。
   */
  events: {
    /** SNS でバズる: 営業中に checkEvery 秒ごとに抽選。1日1回まで */
    buzz: {
      minDay: 2,
      checkEvery: 30,
      /** 評判3.0・直近の口コミの平均★3.5 のときの1回の抽選の確率（1日あたり約7%） */
      chancePerCheck: 0.004,
      /** 評判による倍率の指数（(評判/3)^指数） */
      reputationExponent: 2,
      /** 直近の口コミとして見る件数 */
      recentReviews: 20,
      /** 続く時間（営業の経過秒。営業時間は 540 秒） */
      duration: 120,
      /** 来客の倍率 */
      arrivalMult: 2.2,
      /** 営業時間のこの割合を過ぎたら始まらない */
      latestStart: 0.8,
      cooldownDays: 2,
      /** SNS を見て来た客は口コミを書きやすい（投稿する人たち） */
      reviewPropensityBonus: 0.25,
      /** SNS を見て来た客が「SNSで見た」と話す確率 */
      sayChance: 0.35,
    },
    /** 怒った客・理不尽なクレーム */
    complaint: {
      /** 1回の来店でのクレームの上限 */
      maxPerVisit: 2,
      /** 放置すると怒って帰るまでの秒数 */
      timeout: 30,
      /** 提供の遅れ: 着席からの待ちが我慢の限度（45＋70×我慢強さ 秒）のこの割合を超えたら、クレームの言いやすさ×chance で一度だけ抽選 */
      delayAt: 0.9,
      delayChance: 0.3,
      /** 汚れ: この汚れ以上の席に座ったら、清潔さへのこだわり×chance で一度だけ抽選 */
      dirtySeat: 0.5,
      dirtyChance: 0.3,
      /** 理不尽な要求: 良い丼を出しても、クレームの言いやすさ×(1−マナー)×chance で抽選。店全体で minGap 秒あけ、1日 maxPerDay 回まで */
      unreasonableChance: 0.06,
      unreasonableGap: 120,
      unreasonableMaxPerDay: 3,
      /** 対応の所要時間（秒） */
      time: { apologize: 1.2, remake: 1, refund: 1, explain: 2, refuse: 1 },
      /** 謝る・説明する・断るを受け入れてもらえる基本の確率（接客の上手さと客の性格で増減。作り直し・返金は必ず受け入れる） */
      accept: {
        mistake: { apologize: 0.35, explain: 0.15, refuse: 0 },
        quality: { apologize: 0.45, explain: 0.25, refuse: 0 },
        delay: { apologize: 0.8, explain: 0.4, refuse: 0 },
        dirty: { apologize: 0.9, explain: 0.35, refuse: 0 },
        unreasonable: { apologize: 0.4, explain: 0.6, refuse: 0.45 },
      },
      /** 混雑しているとき（提供待ち3件以上か行列3人以上）の遅れの説明は受け入れられやすい */
      explainBusyBonus: 0.35,
      /** 謝って受け入れてもらえたときに戻る我慢（秒） */
      patienceBack: 45,
    },
    /** 有名レビュアー（覆面調査員）: 開店時に1日1回抽選し、当たった日は営業中のある時刻以降に来た最初の新規客が調査員 */
    critic: {
      minDay: 3,
      chancePerDay: 0.12,
      cooldownDays: 4,
      /** 来店する時刻の範囲（営業時間に対する割合） */
      arriveFrom: 0.15,
      arriveTo: 0.7,
      /** 評価の重み（満足度の項目そのものを使う。乱数は入れない） */
      weights: { taste: 0.35, speed: 0.2, service: 0.15, cleanliness: 0.15, accuracy: 0.15 },
      /** 公開する日（来店の何日後の仕込みの開始時） */
      publishAfterDays: 1,
      /** 評判の変化 = (★ − 3) × repPerStar */
      repPerStar: 0.1,
      goodStars: 4,
      goodMult: 1.25,
      goodDays: 3,
      badStars: 2.5,
      badMult: 0.85,
      badDays: 2,
      /** この点数未満の項目を改善点として示す */
      improveBelow: 0.6,
      /** 待っている間にメモを取るそぶりを見せる確率（正体の手がかり） */
      noteChance: 0.5,
    },
    /** 珍しい客（演出だけ。報酬はない） */
    rare: {
      minDay: 1,
      /** 金髪の女性と彼氏のカップル（1人の来店あたり。下の一人客より低い） */
      coupleChance: 0.004,
      /** 一人でラーメンを愛する客（1人の来店あたり） */
      loverChance: 0.012,
      /** それぞれ1日の上限 */
      perDay: 1,
      /** カップルが会話できる距離（m） */
      coupleNear: 1.6,
      /** 並んで・座ってから話すまでの秒数 */
      coupleAfter: 3,
      /** 吹き出しを出す秒数 */
      lineSec: 5.5,
      /** 一人客が話すのは食事のこの割合が進んだころで、味の満足がこれ以上のときだけ */
      loverAt: 0.45,
      loverMinTaste: 0.6,
    },
    /**
     * 爆発事故: 開店の操作の中で1営業日に1回だけ抽選（0.001%）。当たったら営業中の時刻を決めて予約する。
     * その日の仕込み開始時点の控えがない日（このバージョンより前のセーブを途中から続けた日）は抽選しない。
     */
    explosion: {
      minDay: 2,
      chancePerDay: 0.00001,
      /** 起きる時刻の範囲（営業時間に対する割合） */
      atFrom: 0.2,
      atTo: 0.8,
      /** 設備の異常（予兆）の秒数。この間は営業が続く */
      warningSec: 5,
      /** 爆発から目覚めるまでの秒数（閃光・暗転・時間経過の演出）。この間は動けず、リセットもできない */
      faintSec: 9,
    },
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
