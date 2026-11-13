// 独立したイベントの基盤（じろ7 6）と、珍客・特殊イベント（UFO・金色覚醒・横バウンス・鼻をほじる客・クマ。じろ7 6-5・Phase 6）。
// - 定義（確率・条件・クールダウン・大事さ・連鎖）は data/chaos.ts の表。抽選・同時の上限・1日の上限・クールダウン・連鎖・記録はここで共通に行い、
//   イベントごとの処理（主役にする・進める・終わる）は下の HANDLERS に分ける。新しいイベントは表に1つ・HANDLERS に1つ足すだけで入る
// - どのイベントもほかのイベントを必須の条件にしない。条件が合ったときだけ連鎖する（確率・日数・深さの上限があり、無限につながらない）
// - 抽選は珍客イベント専用の乱数（chaos.rng）。今までのイベント（events.rng）と客の乱数（s.rng）の並びは変えない
// - 今までのイベント（バズ・調査員・YouTuber・テレビなど）は動きを変えず、同時に起きているイベントのつながり（related）だけ共通に記録する
// - まわりの客の反応（驚く・笑う・怖がる・撮影する・まねする・嫌がる・店員に知らせる）は、主役の近くの客だけ（全員に重い計算をしない）

import { CHAOS, CHAOS_KINDS, CHAOS_RULES as R, QUARREL_CALMED, QUARREL_REPLIES, REACT_LINES } from '../data/chaos';
import type { ChaosKind, ChaosRun, ChaosState, Customer, GameState, Id, ReactKind, Vec2 } from '../types';
import { clamp01, dist, hashString, newId, rand } from '../util';
import { sayEvent } from './customers';
import { addDaily, cooledDown, dailyCount, ensureEvents, eventsAllowed, finishEvent, noteDraw, noteFire } from './events';
import { emit, notify, type SimCtx } from './notices';
import { gameClockMinute, lightPollution, nightness } from './sky';
import { openDurationOf } from './hours';
import { addLegend, noteFeatured, noteSaw } from './fame';
import { LEGEND_KINDS } from '../data/fame';
import { stageOf } from '../geometry';

/** 店の中・外にいる客（帰った・帰る途中は除く） */
const GONE = new Set(['leaving', 'left', 'abandoned', 'dead']);

export function ensureChaos(s: GameState): ChaosState {
  const ev = ensureEvents(s);
  return (ev.chaos ??= { rng: (hashString(`chaos:${s.seed}`) ^ 0x5bd1e995) >>> 0, plans: [], active: [], boosts: [], ufo: null });
}

/** 珍客イベント専用の乱数 */
export function chaosRand(s: GameState): number {
  return rand(ensureChaos(s));
}

function pick<T>(s: GameState, list: readonly T[]): T {
  return list[Math.floor(chaosRand(s) * list.length) % list.length]!;
}

/** そのイベントの今日の起こりやすさの倍率（夜・田舎・連鎖のブースト） */
export function chaosWeight(s: GameState, kind: ChaosKind): number {
  const d = CHAOS[kind];
  let w = 1;
  // 夜（営業の真ん中の時刻で見る）・田舎
  if (d.nightMult) {
    const mid = gameClockMinute({ ...s, phase: 'open', openT: openDurationOf(s) / 2 } as GameState);
    w *= 1 + (d.nightMult - 1) * nightness(mid);
  }
  if (d.ruralMult) w *= 1 + (d.ruralMult - 1) * (1 - lightPollution(s));
  for (const b of s.events?.chaos?.boosts ?? []) if (b.kind === kind && b.untilDay >= s.day) w *= b.mult;
  return w;
}

/** 起きてよいか（日・チュートリアル・クールダウン・1日の上限） */
function allowed(s: GameState, kind: ChaosKind): boolean {
  const d = CHAOS[kind];
  return eventsAllowed(s, d.minDay) && cooledDown(s, kind, d.cooldownDays) && dailyCount(s, 'chaos') < R.perDayMax;
}

