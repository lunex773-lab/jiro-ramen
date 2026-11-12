// 独立したイベント（珍客・特殊イベント）の定義の表（じろ7 6）。新しいイベントは、ここに定義を1つ足し、
// sim/chaos.ts の「イベントごとの処理」に1つ足すだけで入れられる（抽選・同時の上限・クールダウン・連鎖・記録は共通）。
// どのイベントもほかのイベントを必須の条件にしない（YouTuber がいなくても UFO は来る）。条件が合ったときだけ、ほかのイベントへ影響する（連鎖）。
// オーナーの判断: 実在の作品・人物・曲は使わない（クマはオリジナル、金色覚醒は作品名を出さない、ダンスの曲はオリジナル）。

import type { ChaosKind, ReactKind } from '../types';

/** 連鎖: このイベントのあと、条件が合えば（確率で）別のイベントを起こりやすくする（必ずではない） */
export interface ChaosLink {
  to: ChaosKind;
  /** つながる確率 */
  chance: number;
  /** 起こりやすさの倍率と、続く日数 */
  mult: number;
  days: number;
  /** 連鎖の説明（記録に出す） */
  why: string;
}

export interface ChaosDef {
  kind: ChaosKind;
  /** 名前（記録・お知らせ） */
  label: string;
  /** 開店のときに1日1回引く確率（その日の、ある時刻のあとに来た新規の客がこのイベントの主役になる） */
  dayChance: number;
  /** 何日目から起こるか */
  minDay: number;
  /** 起きたあと、同じイベントが起きない日数 */
  cooldownDays: number;
  /** 同時に起きたときの大事さ（大きいほど先・演出を優先） */
  priority: number;
  /** 営業の邪魔になる大きなイベント（ほかの大きなイベントとは同時に起きない） */
  disruptive: boolean;
  /** 夜（ゲーム内の時刻）の倍率・田舎（光害の少ないところ）の倍率 */
  nightMult?: number;
  ruralMult?: number;
  /** 主役のセリフ（来たとき・途中） */
  lines: readonly string[];
  /** まわりの客の反応の重み（性格で変わる） */
  reactions: Partial<Record<ReactKind, number>>;
  /** 反応する範囲（m）。0 なら反応しない */
  reactRadius: number;
  /** 反応した客の満足度の変化（よい珍事は少し上がる、迷惑は下がる） */
  reactMood: number;
  links: readonly ChaosLink[];
}

/** 共通の決まり */
export const CHAOS_RULES = {
  /** 同時に起きていてよい数（主役が店にいる間） */
  maxConcurrent: 2,
  /** 1日に起きてよい数 */
  perDayMax: 2,
  /** 連鎖の深さの上限（無限につながらない） */
  maxDepth: 2,
  /** 反応が続く秒（ゲームの秒） */
  reactSecFrom: 4,
  reactSecTo: 9,
  /** 同じ客が続けて反応しない間隔（秒） */
  reactGap: 25,
  /** 予定の時刻（開店からの割合） */
  planFrom: 0.12,
  planTo: 0.75,
} as const;

