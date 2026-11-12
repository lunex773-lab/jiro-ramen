// 知名度・話題性・SNS・YouTuber・店の伝説の数値と文（じろ7 Phase 7。設計書 7〜9・11）。
// オーナーの判断 Q7（控えめ）: 知名度は来客を最大 +20%（ゆっくり貯まる）、話題性は最大 +50%（毎日薄れる）、炎上は評判を最大 -0.3★。
// ふつうの日の収支がほぼ今のままになるよう、ふつうの営業だけでは知名度はほとんど上がらない（イベント・動画・SNS・伝説で上がる）。
// YouTuber・チャンネル・投稿者の名前はすべて架空（実在の人物・チャンネルではない）。

import type { FilmLevel, LegendRank, SnsKind, VideoOutcome, VideoPlan } from '../types';

export const FAME = {
  /** 来客への効き方の上限（Q7） */
  awarenessMaxBonus: 0.2,
  topicMaxBonus: 0.5,
  flameMaxRep: 0.3,
  /** ふつうの営業: 前の日に提供した数の平方根 × この値だけ知名度が上がり、毎日この割合で薄れる（1日100人なら 4 ほどでつり合う = 来客 +0.8%） */
  awarenessPerServedSqrt: 0.006,
  awarenessDecay: 0.015,
  /** 毎朝の話題性の残り（半分ほどになる） */
  topicKeep: 0.55,
  /** 話題性が高いほど SNS でバズりやすい（最大の倍率は 1 + この値） */
  buzzByTopic: 0.5,
  /** 残す数 */
  postsKeep: 60,
  historyKeep: 30,
  videosKeep: 40,
  creatorsKeep: 16,
  legendsKeep: 80,
  /** 一般の客の投稿: 基本の確率 + SNS の傾向 × この値。珍事を見た客は倍率 */
  postBase: 0.03,
  postSns: 0.22,
  postWitnessMult: 3,
  postMax: 0.75,
  /**
   * 1日の投稿 → 話題性・知名度（上限あり）。投稿の話題の強さは2乗で効かせる（珍事の投稿は強く、ふつうの写真・感想はほとんど効かない。
   * ふつうの日の話題性は 1 以下でつり合う）
   */
  postTopicScale: 12,
  postTopicCap: 30,
  postAwarenessScale: 1.5,
  postAwarenessCap: 2,
  /** 悪い投稿が多い日の評判の下がり（最大） */
  postRepMax: 0.04,
  /** 話題性がこれを超えたら「SNS で大拡散」の伝説（間を空ける） */
  explosionTopic: 60,
  explosionGapDays: 7,
} as const;

/** YouTuber の規模（設計書 7-2。登録者数の範囲と、来る YouTuber の中の割合） */
export const CREATOR_TIERS = [
  { id: 'small', label: '小規模', min: 1_000, max: 10_000, weight: 0.5 },
  { id: 'mid', label: '中規模', min: 10_000, max: 100_000, weight: 0.32 },
  { id: 'large', label: '大規模', min: 100_000, max: 1_000_000, weight: 0.14 },
  { id: 'huge', label: '超大規模', min: 1_000_000, max: 5_000_000, weight: 0.04 },
] as const;

export function creatorTierLabel(subs: number): string {
  for (let i = CREATOR_TIERS.length - 1; i >= 0; i--) if (subs >= CREATOR_TIERS[i]!.min) return CREATOR_TIERS[i]!.label;
  return CREATOR_TIERS[0].label;
}

/** 名前の部品（架空） */
export const CREATOR_NAME_HEAD = ['すすり', 'マシマシ', '背脂', 'もやし', 'ガッツ', 'カラメ', 'ニンニク', '天地返し', '極太', '麺活'] as const;
export const CREATOR_NAME_TAIL = ['太郎', 'ちゃん', '王子', '姫', '先生', '部長', 'マン', 'くん', '兄さん', 'ねえさん'] as const;
export const CHANNEL_HEAD = ['ズルズル', 'ガッツリ', '麺', '大盛り', '夜ふかし', 'ひとり飯', 'まんぷく', 'ラーメン'] as const;
export const CHANNEL_TAIL = ['チャンネル', 'TV', 'ちゃんねる', 'ログ', '食堂', 'ラボ', '研究所', '日記'] as const;

export const CREATOR_GENRE_LABEL = { gourmet: 'グルメ', challenge: '大食い・チャレンジ', variety: 'バラエティ', vlog: '日常', review: 'レビュー' } as const;
export const CREATOR_PERSONALITY_LABEL = { polite: 'ていねい', loud: 'にぎやか', reckless: '無茶をする', calm: '落ち着いている' } as const;
export const CREATOR_STYLE_LABEL = { handheld: '手持ちカメラ', tripod: '三脚', live: '生配信' } as const;

/**
 * 企画（設計書 7-3）: 面白さの基本・炎上しやすさ・撮るのに要る許可。
 * 許可の意味: full = 全部、dining = 客席の中だけ（店の外・厨房は撮らない）、noKitchen = 厨房以外（客席と店の外）、planOnly = 申し込まれた企画だけ
 */