/**
 * 開店のときの抽選（その日の1回目の開店だけ）。当たったイベントは、その日の営業のある時刻のあとに来た新規の客が主役になる。
 * 大事さの高い順に引き、1日の上限まで
 */
export function planChaos(s: GameState): void {
  const ch = ensureChaos(s);
  ch.plans = ch.plans.filter((p) => p.day >= s.day);
  ch.boosts = ch.boosts.filter((b) => b.untilDay >= s.day);
  if (s.tutorial) return;
  const kinds = [...CHAOS_KINDS].sort((a, b) => CHAOS[b].priority - CHAOS[a].priority);
  let planned = ch.plans.filter((p) => p.day === s.day).length;
  const D = openDurationOf(s);
  for (const kind of kinds) {
    if (planned >= R.perDayMax || !allowed(s, kind)) continue;
    noteDraw(s, kind);
    const p = Math.min(0.9, CHAOS[kind].dayChance * chaosWeight(s, kind));
    if (chaosRand(s) >= p) continue;
    ch.plans.push({ kind, day: s.day, afterOpenT: D * (R.planFrom + (R.planTo - R.planFrom) * chaosRand(s)), depth: 0, cause: null, chance: p });
    planned += 1;
  }
}

/** 今起きているイベント（主役が店にいる間） */
export function activeChaos(s: GameState): ChaosRun[] {
  return s.events?.chaos?.active ?? [];
}

/** 今起きている、ほかのイベント（YouTuber の撮影・テレビ取材・ほかの珍客）の記録の ID（つながりとして残す） */
function concurrentIds(s: GameState): Id[] {
  const ids: Id[] = activeChaos(s).map((r) => r.recordId);
  for (const c of s.customers) {
    if (GONE.has(c.state)) continue;
    if (c.special?.kind === 'youtuber' && c.special.film && !ids.includes(c.special.eventId)) ids.push(c.special.eventId);
  }
  if (s.events?.tv) ids.push(s.events.tv.id);
  return ids;
}

/**
 * 来店した客（onCustomerArrive の最後。ほかの珍しい客になっていない新規の客）を、予定の時刻を過ぎたイベントの主役にする。
 * 同時の上限・大きなイベントどうしは同時に起こさない
 */
export function onChaosArrival(s: GameState, c: Customer, ctx: SimCtx): void {
  if (s.tutorial || c.special || c.regularId || c.group || c.script || c.forLostItem) return;
  const ch = s.events?.chaos;
  if (!ch || ch.plans.length === 0) return;
  const due = ch.plans
    .filter((p) => p.day === s.day && s.openT >= p.afterOpenT)
    .sort((a, b) => CHAOS[b.kind].priority - CHAOS[a.kind].priority);
  for (const p of due) {
    if (ch.active.length >= R.maxConcurrent) return;
    if (CHAOS[p.kind].disruptive && ch.active.some((r) => CHAOS[r.kind].disruptive)) continue;
    ch.plans = ch.plans.filter((x) => x !== p);
    startChaos(s, ctx, p.kind, c, { depth: p.depth, cause: p.cause, chance: p.chance ?? null, forced: !!p.forced });
    return;
  }
}

/** イベントを始める（主役の客を決めて、種類ごとの処理へ） */
function startChaos(s: GameState, ctx: SimCtx, kind: ChaosKind, c: Customer, o: { depth: number; cause: Id | null; chance: number | null; forced: boolean }): ChaosRun {
  const ch = ensureChaos(s);
  addDaily(s, 'chaos');
  const rec = noteFire(s, kind, o.forced, { chance: o.chance, happening: true });
  const run: ChaosRun = {
    id: newId(s, 'cx'),
    recordId: rec.id,
    kind,
    day: s.day,
    t: s.t,
    customerIds: [c.id],
    depth: o.depth,
    cause: o.cause,
    related: concurrentIds(s),
    films: 0,
    witnesses: 0,
    reacted: [],
    step: 0,
  };
  ch.active.push(run);
  c.special = { kind: SPECIAL_OF[kind], eventId: rec.id, spoken: false };
  // 撮影中の YouTuber の動画に映る（じろ7 Phase 7）
  noteFeatured(s, kind);
  HANDLERS[kind].start(s, ctx, run, c);
  emit(ctx, { type: 'chaos', targetId: c.id, text: kind });
  return run;
}