export const CHAOS: Readonly<Record<ChaosKind, ChaosDef>> = {
  ufo: {
    kind: 'ufo',
    label: 'UFO・宇宙人の来店',
    dayChance: 0.035,
    minDay: 4,
    cooldownDays: 5,
    priority: 5,
    disruptive: true,
    nightMult: 3,
    ruralMult: 1.6,
    lines: ['ワレワレハ ジロウヲ タベニキタ', '……ヤサイ、マシマシ。', 'チキュウノ アブラ、スバラシイ'],
    reactions: { surprise: 4, film: 3, scared: 2, laugh: 1 },
    reactRadius: 9,
    reactMood: 0.03,
    links: [{ to: 'golden', chance: 0.3, mult: 3, days: 1, why: '宇宙人を見た客が、何かに目覚めそう' }],
  },
  golden: {
    kind: 'golden',
    label: '金色覚醒',
    dayChance: 0.045,
    minDay: 3,
    cooldownDays: 3,
    priority: 4,
    disruptive: false,
    lines: ['……うおおおおっ！！', 'この一杯で、力がみなぎってきた……！', 'ごちそうさまでしたあああっ！！'],
    reactions: { surprise: 4, film: 4, laugh: 1 },
    reactRadius: 6,
    reactMood: 0.03,
    links: [{ to: 'ufo', chance: 0.15, mult: 2, days: 2, why: '空を飛んで帰った客を、空の上から誰かが見ていた' }],
  },
  bounce: {
    kind: 'bounce',
    label: '横バウンス・店内ダンス',
    dayChance: 0.05,
    minDay: 2,
    cooldownDays: 3,
    priority: 3,
    disruptive: false,
    lines: ['♪ ズン、チャッ、ズン、チャッ', '横に、跳ねて、また横に！', '食べるとき以外は踊っちゃう体質で…'],
    reactions: { laugh: 4, film: 3, imitate: 2, annoyed: 1 },
    reactRadius: 4.5,
    reactMood: 0.02,
    links: [{ to: 'bear', chance: 0.2, mult: 2, days: 2, why: 'ダンスの動画を見たクマが、店を探している' }],
  },
  nosepick: {
    kind: 'nosepick',
    label: '鼻をほじる迷惑客',
    dayChance: 0.1,
    minDay: 2,
    cooldownDays: 2,
    priority: 2,
    disruptive: false,
    lines: ['（ほじほじ……）', '（鼻をほじっている）'],
    reactions: { annoyed: 5, tell: 2, film: 1 },
    reactRadius: 2.4,
    reactMood: -0.04,
    links: [],
  },
  bear: {
    kind: 'bear',
    label: 'クマの来店（はちみつ好きのクマ「みつぐま」）',
    dayChance: 0.035,
    minDay: 4,
    cooldownDays: 5,
    priority: 4,
    disruptive: false,
    ruralMult: 2,
    lines: ['はちみつトッピング、ありますか？', 'もぐもぐ……おいしいクマ。', '森の仲間にも教えてあげるクマ'],
    reactions: { surprise: 4, film: 3, laugh: 2, scared: 1 },
    reactRadius: 7,
    reactMood: 0.03,
    links: [{ to: 'bounce', chance: 0.2, mult: 2, days: 2, why: 'クマの来店がうわさになり、踊る客も来そう' }],
  },
  // 客どうしの口論（じろ7 Phase 7・オーナーの判断 Q8）: となりの客と言い合いになる。店員が仲裁すると収まる
  quarrel: {
    kind: 'quarrel',
    label: '客どうしの口論',
    dayChance: 0.06,
    minDay: 3,
    cooldownDays: 2,
    priority: 2,
    disruptive: false,
    lines: ['ちょっと、肘が当たってるんですけど', 'ここ、私が先に座ってたんですけど？', 'コールの声、大きすぎませんか？', 'さっきから麺の汁が飛んでるんですよ'],
    reactions: { annoyed: 4, scared: 2, film: 2, tell: 2 },
    reactRadius: 3.5,
    reactMood: -0.04,
    links: [],
  },
};

export const CHAOS_KINDS: readonly ChaosKind[] = ['ufo', 'golden', 'bounce', 'nosepick', 'bear', 'quarrel'];

/** 口論の言い返し（相手の側） */
export const QUARREL_REPLIES: readonly string[] = ['はあ？ 狭いんだから仕方ないでしょ', '次郎系でそれ言います？', 'そっちこそ、すすり方がうるさいんですよ', '関係ないでしょ！', 'こっちだって急いでるんです'];

/** 仲裁されたときのセリフ */
export const QUARREL_CALMED: readonly string[] = ['……すみません、言いすぎました', 'お騒がせしました', 'まあ、ラーメンに罪はないですね'];

/** 反応のセリフ */
export const REACT_LINES: Readonly<Record<ReactKind, readonly string[]>> = {
  surprise: ['えっ！？', 'うそでしょ…', 'なになに！？'],
  laugh: ['あはは！', 'なにこれ最高', 'ウケる'],
  scared: ['こ、こわい…', 'ひっ…！', '大丈夫なの…？'],
  film: ['📱 撮っとこ', '📱 これは撮るしかない', '📱 動画回しとこ'],
  imitate: ['♪ 私も…！', 'つられちゃう～', '♪ 横に、ぴょん！'],
  annoyed: ['ちょっと…食欲なくなる', 'え、やめてほしい…', 'うわぁ…'],
  tell: ['すみません、隣の人が…', '店員さん、ちょっと…'],
};
