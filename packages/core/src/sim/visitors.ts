// 客にまつわる営業中のイベント: SNS でバズる（設計書 A）、有名レビュアー・覆面調査員（C）、珍しい客（D）。
// どれも通常の客の流れ（行列・食券・着席・注文・食事・会計）をそのまま使い、売上を直接足したり特別な報酬を出したりしない。

import { BALANCE } from '../data/balance';
import { BUZZ_POSTS, BUZZ_SAYS, CRITIC_ITEMS, CRITIC_NOTES, RARE_LINES } from '../data/events';
import type { CriticItem, CriticReport, Customer, EventKind, GameState, Review } from '../types';
import { clamp, clamp01, dist, newId, pick, randRange } from '../util';
import { makeCustomer, sayFor } from './customers';
import { addDaily, cooledDown, dailyCount, ensureEvents, eventsAllowed, evRand, noteDraw, noteFire, takeForced } from './events';
import { forceAccident } from './accident';
import { emit, notify, type SimCtx } from './notices';

const E = BALANCE.events;

// ───────────────────────── 1日の区切り ─────────────────────────

/** 開店したとき（openShop から）: その日の抽選の準備と、覆面調査員の抽選 */
export function onOpenShopEvents(s: GameState): void {
  const ev = ensureEvents(s);
  ev.nextBuzzCheck = E.buzz.checkEvery;
  ev.buzz = null;
  drawCritic(s);
}

/** 翌日の朝（nextDay から。仕込み開始時点の控えを作る前）: 覆面調査員の記事の公開、期限の切れた効果の整理 */
export function onDayStartEvents(s: GameState, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  ev.buzz = null;
  ev.criticPlan = null;
  ev.accidentPlan = null;
  ev.effects = ev.effects.filter((e) => e.untilDay >= s.day);
  for (const r of ev.critics) if (!r.published && r.publishDay <= s.day) publishCritic(s, ctx, r);
  ev.critics = ev.critics.slice(-10);
}

/** 閉店の精算のとき: 当日だけのイベントを終える */
export function onDayEndEvents(s: GameState): void {
  const ev = s.events;
  if (!ev) return;
  ev.buzz = null;
  ev.criticPlan = null;
  ev.accidentPlan = null;
}

// ───────────────────────── SNS でバズる ─────────────────────────

/** 直近の口コミの平均（★。口コミがなければ 3） */
function recentStars(s: GameState): number {
  const list = [...s.reviews, ...s.todayReviews].filter((r) => !r.critic).slice(-E.buzz.recentReviews);
  if (list.length === 0) return 3;
  return list.reduce((a, r) => a + r.stars, 0) / list.length;
}

/** 1回の抽選でバズる確率。評判と直近の口コミが良いほど高い */
export function buzzChance(s: GameState): number {
  const b = E.buzz;
  const repF = Math.pow(clamp(s.reputation, 1, 5) / 3, b.reputationExponent);
  const recentF = clamp(recentStars(s) / 3.5, 0.4, 1.5);
  return b.chancePerCheck * repF * recentF;
}

function updateBuzz(s: GameState, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  if (ev.buzz && s.openT >= ev.buzz.endT) {
    ev.buzz = null;
    notify(s, ctx, 'buzz', 'info', 'SNSの話題が落ち着いてきました');
    emit(ctx, { type: 'buzzEnd' });
  }
  if (s.phase !== 'open' || ev.buzz || s.openT < ev.nextBuzzCheck) return;
  ev.nextBuzzCheck = s.openT + E.buzz.checkEvery;
  const forced = takeForced(s, 'sns_buzz');
  if (!forced) {
    if (!eventsAllowed(s, E.buzz.minDay) || s.openT > BALANCE.openDuration * E.buzz.latestStart) return;
    if (s.events!.stats.sns_buzz?.lastDay === s.day || !cooledDown(s, 'sns_buzz', E.buzz.cooldownDays)) return;
    noteDraw(s, 'sns_buzz');
    if (evRand(s) >= buzzChance(s)) return;
  }
  startBuzz(s, ctx, forced);
}

export function startBuzz(s: GameState, ctx: SimCtx, forced = false): void {
  const ev = ensureEvents(s);
  const post = pick(ev, BUZZ_POSTS).replace('{shop}', s.shopName);
  ev.buzz = { id: newId(s, 'ev'), startT: s.openT, endT: Math.min(BALANCE.openDuration, s.openT + E.buzz.duration), mult: E.buzz.arrivalMult, post };
  noteFire(s, 'sns_buzz', forced);
  notify(s, ctx, 'buzz', 'good', `📱 SNSでバズっています！「${post}」 しばらくお客さんが増えます`);
  emit(ctx, { type: 'buzzStart', text: post });
}