const SPECIAL_OF: Record<ChaosKind, 'alien' | 'golden' | 'dancer' | 'nosepicker' | 'bear' | 'quarreler'> = {
  ufo: 'alien',
  golden: 'golden',
  bounce: 'dancer',
  nosepick: 'nosepicker',
  bear: 'bear',
  quarrel: 'quarreler',
};

/** 主役（最初の客） */
function lead(s: GameState, run: ChaosRun): Customer | null {
  return s.customers.find((x) => x.id === run.customerIds[0]) ?? null;
}

/**
 * まわりの客の反応（主役の近く・半径の中だけ）。性格（好奇心・撮影の傾向・迷惑への我慢・流行への関心）で反応を選ぶ。
 * 同じイベントに同じ客は一度だけ反応する
 */
export function spectate(s: GameState, run: ChaosRun, center: Vec2, radius: number, ctx: SimCtx, only?: ReactKind[]): number {
  const d = CHAOS[run.kind];
  let n = 0;
  for (const x of s.customers) {
    if (GONE.has(x.state) || run.customerIds.includes(x.id) || run.reacted.includes(x.id) || x.special?.kind === 'tv_staff') continue;
    if (dist(x.pos, center) > radius) continue;
    if (x.react && x.react.until > s.t - R.reactGap && x.react.eventId !== run.recordId) continue;
    const kind = chooseReaction(s, x, d.reactions, only);
    if (!kind) continue;
    run.reacted.push(x.id);
    run.witnesses += 1;
    if (kind === 'film') run.films += 1;
    x.react = { kind, until: s.t + R.reactSecFrom + (R.reactSecTo - R.reactSecFrom) * chaosRand(s), eventId: run.recordId };
    sayEvent(x, s, pick(s, REACT_LINES[kind]), 2.6);
    emit(ctx, { type: 'chaosReact', targetId: x.id, text: kind });
    // 見た珍事を覚えておく（帰ったあとの SNS の投稿。じろ7 Phase 7）
    noteSaw(x, run.kind, kind === 'film');
    // よい珍事は少しうれしく、迷惑は不快に（満足度の「居心地」）
    const mood = kind === 'annoyed' || kind === 'scared' ? -Math.abs(d.reactMood) : kind === 'tell' ? -Math.abs(d.reactMood) * 0.5 : d.reactMood;
    x.sat.comfort = clamp01(x.sat.comfort + mood);
    n += 1;
    if (kind === 'tell') notify(s, ctx, `chaosTell:${run.id}`, 'warn', 'お客さんが、近くの客の迷惑な行為を店員に知らせています');
  }
  return n;
}

/** 客の性格の値（新しい性格は前のセーブの客にないので、客の ID から決まった値。客の乱数は使わない） */
export function traitOf(c: Customer, k: 'curiosity' | 'sociability' | 'trend' | 'filming' | 'sns' | 'tolerance'): number {
  const v = c.traits[k];
  if (typeof v === 'number') return v;
  return (hashString(`${k}:${c.id}`) % 1000) / 1000;
}

