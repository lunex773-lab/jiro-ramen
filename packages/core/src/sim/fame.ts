// 知名度・話題性・SNS・YouTuber と動画・店の伝説（じろ7 Phase 7。設計書 7〜9・11）。
// - 評判（★。口コミで決まる今の値）・知名度（店を知っている人の多さ）・話題性（今の話題の強さ）を分けて持つ。来客への効き方には上限がある（オーナーの判断 Q7）
// - 状態は店ごと（GameState.fame。会社の店を切り替えると入れ替わる）。古いセーブにはないので ensureFame で補う
// - 抽選は専用の乱数（fame.rng）。客の乱数（s.rng）・イベントの乱数（events.rng）・珍客の乱数（chaos.rng）の並びは変えない
// - YouTuber は一度来ても消えずに残り（登録者数・投稿の記録・店との関係）、動画は撮った翌日に投稿されて結果（普通〜大バズ・炎上）が決まる
// - 一般の客も帰るときに SNS に投稿する（見た珍事・満足度・店員の対応）。投稿の話題は翌朝に話題性・知名度へまとめ、話題性は毎日薄れる
// - 珍事件は店の伝説として残し、ランク（通常〜神話級）を付ける。高いランクで称号を得る。記念品の棚に飾る（client）
//
// 注意: client の共同経営の複製（サーバーから配られた状態）では ensureFame を呼ばないこと。読むだけなら s.fame?.… を使う。

import {
  CHANNEL_HEAD,
  CHANNEL_TAIL,
  CREATOR_NAME_HEAD,
  CREATOR_NAME_TAIL,
  CREATOR_TIERS,
  FAME,
  HANDLE_HEAD,
  HANDLE_TAIL,
  LEGEND_KINDS,
  legendRankOf,
  MYTH_TITLE,
  SNS_KINDS,
  VIDEO_OUTCOMES,
  VIDEO_PLAN_KEYS,
  VIDEO_PLANS,
} from '../data/fame';
import type { Creator, Customer, FameState, FilmLevel, GameState, Id, Legend, SnsKind, SnsPost, Video, VideoOutcome, VideoPlan } from '../types';
import { clamp, clamp01, hashString, newId, rand } from '../util';
import { activeStore } from './company';
import { emit, notify, type SimCtx } from './notices';

// ───────────────────────── 状態 ─────────────────────────

export function newFame(seed: number): FameState {
  return {
    rng: (hashString(`fame:${seed}`) ^ 0x2545f491) >>> 0,
    awareness: 0,
    topic: 0,
    history: [],
    posts: [],
    today: { day: -1, posts: 0, topic: 0, favor: 0, awareness: 0 },
    creators: [],
    videos: [],
    ytBoosts: [],
    legends: [],
    titles: [],
    lastExplosionDay: -1e9,
  };
}

/** 知名度などの状態。なければ作る（シミュレーションの中でだけ呼ぶ） */
export function ensureFame(s: GameState): FameState {
  if (!s.fame) s.fame = newFame(s.seed);
  return s.fame;
}

function fr(s: GameState): number {
  return rand(ensureFame(s));
}

function pickF<T>(s: GameState, list: readonly T[]): T {
  return list[Math.floor(fr(s) * list.length) % list.length]!;
}

/** 店の表示名（stores.ts の storeDisplayName と同じ決め方。読み込みの輪を作らないためここに置く） */
function shopName(s: GameState): string {
  if (!s.company) return s.shopName;
  const e = activeStore(s);
  return e.propertyId === 'home' ? s.shopName : e.name;
}

// ───────────────────────── 来客への効き方 ─────────────────────────

/**
 * 知名度・話題性による来客の倍率（読むだけ。上限はオーナーの判断 Q7）。
 * events = false（予測など、イベントを入れない見込み）のときは、毎日薄れる話題性を入れない
 */
