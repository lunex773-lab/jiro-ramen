// 営業中のイベントの文言（セリフ・投稿・クレーム）。後から追加・変更できるよう、ロジックから分けてここに置く。
// {shop} は店名に置き換える。

import type { ComplaintCause, ComplaintResponse, CriticItem } from '../types';

/** SNS で拡散する投稿 */
export const BUZZ_POSTS = [
  '「{shop}」の豚、厚さがバグってる #次郎系',
  '{shop}のマシマシ、山がエベレストだった',
  '{shop}の乳化スープ、飲み干したら優勝した',
  '並んででも食べたい。{shop}のワシワシ麺 #ラーメン好きと繋がりたい',
  '{shop}、ニンニクの暴力で午後の会議が終わった',
] as const;

/** SNS を見て来た客のひとこと */
export const BUZZ_SAYS = ['📱 SNSで見て来ました', '📱 これがバズってた店か', '📱 写真で見たやつだ…', '📱 タイムラインで流れてきた'] as const;

/** 珍しい客のセリフ（設計書 D-1, D-2。変えるときはここだけ） */
export const RARE_LINES = {
  /** 金髪の女性客が、一緒に来た彼氏に向けて */
  couple: '私S◯Xよりキスの方が上手いらしいねんな',
  /** 一人客が食事中に小声で */
  lover: 'ジブンほんまにここのラーメン好きやわ',
} as const;

/** 覆面調査員が待っている間のそぶり（正体の手がかり） */
export const CRITIC_NOTES = ['（メモを取っている）', '（店内をじっと見ている）', '（券売機を撮影している）'] as const;

/** クレームの言葉（提供の遅れ・汚れ。盛り間違い・品質は丼の評価の結果から作る） */
export const COMPLAINT_TEXT: Record<'delay' | 'dirty', readonly string[]> = {
  delay: ['まだですか？ずいぶん待ってるんですけど', 'いつまで待たせるの！', '後から来た人の方が先に出てない？'],
  dirty: ['カウンターがベタベタなんだけど。拭いてよ', 'ここ、汚れてるんですけど…'],
};

/** 理不尽な要求。yasai はヤサイをマシ以上で頼んだ客だけが言う */
export const UNREASONABLE_TEXT = {
  yasai: 'ヤサイ多すぎ！こんなの食べられない、タダにしてよ',
  any: [
    '隣の人の豚の方がデカい！不公平だから返金して',
    '量が多すぎる。残すから半額にしてよ',
    'ネットに悪く書かれたくなかったら、タダにしてくれる？',
    '麺が太い。普通の細麺に替えてよ',
  ],
} as const;

/** 原因の短い名前（画面の詳細欄・通知用） */
export const COMPLAINT_CAUSE_LABEL: Record<ComplaintCause, string> = {
  mistake: '盛り間違い',
  quality: '味・品質',
  delay: '提供が遅い',
  dirty: '席が汚い',
  unreasonable: '無理な要求',
};

/** 対応の名前（ボタンの読み上げ名） */
export const COMPLAINT_RESPONSE_LABEL: Record<ComplaintResponse, string> = {
  apologize: '謝る',
  remake: 'お詫びして作り直す',
  refund: 'お詫びして返金する',
  explain: '状況を説明する',
  refuse: '不当な要求を断る',
};

/** 対応したあとの客のひとこと */
export const COMPLAINT_REPLY = {
  accepted: {
    apologize: ['まあ、次から気をつけてね', 'わかりました…', 'しょうがないな'],
    explain: ['そういうことなら…', 'なるほど、わかりました', '…まあ、いいや'],
    refuse: ['ちっ…わかったよ', '…言ってみただけだよ'],
  },
  rejected: {
    apologize: ['謝るだけ？どうにかしてよ', '謝ってほしいんじゃないんだけど'],
    explain: ['言い訳はいいから！', '屁理屈はいい！'],
    refuse: ['なんだその態度は！', 'もう二度と来ない！'],
  },
  /** 正当なクレームを断られた */
  refusedLegit: 'クレームを突っぱねられた',
  /** 提供前に食券を払い戻した */
  ticketBack: 'じゃあ、食券代を返してください',
} as const;

/** 覆面調査員の評価項目の名前と、改善点の説明 */
export const CRITIC_ITEMS: Record<CriticItem, { name: string; improve: string }> = {
  taste: { name: '味・品質', improve: '麺のゆで加減・スープの温度・食材の鮮度' },
  speed: { name: '提供の速さ', improve: '着席から提供までの時間・行列の待ち時間' },
  service: { name: '接客', improve: 'コールの確認・クレームへの対応' },
  cleanliness: { name: '清潔さ', improve: 'カウンター・床・厨房の汚れ、ゴミ箱' },
  accuracy: { name: '注文の正確さ', improve: 'コールどおりの盛り付け' },
};