function chooseReaction(s: GameState, x: Customer, weights: Partial<Record<ReactKind, number>>, only?: ReactKind[]): ReactKind | null {
  // 反応しない客もいる（好奇心が低いと気にしない）
  if (chaosRand(s) > 0.35 + 0.6 * traitOf(x, 'curiosity')) return null;
  const adj: [ReactKind, number][] = [];
  for (const [k, w0] of Object.entries(weights) as [ReactKind, number][]) {
    if (only && !only.includes(k)) continue;
    let w = w0;
    if (k === 'film') w *= 0.4 + 1.2 * traitOf(x, 'filming');
    if (k === 'imitate') w *= 0.2 + 1.6 * traitOf(x, 'trend');
    if (k === 'laugh') w *= 0.5 + traitOf(x, 'sociability');
    if (k === 'annoyed' || k === 'tell') w *= 1.4 - traitOf(x, 'tolerance');
    if (k === 'scared') w *= 1.2 - traitOf(x, 'curiosity');
    adj.push([k, Math.max(0, w)]);
  }
  const sum = adj.reduce((a, [, w]) => a + w, 0);
  if (sum <= 0) return null;
  let r = chaosRand(s) * sum;
  for (const [k, w] of adj) {
    r -= w;
    if (r < 0) return k;
  }
  return adj[adj.length - 1]![0];
}

/** 毎ステップ: 起きているイベントを進め、主役が帰ったら終える（連鎖を引く）。反応の時間切れを消す */
export function updateChaos(s: GameState, dt: number, ctx: SimCtx): void {
  const ch = s.events?.chaos;
  if (!ch) return;
  for (const x of s.customers) if (x.react && x.react.until <= s.t) x.react = null;
  for (const run of [...ch.active]) {
    const c = lead(s, run);
    const h = HANDLERS[run.kind];
    const done = h.update(s, dt, ctx, run, c);
    if (done) finishChaos(s, ctx, run);
  }
  if (ch.ufo) updateUfo(s, dt, ctx);
}

/**
 * 閉店の精算のとき: 起きているイベントを終える（記録に結果を書く。連鎖は引かない）、UFO を片づける。
 * 主役が帰っていれば updateChaos で先に終わっているので、ここに来るのは営業が途中で終わったときだけ
 */
export function endChaosDay(s: GameState): void {
  const ch = s.events?.chaos;
  if (!ch) return;
  for (const run of ch.active) {
    const d = CHAOS[run.kind];
    finishEvent(s, run.recordId, `${d.label}: 見た客 ${run.witnesses}人・撮影 ${run.films}人（営業の終わりで終了）`);
    const rec = s.events?.log?.find((x) => x.id === run.recordId);
    if (rec) {
      rec.related = [...run.related];
      rec.witnesses = run.witnesses;
      rec.films = run.films;
      if (run.cause) rec.cause = run.cause;
    }
  }
  ch.active = [];
  ch.ufo = null;
  ch.plans = ch.plans.filter((p) => p.day > s.day);
}

/** イベントが終わった: 記録に結果を書き、連鎖を引く（深さの上限まで） */
function finishChaos(s: GameState, ctx: SimCtx, run: ChaosRun): void {
  const ch = ensureChaos(s);
  ch.active = ch.active.filter((r) => r !== run);
  const d = CHAOS[run.kind];
  const result = `${d.label}: 見た客 ${run.witnesses}人・撮影 ${run.films}人${run.related.length > 0 ? '・ほかのイベントと同時' : ''}${run.note ? `・${run.note}` : ''}`;
  finishEvent(s, run.recordId, result);
  const rec = s.events?.log?.find((x) => x.id === run.recordId);
  if (rec) {
    rec.related = [...run.related];
    rec.witnesses = run.witnesses;
    rec.films = run.films;
    if (run.cause) rec.cause = run.cause;
  }
  // 店の伝説（じろ7 Phase 7）: 記録する種類（UFO・覚醒・クマ・ダンス）と、連鎖で起きたもの
  const lk = LEGEND_KINDS[run.kind];
  if (lk && (lk.record || run.depth >= 1) && run.witnesses + run.films > 0) {
    const chained = run.depth >= 1;
    addLegend(s, ctx, chained ? 'chain' : run.kind, {
      title: chained ? `${lk.name}（珍事の連鎖）` : lk.name,
      summary: `${d.label}。見た客 ${run.witnesses}人・撮影 ${run.films}人${run.related.length > 0 ? '・ほかのイベントと同時' : ''}${run.note ? `・${run.note}` : ''}`,
      people: [d.kind === 'bear' ? 'みつぐま' : d.kind === 'ufo' ? '宇宙人' : 'お客さん'],
      related: [run.recordId, ...run.related, ...(run.cause ? [run.cause] : [])],
      witnesses: run.witnesses,
      films: run.films,
      depth: run.depth,
      bonus: chained ? lk.base * 0.3 : 0,
    });
  }
  if (run.depth >= R.maxDepth) return;
  for (const l of d.links) {
    if (chaosRand(s) >= l.chance) continue;
    ch.boosts.push({ kind: l.to, mult: l.mult, untilDay: s.day + l.days, cause: run.recordId, depth: run.depth + 1 });
    notify(s, ctx, `chaosLink:${run.id}:${l.to}`, 'info', `うわさ: ${l.why}`);
  }
}