export function fameDemandFactor(s: GameState, events = true): number {
  const f = s.fame;
  if (!f) return 1;
  const a = 1 + FAME.awarenessMaxBonus * clamp01(f.awareness / 100);
  const t = events ? 1 + FAME.topicMaxBonus * clamp01(f.topic / 100) : 1;
  return a * t;
}

/** 話題性による SNS バズの確率の倍率（読むだけ） */
export function topicBuzzFactor(s: GameState): number {
  return 1 + FAME.buzzByTopic * clamp01((s.fame?.topic ?? 0) / 100);
}

// ───────────────────────── 毎朝のまとめ ─────────────────────────

/**
 * 翌日の朝（onDayStartEvents から）: 前の日の投稿を話題性・知名度へまとめ、話題性を薄め、投稿する日になった動画を投稿する。
 * ふつうの営業でも知名度はわずかに上がる（前の日に提供した数の平方根）。記録を残し、古いものを消す
 */
export function onDayStartFame(s: GameState, ctx: SimCtx): void {
  if (s.tutorial) return;
  const f = ensureFame(s);
  const prev = s.day - 1;
  // 知名度はゆっくり薄れ、ふつうの営業で少し上がる
  const served = s.history.find((r) => r.day === prev)?.served ?? 0;
  f.awareness = clamp(f.awareness * (1 - FAME.awarenessDecay) + FAME.awarenessPerServedSqrt * Math.sqrt(Math.max(0, served)), 0, 100);
  // 話題性は毎日薄れる
  f.topic = clamp(f.topic * FAME.topicKeep, 0, 100);
  // 前の日の投稿
  if (f.today.day === prev && f.today.posts > 0) {
    f.topic = clamp(f.topic + Math.min(FAME.postTopicCap, f.today.topic * FAME.postTopicScale), 0, 100);
    f.awareness = clamp(f.awareness + Math.min(FAME.postAwarenessCap, f.today.awareness * FAME.postAwarenessScale), 0, 100);
    // 悪い投稿が多い日は評判（★）が少し下がる
    if (f.today.favor < 0) s.reputation = clamp(s.reputation - Math.min(FAME.postRepMax, -f.today.favor * 0.01), 1, 5);
  }
  f.today = { day: s.day, posts: 0, topic: 0, favor: 0, awareness: 0 };
  // 動画の投稿（撮った翌日）
  for (const v of f.videos) if (!v.posted && v.postDay <= s.day) postVideo(s, ctx, v);
  f.ytBoosts = f.ytBoosts.filter((b) => b.untilDay >= s.day);
  // SNS で大拡散（話題性がとても高い）
  if (f.topic >= FAME.explosionTopic && s.day - f.lastExplosionDay >= FAME.explosionGapDays) {
    f.lastExplosionDay = s.day;
    addLegend(s, ctx, 'sns', {
      summary: `SNS で${shopName(s)}の話題が一気に広がった（話題性 ${Math.round(f.topic)}）`,
      sns: f.posts.filter((p) => p.day >= s.day - 2).length,
      bonus: clamp01((f.topic - FAME.explosionTopic) / 80) * 0.3,
    });
  }
  f.history.push({ day: s.day, awareness: round1(f.awareness), topic: round1(f.topic), reputation: Math.round(s.reputation * 100) / 100 });
  if (f.history.length > FAME.historyKeep) f.history.splice(0, f.history.length - FAME.historyKeep);
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ───────────────────────── 一般の客の SNS ─────────────────────────

function handle(s: GameState): string {
  return `@${pickF(s, HANDLE_HEAD)}_${pickF(s, HANDLE_TAIL)}${Math.floor(fr(s) * 90) + 10}`;
}

function addPost(s: GameState, p: Omit<SnsPost, 'id' | 'day' | 't'>): SnsPost {
  const f = ensureFame(s);
  const post: SnsPost = { id: newId(s, 'sns'), day: s.day, t: Math.round(s.t), ...p };
  f.posts.push(post);
  if (f.posts.length > FAME.postsKeep) f.posts.splice(0, f.posts.length - FAME.postsKeep);
  if (f.today.day !== s.day) f.today = { day: s.day, posts: 0, topic: 0, favor: 0, awareness: 0 };
  f.today.posts += 1;
  // 話題の強さは2乗で効かせる（珍事の投稿は強く、ふつうの写真・感想はほとんど効かない）
  f.today.topic += post.topic ** 2 * post.reach * post.credibility;
  f.today.favor += post.favor * post.reach;
  f.today.awareness += post.reach * post.topic ** 2;
  return post;
}

/** 客の性格の値（chaos.ts の traitOf と同じ決め方。前のセーブの客は ID から決まる値） */
function trait(c: Customer, k: 'sns' | 'filming'): number {
  const v = c.traits[k];
  if (typeof v === 'number') return v;
  return (hashString(`${k}:${c.id}`) % 1000) / 1000;
}

/** 珍事の種類 → 投稿の種類 */
const SAW_TO_POST: Record<string, SnsKind> = { ufo: 'ufo', golden: 'golden', bounce: 'dance', bear: 'rare', nosepick: 'nuisance', quarrel: 'quarrel' };

/**
 * 客が帰るとき（finalizeVisit から）: SNS に投稿するかを決める。見た珍事（撮影したもの）があれば、その話題を投稿しやすい。
 * 投稿は店の売上を直接変えず、翌朝に話題性・知名度へまとめる
 */
export function onVisitSns(s: GameState, c: Customer, sat: number, failed: boolean): void {
  if (s.tutorial || c.script || c.special?.kind === 'tv_staff' || c.special?.kind === 'tv_camera' || c.special?.kind === 'youtuber') return;
  const saw = (c.saw ?? []).filter((x) => SAW_TO_POST[x.kind]);
  const p = Math.min(FAME.postMax, (FAME.postBase + FAME.postSns * trait(c, 'sns')) * (saw.length > 0 ? FAME.postWitnessMult : 1));
  if (fr(s) >= p) return;
  const shop = shopName(s);
  let kind: SnsKind;
  let good = sat >= 0.55;
  let filmed = false;
  if (saw.length > 0) {
    const pickSaw = saw.find((x) => x.filmed) ?? saw[0]!;
    kind = SAW_TO_POST[pickSaw.kind]!;
    filmed = pickSaw.filmed;
    // 迷惑（鼻ほじり・口論）は店の対応で好意が変わる
    if (kind === 'nuisance' || kind === 'quarrel') good = sat >= 0.6 && !failed;
    else good = true;
  } else if (c.sat.service > 0.85 || c.sat.service < 0.3) {
    kind = 'staff';
    good = c.sat.service > 0.85;
  } else {
    kind = fr(s) < 0.55 ? 'photo' : 'review';
    if (kind === 'photo') good = true;
  }
  const def = SNS_KINDS[kind];
  const texts = good || !def.bad ? def.texts : def.bad;
  const text = pickF(s, texts).replace('{shop}', shop).replace('{channel}', '');
  const reach = clamp01(0.08 + 0.9 * trait(c, 'sns') ** 2 + (filmed ? 0.15 : 0));
  const topic = clamp01(def.topic * (filmed ? 1.3 : 1));
  const credibility = filmed ? 0.9 : kind === 'ufo' || kind === 'golden' ? 0.35 : 0.6;
  const favor = good ? Math.abs(def.favor) * (0.6 + 0.4 * sat) : -Math.max(0.2, Math.abs(def.favor)) * (1.2 - sat);
  addPost(s, { author: handle(s), kind, text, topic, credibility, favor, reach, reactions: Math.round(reach * topic * (40 + 400 * fr(s))) });
}

/** 珍事を見た客を覚えておく（chaos.ts の反応から）。帰ったあとの投稿に使う */
export function noteSaw(c: Customer, kind: string, filmed: boolean): void {
  const list = (c.saw ??= []);
  const e = list.find((x) => x.kind === kind);
  if (e) e.filmed = e.filmed || filmed;
  else list.push({ kind, filmed });
}

// ───────────────────────── YouTuber ─────────────────────────

/** 架空の YouTuber を作る（規模は CREATOR_TIERS の割合で） */
export function makeCreator(s: GameState, discoveredFrom: Id | null = null): Creator {
  const f = ensureFame(s);
  let r = fr(s);
  let tier: (typeof CREATOR_TIERS)[number] = CREATOR_TIERS[0];
  for (const t of CREATOR_TIERS) {
    if (r < t.weight) {
      tier = t;
      break;
    }
    r -= t.weight;
  }
  const subs = Math.round(Math.exp(Math.log(tier.min) + (Math.log(tier.max) - Math.log(tier.min)) * fr(s)));
  let name = '';
  let channel = '';
  for (let i = 0; i < 6; i++) {
    name = `${pickF(s, CREATOR_NAME_HEAD)}${pickF(s, CREATOR_NAME_TAIL)}`;
    channel = `${pickF(s, CHANNEL_HEAD)}${pickF(s, CHANNEL_TAIL)}`;
    if (!f.creators.some((c) => c.name === name || c.channel === channel)) break;
  }
  const personality = pickF(s, ['polite', 'loud', 'reckless', 'calm'] as const);
  return {
    id: newId(s, 'yt'),
    name,
    channel,
    subs,
    popularity: clamp01(0.2 + 0.6 * fr(s)),
    genre: pickF(s, ['gourmet', 'challenge', 'variety', 'vlog', 'review'] as const),
    personality,
    style: pickF(s, ['handheld', 'tripod', 'live'] as const),
    quality: clamp01(0.3 + 0.6 * fr(s)),
    flameRisk: clamp01((personality === 'reckless' ? 0.5 : personality === 'loud' ? 0.3 : 0.1) + 0.3 * fr(s)),
    interest: clamp01(0.3 + 0.7 * fr(s)),
    relation: 0,
    visits: 0,
    lastVisitDay: -1,
    videos: [],
    discoveredFrom,
  };
}

/**
 * 来店する YouTuber を決める（media.ts の来店から）: 前に来た人（店への興味・関係・動画を見て来た）か、新しい人。
 * 返す YouTuber は名簿に入っている
 */
export function pickCreator(s: GameState): Creator {
  const f = ensureFame(s);
  const known = f.creators.filter((c) => s.day - c.lastVisitDay >= 3 && c.relation > -0.6);
  // 前に来た人がまた来る（興味と関係で）。動画の反響で別の人が来るときは新しい人
  const boostFrom = f.ytBoosts.length > 0 && fr(s) < 0.6 ? f.ytBoosts[f.ytBoosts.length - 1]!.from : null;
  if (!boostFrom && known.length > 0 && fr(s) < 0.4) {
    const w = known.map((c) => Math.max(0.05, c.interest * (1 + c.relation)));
    let x = fr(s) * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < known.length; i++) {
      x -= w[i]!;
      if (x <= 0) return known[i]!;
    }
    return known[known.length - 1]!;
  }
  const c = makeCreator(s, boostFrom);
  f.creators.push(c);
  if (f.creators.length > FAME.creatorsKeep) {
    // 動画が少なく関係の薄い人から消す（いま来ている人は消さない）
    const removable = f.creators.filter((x) => x.id !== c.id).sort((a, b) => a.videos.length + Math.abs(a.relation) - (b.videos.length + Math.abs(b.relation)));
    const drop = removable[0];
    if (drop) f.creators = f.creators.filter((x) => x !== drop);
  }
  return c;
}