export const VIDEO_PLANS: Readonly<Record<VideoPlan, { label: string; fun: number; flame: number; needs: readonly FilmLevel[]; titles: readonly string[] }>> = {
  bigEat: { label: '大食いチャレンジ', fun: 0.6, flame: 0.04, needs: ['full', 'dining', 'noKitchen', 'planOnly'], titles: ['【大食い】{shop}の大ラーメンを完食できるか！？', '【限界】マシマシ全部のせに挑戦してみた結果…'] },
  kitchen: { label: '厨房密着取材', fun: 0.55, flame: 0.03, needs: ['full', 'planOnly'], titles: ['【密着】{shop}の厨房の一日がすごすぎた', '1杯ができるまで全部見せます【{shop}】'] },
  spicyBig: { label: '激辛・大盛り検証', fun: 0.6, flame: 0.07, needs: ['full', 'dining', 'noKitchen', 'planOnly'], titles: ['【検証】{shop}の大盛りは本当に食べきれるのか', '激辛カラメ全マシにしたらどうなる？'] },
  live: { label: '突然の生配信', fun: 0.5, flame: 0.1, needs: ['full', 'noKitchen', 'planOnly'], titles: ['【生配信】いま{shop}に並んでます！', '突然ですが行列から生配信します'] },
  crazy: { label: '無茶な検証企画', fun: 0.75, flame: 0.22, needs: ['full', 'planOnly'], titles: ['【検証】次郎系を100回すすったら何秒かかる？', '店主にお願いして無茶な注文してみた【{shop}】'] },
  interview: { label: '店長インタビュー', fun: 0.45, flame: 0.02, needs: ['full', 'noKitchen', 'planOnly', 'dining'], titles: ['{shop}の店長に話を聞いてきた', '行列店のこだわりを聞いてみた【{shop}】'] },
  plain: { label: 'ふつうの食レポ', fun: 0.35, flame: 0.02, needs: ['full', 'dining', 'noKitchen', 'planOnly'], titles: ['{shop}に行ってきた', '今日のラーメン【{shop}】'] },
};

export const VIDEO_PLAN_KEYS: readonly VideoPlan[] = ['bigEat', 'kitchen', 'spicyBig', 'live', 'crazy', 'interview'];

/** 撮影の許可（5段）の名前と説明（ホストの確認の画面） */
export const FILM_LEVEL_LABEL: Readonly<Record<FilmLevel, { label: string; note: string }>> = {
  full: { label: '全面許可', note: '厨房も店の外も、どの企画も撮ってよい' },
  dining: { label: '店内（客席）のみ', note: '客席の中だけ。店の外・厨房は撮らない' },
  noKitchen: { label: '厨房以外を許可', note: '客席と店の外はよい。厨房はだめ' },
  planOnly: { label: 'この企画だけ許可', note: '申し込まれた企画だけ撮ってよい' },
  deny: { label: '撮影禁止', note: '撮影は断る（それでも撮ろうとする人がいる）' },
};

export const FILM_LEVELS: readonly FilmLevel[] = ['full', 'dining', 'noKitchen', 'planOnly', 'deny'];

/** 動画の結果: 再生数の倍率・知名度・話題性・評判の変化（評判は炎上・評価の低下だけ） */
export const VIDEO_OUTCOMES: Readonly<Record<VideoOutcome, { label: string; views: number; awareness: number; topic: number; reputation: number }>> = {
  normal: { label: '普通', views: 1, awareness: 0.4, topic: 2, reputation: 0 },
  small: { label: '小さな成功', views: 1.8, awareness: 1.2, topic: 6, reputation: 0 },
  hit: { label: '大ヒット', views: 4, awareness: 3.5, topic: 15, reputation: 0 },
  viral: { label: '爆発的なバズ', views: 12, awareness: 8, topic: 35, reputation: 0 },
  flame: { label: '炎上', views: 6, awareness: 4, topic: 25, reputation: -FAME.flameMaxRep },
  sour: { label: '投稿後に評価が低下', views: 3, awareness: 1.5, topic: 8, reputation: -0.08 },
};