// ───────────────────────── イベントごとの処理 ─────────────────────────

interface ChaosHandler {
  /** 主役が決まったとき */
  start(s: GameState, ctx: SimCtx, run: ChaosRun, c: Customer): void;
  /** 毎ステップ。終わったら true */
  update(s: GameState, dt: number, ctx: SimCtx, run: ChaosRun, c: Customer | null): boolean;
}

const gone = (c: Customer | null) => !c || c.state === 'left' || c.state === 'abandoned' || c.state === 'dead';

const HANDLERS: Record<ChaosKind, ChaosHandler> = {
  // UFO: 店の前の通りに降り、宇宙人が客として並んで食べ、帰りも UFO に乗って帰る
  ufo: {
    start(s, ctx, run, c) {
      const ch = ensureChaos(s);
      // 店の入口の正面の道路（車道の真ん中）に降りる
      const st = stageOf(s);
      const door = { x: (st.door.x0 + st.door.x1) / 2, z: -8.6 };
      ch.ufo = { id: run.id, phase: 'descend', t: 0, x: door.x, z: door.z, alienId: c.id };
      c.look = 'alien';
      c.pos = { x: door.x, z: door.z + 0.6 };
      c.traits.complaintPropensity = 0;
      sayEvent(c, s, pick(s, CHAOS.ufo.lines), 3);
      notify(s, ctx, `chaos:${run.id}`, 'good', '🛸 店の前に UFO が降りてきた！ 宇宙人がラーメンを食べに来たようです');
    },
    update(s, _dt, ctx, run, c) {
      const ch = ensureChaos(s);
      const u = ch.ufo;
      // UFO が降りてくる間は、宇宙人はまだ乗っている（降りた場所から歩き出す）
      if (u && u.phase === 'descend' && c && c.state === 'arriving') c.pos = { x: u.x, z: u.z + 0.6 };
      if (run.step === 0 && u && u.phase === 'landed') {
        run.step = 1;
        spectate(s, run, { x: u.x, z: u.z }, CHAOS.ufo.reactRadius, ctx);
      }
      if (c && c.state === 'eating' && run.step === 1) {
        run.step = 2;
        sayEvent(c, s, pick(s, CHAOS.ufo.lines), 3);
        spectate(s, run, c.pos, 4, ctx);
      }
      // 帰るときは UFO の下まで歩いて乗り込む（帰り道の最後を UFO にする）
      if (c && c.state === 'leaving' && u && run.step < 3 && c.path.length > 0) {
        run.step = 3;
        c.path[c.path.length - 1] = { x: u.x, z: u.z + 0.3 };
      }
      // 宇宙人が乗り込んだら、UFO が飛び立つ
      if (gone(c) && u && u.phase === 'landed') {
        u.phase = 'ascend';
        u.t = 0;
        emit(ctx, { type: 'chaosFx', text: 'ufoAscend' });
      }
      return !u || (gone(c) && u.phase === 'ascend' && u.t > 4);
    },
  },
  // 金色覚醒: 食べ終わった瞬間に金色の光に包まれ、店を出ると空を飛んで帰る
  golden: {
    start(_s, _ctx, _run, c) {
      c.traits.appetite = Math.max(c.traits.appetite, 0.7);
    },
    update(s, _dt, ctx, run, c) {
      if (!c) return true;
      const sp = c.special;
      // 食べている → 食べ終わった瞬間に覚醒
      if (run.step === 0 && c.state === 'eating') run.step = 1;
      if (sp && sp.awakenedAt === undefined && run.step === 1 && c.state !== 'eating') {
        sp.awakenedAt = s.t;
        emit(ctx, { type: 'chaosFx', targetId: c.id, text: 'awaken' });
        sayEvent(c, s, pick(s, CHAOS.golden.lines), 3.5);
        spectate(s, run, c.pos, CHAOS.golden.reactRadius, ctx);
        notify(s, ctx, `chaos:${run.id}`, 'good', '✨ 食べ終わったお客さんが、金色の光に包まれた……！');
      }
      // 店を出たら空へ（見た目は client。主役が帰るまで続く）
      if (sp?.awakenedAt !== undefined && sp.flyAt === undefined && c.state === 'leaving' && c.pos.z < -0.4) {
        sp.flyAt = s.t;
        emit(ctx, { type: 'chaosFx', targetId: c.id, text: 'fly' });
        spectate(s, run, c.pos, 8, ctx, ['surprise', 'film']);
      }
      return gone(c) || (sp?.flyAt !== undefined && s.t - sp.flyAt > 5);
    },
  },
  // 横バウンス: 横に弾みながら来て、食べる間以外は踊る。近くの客がまねすることがある
  bounce: {
    start(s, ctx, run, c) {
      sayEvent(c, s, pick(s, CHAOS.bounce.lines), 3);
      notify(s, ctx, `chaos:${run.id}`, 'info', '💃 横に弾みながら踊るお客さんが来た');
    },
    update(s, dt, ctx, run, c) {
      if (gone(c)) return true;
      if (!c || c.state === 'eating') return false;
      // 6秒ごとに近くの客が反応する（まねする客が出たら、連鎖として記録）
      run.acc = (run.acc ?? 0) + dt;
      if (run.acc >= 6) {
        run.acc = 0;
        const before = run.reacted.length;
        spectate(s, run, c.pos, CHAOS.bounce.reactRadius, ctx);
        const imitators = s.customers.filter((x) => run.reacted.slice(before).includes(x.id) && x.react?.kind === 'imitate');
        if (imitators.length > 0 && !run.note) run.note = `まねして踊る客 ${imitators.length}人`;
        if (chaosRand(s) < 0.35) sayEvent(c, s, pick(s, CHAOS.bounce.lines), 2.4);
      }
      return false;
    },
  },
  // 鼻をほじる迷惑客: 席で鼻をほじり、隣の客が嫌がる。店員が注意すると落ち着く（manners.ts の迷惑の仕組みを使う）
  nosepick: {
    start(s, _ctx, _run, c) {
      c.nosepick = { next: 6 + 8 * chaosRand(s), count: 0, warned: false };
    },
    update(s, dt, ctx, run, c) {
      if (gone(c)) return true;
      if (!c || !c.nosepick) return false;
      const np = c.nosepick;
      const seated = c.state === 'seated' || c.state === 'eating';
      if (!seated || np.warned) return false;
      np.next -= dt;
      if (np.next > 0) return false;
      np.next = 9 + 10 * chaosRand(s);
      np.count += 1;
      np.pickUntil = s.t + 2.5;
      sayEvent(c, s, pick(s, CHAOS.nosepick.lines), 2.2);
      spectate(s, run, c.pos, CHAOS.nosepick.reactRadius, ctx);
      if (np.count === 2) notify(s, ctx, `chaos:${run.id}`, 'warn', '近くのお客さんが嫌がっています。鼻をほじっているお客さんに声をかけましょう（席を見て「注意する」）');
      if (np.count >= 4 && !run.note) run.note = '注意しないまま、まわりの客が不快になった';
      return false;
    },
  },
  // クマ（オリジナルのクマ「みつぐま」）: 来店して並び、食べて帰る。まわりの客が驚く・撮影する
  bear: {
    start(s, ctx, run, c) {
      c.look = 'bear';
      sayEvent(c, s, pick(s, CHAOS.bear.lines), 3);
      notify(s, ctx, `chaos:${run.id}`, 'good', '🧸 はちみつ好きのクマ「みつぐま」が来店した！');
    },
    update(s, _dt, ctx, run, c) {
      if (gone(c)) return true;
      if (!c) return false;
      if (run.step === 0 && (c.state === 'queue' || c.state === 'ticket' || c.state === 'waitingSeat')) {
        run.step = 1;
        spectate(s, run, c.pos, CHAOS.bear.reactRadius, ctx);
      }
      if (run.step === 1 && c.state === 'eating') {
        run.step = 2;
        sayEvent(c, s, pick(s, CHAOS.bear.lines), 3);
        spectate(s, run, c.pos, 4, ctx);
      }
      return false;
    },
  },
  // 客どうしの口論（オーナーの判断 Q8）: 主役が席に着くと、となりの客と言い合いになる。言い合うたびに近くの客が嫌がる。
  // 仲裁すると収まる（従業員も何度か言い合ったら仲裁しに行く）。仲裁しないままだと、2人とも満足度が下がって言い合いは止む
  quarrel: {
    start() {
      // 席に着くまで待つ
    },
    update(s, dt, ctx, run, c) {
      if (gone(c)) {
        const other = run.customerIds[1] ? s.customers.find((x) => x.id === run.customerIds[1]) : null;
        if (other?.quarrel) other.quarrel = null;
        return true;
      }
      if (!c) return false;
      const seated = c.state === 'seated' || c.state === 'eating';
      if (run.step === 0) {
        if (!seated) return false;
        const n = quarrelPartner(s, c);
        if (!n) return c.state === 'eating' && c.eatLeft < (c.eatTotal ?? 1) * 0.3;
        run.step = 1;
        run.customerIds.push(n.id);
        c.quarrel = { with: n.id, lead: true, next: 1.5, count: 0, calmed: false };
        n.quarrel = { with: c.id, lead: false, next: 1e9, count: 0, calmed: false };
        return false;
      }
      const q = c.quarrel;
      const other = s.customers.find((x) => x.id === run.customerIds[1]);
      if (!q || q.calmed || run.step >= 2) return false;
      // 相手が帰った・席を離れた
      if (!other || !other.quarrel || (other.state !== 'seated' && other.state !== 'eating')) {
        run.step = 2;
        if (other?.quarrel) other.quarrel = null;
        c.quarrel = null;
        return false;
      }
      q.next -= dt;
      if (q.next > 0) return false;
      q.next = 4 + 3 * chaosRand(s);
      const speaker = q.count % 2 === 0 ? c : other;
      sayEvent(speaker, s, pick(s, q.count % 2 === 0 ? CHAOS.quarrel.lines : QUARREL_REPLIES), 3);
      for (const x of [c, other]) if (x.quarrel) x.quarrel.argueUntil = s.t + 3;
      q.count += 1;
      other.quarrel.count = q.count;
      spectate(s, run, c.pos, CHAOS.quarrel.reactRadius, ctx);
      if (q.count === 2) {
        const seat = s.seats.find((x) => x.id === c.seatId);
        notify(s, ctx, `chaos:${run.id}`, 'warn', `${(seat?.index ?? 0) + 1}番席のあたりで、お客さんどうしが口論しています（席を見て「仲裁する」）`);
      }
      // 仲裁しないまま言い合いが続いた: 2人とも不満を抱えたまま黙る
      if (q.count >= 8) {
        run.step = 2;
        for (const x of [c, other]) {
          x.sat.comfort = clamp01(x.sat.comfort - 0.2);
          x.sat.service = clamp01(x.sat.service - 0.1);
          if (x.quarrel) x.quarrel.argueUntil = 0;
        }
        run.note = '仲裁しないまま、2人とも不満を抱えた';
      }
      return false;
    },
  },
};