/** 企画を決める（ジャンル・性格で選びやすいものが変わる） */
export function pickPlan(s: GameState, c: Creator): VideoPlan {
  const w: Record<string, number> = { bigEat: 1, kitchen: 0.6, spicyBig: 1, live: 0.6, crazy: 0.4, interview: 0.7 };
  const mul = (k: string, m: number) => {
    w[k] = (w[k] ?? 0) * m;
  };
  if (c.genre === 'challenge') {
    mul('bigEat', 2.5);
    mul('spicyBig', 2);
  }
  if (c.genre === 'review' || c.genre === 'gourmet') {
    mul('interview', 2);
    mul('kitchen', 1.8);
  }
  if (c.genre === 'variety') mul('crazy', 2.5);
  if (c.style === 'live') mul('live', 3);
  if (c.personality === 'reckless') mul('crazy', 2);
  if (c.personality === 'polite') mul('crazy', 0.3);
  const keys = VIDEO_PLAN_KEYS;
  let x = fr(s) * keys.reduce((a, k) => a + (w[k] ?? 0), 0);
  for (const k of keys) {
    x -= w[k] ?? 0;
    if (x <= 0) return k;
  }
  return 'bigEat';
}

/** 許可の範囲でその企画が撮れるか */
export function planAllowed(plan: VideoPlan, level: FilmLevel | undefined): boolean {
  if (!level || level === 'deny') return false;
  return VIDEO_PLANS[plan].needs.includes(level);
}

