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