/** 口論の相手になれる、となりの席の客（主役と同じ団体でない・ほかの珍しい客でない） */
function quarrelPartner(s: GameState, c: Customer): Customer | null {
  const seat = s.seats.find((x) => x.id === c.seatId);
  if (!seat) return null;
  for (const d of [1, -1]) {
    const ns = s.seats.find((x) => x.installed && x.index === seat.index + d);
    const n = ns && s.customers.find((x) => x.id === ns.customerId);
    if (!n || n.special || n.quarrel || (c.group && n.group?.id === c.group.id)) continue;
    if (n.state === 'seated' || n.state === 'eating') return n;
  }
  return null;
}

/** 口論を仲裁する（店員・プレイヤーの「仲裁する」から）。両方が落ち着き、嫌がっていた客の不快が少し戻る */
export function calmQuarrel(s: GameState, c: Customer): boolean {
  const q = c.quarrel;
  if (!q || q.calmed) return false;
  const other = s.customers.find((x) => x.id === q.with);
  for (const x of [c, other]) {
    if (!x?.quarrel) continue;
    x.quarrel.calmed = true;
    x.quarrel.argueUntil = 0;
  }
  sayEvent(c, s, pick(s, QUARREL_CALMED), 2.6);
  const run = activeChaos(s).find((r) => r.customerIds.includes(c.id));
  if (run) {
    for (const id of run.reacted) {
      const x = s.customers.find((y) => y.id === id);
      if (x) x.sat.comfort = clamp01(x.sat.comfort + Math.abs(CHAOS.quarrel.reactMood) * 0.6);
    }
    run.note = run.note ? `${run.note}・あとで仲裁した` : '仲裁して収めた';
  }
  return true;
}