// ───────────────────────── 覆面調査員 ─────────────────────────

function drawCritic(s: GameState): void {
  const ev = ensureEvents(s);
  const c = E.critic;
  ev.criticPlan = null;
  const forced = takeForced(s, 'critic');
  if (!forced) {
    if (!eventsAllowed(s, c.minDay) || !cooledDown(s, 'critic', c.cooldownDays)) return;
    noteDraw(s, 'critic');
    if (evRand(s) >= c.chancePerDay) return;
  }
  ev.criticPlan = { day: s.day, afterOpenT: forced ? 0 : randRange(ev, c.arriveFrom, c.arriveTo) * BALANCE.openDuration };
  if (forced) ev.forced.push('critic'); // 来店したときに「強制」として記録する
}

/** 覆面調査員の評価。満足度の項目（実際の営業の結果）だけで決め、乱数は入れない */
export function criticScore(c: Customer, ate: boolean): { stars: number; scores: Record<CriticItem, number>; improve: CriticItem[] } {
  const w = E.critic.weights;
  const scores: Record<CriticItem, number> = {
    taste: ate ? c.sat.taste : 0.2,
    speed: c.sat.speed,
    service: c.sat.service,
    cleanliness: c.sat.cleanliness,
    accuracy: ate ? c.sat.accuracy : 0.5,
  };
  let sum = 0;
  let wsum = 0;
  for (const k of Object.keys(w) as CriticItem[]) {
    sum += clamp01(scores[k]) * w[k];
    wsum += w[k];
  }
  const overall = sum / wsum;
  const stars = clamp(Math.round((1 + 4 * overall) * 2) / 2, 1, 5);
  const improve = (Object.keys(scores) as CriticItem[]).filter((k) => scores[k] < E.critic.improveBelow).sort((a, b) => scores[a] - scores[b]);
  return { stars, scores, improve };
}

function criticText(s: GameState, stars: number, scores: Record<CriticItem, number>, walkedOut: boolean): string {
  const items = Object.keys(scores) as CriticItem[];
  const best = CRITIC_ITEMS[items.reduce((a, b) => (scores[b] > scores[a] ? b : a))].name;
  const worst = CRITIC_ITEMS[items.reduce((a, b) => (scores[b] < scores[a] ? b : a))].name;
  if (walkedOut) return `「${s.shopName}」は待たされるばかりで、食べずに店を出た`;
  if (stars >= 4.5) return `「${s.shopName}」は文句なしの名店。${best}が特に素晴らしい`;
  if (stars >= 4) return `「${s.shopName}」は並ぶ価値のある一杯。${best}が光る`;
  if (stars >= 3) return `「${s.shopName}」は悪くないが、${worst}に課題が残る`;
  if (stars >= 2) return `「${s.shopName}」は期待外れ。${worst}が気になった`;
  return `「${s.shopName}」はおすすめできない。${worst}がひどい`;
}

function publishCritic(s: GameState, ctx: SimCtx, r: CriticReport): void {
  const c = E.critic;
  r.published = true;
  s.reputation = clamp(s.reputation + (r.stars - 3) * c.repPerStar, 1, 5);
  const ev = ensureEvents(s);
  if (r.stars >= c.goodStars) ev.effects.push({ id: newId(s, 'ef'), source: 'critic', mult: c.goodMult, untilDay: s.day + c.goodDays - 1 });
  else if (r.stars <= c.badStars) ev.effects.push({ id: newId(s, 'ef'), source: 'critic', mult: c.badMult, untilDay: s.day + c.badDays - 1 });
  const review: Review = {
    id: newId(s, 'rv'),
    day: r.day,
    stars: r.stars,
    text: `【グルメ評論家】${r.text}`,
    parts: { taste: r.scores.taste, speed: r.scores.speed, service: r.scores.service, cleanliness: r.scores.cleanliness, accuracy: r.scores.accuracy, stock: 1, value: 0.7, comfort: 0.7 },
    regular: false,
    critic: true,
  };
  s.reviews = [...s.reviews, review].slice(-60);
  const hint = r.improve.length > 0 ? ` 改善点: ${r.improve.map((k) => CRITIC_ITEMS[k].name).join('・')}` : '';
  const level = r.stars >= c.goodStars ? 'good' : r.stars <= c.badStars ? 'danger' : 'info';
  notify(s, ctx, `critic:${r.id}`, level, `📰 グルメサイトに記事が載りました（★${r.stars}）「${r.text}」${hint}`);
  emit(ctx, { type: 'criticPublished', targetId: r.id, value: r.stars, text: r.text });
}

