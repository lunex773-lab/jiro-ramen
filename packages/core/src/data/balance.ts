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
  /**
   * 営業時間（じろ1 5.1）。光熱費の基本は「1日の固定分 + 営業1時間あたり」に分ける（11〜15時の4時間なら今までと同じ 2,500円）。
   * 定休日は固定分だけ
   */
  hours: {
    maxSessions: 3,
    stepMin: 30,
    minSessionMin: 60,
    minBreakMin: 30,
    maxOpenMin: 18 * 60,
    utilitiesFixed: 1_000,
    utilitiesPerHour: 375,
    /** 給料: 1日8時間を超えた分・深夜（22:00〜翌5:00）の分の割り増し、6時間を超える勤務の休憩（給与なし）の分 */
    overtimeAfterH: 8,
    overtimeRate: 0.25,
    lateNightRate: 0.25,
    breakOver6h: 0.75,
    breakOver8h: 1,
  },

  /** 設備の摩耗と定期メンテ（統合進化設計書 v2.1 の経済の調整） */
  equipment: {
    /**
     * 1回使うごとの摩耗（設備ごとの wearPerUse）に掛ける倍率。
     * 1 → 0.6（拡張して杯数が増えると2〜3日に1回故障し、修理代が純売上の約9%になっていた。経済の調整 Phase 1-5）
     */
    wearMult: 0.6,
    /** 定期メンテの費用 = 修理費 × rate（最低 min）。0.2・2,000円 → 0.15・1,000円（予約したほうが得になるように） */
    maintenanceRate: 0.15,
    maintenanceMin: 1_000,
  },

  /** 「売れ行きに合わせる」自動発注 */
  autoOrderSales: {
    /** 最近の何日分の使用量の平均を見るか */
    days: 3,
    /** 平均の使用量に掛ける余裕 */
    safety: 1.35,
    /** 品切れがあった食材はさらにこの倍率 */
    stockoutBoost: 1.25,
    /** 目安の量の下限（手動の目安に対する割合。使用量が少ない日でも最低限は持つ） */
    floorOfManual: 0.5,
    /** 目安の量の下限（仕込みのレシピ1回に使う量の何回分か） */
    batchFloor: 2,
  },

  /**
   * 従業員の仕込みの目安。決まった量（data/prep.ts の restockBelow）か、
   * 「仕込みにかかる時間のあいだに使う見込みの量」の多いほうを下回ったら仕込む（店が大きくなっても仕込みが追いつくように）
   */
  /**
   * 店長の役割（オーナーの指示 2026-11-11）: 急ぎの仕込みを先にする・閉店までに足りない材料は当日便で先に仕入れる・
   * 閉店後に翌日の来客を予測して発注する（sim/store-manager.ts・inventory.ts の forecastNextDay）
   */
  storeManager: {
    /** 予測に使う最近の営業日の数 */
    recentDays: 7,
    /** 予測で今日の数字に掛ける重み（ほかの日は1） */
    todayWeight: 2,
    /** 店長が「急ぎの仕込み」を選ぶときに足す点（ほかの仕事より先に仕込む） */
    urgentPrepBonus: 25,
    /** 当日便が要るかを確かめる間隔（営業の秒） */
    checkEverySec: 10,
    /** 今日のここまでの使用の速さを使い始める、来客の多さの割合（それより前は最近の日の平均だけ） */
    paceFromShare: 0.2,
    /** 今日の速さと最近の日の平均を混ぜる割合（今日の速さの重み） */
    paceWeight: 0.6,
    /** 閉店までの見込みの使用量に掛ける余裕 */
    expressSafety: 1.15,
    /** 残りの来客の多さがこの割合より少なければ、当日便は頼まない（閉店の間際） */
    lastShare: 0.08,
    /** 1回の当日便の上限（パック） */
    maxExpressPacks: 6,
  },

  /**
   * 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 罰は軽い）。客を襲うと、その客と見ていた客は逃げ、評判が下がり、
   * 通報で警察が来てその日の営業は終わる
   */
  armory: {
    /** 評判の下がり方（その日の最初の事件だけ） */
    reputationPenalty: 0.4,
    /** 通報から警察が来るまで（営業の秒） */
    policeDelay: 20,
  },

  /** アルバイトのシフトを組む目安（sim/shift-plan.ts。オーナーの指示 2026-11-11） */
  shiftPlan: {
    /** 1人で回せる1時間あたりの来客（店主・社員・アルバイトを同じに数える。必要な人数の目安） */
    customersPerStaffHour: 12,
    /** 営業した日がまだないときの、11〜15時の店の1日の来客の見込み */
    defaultDailyCustomers: 60,
    /** 1回のシフトの長さ（分）。営業の枠がこれより短ければ枠の長さ */
    minShiftMin: 120,
    maxShiftMin: 360,
    /** 足りない時間がこれ（分）より短ければ人を入れない */
    minGainMin: 60,
    /** アルバイトが週に入る回数の上限（疲れているときは少なく） */
    maxDaysPerWeek: 5,
    maxDaysTired: 3,
    tiredFatigue: 0.6,
  },

  prepPlan: {
    /** 最近の何日分の使用量を見るか（その中の最大） */
    days: 3,
    /** ピークの時間帯の使用の速さ ÷ 1日の平均の速さ（来客の時間帯の山） */
    peakFactor: 1.6,
    /** 仕込みの時間に足す、運ぶ・取り出すなどの時間（秒） */
    leadMarginSec: 20,
    /** 見込みに掛ける余裕 */
    safety: 1.2,
    /** 品切れがあった日の使用量はこの倍率で見る（品切れで使えなかった分） */
    stockoutBoost: 1.5,
  },

  /**
   * 会社と複数店舗（統合進化設計書 v2.1 Phase 2）。オーナーの判断: 2店舗目は12席の店が軌道に乗ったら、物件は候補から選ぶ、店長は社員から任命。
   * 物件ごとの家賃・来客・初期費用は data/properties.ts
   */
  company: {
    /** 出店の範囲（じろ1 5.6・Q3: 店の数の上限はなし）。この店目までは本店と同じ都道府県、その次からこの店目までは同じ地方、そのあとは全国 */
    range: { prefectureUpTo: 5, regionUpTo: 10 },
    /** 共通市場の AI 企業が持つ店の数の上限（AI は市場の街の中だけに出す） */
    aiMaxStores: 4,
    /** 出店の条件: この段階（1 = 12席）以上で、評判がこれ以上の店があること */
    unlockStage: 1,
    unlockReputation: 4.0,
    /** 出店のあとに必要な手元資金（初期費用とは別） */
    minFundsAfterOpen: 100_000,
    /** 新しい店の最初の評判 = 初期値 + (出店を決めた店の評判 − 初期値) × brandCarry（のれん） */
    brandCarry: 0.5,
    /**
     * プレイヤーがいない店の「店長の営業」（1日単位の計算）。係数は細かいシミュレーション（test/econ）の結果に合わせる
     */
    model: {
      /** 席1つあたりの1日の提供の上限（人手が足りているとき）。じろ1 P3 の行列（食券が先・外で待つ）で席の回転が上がったので測り直した */
      seatTurns: 9.0,
      /** 店長が一人で出せる杯数（能力0.65のとき）。42 → 52（切れた材料で作り直しを繰り返さなくなり、細かいシミュレーションの杯数が増えた。じろ1 P5） */
      leadPoints: 52,
      /** ほかの従業員が増やす杯数（担当ごと。能力0.65のとき）。
       *  接客担当（仕込みも受け持つ）は、店長と調理担当の店の詰まり（食券・案内・下げ物・仕込み）をまとめてほどくので大きい（じろ1 P3 で測り直し） */
      rolePoints: { cook: 24, server: 58, cleaner: 14, leader: 58 } as Record<string, number>,
      /** 2人目以降の従業員の効き方の減り（人数が増えるほど1人あたりは減る） */
      extraDiminish: 0.08,
      /** 能力の効き方: 倍率 = skillBase + skillSlope × 能力 */
      skillBase: 0.8,
      skillSlope: 0.3,
      /** 来店した人のうち、待てずに帰らない割合（席と人手に余裕があっても少しは帰る） */
      joinShare: 0.92,
      /** 1杯あたりに使う仕入れの食材（仕込みの分を含む。細かいシミュレーションの使用量から） */
      usePerBowl: {
        noodle: 285, pork_raw: 0.16, bones: 100, backfat_raw: 37, moyashi: 232, cabbage: 58, garlic_raw: 10, soy: 75, ichimi: 1,
      } as Record<string, number>,
      /** 使う量に対する廃棄（ゆですぎ・こぼし・残り）の割合 */
      wasteShare: 0.1,
      /** 朝にそろえる在庫 = 見込みの杯数の分 × この倍率 */
      stockSafety: 1.25,
      /** 冷蔵庫の容量1kgあたりで回せる1日の杯数（12席で1日90杯を超えると冷蔵庫1台では足りない） */
      bowlsPerFridgeKg: 0.75,
      /** 光熱費 = utilitiesBase + 1杯あたり（設備の使用を含む） */
      utilitiesPerBowl: 44,
      /** 修理費（1杯あたり。定期メンテを予約しないと増える） */
      repairPerBowl: 25,
      /** 客単価の見込みに掛ける倍率（返金・作り直しなど） */
      ticketFactor: 0.965,
      repairNoMaintenanceMult: 1.8,
      /** 評判: 目標 = base + 店長の能力の効き − 高すぎる値段の効き + 安い値段の効き。毎日 approach の割合だけ近づく */
      repBase: 4.4,
      repManagerSlope: 0.8,
      repHighPricePenalty: 2.0,
      repLowPriceBonus: 0.5,
      repApproach: 0.08,
      /** 休業した日の評判の下がり */
      repClosedDecay: 0.03,
      /** 店長がいなくても店主が自分で回す店（オンライン市場の本店）の店主の能力 */
      ownerSkill: 0.65,
    },
  },

  /**
   * オンライン市場（統合進化設計書 v2.1 Phase 3+4）。オーナーの判断: 市場の1日＝実時間9分（営業9分の今の1日と同じ周期）、
   * 市場用に新しく始める、招待コード＋AIだけの市場、AI 企業はプレイヤーと合わせて最大6社
   */
  /**
   * 暦と需要（共通市場の仕様書 4.2。オーナーの判断 11「小さめ」）。平均の客数は変えず、ばらつきだけ付ける。
   * 曜日（月〜日）: 平日は約−5〜−8%、金曜はふつう、土日は約+13%（1週間の平均が1になるように割り直す）。
   * 季節: 1月中旬がいちばん売れ（+8%）、7月中旬がいちばん落ちる（−8%）。1年の平均は1
   */
  calendar: {
    weekdayDemand: [0.92, 0.92, 0.94, 0.95, 1.0, 1.14, 1.13] as readonly number[],
    seasonAmp: 0.08,
    /** いちばん売れる日（4月1日からの日数。1月15日） */
    seasonPeakDoy: 289,
  },

  /**
   * 広告（オーナーの判断 14「控えめ」）。来客 × (1 + max × (1 − exp(−その日の広告費 ÷ k)))。
   * 1日3,000円で約+8%、どれだけ出しても+20%まで（効きは段々弱まる）。広告費は開店のとき（1日単位の計算では営業の前）に払い、払えなければその日は出さない
   */
  ads: { max: 0.2, k: 5873, choices: [0, 1000, 2000, 3000, 5000, 8000] as readonly number[] },

  /**
   * 出店の場所と地域の経済（docs/STORE_MAP_PLAN.md 4章・docs/JIRO1_PLAN.md 5.5。オーナーの判断「少し差がある」）。
   * 人口指数 P = log10(人口 ÷ 標準の人口)、密度の指数 D = log10(人口密度 ÷ refDensity) ÷ densityLogSpan（どちらも −1〜1）。
   * 来客 ×(1 + demandSpan·P + densityDemandSpan·D)・家賃 ×(1 + rentSpan·P + densityRentSpan·D) × 物価^rentPriceExp・仕入れ値 × 食料の物価。
   * 購買力 = 所得の比^powerIncomeExp × 物価^powerPriceExp × (1 + powerDensity·D)。1 より高い地域は値段の許容度（〜toleranceMax）、
   * 低い地域は高いときの敏感さ（1 + lowPowerSensitivity × 低さ）と量の多い品の好み（lowPowerPortion × 低さ。低さは lowPowerMax まで）
   */
  location: {
    refPopulation: 100_000,
    demandSpan: 0.05,
    rentSpan: 0.1,
    refDensity: 1_000,
    densityLogSpan: 1.3,
    densityDemandSpan: 0.05,
    densityRentSpan: 0.3,
    rentPriceExp: 2,
    powerIncomeExp: 0.2,
    powerPriceExp: 0.5,
    powerDensity: 0.04,
    toleranceMax: 1.15,
    lowPowerSensitivity: 1.5,
    lowPowerPortion: 2,
    lowPowerMax: 0.12,
    /** 購買力が高い地域の、高い品の選ばれやすさ = highPowerPremium × (購買力 − 1)（toleranceMax − 1 まで） */
    highPowerPremium: 3,
    /**
     * 候補地の数字（じろ2: 改修設計書03。オーナーの判断「公的な統計を同梱」。来客の見込みに少しだけ入れる）。
     * 来客の倍率 = 1 + siteSpan × 点数（−1.5〜1.5）。点数: 昼夜間人口比率（駅前は昼の人が多いほど、住宅街は夜の人が多いほど良い）＋
     * 小売業の多さ（人が集まる）− 飲食店の多さ（競争が激しい）。交通量は場所の種類と人口密度から（表示用）
     */
    siteSpan: 0.04,
    siteDaytime: { station: 1, home: 0.5, roadside: 0.25, residential: -0.5 } as Record<string, number>,
    siteRetail: 0.5,
    siteFood: 0.25,
    trafficBase: { station: 1.3, home: 1, roadside: 1.1, residential: 0.7 } as Record<string, number>,
    trafficDensity: 0.3,
  },
  market: {
    /**
     * コミュニティの企業の数（プレイヤー＋AI）の、作る人が選べる範囲（改修設計書04: 最大25社。26社目は断る）と既定（前の上限の6社）
     */
    maxCompanies: 25,
    minCompanies: 2,
    defaultCompanies: 6,
    /** 1人が持てる市場の企業の数（オーナーの判断: 5社まで。サーバーが数える） */
    maxCompaniesPerPlayer: 5,
    /** 0時に営業中の日を待つ長さ（オーナーの判断: 終わるまで待ち前の期間に数える。最大30分） */
    closeGraceMs: 30 * 60_000,
    /** 同期で1回の要求に自動営業する企業・日の数（残りはアラームで続ける。進行の上限ではなく分割） */
    syncBudget: 3000,
    /** 自動営業の計算式の版（processingVersion。式を変えたら上げる） */
    autoSimVersion: 1,
    /** 企業ごとに残す確定した日の記録（集計が済んだ分） */
    keepDayRecords: 60,
    /**
     * 企業間の貸し借り（じろ2: 改修設計書04。オーナーの判断「自動で返す形」2026-11-11）。
     * 貸し手が借り手・金額・返す日数・利率（0 = 無利子）を決めて申し込み、借り手が承認するとサーバーでお金を動かす。
     * 日数は市場の日付（全社がそろった日付）で数える。期限の日に借り手の現金から自動で返し、足りなければ延滞（利息に overdueRate を上乗せし、
     * 毎日自動で回収）。期限から defaultAfterDays 日で債務不履行（新しく借りられない・評判が defaultReputation 下がる）
     */
    credit: {
      minAmount: 10_000,
      step: 10_000,
      maxAmount: 5_000_000,
      /** 日利の上限と刻み（0.1%刻み・1%まで） */
      maxDailyRate: 0.01,
      rateStep: 0.001,
      minDays: 1,
      maxDays: 60,
      overdueRate: 0.002,
      defaultAfterDays: 14,
      defaultReputation: 0.3,
      /** 申し込みの有効期間（返事がなければ取り消し） */
      offerTtlMs: 72 * 3_600_000,
      /** 1社が出しておける返事待ちの申し込みの数 */
      maxOpenOffers: 5,
      /** 残す契約の記録の数（終わった契約の古い順に捨てる） */
      keep: 200,
    },
    /**
     * 客の取り合いの強さ: 来客の倍率 = 自分の見込み ÷ (自分の見込み + strength × 同じ地域のほかの店の見込みの合計)。
     * 同じくらいの店が2つなら、それぞれ 1 ÷ 1.4 ≒ 0.71 倍（地域の客は全体では増える。ラーメンの激戦区）
     */
    competition: 0.4,
    /**
     * 距離の取り合い（じろ2: 改修設計書03）: 同じ市区町村の同じ場所の店どうしは competition の強さ、同じ市区町村の別の場所の店とは
     * その nearShare 倍の弱さで取り合う。同じ会社の店どうしも取り合う（客を食い合う）
     */
    nearShare: 0.25,
    /**
     * 新規参入の保護（オーナーの判断「話題性＋段階的＋過密の注意」2026-11-11）: 開店から noveltyDays 日は「新店の話題性」で
     * 取り合いの重みを noveltyMult 倍 → 1 倍へ、ほかの店との取り合いは rampDays 日かけて強める。利益は保証しない。
     * 同じ場所に crowdedSite 店以上（同じ市区町村に crowdedCity 店以上）あれば出店の地図で「過密」の注意を出す
     */
    entry: { noveltyMult: 1.3, noveltyDays: 14, rampDays: 7, crowdedSite: 3, crowdedCity: 8 },
    /** 市場シェア = 直近この日数の純売上の割合 */
    shareDays: 30,
    /**
     * 出店の範囲を広げる条件（じろ1 Q13。オーナーが承認した案）: 同じ都道府県 = 市場の街に prefectureCityStores 店以上＋シェアが平均以上
     * （または市場の街の物件が満室）、同じ地方 = regionStores 店以上＋シェアが平均の regionShareOfAvg 倍以上＋直近7日が黒字、
     * 全国 = nationalStores 店以上＋シェア1位＋直近30日が黒字
     */
    range: { prefectureCityStores: 2, regionStores: 4, regionShareOfAvg: 1.5, nationalStores: 7 },
    /** 出店先の地域ごとの物件の数（全社で取り合う） */
    branchSlots: { station: 3, residential: 3, roadside: 2 } as Record<string, number>,
    /**
     * 端末から届いた1日のデータの確かめ方（verify.ts）。値はボットで多くの日を回した実際の最大に余裕を持たせたもの
     * （test/verify.test.ts の測定。根拠は MARKET_RANKING_PLAN.md 4 章）
     */
    verify: {
      /** お金の丸めの許し（円） */
      moneyEps: 1,
      /** 能力が1日に伸びる上限（growth.dailyCap）の何日分まで許すか */
      skillDays: 1,
      /** 新しい設備の定価の合計 ≤ 設備・工事・出店に払った額 × この倍率 */
      equipmentSlack: 1,
      /** 評判が1日に動ける幅（★） */
      reputationPerDay: 1.2,
      /** 在庫の価値の許し（円。仕込みで作った品の原価の丸め） */
      stockEps: 500,
      /** 1席が1日に出せる杯数の上限と、その余裕（杯） */
      servedPerSeat: 14,
      servedSlack: 5,
      /** 来客の上限 = 見込み（イベント込み）× この倍率 + 余裕（人） */
      arrivalMult: 1.8,
      arrivalSlack: 10,
    },
    /** AI 企業の意思決定 */
    ai: {
      /** 戦略ごとの価格の倍率の基準 */
      basePrice: { budget: 0.9, standard: 1.0, premium: 1.15 } as Record<string, number>,
      /** 価格を変える間隔（日）と幅 */
      priceEveryDays: 3,
      priceStep: 0.05,
      priceMin: 0.8,
      priceMax: 1.3,
      /** 来た客のうち帰った客がこの割合を超えたら値上げ、提供が処理能力のこの割合を下回ったら値下げ */
      lostRaise: 0.25,
      idleCut: 0.7,
      /** 手元に残す資金（これを超えた分で人・設備・出店に使う） */
      reserve: 150_000,
      /** 拡張のときに工事費・席・冷蔵庫・工事後の手元資金のほかに残す資金 */
      expandReserve: 50_000,
      /** 1人目を雇う日（それまでは店主だけ） */
      hireFromDay: 3,
      /** 提供が処理能力のこの割合以上なら「手いっぱい」（人を雇う） */
      busyShare: 0.9,
    },
  },

  /** 支払いの猶予日数（これを超えた未払いは期限超過） */
  arrearsGraceDays: 3,
  /** 資金注意の閾値（固定費の何日分） */
  cautionDaysOfFixedCost: 3,

  /**
   * 銀行の融資（じろ2: 改修設計書04。オーナーの判断「額を選べる・返済能力で上限」2026-11-11）。
   * 5万円刻みで額を選ぶ。借入の残りの合計は maxTotal まで、かつ返済能力（直近 capacityRecentDays 日の営業利益の平均 × capacityDays 日分。
   * 最低 minCapacity）まで。利率・返済日数は前と同じ。amount は額を選ばないときの額（前の版の固定の額）
   */
  loan: {
    amount: 200_000,
    step: 50_000,
    maxTotal: 500_000,
    minCapacity: 200_000,
    capacityDays: 30,
    capacityRecentDays: 7,
    dailyRate: 0.004,
    days: 30,
    minReputation: 1.5,
  },

  /** 設備売却時の買取率 */
  resaleRate: 0.4,
  /**
   * 仕入れ値の全体の倍率（食材の表の値段に掛ける。場所の食料の物価・当日便の割増しはこの上に掛ける）。
   * じろ1 P5 で 1.2 も試したが、オーナーの判断で 1.0 のまま（多少簡単になるのは問題ない。2026-11-11）
   */
  purchaseCostMult: 1 as number,
  /** 1杯の値段の範囲（じろ1 5.5: 上限 3,000円 → 5,000円） */
  priceMin: 500,
  priceMax: 5_000,
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
    /**
     * 価格の効き方（来客の倍率 = (基準 ÷ 平均価格)^指数）。基準より安いとき／高いとき。
     * 1.3・1.3 → 1.8・2.6（安くすると客が大きく増え、高くすると大きく減る。経済の調整 Phase 1-5）
     */
    priceExponentLow: 1.8,
    priceExponentHigh: 2.6,
    /**
     * 価格による来客の倍率の下限。0.35 → 0.03（じろ1 5.5: 値段の上限を5,000円にしたので、とても高い値段では客がほとんど来ない。
     * 0.35 は定価の約1.5倍より高い値段でだけ効いていたので、それまでの範囲の来客は変わらない）
     */
    priceFloor: 0.03,
    /**
     * 来客の価格の比べ方。'reference' = メニューの平均価格 ÷ 基準（referencePrice）、
     * 'menu' = 定価に対する割合の平均（メニューが解放されて平均価格が上がっても、定価のままなら倍率は1）
     */
    priceAnchor: 'menu' as 'reference' | 'menu',
    /**
     * 満足度のうち「値段に見合うか」の重み。0.09 → 0.3（高すぎる値段は満足度・口コミ・常連に効く。経済の調整 Phase 1-5）
     * → 0.6（じろ1 P5: 定価の1.3倍にすると得をしすぎていた）
     */
    valueWeight: 0.6,
    /**
     * 「値段に見合うか」= (品質 × qualityWeight + base) × (比べる価格 ÷ 払った価格)^priceExponent
     *   − sensitivityPenalty × 価格への敏感さ × 高すぎる割合。比べる価格は anchor（基準の価格 / そのメニューの定価）
     */
    value: {
      qualityWeight: 1.0,
      base: 0.15,
      /** 2.5 → 3.5（じろ1 P5: 高い値段は「見合わない」と感じやすく） */
      priceExponent: 3.5,
      sensitivityPenalty: 0.5,
      /** 量の多い品（大・豚の多い品）を「見合う」と感じる増え方 = portionBonus × 地域の量の好み（所得の低い地域。じろ1 5.5） */
      portionBonus: 0.5,
      anchor: 'menu' as 'reference' | 'menu',
    },
    maxCustomers: 60,
    /**
     * 閉店の時刻のあと、店の外の列（食券を買った客）が待つ時間（営業の sim 秒。約45分）。その間に入れた客には提供する。
     * 入れなかった客は帰る（店の評価には影響しない。じろ1 5.3「すぐに解散しない」）
     */
    afterCloseWaitSec: 100,
    walkSpeed: 1.25,
    ticketTime: 2,
    /** 標準の食事時間（秒）。量・食事速度で増減 */
    eatTimeBase: 22,
    /** 店外行列の長さに対する入店意欲の減衰 */
    balkPerQueue: 0.06,
    /**
     * 店の大きさ（拡張の段階）ごとの来客の倍率（統合進化設計書 v2.1 の経済の調整）。
     * 店が大きいほど目立ち、行列も見えるので人が集まる。拡張すると来客が増え、人を増やして杯数を出せば利益になる。
     * 席の数の増え方（8 → 12 → 16 → 22席）に合わせた（12席は 1.5 倍。16・22席は未測定）
     */
    stageDemand: [1, 1.5, 1.95, 2.7] as readonly number[],
    patienceBase: 150,
  },

  /** 調理 */
  cooking: {
    /**
     * 理想のゆで時間（秒）。極太麺（ゲームの約8分）。品質の幅（±3秒で最高・±12秒で0.25）。
     * じろ1 5.4（オーナーの指示「もう少し短く」）: 16秒（約7分）への短縮を測った。ボットでは18秒と15秒で提供の数に差がなく、
     * 16秒にすると店長の営業の計算の合わせ（test/manager-model）と拡張の日数が変わるため、営業時間・行列と一緒に P5 で合わせ直してから変える
     */
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
    /** 常連の上限（人）。60 → 150（オーナーの指示「常連の上限アップ」）。常連による来客の増え方の上限（+60%）は変えない */
    maxRegulars: 150,
  },

  /** 従業員 */
  /**
   * 従業員。1営業日 = 昼の4時間営業（11〜15時）なので、日給は4時間勤務の額にしている。
   * 設計書 14.2 の仮値（日給12,000〜20,000円＝終日勤務相当）から変更（docs/BALANCE.md 参照）。
   */
  staff: {
    /** 採用の候補のうち、調理担当の候補を仕込み担当にしていた割合（じろ1 で仕込み担当はなくなった。乱数の並びを変えないよう抽選だけ残す） */
    prepRoleShare: 0.35,
    /** 日給の範囲。6,000〜10,000円 → 5,000〜8,500円（調理担当を1人雇うと利益が増えるように。経済の調整 Phase 1-5）。じろ1 で時給は pay の式に変わった（解雇手当などの目安に残す） */
    wageMin: 5_000,
    wageMax: 8_500,
    /**
     * 給料（じろ1 5.7）。時給 = 都道府県の最低賃金 × 担当 ×（1 + abilitySlope × 能力 + experienceSlope × 経験）×（1 ± spread）。
     * 最低賃金を下回らない。調理は少し高め、シフトリーダーは2割高。能力0.5の人は最低賃金の約1.15倍
     */
    pay: {
      roleFactor: { cook: 1.06, server: 1.0, cleaner: 1.0, leader: 1.2 } as Record<string, number>,
      abilitySlope: 0.3,
      experienceSlope: 0.5,
      spread: 0.05,
    },
    /** シフトリーダー（社員から昇格。日給は社員の日給 × leaderRaise） */
    leader: { leaderRaise: 1.15, minDaysFullTime: 5, minSkill: 0.6 },
    hireFeeMin: 10_000,
    hireFeeMax: 25_000,
    candidatesPerDay: 4,
    baseWalkSpeed: 1.9,
    /** 勤務した日ごとに増える経験（作業の速さに最大 +20% で効く） */
    experiencePerDay: 0.01,

    // ── 第2版: 雇用形態・シフト・勤怠・辛抱・成長（docs/SALES_IMPROVEMENT_IMPLEMENTATION_PLAN.md「第2版 Phase 2」）。値はすべて初期のバランス案 ──

    /** 雇用形態 */
    employment: {
      /** 採用はアルバイトから */
      hireAs: 'part' as const,
      /** 仕込みから出勤したときに給与を払う時間（仕込みは時刻がないので固定の時間で数える） */
      prepPaidHours: 0.5,
      /** 時給 = 候補者の日給の目安 ÷（営業4時間＋仕込み）。毎日・仕込みから閉店までのシフトなら今までの日給と同じ額になる */
      fullShiftHours: 4.5,
      /** 社員にすると日給はアルバイトの1日分（仕込みから閉店まで）× この倍率 */
      fullTimeRaise: 1.15,
      /** 社員は勤怠が安定する（勤怠の値に足す） */
      fullTimeDiligenceBonus: 0.15,
    },
    /** 社員への昇格の目安（画面に参考として出すだけ。昇格するかはプレイヤーが決める） */
    promotionGuide: {
      minDaysWorked: 5,
      /** 遅刻と欠勤の合計（直近 recentDays 日） */
      maxLateAbsent: 1,
      maxSlack: 1,
      maxArgue: 0,
      /** 担当の仕事の能力 */
      minRoleSkill: 0.55,
      recentDays: 10,
    },
    /** 隠しパラメータの初期分布（平均 ± 幅の一様分布） */
    diligence: { mean: 0.68, spread: 0.3 },
    patience: { mean: 0.6, spread: 0.35 },
    /**
     * 遅刻・当日欠勤（毎朝の出勤確認で1回だけ引く）。確率 = 最大値 ×（1 − 勤怠）^exponent。
     * 勤怠 0.7 で 欠勤 約2.5%・遅刻 約5%、勤怠 0.3 で 欠勤 約9%・遅刻 約18%
     */
    attendance: {
      absentMax: 0.16,
      lateMax: 0.32,
      exponent: 1.5,
      /** 遅刻の分数（ゲーム内の分） */
      lateMinFrom: 10,
      lateMinTo: 50,
      /** 欠勤した次の日から、この日数は欠勤しない（続けて休まない） */
      absentGapDays: 3,
      /** 遅刻した次の日から、この日数は遅刻しない */
      lateGapDays: 1,
      /** 休みの人を当日に呼び出したとき、着くまでの時間（ゲーム内の分） */
      callInMin: 30,
    },
    /**
     * サボり・私的な休憩（営業中、checkEvery 秒ごとに引く。毎フレームは引かない）。確率 = 最大値 ×（1 − 勤怠）^exponent
     * 勤怠 0.7 で1回 約1.4%（1日に約15%）、勤怠 0.3 で1回 約7%
     */
    conduct: {
      checkEvery: 45,
      chanceMax: 0.15,
      exponent: 2,
      /** サボっている時間（営業の sim 秒） */
      durationFrom: 14,
      durationTo: 30,
      /** そのうち、持ち場を離れる私的な休憩の割合 */
      privateShare: 0.4,
      /** 次に起きるまでの最短の間隔（sim 秒） */
      gap: 150,
      maxPerDay: 2,
      /** 仕事を後回しにする（仕事を選ぶときに引く） */
      postponeMax: 0.12,
      postponeDelayFrom: 3,
      postponeDelayTo: 7,
      /** 後回しの記録は1日にこの回数まで（同じ日に何度も記録しない） */
      postponeLogPerDay: 1,
    },
    /**
     * クレーム対応での口論（従業員が謝る・説明する・断るときに引く）。確率 = 最大値 ×（1 − 辛抱）^exponent × 原因の倍率 × 客の言いやすさ。
     * 接客の能力（受け入れてもらえる確率）とは別に効く
     */
    temper: {
      argueMax: 0.5,
      exponent: 1.6,
      unreasonableMult: 1.6,
      /** 客の「クレームの言いやすさ」（0..1）による倍率 0.6〜1.4 */
      propensityFrom: 0.6,
      propensityTo: 1.4,
      /** 言い返したときの吹き出しの秒数 */
      sayFor: 4,
      /** 辛抱が切れたときの出方: 対応を放棄する・態度が悪くなる・残りは言い返して口論になる */
      abandonShare: 0.15,
      rudeShare: 0.25,
      /** 対応を放棄したあと、仕事に戻るまでの秒数 */
      abandonCooldown: 10,
      /** 態度が悪いと、受け入れてもらえる確率・満足度に効く接客の上手さがこの倍率になる */
      rudeServiceMult: 0.4,
    },
    /**
     * 仕事の経験による成長。1回の作業で 能力 += perUnit ×（1 − 能力）。1日に伸びる量は dailyCap まで（急に伸びない）
     * 調理 → 調理、清掃・洗い物 → 衛生、接客 → 接客、配膳・運ぶ → 速さ・移動
     */
    growth: {
      perUnit: { cooking: 0.004, hygiene: 0.004, service: 0.005, speed: 0.002, movement: 0.002 },
      dailyCap: 0.012,
    },
    /** 履歴に残す出来事の数 */
    logMax: 40,
    /** シフトの刻み（分） */
    shiftStepMin: 30,
    /** カレンダーで日にちごとにシフトを決められる日数（今日から4週間） */
    calendarDays: 28,
    /**
     * 疲れ（オーナーの判断 12「作業が遅くなり欠勤しやすく」）。働いた日: 疲れ = 疲れ × keepWorking + gainPerDay × 働いた割合、
     * 休みの日: 疲れ × keepResting。毎日働くと 0.6 に近づき（作業が12%遅い）、週5日・2日休みなら週の終わりで約0.4、2日休むと約0.06まで戻る。
     * 作業の速さ × (1 − speedPenalty × 疲れ)、遅刻・欠勤の確率 × (1 + absentMult × 疲れ)
     */
    fatigue: { gainPerDay: 0.12, keepWorking: 0.8, keepResting: 0.4, speedPenalty: 0.2, absentMult: 0.6 },
    /**
     * 満足度（オーナーの判断 13「入れられるが不満がたまる」）。毎日 基準へ approach の割合で戻り、
     * 希望外の日に働くと offWishPenalty、疲れていると fatiguePenalty × 疲れ だけ下がる。
     * 基準より低いと遅刻・欠勤の確率 × (1 + attendanceMult × 下がった割合)。quitBelow より低いと、毎朝 (quitBelow − 満足度) × quitPerDay の確率で辞める。
     * 希望外の日に毎日入れ続けると約0.28まで下がる（1日に約1.7%で辞める）。週2日なら約0.62（遅刻・欠勤 約1.3倍）
     */
    morale: { base: 0.75, approach: 0.15, offWishPenalty: 0.07, fatiguePenalty: 0.03, attendanceMult: 1.5, quitBelow: 0.35, quitPerDay: 0.25 },
    /** 通常の採用は、採用の何日後から出勤できるか（オーナーの判断 14 の補足「短期バイトに意義を持たせる」） */
    hireDelayDays: 2,
    /**
     * 短期バイト（オーナーの判断 14「控えめ」）: その日すぐ来る・その日だけ。時給は通常（候補の日給の平均）の wageMult 倍・採用費なし・能力は新人並み。
     * 1日に maxPerDay 人まで
     */
    temp: { wageMult: 1.5, skillFrom: 0.3, skillTo: 0.45, maxPerDay: 2 },
    /** 希望シフト: アルバイトが出られる曜日の数（採用の候補のときに決まる） */
    wishDaysMin: 3,
    wishDaysMax: 6,
  },

  /**
   * 吹き出し（第2版 13）。通常のコメント（コール・食事のコメント）は今までどおり。
   * イベントの吹き出しの秒数 = max(元の秒数 × eventMult, eventMin, 文字数 × perChar)、eventMax まで（会話の長さに合わせる）
   */
  ui: {
    eventMult: 1.5,
    eventMin: 3.5,
    perChar: 0.16,
    eventMax: 9,
  },

  /**
   * 第2版 Phase 3: 団体客・食べ方の汚い客・居座り・店外の喫煙・トラブル（docs/SALES_IMPROVEMENT_IMPLEMENTATION_PLAN.md「第2版 Phase 3」）。
   * 値はすべて初期のバランス案。抽選はイベント専用の乱数。チュートリアル中は食べ方・居座り・喫煙は起きない
   */
  guests: {
    group: {
      /** 1〜4人の来店の割合（1回の来店あたり） */
      sizeWeights: [0.62, 0.24, 0.09, 0.05] as readonly number[],
      /** 隣り合った席がそろうのを待つ上限（秒）。過ぎたら人数分の空き席に離れて座る（オーナー回答） */
      adjacentWait: 40,
      /** 団体の会話の間隔（秒） */
      chatFrom: 10,
      chatTo: 20,
      /** 会話の吹き出しの秒数（1行あたり） */
      chatSay: 4,
      /** 食後に居座る確率（2人以上の団体、1回の来店で1回だけ抽選） */
      lingerChance: 0.12,
      /** 居座る時間（秒）。過ぎると自分から帰る */
      lingerFrom: 70,
      lingerTo: 150,
      /** 居座りを「トラブル」として数えるまでの時間（秒）。待っている客がいるときだけ */
      lingerTroubleAfter: 15,
    },
    /** 退店を促す: 受け入れてもらえる確率の元の値（接客の上手さ・客のマナーで変わる） */
    ask: {
      polite: 0.5,
      /** 混雑の説明は、実際に待っている客がいるときだけよく効く */
      explain: 0.75,
      explainNotBusy: 0.25,
      request: 0.85,
      /** 「お願い」で帰ってもらったとき、気分を害する確率の元（1 − マナー をかける） */
      offendRequest: 0.6,
      /** 断られたとき、居座りが延びる秒数 */
      refusedExtend: 20,
    },
    /** 食べ方の汚い客 */
    messy: {
      /** 出現率（1人あたり） */
      chance: 0.04,
      /** 食事中、この秒数ごとに汚すかを抽選 */
      every: 6,
      chancePerCheck: 0.6,
      /** 汚したときの席の汚れ */
      counterDirt: 0.14,
      /** 床にこぼす割合 */
      floorShare: 0.25,
      /** 隣の客に飛ぶ割合 */
      splashShare: 0.45,
      /** 隣（1つ隣・2つ隣）の客が迷惑に感じる確率の倍率（距離で計算。全員が不快になるわけではない） */
      nearFactor: 1,
      farFactor: 0.3,
      /** 迷惑に感じる確率 = bother × 距離の倍率 ×（0.4 + 清潔さへのこだわり） */
      bother: 0.6,
      /** 迷惑を受けた客の満足度の低下（1つのトラブルで1回だけ） */
      comfortLoss: 0.3,
      cleanlinessLoss: 0.2,
      /** 隣の客の席に飛ぶ汚れ */
      neighborDirt: 0.1,
      /** よい対応で戻る割合（早いとき・遅いとき）と、早いとみなす秒数 */
      reliefQuick: 0.6,
      reliefSlow: 0.3,
      quickWithin: 30,
      /** 注意したときの反応: 改める = stopBase + stopManners × マナー、怒る = annoyed × クレームの言いやすさ、残りは聞き流す */
      stopBase: 0.3,
      stopManners: 0.55,
      annoyed: 0.45,
      /** 改めたあとは汚す確率がこの倍率になる */
      calmedMult: 0.15,
      /** 食べ終わったときに残す汚れ（席・床） */
      leaveDirt: 0.2,
    },
    /** 店外の喫煙（食べ終わって店を出た客） */
    smoke: {
      chance: 0.06,
      /** 吸っている時間（秒） */
      from: 40,
      to: 80,
      /** 煙を嫌がる範囲（m）と、確かめる間隔（秒） */
      radius: 3.2,
      every: 2,
      /** 嫌がる確率 =（0.35 + 清潔さへのこだわり × 0.65）。1人1回だけ */
      comfortLoss: 0.22,
      /** 声をかけたときの反応: 無視 = ignore ×（1 − マナー）× (0.5 + クレームの言いやすさ)、不満 = displeased × クレームの言いやすさ、謝って立ち去る = apologize、残りはすぐやめる */
      ignore: 0.6,
      displeased: 0.45,
      apologize: 0.45,
      /** よい対応で戻る割合と、早いとみなす秒数 */
      reliefQuick: 0.5,
      reliefSlow: 0.25,
      quickWithin: 20,
    },
    /** 店員の口論を見た周りの客（2つ隣まで）の居心地の低下（1つのトラブルで1回だけ） */
    witness: { seats: 2, comfortLoss: 0.15 },
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
      /**
       * 続く時間（ゲームの分。オーナーの指示: 1時間〜3時間のあいだで30分刻みにランダム）。起きたときに
       * durationMinFrom〜durationMinTo の durationStepMin 刻みから等しい確率で1つ選ぶ（閉店の時刻を超えた分は閉店で終わる）
       */
      durationMinFrom: 60,
      durationMinTo: 180,
      durationStepMin: 30,
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
    /**
     * YouTuber（第2版 11）: 開店時に1日1回抽選し、当たった日は営業中のある時刻以降に来た最初の新規の一人客が YouTuber になる。
     * 来店前に撮影の許可を求めることがある（ホストが答える。答えがなければ許可しない）。
     * 許可して撮影が完了したら、その日から3日間 SNS バズの確率が上がる（重ねられる。上限あり。オーナー回答）
     */
    youtuber: {
      minDay: 3,
      chancePerDay: 0.08,
      cooldownDays: 2,
      arriveFrom: 0.1,
      arriveTo: 0.65,
      /** 来店前に許可を求める確率 */
      askChance: 0.7,
      /** 答えを待つ秒数（過ぎたら許可しない） */
      answerTimeout: 30,
      /** 許可がないのに撮る確率（聞かずに来た・断られた） */
      sneakUnasked: 0.7,
      sneakDenied: 0.25,
      /** 撮影を完了したときの SNS バズの確率の上乗せ（1本あたり）と、合計の上限（倍率） */
      buzzBoost: 1.5,
      buzzBoostCap: 4,
      /** 効く日数（撮影した日から） */
      boostDays: 3,
      /** 撮影のセリフの間隔（秒） */
      talkEvery: 9,
      /** 許可のない撮影を嫌がる周りの客（2つ隣まで）の居心地の低下（1人1回だけ） */
      annoyComfort: 0.15,
      /** やめるよう伝えたときの反応: 続ける = keepOn（伝え方で変わる、伝えるたびに下がる）、残りは やめる／謝る／不満を示す */
      keepOnStop: 0.35,
      keepOnRules: 0.2,
      displeased: 0.35,
      apologize: 0.35,
    },
    /**
     * テレビ取材（第2版 12）: 開店時に1日1回抽選。8人（出演者2・カメラマン2・スタッフ4）が来て、ホストが受けるか選ぶ（オーナー回答）。
     * 出演者2人だけが食べる。出演者が食べ終えてチーム全員が帰れば完了し、翌日と翌々日の来客が確定で増える（実際の来客で。売上を直接足さない）
     */
    tv: {
      minDay: 5,
      chancePerDay: 0.03,
      cooldownDays: 7,
      arriveFrom: 0.15,
      arriveTo: 0.5,
      answerTimeout: 30,
      /** 翌日・翌々日の来客の倍率（同じ日に重ねない。高いほうを使う） */
      nextDayMult: 2.4,
      dayAfterMult: 1.7,
      /** カメラマンが店内にいる間、座っている通常の客の居心地の低下（店が狭く混んでいるほど大きい。1人1回だけ） */
      crowdComfort: 0.12,
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
      /**
       * オンライン市場の会社で、まだ一度も爆発が起きていない間の1日の確率（オーナーの指示: 2日目以降の初回は 0.1%、
       * 一度起きたあとは通常の chancePerDay）。ひとりの経営は通常の確率のまま
       */
      marketFirstChancePerDay: 0.001,
      /** 起きる時刻の範囲（営業時間に対する割合） */
      atFrom: 0.2,
      atTo: 0.8,
      /**
       * 設備が発火してから爆発するまでの秒数（オーナーの指示で 5 → 15 秒）。この間は営業が続き、火は設備から設備へ燃え移る。
       * 火は消せず、必ず爆発する（オーナー回答）
       */
      warningSec: 15,
      /**
       * 燃え移り: 店の設備のすべてに、予兆の spreadEndFrac の時点で火が回る。燃えている台数は (経過/終わり)^spreadPower で増える
       * （初めはゆっくり、だんだん速く。店の広さ・設備の数によらず15秒の間ずっと燃え広がる）
       */
      spreadEndFrac: 0.85,
      spreadPower: 1.6,
      /** 発火から、お客さんと従業員が火に気づいて騒ぎ始めるまでの秒数（騒ぐが店からは出ない。オーナー回答） */
      noticeSec: 1.5,
      /** 爆発から目覚めるまでの秒数（閃光・暗転・時間経過の演出）。この間は動けず、リセットもできない */
      faintSec: 9,
    },
  },

  /** 出退勤の動き（歩いて入店 → あいさつ → 手洗い／あいさつ → 歩いて退店） */
  commute: {
    /** あいさつの秒数（この間は立ち止まる） */
    greetSec: 1.6,
    /** 手洗いの秒数 */
    washSec: 4,
    /** 店の外の、歩いて来る・帰っていく場所（入口から左へ。z<0 は歩道） */
    streetX: -2.6,
    streetZ: -2.7,
    /** 何人も同時に来るときの間隔（m。遠くから来る人ほど遅れて着く） */
    stagger: 1.4,
    /** 詰まったときの打ち切り（秒）。過ぎたら店の中へ・外へそのまま移す */
    giveUpSec: 45,
    /** 閉店のあと、全員が帰るのを待つ最大の秒数（過ぎたら精算する） */
    closeWaitMax: 25,
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