/** 撮影中の YouTuber に、起きた珍事が映る（chaos.ts の始まりから） */
export function noteFeatured(s: GameState, kind: string): void {
  for (const c of s.customers) {
    const f = c.special?.film;
    if (c.special?.kind !== 'youtuber' || !f || f.filming !== 'filming') continue;
    const list = (f.featured ??= []);
    if (!list.includes(kind)) list.push(kind);
  }
}

/** 珍事の珍しさ（動画の珍しさ） */
const FEATURE_RARITY: Record<string, number> = { ufo: 1, golden: 0.9, bear: 0.8, bounce: 0.5, quarrel: 0.3, nosepick: 0.25, tv: 0.6 };

/**
 * 撮影が終わった（media.ts から）: 動画を作り、翌日に投稿する。
 * 許可の範囲で企画が撮れなければ、ふつうの食レポになる。許可なく撮った動画は炎上しやすい
 */
export function makeVideo(s: GameState, ctx: SimCtx, c: Customer, sneaky: boolean): Video | null {
  const film = c.special?.film;
  if (!film?.creatorId) return null;
  const f = ensureFame(s);
  const cr = f.creators.find((x) => x.id === film.creatorId);
  if (!cr) return null;
  const level: FilmLevel | 'none' = film.level ?? 'none';
  const wanted = film.plan ?? 'plain';
  const plan: VideoPlan = sneaky ? wanted : planAllowed(wanted, film.level) ? wanted : 'plain';
  const def = VIDEO_PLANS[plan];
  const featured = [...(film.featured ?? [])];
  const rarity = clamp01(featured.reduce((a, k) => a + (FEATURE_RARITY[k] ?? 0.2), 0) * 0.8);
  // 品質: YouTuber の腕・食事の満足度。面白さ: 企画・性格・映った珍事
  const meal = clamp01((c.sat.taste + c.sat.speed + c.sat.service) / 3);
  const quality = clamp01(cr.quality * 0.6 + meal * 0.4);
  const fun = clamp01(def.fun + (cr.personality === 'loud' || cr.personality === 'reckless' ? 0.08 : 0) + rarity * 0.35 + (fr(s) - 0.5) * 0.15);
  const title = pickF(s, def.titles).replace('{shop}', shopName(s));
  const v: Video = {
    id: newId(s, 'vid'),
    creatorId: cr.id,
    title: featured.includes('ufo') ? `【衝撃】ラーメン屋に UFO が来た…${title}` : featured.length > 0 ? `【珍事】${title}` : title,
    day: s.day,
    postDay: s.day + 1,
    posted: false,
    plan,
    level,
    quality,
    fun,
    rarity,
    featured,
    sneaky,
    views: 0,
    likes: 0,
    comments: 0,
    spread: 0,
    outcome: null,
    effect: { awareness: 0, topic: 0, reputation: 0 },
  };
  f.videos.push(v);
  if (f.videos.length > FAME.videosKeep) f.videos.splice(0, f.videos.length - FAME.videosKeep);
  cr.videos.push(v.id);
  cr.visits += 1;
  cr.lastVisitDay = s.day;
  // 許可して撮れた・企画どおりに撮れたら関係がよくなる
  cr.relation = clamp(cr.relation + (sneaky ? -0.1 : plan === wanted ? 0.15 : 0.05), -1, 1);
  emit(ctx, { type: 'videoMade', targetId: v.id });
  return v;
}