// ───────────────────────── 来店・退店 ─────────────────────────

/**
 * 客が行列に加わったとき（updateArrivals から）。SNS を見て来た客・覆面調査員・珍しい客を決める。
 * カップルなら一緒に来た彼氏を返す（呼び出し側が行列の彼女のすぐ後ろに並ばせる）。
 */
export function onCustomerArrive(s: GameState, c: Customer, ctx: SimCtx): Customer | null {
  const ev = ensureEvents(s);
  if (s.tutorial || c.script || c.forLostItem) return null;
  if (ev.buzz && s.openT >= ev.buzz.startT && s.openT < ev.buzz.endT) {
    c.fromBuzz = true;
    c.traits.reviewPropensity = clamp01(c.traits.reviewPropensity + E.buzz.reviewPropensityBonus);
  }
  if (c.regularId) return null;
  // 覆面調査員: 予定の時刻を過ぎて最初に来た新規客
  const plan = ev.criticPlan;
  if (plan && plan.day === s.day && s.openT >= plan.afterOpenT) {
    ev.criticPlan = null;
    c.special = { kind: 'critic', eventId: newId(s, 'ev'), spoken: false };
    // 調査員はクレームを言わず、普通の口コミも書かない（評価は記事で公開する）
    c.traits.tasteCritic = Math.max(c.traits.tasteCritic, 0.75);
    c.traits.complaintPropensity = 0;
    c.traits.reviewPropensity = 0;
    noteFire(s, 'critic', takeForced(s, 'critic'));
    return null;
  }
  const r = E.rare;
  // 金髪の女性と彼氏のカップル（一人客より低い確率）
  const forcedCouple = takeForced(s, 'rare_couple');
  if (forcedCouple || drawRare(s, 'rare_couple', r.coupleChance)) {
    addDaily(s, 'rare_couple');
    noteFire(s, 'rare_couple', forcedCouple);
    const id = newId(s, 'ev');
    const him = makeCustomer(s, null);
    c.look = 'blonde_woman';
    c.special = { kind: 'couple_her', eventId: id, spoken: false };
    c.traits.complaintPropensity = Math.min(c.traits.complaintPropensity, 0.2);
    him.look = 'boyfriend';
    him.special = { kind: 'couple_him', eventId: id, spoken: false };
    him.traits.complaintPropensity = Math.min(him.traits.complaintPropensity, 0.2);
    him.pos = { x: c.pos.x + 0.5, z: c.pos.z };
    c.partyId = him.id;
    him.partyId = c.id;
    emit(ctx, { type: 'rareArrive', targetId: c.id, text: 'couple' });
    return him;
  }
  // 一人でラーメンを愛する客
  const forcedLover = takeForced(s, 'rare_lover');
  if (forcedLover || drawRare(s, 'rare_lover', r.loverChance)) {
    addDaily(s, 'rare_lover');
    noteFire(s, 'rare_lover', forcedLover);
    c.special = { kind: 'ramen_lover', eventId: newId(s, 'ev'), spoken: false };
    emit(ctx, { type: 'rareArrive', targetId: c.id, text: 'lover' });
  }
  return null;
}

/** 珍しい客の抽選（1日の上限まで） */
function drawRare(s: GameState, kind: 'rare_couple' | 'rare_lover', chance: number): boolean {
  if (!eventsAllowed(s, E.rare.minDay) || dailyCount(s, kind) >= E.rare.perDay) return false;
  noteDraw(s, kind);
  return evRand(s) < chance;
}

/** 退店するとき（finalizeVisit から）: 覆面調査員なら評価をまとめ、翌日に公開する */
export function onVisitEnd(s: GameState, c: Customer): void {
  if (c.special?.kind !== 'critic') return;
  const ev = ensureEvents(s);
  const o = s.orders.find((x) => x.id === c.orderId);
  const ate = !!o && (o.status === 'served' || o.status === 'refunded');
  const { stars, scores, improve } = criticScore(c, ate);
  ev.critics.push({
    id: c.special.eventId,
    day: s.day,
    publishDay: s.day + E.critic.publishAfterDays,
    stars,
    scores,
    walkedOut: !ate,
    published: false,
    text: criticText(s, stars, scores, !ate),
    improve,
  });
  ev.critics = ev.critics.slice(-10);
}