/** 店員・プレイヤーが鼻をほじる客に声をかけた（manners の「注意する」から） */
export function warnNosepicker(s: GameState, c: Customer): boolean {
  if (!c.nosepick || c.nosepick.warned) return false;
  c.nosepick.warned = true;
  sayEvent(c, s, 'あ…すみません', 2.4);
  // 嫌がっていた客の不快を少し戻す
  const run = activeChaos(s).find((r) => r.customerIds.includes(c.id));
  if (run) {
    for (const id of run.reacted) {
      const x = s.customers.find((y) => y.id === id);
      if (x) x.sat.comfort = clamp01(x.sat.comfort + Math.abs(CHAOS.nosepick.reactMood) * 0.6);
    }
    run.note = run.note ? `${run.note}・あとで注意した` : '注意してやめさせた';
  }
  return true;
}

/** UFO の降下・着陸・離陸（演出の時間だけ。客の動きは customers.ts） */
function updateUfo(s: GameState, dt: number, ctx: SimCtx): void {
  const ch = ensureChaos(s);
  const u = ch.ufo!;
  u.t += dt;
  if (u.phase === 'descend' && u.t >= 3.5) {
    u.phase = 'landed';
    u.t = 0;
    emit(ctx, { type: 'chaosFx', text: 'ufoLand' });
  }
  if (u.phase === 'ascend' && u.t >= 5) ch.ufo = null;
}

/** テスト・開発用: 次に来た新規の客でそのイベントを起こす（ひとりプレイの debugEvent から） */
export function forceChaos(s: GameState, kind: ChaosKind): { ok: boolean; reason?: string } {
  if (s.phase !== 'prep' && s.phase !== 'open') return { ok: false, reason: '仕込み中か営業中に起こせます' };
  const ch = ensureChaos(s);
  ch.plans.push({ kind, day: s.day, afterOpenT: s.phase === 'open' ? s.openT : 0, depth: 0, cause: null, chance: null, forced: true });
  return { ok: true };
}

/** 主役の店の中にいる珍客（client の演出・音楽で使う。読むだけ） */
export function chaosCast(s: GameState): { id: Id; kind: ChaosKind }[] {
  return activeChaos(s).flatMap((r) => r.customerIds.map((id) => ({ id, kind: r.kind })));
}