/** 一般の客の SNS の投稿（設計書 8）: 話題の強さ・好意・文（{shop} は店の名前） */
export const SNS_KINDS: Readonly<Record<SnsKind, { topic: number; favor: number; texts: readonly string[]; bad?: readonly string[] }>> = {
  photo: { topic: 0.1, favor: 0.5, texts: ['{shop}の小ラーメン、野菜マシマシの山！', '今日の一杯。{shop}の背脂がうまい', '【写真】{shop}の天地返し'] },
  review: { topic: 0.08, favor: 0.4, texts: ['{shop}、また来たい', '量も味も大満足だった', '{shop}のスープ、クセになる'], bad: ['{shop}、ちょっと待たされた…', '今日はイマイチだった', 'うーん、期待しすぎたかも'] },
  ufo: { topic: 0.95, favor: 0.6, texts: ['【速報】{shop}の前にUFOが降りてきた', 'ラーメン屋に宇宙人が並んでたんだが？？', '宇宙人も次郎系が好きらしい'] },
  golden: { topic: 0.85, favor: 0.6, texts: ['ラーメン食べた人が金色に光って空を飛んでった', '{shop}の一杯、人を覚醒させるらしい', '覚醒する瞬間を見てしまった…'] },
  dance: { topic: 0.6, favor: 0.5, texts: ['{shop}に横に弾む客がいて店内が踊りだした', '踊りながら行列に並ぶ人を初めて見た', '音楽が流れてて楽しい店だった'] },
  rare: { topic: 0.7, favor: 0.6, texts: ['{shop}にクマが並んでた（本当）', 'はちみつトッピングを聞くクマがいた', '珍しいお客さんがいた'] },
  staff: { topic: 0.15, favor: 0.6, texts: ['{shop}の店員さん、対応が神', '忙しいのに丁寧だった'], bad: ['{shop}の店員さん、ちょっと雑…', '提供が遅いし説明もなかった'] },
  nuisance: { topic: 0.3, favor: -0.2, texts: ['店員さんがすぐ注意してくれて助かった'], bad: ['隣の客が鼻ほじってて食欲なくなった…', '迷惑な客がいたのに店は放置'] },
  quarrel: { topic: 0.35, favor: -0.1, texts: ['客同士のケンカを店員さんがうまく収めてた'], bad: ['{shop}で客同士がケンカしてた…', '口論がうるさくて落ち着かなかった'] },
  share: { topic: 0.4, favor: 0.4, texts: ['この動画の店、行ってきた！（{channel}）', '{channel}の動画で見た店！'] },
};

/** 投稿者の名前（架空のハンドルネーム） */
export const HANDLE_HEAD = ['ramen', 'men', 'jiro', 'zuru', 'hara', 'mashi', 'ninniku', 'abura', 'yasai', 'karame'] as const;
export const HANDLE_TAIL = ['lover', 'daisuki', 'nikki', 'log', 'san', 'chan', 'kun', 'ism'] as const;

/**
 * 店の伝説（設計書 9）: 種類ごとの珍しさの基本・称号・名前。
 * 点数 = 珍しさの基本 + 見た客・撮影・連鎖・同時のイベント・SNS・再生数で上がる。ランクは点数で決める
 */
export const LEGEND_KINDS: Readonly<Record<string, { base: number; title: string; name: string; record: boolean }>> = {
  ufo: { base: 0.62, title: 'UFO が来た店', name: 'UFO 来店事件', record: true },
  golden: { base: 0.55, title: '覚醒の一杯', name: '金色覚醒事件', record: true },
  bear: { base: 0.5, title: 'クマも並ぶ店', name: 'クマ「みつぐま」来店', record: true },
  bounce: { base: 0.32, title: '踊る行列', name: '店内ダンス騒動', record: true },
  quarrel: { base: 0.12, title: '仲裁の名店', name: '客どうしの口論', record: false },
  nosepick: { base: 0.08, title: '', name: '鼻ほじり客', record: false },
  viral: { base: 0.6, title: 'バズった店', name: '動画の大バズ', record: true },
  hit: { base: 0.38, title: '動画で見た店', name: '動画の大ヒット', record: true },
  flame: { base: 0.4, title: '', name: '動画の炎上', record: true },
  sns: { base: 0.45, title: '話題沸騰の店', name: 'SNS で大拡散', record: true },
  tv: { base: 0.42, title: 'テレビで見た店', name: 'テレビ取材', record: true },
  chain: { base: 0.5, title: '珍事が呼ぶ店', name: '珍事の連鎖', record: true },
};

/** ランク（設計書 9-4）: 点数のしきい値・名前・知名度と話題性への上乗せ・飾る物 */
export const LEGEND_RANKS: readonly { rank: LegendRank; min: number; label: string; awareness: number; topic: number; display: 'photo' | 'plaque' | 'trophy' | 'video' }[] = [
  { rank: 'myth', min: 0.88, label: '神話級', awareness: 9, topic: 20, display: 'trophy' },
  { rank: 'legend', min: 0.72, label: '伝説', awareness: 5, topic: 12, display: 'trophy' },
  { rank: 'epic', min: 0.55, label: '激レア', awareness: 2.5, topic: 6, display: 'plaque' },
  { rank: 'rare', min: 0.35, label: '希少', awareness: 1, topic: 3, display: 'plaque' },
  { rank: 'normal', min: 0, label: '通常', awareness: 0.5, topic: 1, display: 'photo' },
];

export function legendRankOf(score: number): (typeof LEGEND_RANKS)[number] {
  return LEGEND_RANKS.find((r) => score >= r.min) ?? LEGEND_RANKS[LEGEND_RANKS.length - 1]!;
}

export const LEGEND_RANK_LABEL: Readonly<Record<LegendRank, string>> = { normal: '通常', rare: '希少', epic: '激レア', legend: '伝説', myth: '神話級' };

/** 神話級の伝説が出たときの称号 */
export const MYTH_TITLE = '神話の店';