/** 断られた・揉めた（関係が下がる） */
export function creatorSnubbed(s: GameState, creatorId: Id | undefined, amount: number): void {
  const cr = s.fame?.creators.find((x) => x.id === creatorId);
  if (cr) {
    cr.relation = clamp(cr.relation - amount, -1, 1);
    cr.visits += 1;
    cr.lastVisitDay = s.day;
  }
}

/**
 * 動画を投稿する（撮った翌日の朝）: 再生数と結果を決め、知名度・話題性・評判へ別々に効かせる。
 * 大ヒット・大バズはほかの YouTuber を呼び（後日来やすくなる）、珍事が映っていれば店の伝説になる
 */
export function postVideo(s: GameState, ctx: SimCtx, v: Video): void {
  const f = ensureFame(s);
  const cr = f.creators.find((x) => x.id === v.creatorId);
  v.posted = true;
  const subs = cr?.subs ?? 5000;
  const def = VIDEO_PLANS[v.plan];
  // 結果: 炎上（企画・性格・許可なし）→ 点数で普通〜大バズ。大ヒットでも食事がよくなければ、あとで評価が下がることがある
  const flameP = clamp01((cr?.flameRisk ?? 0.2) * 0.25 + def.flame + (v.sneaky ? 0.15 : 0));
  const score = v.quality * 0.35 + v.fun * 0.3 + v.rarity * 0.35 + (fr(s) - 0.5) * 0.3;
  let outcome: VideoOutcome = score > 0.8 ? 'viral' : score > 0.64 ? 'hit' : score > 0.5 ? 'small' : 'normal';
  if (fr(s) < flameP) outcome = 'flame';
  else if ((outcome === 'hit' || outcome === 'viral') && v.quality < 0.45 && fr(s) < 0.5) outcome = 'sour';
  const o = VIDEO_OUTCOMES[outcome];
  const reachF = (0.04 + 0.3 * (cr?.popularity ?? 0.4)) * (0.6 + 0.6 * v.quality + 0.4 * v.fun + 0.8 * v.rarity) * Math.exp((fr(s) - 0.5) * 0.8);
  v.views = Math.max(50, Math.round(subs * reachF * o.views));
  v.likes = Math.round(v.views * (outcome === 'flame' ? 0.01 : 0.03 + 0.04 * v.quality));
  v.comments = Math.round(v.views * (outcome === 'flame' ? 0.02 : 0.004));
  v.spread = clamp01(Math.log10(v.views + 1) / 7);
  v.outcome = outcome;
  // 店への影響: 規模（登録者数）で大きさが変わる。評判は炎上・評価の低下だけ（上限 Q7）
  const scale = clamp(Math.log10(subs) / 5, 0.6, 1.4);
  const da = o.awareness * scale;
  const dt = o.topic * scale;
  const dr = o.reputation * (outcome === 'flame' ? clamp01(0.5 + v.spread) : 1);
  f.awareness = clamp(f.awareness + da, 0, 100);
  f.topic = clamp(f.topic + dt, 0, 100);
  s.reputation = clamp(s.reputation + Math.max(-FAME.flameMaxRep, dr), 1, 5);
  v.effect = { awareness: round1(da), topic: round1(dt), reputation: Math.round(dr * 100) / 100 };
  if (cr) {
    cr.subs = Math.round(cr.subs + v.views * (outcome === 'flame' ? 0.0005 : 0.002));
    cr.popularity = clamp01(cr.popularity + (outcome === 'viral' ? 0.08 : outcome === 'hit' ? 0.03 : 0));
  }
  // 動画を見た人の共有（話題の投稿）
  const shares = outcome === 'viral' ? 4 : outcome === 'hit' ? 2 : outcome === 'flame' ? 3 : outcome === 'small' ? 1 : 0;
  for (let i = 0; i < shares; i++) {
    const good = outcome !== 'flame';
    addPost(s, {
      author: handle(s),
      kind: 'share',
      text: good ? pickF(s, SNS_KINDS.share.texts).replace('{channel}', cr?.channel ?? 'この動画').replace('{shop}', shopName(s)) : `${cr?.channel ?? 'あの動画'}の撮り方、さすがにひどくない？`,
      topic: SNS_KINDS.share.topic,
      credibility: 0.8,
      favor: good ? 0.4 : -0.5,
      reach: clamp01(0.2 + 0.6 * fr(s)),
      reactions: Math.round(v.views * 0.002 * (0.5 + fr(s))),
      ref: v.id,
    });
  }
  const label = `${cr ? `${cr.name}（${cr.channel}）` : 'YouTuber'}の動画「${v.title}」`;
  const level = outcome === 'flame' || outcome === 'sour' ? 'warn' : outcome === 'normal' ? 'info' : 'good';
  notify(s, ctx, `video:${v.id}`, level, `${label}が公開されました: ${o.label}（再生 ${v.views.toLocaleString('ja-JP')}回）`);
  emit(ctx, { type: 'videoPosted', targetId: v.id, text: outcome });
  // 大ヒット・大バズ: ほかの YouTuber が見て、後日来やすくなる（連鎖。必ずではない）。大バズは珍客も来やすくなる
  if (outcome === 'viral' || outcome === 'hit') {
    f.ytBoosts.push({ untilDay: s.day + 4, mult: outcome === 'viral' ? 2 : 1.4, from: v.id });
    const ch = s.events?.chaos;
    if (outcome === 'viral' && ch) {
      const kinds = ['ufo', 'golden', 'bounce', 'bear'] as const;
      const k = kinds[Math.floor(fr(s) * kinds.length) % kinds.length]!;
      ch.boosts.push({ kind: k, mult: 1.5, untilDay: s.day + 3, cause: v.id, depth: 1 });
    }
  }
  // 店の伝説: 大ヒット・大バズ・炎上、珍事が映った動画
  if (outcome === 'viral' || outcome === 'hit' || outcome === 'flame' || v.rarity >= 0.7) {
    addLegend(s, ctx, outcome === 'viral' ? 'viral' : outcome === 'flame' ? 'flame' : 'hit', {
      title: `${LEGEND_KINDS[outcome === 'viral' ? 'viral' : outcome === 'flame' ? 'flame' : 'hit']!.name}「${v.title}」`,
      summary: `${label}が${o.label}。再生 ${v.views.toLocaleString('ja-JP')}回${v.featured.length > 0 ? `（映った珍事: ${v.featured.length}件）` : ''}`,
      people: cr ? [cr.name] : [],
      related: [v.id],
      views: v.views,
      bonus: v.rarity * 0.2 + clamp01(Math.log10(v.views + 1) / 8) * 0.15,
    });
  }
}