// ───────────────────────── 営業中の更新 ─────────────────────────

/** step から: SNS バズの抽選と終了、珍しい客のセリフ、SNS を見て来た客・覆面調査員のそぶり */
export function updateVisitors(s: GameState, ctx: SimCtx): void {
  if (s.phase !== 'open' && s.phase !== 'closing') return;
  updateBuzz(s, ctx);
  const ev = s.events!;
  const r = E.rare;
  for (const c of s.customers) {
    if (c.fromBuzz && c.state === 'queue' && !hasRolled(c, 'buzzSay')) {
      markRolled(c, 'buzzSay');
      if (evRand(s) < E.buzz.sayChance) sayFor(c, s, pick(ev, BUZZ_SAYS), 3);
    }
    const sp = c.special;
    if (!sp || sp.spoken) continue;
    if (sp.kind === 'couple_her') {
      // 彼氏が近くにいるとき（並んでいる・待っている・座っている）に一度だけ、彼氏に向けて話す
      if ((c.state !== 'queue' && c.state !== 'waitingSeat' && c.state !== 'seated') || c.stateTime < r.coupleAfter) continue;
      const him = s.customers.find((x) => x.id === c.partyId);
      if (!him || (him.state !== 'queue' && him.state !== 'waitingSeat' && him.state !== 'seated' && him.state !== 'eating')) continue;
      if (dist(c.pos, him.pos) > r.coupleNear) continue;
      sp.spoken = true;
      sayFor(c, s, RARE_LINES.couple, r.lineSec);
      emit(ctx, { type: 'rareLine', targetId: c.id, text: RARE_LINES.couple });
    } else if (sp.kind === 'ramen_lover') {
      // 食事の途中で一度だけ、味に満足しているときに小声で
      if (c.state !== 'eating' || !c.eatTotal || c.stateTime < c.eatTotal * r.loverAt) continue;
      sp.spoken = true;
      if (c.sat.taste < r.loverMinTaste) continue;
      sayFor(c, s, RARE_LINES.lover, r.lineSec);
      c.sayStyle = 'whisper';
      emit(ctx, { type: 'rareLine', targetId: c.id, text: RARE_LINES.lover });
    } else if (sp.kind === 'critic') {
      // 正体は出さないが、待っている間にときどきメモを取る
      if (c.state !== 'seated' || c.stateTime < 6) continue;
      sp.spoken = true;
      if (evRand(s) < E.critic.noteChance) sayFor(c, s, pick(ev, CRITIC_NOTES), 3);
    } else {
      sp.spoken = true;
    }
  }
}

export function hasRolled(c: Customer, key: string): boolean {
  return !!c.rolled?.includes(key);
}

export function markRolled(c: Customer, key: string): void {
  (c.rolled ??= []).push(key);
}

// ───────────────────────── テスト用の強制発生 ─────────────────────────

/**
 * テスト用にイベントを起こす（ひとりプレイ専用の操作 debugEvent と単体テストから）。
 * 共同経営のサーバーは debugEvent を受け付けないので、1人のクライアントがサーバーの状態を変えることはできない。
 */
export function forceEvent(s: GameState, ctx: SimCtx, kind: EventKind): { ok: boolean; reason?: string } {
  if (s.tutorial) return { ok: false, reason: 'チュートリアル中は起こせません' };
  if (s.phase !== 'prep' && s.phase !== 'open') return { ok: false, reason: '仕込み中か営業中に起こせます' };
  const ev = ensureEvents(s);
  switch (kind) {
    case 'sns_buzz':
      if (s.phase !== 'open') return { ok: false, reason: '営業中に起こせます' };
      if (ev.buzz) return { ok: false, reason: 'すでにバズっています' };
      startBuzz(s, ctx, true);
      return { ok: true };
    case 'critic':
      if (s.phase === 'open') {
        ev.criticPlan = { day: s.day, afterOpenT: s.openT };
        ev.forced.push('critic');
      } else ev.forced.push('critic');
      return { ok: true };
    case 'rare_couple':
    case 'rare_lover':
    case 'complaint_unreasonable':
      if (!ev.forced.includes(kind)) ev.forced.push(kind);
      return { ok: true };
    case 'explosion':
      return forceAccident(s, ctx);
    default:
      return { ok: false, reason: '不明なイベントです' };
  }
}