/** YouTuber が来やすくなる倍率（大ヒット・大バズの動画を見た別の YouTuber。読むだけ） */
export function creatorVisitFactor(s: GameState): number {
  const list = s.fame?.ytBoosts ?? [];
  return list.filter((b) => b.untilDay >= s.day).reduce((a, b) => a * b.mult, 1);
}

// ───────────────────────── 店の伝説 ─────────────────────────

export interface LegendInput {
  title?: string;
  summary: string;
  people?: string[];
  related?: Id[];
  sns?: number;
  views?: number;
  witnesses?: number;
  films?: number;
  depth?: number;
  /** 点数への上乗せ（0..） */
  bonus?: number;
}

/**
 * 店の伝説を1つ足す。点数 = 種類の珍しさ + 見た客・撮影・連鎖・同時のイベント・SNS・再生数・上乗せ（少しのゆらぎ）。
 * ランクが高いほど知名度・話題性が上がり、激レア以上で称号を得る
 */
export function addLegend(s: GameState, ctx: SimCtx, kind: string, o: LegendInput): Legend | null {
  const k = LEGEND_KINDS[kind];
  if (!k) return null;
  const f = ensureFame(s);
  const witnesses = o.witnesses ?? 0;
  const films = o.films ?? 0;
  const related = o.related ?? [];
  const importance = clamp01(0.2 + witnesses * 0.04 + films * 0.06 + (o.sns ?? 0) * 0.03 + (o.views ? Math.log10(o.views + 1) / 8 : 0));
  const score = clamp01(
    k.base +
      Math.min(0.1, witnesses * 0.012) +
      Math.min(0.12, films * 0.025) +
      (o.depth ?? 0) * 0.08 +
      Math.max(0, related.length - 1) * 0.05 +
      (o.bonus ?? 0) +
      (fr(s) - 0.5) * 0.08,
  );
  const r = legendRankOf(score);
  const entry = s.company ? activeStore(s) : null;
  const legend: Legend = {
    id: newId(s, 'lg'),
    kind,
    title: o.title ?? k.name,
    day: s.day,
    t: Math.round(s.t),
    storeId: entry?.id ?? 'home',
    storeName: shopName(s),
    summary: o.summary,
    people: o.people ?? [],
    related,
    sns: o.sns ?? 0,
    views: o.views ?? 0,
    // 来客への影響の見込み（%）: 話題性の上乗せ × 話題性の効き方
    customers: Math.round(FAME.topicMaxBonus * r.topic),
    rarity: clamp01(k.base),
    importance,
    score: Math.round(score * 1000) / 1000,
    rank: r.rank,
    display: kind === 'tv' ? 'sign' : kind === 'viral' || kind === 'hit' ? 'video' : r.display,
  };
  // 称号: 激レア以上で、まだ持っていない種類の称号
  if ((r.rank === 'epic' || r.rank === 'legend' || r.rank === 'myth') && k.title && !f.titles.includes(k.title)) {
    legend.earnedTitle = k.title;
    f.titles.push(k.title);
  }
  if (r.rank === 'myth' && !f.titles.includes(MYTH_TITLE)) {
    legend.earnedTitle = legend.earnedTitle ? `${legend.earnedTitle}・${MYTH_TITLE}` : MYTH_TITLE;
    f.titles.push(MYTH_TITLE);
  }
  f.legends.push(legend);
  if (f.legends.length > FAME.legendsKeep) f.legends.splice(0, f.legends.length - FAME.legendsKeep);
  f.awareness = clamp(f.awareness + r.awareness, 0, 100);
  f.topic = clamp(f.topic + r.topic, 0, 100);
  notify(s, ctx, `legend:${legend.id}`, r.rank === 'normal' ? 'info' : 'good', `🏆 店の伝説に「${legend.title}」が加わりました（${rankLabel(r.rank)}）${legend.earnedTitle ? `。称号「${legend.earnedTitle}」を得ました` : ''}`);
  emit(ctx, { type: 'legend', targetId: legend.id, text: r.rank });
  return legend;
}

function rankLabel(r: Legend['rank']): string {
  return { normal: '通常', rare: '希少', epic: '激レア', legend: '伝説', myth: '神話級' }[r];
}

/** 棚に飾る伝説（ランクの高い順・新しい順に n 個。読むだけ） */
export function shelfLegends(s: GameState, n = 6): Legend[] {
  const order = { myth: 0, legend: 1, epic: 2, rare: 3, normal: 4 } as const;
  return [...(s.fame?.legends ?? [])].sort((a, b) => order[a.rank] - order[b.rank] || b.day - a.day || b.t - a.t).slice(0, n);
}

/** いちばんよい称号（なければ null。読むだけ） */
export function bestTitle(s: GameState): string | null {
  const t = s.fame?.titles ?? [];
  if (t.includes(MYTH_TITLE)) return MYTH_TITLE;
  return t[t.length - 1] ?? null;
}
