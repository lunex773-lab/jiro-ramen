// 第2版 Phase 3: 団体客・居座り・食べ方の汚い客・店外の喫煙・トラブルと評価（設計書 7〜10）。
// - 団体: 1〜4人で来店し、同じ団体として並び・座り・帰る。注文・食事・満足度は一人ずつ
// - 居座り: 2人以上の団体がまれに食後も席に残る（席が空かない）。退店を促す3つの対応と、性格・混雑による反応
// - 食べ方の汚い客: 食事中に席・床を汚し、隣の客に迷惑をかける（距離と客の性格で計算。全員が不快になるわけではない）
// - 店外の喫煙: 食後に店の前でタバコを吸う。近くの客が嫌がる。声をかけると性格で反応が変わる
// - トラブルの評価は「迷惑を受けた客の満足度」を通して口コミ・評判に表れる（オーナー回答: 直接は下げない）。
//   同じトラブルで同じ客の不満を二度数えない（botheredBy にトラブルの ID を記録）。よい対応・早い対応で不満の一部を戻す
// - 抽選はイベント専用の乱数。チュートリアル中は食べ方・居座り・喫煙は起きない

import { BALANCE } from '../data/balance';
import { GROUP_CHATS, LINGER_CHATS, LINGER_REPLY, MESSY_LINES, SMOKE_LINES } from '../data/events';
import { seatPos } from '../geometry';
import type { Customer, Employee, GameState, Id, LingerResponse, Player, Seat, Vec2 } from '../types';
import { clamp01, dist, newId } from '../util';
import { addDirt, finalizeVisit, sayEvent, startLeaving } from './customers';
import { ensureEvents, evRand } from './events';
import { emit, notify, type SimCtx } from './notices';
import { argueChance, patienceOf } from './staff';

const G = BALANCE.guests;

type Actor = Player | Employee;

function pickEv<T>(s: GameState, list: readonly T[]): T {
  return list[Math.floor(evRand(s) * list.length) % list.length]!;
}

/** 吹き出し（団体の会話・イベントのセリフ）。通常の食事のコメントと区別する */
export function talkFor(c: Customer, s: GameState, text: string, sec: number): void {
  sayEvent(c, s, text, sec);
}

// ───────────────────────── 団体 ─────────────────────────

/** 1回の来店の平均人数（来店の回数をこれで割り、1日の客数を今と同じくらいに保つ。オーナー回答） */
export function meanGroupSize(): number {
  const w = G.group.sizeWeights;
  const sum = w.reduce((a, x) => a + x, 0);
  return w.reduce((a, x, i) => a + x * (i + 1), 0) / sum;
}

/** 来店の人数（1〜4） */
export function drawGroupSize(s: GameState): number {
  const w = G.group.sizeWeights;
  const sum = w.reduce((a, x) => a + x, 0);
  let r = evRand(s) * sum;
  for (let i = 0; i < w.length; i++) {
    r -= w[i]!;
    if (r < 0) return i + 1;
  }
  return 1;
}

const GONE = new Set(['leaving', 'left', 'abandoned', 'smoking']);

/** 同じ団体で、まだ店にいる人（自分を含む） */
export function groupMembers(s: GameState, c: Customer): Customer[] {
  if (!c.group) return [c];
  const id = c.group.id;
  return s.customers.filter((x) => x.group?.id === id && !GONE.has(x.state));
}

export function groupLeader(s: GameState, c: Customer): Customer {
  if (!c.group) return c;
  const id = c.group.id;
  return s.customers.find((x) => x.group?.id === id && x.group.leader) ?? c;
}

/** 団体の席を探す。隣り合った席を優先し、待った時間が上限を超えたら人数分の空き席に離れて座る（オーナー回答） */
export function findGroupSeats(s: GameState, free: Seat[], n: number, waited: number): Seat[] | null {
  if (free.length < n) return null;
  const sorted = [...free].sort((a, b) => a.index - b.index);
  for (let i = 0; i + n <= sorted.length; i++) {
    const run = sorted.slice(i, i + n);
    if (run[n - 1]!.index - run[0]!.index === n - 1) return run;
  }
  if (waited < G.group.adjacentWait) return null;
  // できるだけ近くにまとまる席
  let best: Seat[] | null = null;
  let span = Infinity;
  for (let i = 0; i + n <= sorted.length; i++) {
    const run = sorted.slice(i, i + n);
    const sp = run[n - 1]!.index - run[0]!.index;
    if (sp < span) {
      span = sp;
      best = run;
    }
  }
  return best;
}

/** 食後の団体: 全員が食べ終わったら、居座るか（まれに）を決め、居座らなければ一緒に帰る */
function updateGroupAfterMeal(s: GameState, leader: Customer, members: Customer[], ctx: SimCtx): void {
  const g = leader.group!;
  if (!members.every((m) => m.state === 'afterMeal')) return;
  if (g.linger === undefined) {
    const allowed = !s.tutorial && members.length >= 2 && s.phase !== 'closing';
    if (allowed && evRand(s) < G.group.lingerChance) {
      g.linger = { until: s.t + G.group.lingerFrom + (G.group.lingerTo - G.group.lingerFrom) * evRand(s), startT: s.t, tried: [], asked: 0 };
      g.chatAt = s.t + 2;
      emit(ctx, { type: 'lingerStart', targetId: leader.seatId ?? undefined });
    } else {
      g.linger = null;
    }
  }
  const lg = g.linger;
  // 閉店作業に入ったら居座りは終わる
  if (lg && s.t < lg.until && s.phase !== 'closing') {
    // 待っている客がいる間の居座りはトラブル（1回だけ数える）
    const waiting = s.queue.length + s.insideQueue.length > 0;
    if (waiting && s.t - lg.startT >= G.group.lingerTroubleAfter && !leader.rolled?.includes('lingerTrouble')) {
      (leader.rolled ??= []).push('lingerTrouble');
      noteTrouble(s);
      const seat = s.seats.find((x) => x.id === leader.seatId);
      notify(s, ctx, `linger:${g.id}`, 'warn', `${(seat?.index ?? 0) + 1}番席の団体が食べ終わっても席を空けません（待っているお客さんがいます）`);
    }
    return;
  }
  // 一緒に帰る
  for (const m of members) leaveAfterMeal(s, m, ctx);
}

/** 団体の会話（食事中・居座り中）。leader が会話を選び、1行ずつ別の人が話す */
function updateGroupChat(s: GameState, leader: Customer, members: Customer[]): void {
  const g = leader.group!;
  if (members.length < 2) return;
  const seated = members.filter((m) => m.state === 'eating' || m.state === 'afterMeal' || m.state === 'seated');
  if (seated.length < 2) return;
  if (g.chatAt === undefined) g.chatAt = s.t + G.group.chatFrom * evRand(s);
  if (s.t < g.chatAt) return;
  const lingering = !!g.linger && s.t < g.linger.until;
  const pool = lingering ? LINGER_CHATS : GROUP_CHATS;
  if (g.chatId === undefined || g.chatLine === undefined || g.chatId >= pool.length || g.chatLine >= pool[g.chatId]!.length) {
    g.chatId = Math.floor(evRand(s) * pool.length) % pool.length;
    g.chatLine = 0;
  }
  const lines = pool[g.chatId]!;
  const speaker = seated[g.chatLine % seated.length]!;
  talkFor(speaker, s, lines[g.chatLine]!, G.group.chatSay);
  g.chatLine += 1;
  if (g.chatLine >= lines.length) {
    g.chatId = undefined;
    g.chatAt = s.t + G.group.chatFrom + (G.group.chatTo - G.group.chatFrom) * evRand(s);
  } else {
    g.chatAt = s.t + G.group.chatSay * 0.9;
  }
}

/** 居座っている団体か（leader を見る） */
export function lingeringGroup(s: GameState, c: Customer): Customer | null {
  if (c.state !== 'afterMeal' || !c.group) return null;
  const leader = groupLeader(s, c);
  const lg = leader.group?.linger;
  return lg && s.t < lg.until ? leader : null;
}

/** 退店を促す対応ができるか（できなければ理由） */
export function lingerBlocked(s: GameState, seat: Seat, resp: LingerResponse): string | null {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c) return 'お客さんがいません';
  const leader = lingeringGroup(s, c);
  if (!leader) return '居座っているお客さんではありません';
  if (leader.group!.linger!.tried.includes(resp)) return 'さっき断られました';
  return null;
}

/** 退店を促す（丁寧に声をかける・混雑を説明する・退店をお願いする） */
export function askToLeave(s: GameState, ctx: SimCtx, seat: Seat, a: Actor, resp: LingerResponse): void {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c) return;
  const leader = lingeringGroup(s, c);
  if (!leader) return;
  const lg = leader.group!.linger!;
  const members = groupMembers(s, leader);
  const A = G.ask;
  const busy = s.queue.length + s.insideQueue.length > 0;
  const manners = members.reduce((x, m) => x + m.traits.manners, 0) / members.length;
  const svc = a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
  // 辛抱の低い従業員は言い方がきつくなることがある（お願いと同じ扱いで、気分を害しやすい）
  const harsh = a.kind === 'employee' && evRand(s) < argueChance(a, false, 0.5) * 0.5;
  const base = resp === 'polite' ? A.polite : resp === 'explain' ? (busy ? A.explain : A.explainNotBusy) : A.request;
  const p = clamp01(base * (0.7 + 0.5 * manners) * (0.75 + 0.5 * svc) * (lg.asked > 0 ? 1.15 : 1));
  lg.asked += 1;
  if (evRand(s) < p) {
    const offended = harsh || (resp === 'request' && evRand(s) < A.offendRequest * (1 - manners));
    for (const m of members) {
      if (offended) m.sat.service = Math.min(m.sat.service, 0.3);
      else if (resp !== 'request' && busy) m.sat.service = Math.max(m.sat.service, 0.6);
    }
    talkFor(leader, s, pickEv(s, offended ? LINGER_REPLY.offended : LINGER_REPLY.accepted), 3);
    lg.until = s.t;
    if (!offended) noteTroubleHandled(s, leader, 'lingerHandled');
    emit(ctx, { type: 'lingerResolved', targetId: seat.id, text: offended ? 'offended' : 'ok' });
    for (const m of members) leaveAfterMeal(s, m, ctx);
    return;
  }
  lg.tried.push(resp);
  lg.until += A.refusedExtend;
  for (const m of members) m.sat.service = Math.max(0, m.sat.service - 0.05);
  talkFor(leader, s, pickEv(s, LINGER_REPLY.refused), 3);
  emit(ctx, { type: 'lingerRefused', targetId: seat.id });
}

/** 食後に店を出る（口コミを決め、まれに店の前でタバコを吸う） */
export function leaveAfterMeal(s: GameState, c: Customer, ctx: SimCtx): void {
  finalizeVisit(s, c, ctx, false);
  startLeaving(s, c, ctx, 'left');
  maybeSmoke(s, c, ctx);
}

/** 食べ終わった（customers.ts から）。団体で、まだ食べている人がいれば席で待つ。true なら待つ */
export function holdAfterMeal(s: GameState, c: Customer): boolean {
  if (!c.group || c.group.size < 2) return false;
  const others = groupMembers(s, c).filter((m) => m.id !== c.id);
  if (others.length === 0) return false;
  c.state = 'afterMeal';
  c.stateTime = 0;
  return true;
}

// ───────────────────────── 食べ方の汚い客 ─────────────────────────

/** 来店したときに、食べ方の汚い客かを決める（低確率） */
export function rollMessy(s: GameState, c: Customer): void {
  if (s.tutorial || c.script || c.special?.kind === 'critic') return;
  if (evRand(s) >= G.messy.chance) return;
  c.messy = { next: G.messy.every * (0.5 + evRand(s)), count: 0, calmed: false, warned: 0, troubleId: newId(s, 'tr'), firstBotherT: null, victims: [] };
}

function seatOfCustomer(s: GameState, c: Customer): Seat | null {
  return s.seats.find((x) => x.id === c.seatId) ?? null;
}

/** 1つ隣・2つ隣に座っている客（食事中・待ち・食後） */
function neighbors(s: GameState, seat: Seat, within: number): { c: Customer; seat: Seat; d: number }[] {
  const out: { c: Customer; seat: Seat; d: number }[] = [];
  for (const other of s.seats) {
    const d = Math.abs(other.index - seat.index);
    if (d === 0 || d > within || !other.customerId) continue;
    const c = s.customers.find((x) => x.id === other.customerId);
    if (!c || GONE.has(c.state)) continue;
    out.push({ c, seat: other, d });
  }
  return out;
}

/** 迷惑を受けた（同じトラブルでは一度だけ）。下げた量を返す */
function bother(s: GameState, victim: Customer, troubleId: Id, comfort: number, cleanliness: number): { comfort: number; cleanliness: number } | null {
  if (victim.botheredBy?.includes(troubleId)) return null;
  (victim.botheredBy ??= []).push(troubleId);
  const dc = Math.min(victim.sat.comfort, comfort);
  const dl = Math.min(victim.sat.cleanliness, cleanliness);
  victim.sat.comfort -= dc;
  victim.sat.cleanliness -= dl;
  return { comfort: dc, cleanliness: dl };
}

function updateMessy(s: GameState, c: Customer, dt: number, ctx: SimCtx): void {
  const m = c.messy!;
  if (c.state !== 'eating') return;
  m.next -= dt;
  if (m.next > 0) return;
  m.next = G.messy.every * (0.7 + 0.6 * evRand(s));
  const chance = G.messy.chancePerCheck * (m.calmed ? G.messy.calmedMult : 1);
  if (evRand(s) >= chance) return;
  const seat = seatOfCustomer(s, c);
  if (!seat) return;
  m.count += 1;
  if (m.count === 1) noteTrouble(s);
  seat.dirt = clamp01(seat.dirt + G.messy.counterDirt);
  const r = evRand(s);
  const p = seatPos(s, seat);
  if (r < G.messy.floorShare) addDirt(s, { x: p.x + (evRand(s) - 0.5) * 0.5, z: p.z - 0.3 - 0.3 * evRand(s) }, 'grime', 'dining');
  if (m.count === 1 || evRand(s) < 0.4) sayEvent(c, s, pickEv(s, MESSY_LINES.self), 2.5);
  emit(ctx, { type: 'messy', targetId: seat.id });
  // 隣の客への迷惑（距離と客の性格で。全員が不快になるわけではない）
  const splash = evRand(s) < G.messy.splashShare;
  for (const n of neighbors(s, seat, 2)) {
    const f = n.d === 1 ? G.messy.nearFactor : G.messy.farFactor;
    const pBother = G.messy.bother * f * (0.4 + n.c.traits.cleanlinessDemand) * (splash ? 1.3 : 0.7);
    if (evRand(s) >= pBother) continue;
    if (splash && n.d === 1) n.seat.dirt = clamp01(n.seat.dirt + G.messy.neighborDirt);
    const loss = bother(s, n.c, m.troubleId, G.messy.comfortLoss * (n.d === 1 ? 1 : 0.6), splash ? G.messy.cleanlinessLoss : G.messy.cleanlinessLoss * 0.4);
    if (!loss) continue;
    m.victims.push({ id: n.c.id, ...loss });
    if (m.firstBotherT === null) m.firstBotherT = s.t;
    sayEvent(n.c, s, pickEv(s, MESSY_LINES.victim), 3);
    const victimSeat = n.seat.index + 1;
    notify(s, ctx, `messy:${c.id}`, 'warn', `${seat.index + 1}番席のお客さんの食べ方で、${victimSeat}番席のお客さんが嫌がっています`);
  }
}

/** 食べ終わったとき（finishEating から）: 汚い客は多めに汚して帰る */
export function messyLeaveDirt(s: GameState, c: Customer, seat: Seat): void {
  if (!c.messy) return;
  seat.dirt = clamp01(seat.dirt + G.messy.leaveDirt * (c.messy.calmed ? 0.3 : 1));
  if (!c.messy.calmed) {
    const p = seatPos(s, seat);
    addDirt(s, { x: p.x, z: p.z - 0.45 }, 'grime', 'dining');
  }
}

/** よい対応: 迷惑を受けた客の不満の一部を戻す（早いほど多く） */
function relieveVictims(s: GameState, victims: { id: Id; comfort: number; cleanliness: number }[], firstT: number | null, quickWithin: number, quick: number, slow: number): void {
  const f = firstT !== null && s.t - firstT <= quickWithin ? quick : slow;
  for (const v of victims) {
    const c = s.customers.find((x) => x.id === v.id);
    if (!c || c.state === 'left' || c.state === 'abandoned') continue;
    c.sat.comfort = clamp01(c.sat.comfort + v.comfort * f);
    c.sat.cleanliness = clamp01(c.sat.cleanliness + v.cleanliness * f);
    // 店がすぐ対応してくれた
    c.sat.service = clamp01(c.sat.service + 0.05);
  }
  victims.length = 0;
}

/** 汚い客への対応ができるか */
export function mannerBlocked(s: GameState, seat: Seat, kind: 'warn' | 'wipe' | 'move' | 'leave'): string | null {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c) return 'お客さんがいません';
  if (kind === 'move') {
    if (!movableVictim(s, c)) return '移ってもらう理由がありません';
    return moveTarget(s, c) ? null : '移れる空き席がありません';
  }
  if (kind === 'wipe') {
    const near = c.messy ? c : neighbors(s, seat, 1).find((n) => n.c.messy && n.c.messy.count > 0)?.c;
    if (!near) return '食べ方の汚いお客さんがいません';
    return seat.dirt > 0.05 || neighbors(s, seat, 1).some((n) => n.seat.dirt > 0.05) ? null : 'きれいです';
  }
  const m = c.messy;
  if (!m || m.count === 0) return '食べ方に問題はありません';
  if (c.state !== 'eating' && c.state !== 'seated') return '食事が終わっています';
  if (kind === 'warn' && (m.calmed || m.warned >= 2)) return 'もう注意しました';
  return null;
}

/** 迷惑を受けていて、まだ隣に汚い客がいる */
function movableVictim(s: GameState, c: Customer): boolean {
  if (c.messy || (c.state !== 'seated' && c.state !== 'eating')) return false;
  const seat = seatOfCustomer(s, c);
  if (!seat) return false;
  return neighbors(s, seat, 1).some((n) => n.c.messy && c.botheredBy?.includes(n.c.messy.troubleId));
}

/** 移る先: 汚い客の隣でない空き席（できるだけ遠く） */
function moveTarget(s: GameState, c: Customer): Seat | null {
  const n = s.seats.length;
  const messySeats = s.customers.filter((x) => x.messy && !GONE.has(x.state)).map((x) => seatOfCustomer(s, x)?.index ?? -99);
  const free = s.seats.filter((x) => x.installed && !x.customerId && !x.bowlId && x.index < n && messySeats.every((i) => Math.abs(i - x.index) > 1));
  if (free.length === 0) return null;
  return free.sort((a, b) => Math.min(...messySeats.map((i) => Math.abs(i - b.index))) - Math.min(...messySeats.map((i) => Math.abs(i - a.index))))[0]!;
}

/** 汚い客への対応（注意する・周りを拭く・隣の客に移ってもらう・退店を促す） */
export function respondManner(s: GameState, ctx: SimCtx, seat: Seat, a: Actor, kind: 'warn' | 'wipe' | 'move' | 'leave'): void {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c) return;
  const M = G.messy;
  if (kind === 'wipe') {
    seat.dirt = 0;
    for (const n of neighbors(s, seat, 1)) n.seat.dirt = Math.max(0, n.seat.dirt * 0.3);
    emit(ctx, { type: 'wipe', actorId: a.id, targetId: seat.id });
    return;
  }
  if (kind === 'move') {
    const to = moveTarget(s, c);
    if (!to) return;
    moveCustomer(s, c, seat, to);
    sayEvent(c, s, pickEv(s, MESSY_LINES.moved), 3);
    // 移ってもらった客の不満の一部を戻す
    const src = neighbors(s, to, 99).find((n) => n.c.messy && c.botheredBy?.includes(n.c.messy.troubleId))?.c ?? s.customers.find((x) => x.messy && c.botheredBy?.includes(x.messy.troubleId));
    if (src?.messy) {
      const mine = src.messy.victims.filter((v) => v.id === c.id);
      relieveVictims(s, mine, src.messy.firstBotherT, M.quickWithin, M.reliefQuick, M.reliefSlow);
      src.messy.victims = src.messy.victims.filter((v) => v.id !== c.id);
    }
    noteTroubleHandled(s, c, 'movedHandled');
    emit(ctx, { type: 'moveSeat', targetId: to.id });
    return;
  }
  const m = c.messy;
  if (!m) return;
  if (kind === 'leave') {
    // 退店を促す: 食事の途中でも帰る（代金は返さない）。本人の満足度は大きく下がるが、周りの迷惑は止まる
    sayEvent(c, s, pickEv(s, MESSY_LINES.leave), 3);
    c.sat.service = Math.min(c.sat.service, 0.15);
    const o = s.orders.find((x) => x.id === c.orderId);
    if (o && o.status === 'waiting') o.status = 'cancelled';
    relieveVictims(s, m.victims, m.firstBotherT, M.quickWithin, M.reliefQuick, M.reliefSlow);
    noteTroubleHandled(s, c, 'messyHandled');
    const b = s.bowls.find((x) => x.id === seat.bowlId);
    if (b && b.state === 'served') {
      b.state = 'dirty';
      b.contents = null;
    }
    finalizeVisit(s, c, ctx, true);
    startLeaving(s, c, ctx, 'left');
    emit(ctx, { type: 'messyLeave', targetId: seat.id });
    return;
  }
  // 注意する: 性格で反応が変わる（改める・聞き流す・怒る）
  m.warned += 1;
  const svc = a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
  const harsh = a.kind === 'employee' && evRand(s) < argueChance(a, false, c.traits.complaintPropensity) * 0.4;
  const pStop = clamp01((M.stopBase + M.stopManners * c.traits.manners) * (0.8 + 0.4 * svc) * (harsh ? 0.6 : 1));
  const pAnnoyed = clamp01(M.annoyed * c.traits.complaintPropensity * (harsh ? 1.8 : 1));
  const r = evRand(s);
  if (r < pStop) {
    m.calmed = true;
    sayEvent(c, s, pickEv(s, MESSY_LINES.stop), 3);
    relieveVictims(s, m.victims, m.firstBotherT, M.quickWithin, M.reliefQuick, M.reliefSlow);
    noteTroubleHandled(s, c, 'messyHandled');
    emit(ctx, { type: 'messyStop', targetId: seat.id });
  } else if (r < pStop + pAnnoyed) {
    c.sat.service = Math.min(c.sat.service, 0.3);
    sayEvent(c, s, pickEv(s, MESSY_LINES.annoyed), 3);
    emit(ctx, { type: 'messyAnnoyed', targetId: seat.id });
  } else {
    sayEvent(c, s, pickEv(s, MESSY_LINES.ignore), 3);
    emit(ctx, { type: 'messyIgnore', targetId: seat.id });
  }
}

/** 客を別の席へ移す（丼と注文も一緒に） */
function moveCustomer(s: GameState, c: Customer, from: Seat, to: Seat): void {
  from.customerId = null;
  to.customerId = c.id;
  c.seatId = to.id;
  const o = s.orders.find((x) => x.id === c.orderId);
  if (o) o.seatId = to.id;
  if (from.bowlId) {
    const b = s.bowls.find((x) => x.id === from.bowlId);
    if (b && b.loc.at === 'seat') {
      to.bowlId = b.id;
      from.bowlId = null;
      b.loc = { at: 'seat', seatId: to.id };
    }
  }
  c.pos = { ...seatPos(s, to) };
  c.path = [];
}

// ───────────────────────── 店外の喫煙 ─────────────────────────

/** 店の前の喫煙の場所（入口の左。行列の先頭と入口の近く） */
export function smokeSpot(s: GameState, k: number): Vec2 {
  void s;
  return { x: -0.6 - 0.55 * k, z: -1.6 };
}

function maybeSmoke(s: GameState, c: Customer, ctx: SimCtx): void {
  if (s.tutorial || c.script || c.forLostItem || c.special?.kind === 'critic' || s.phase === 'closing') return;
  // マナーの悪い客ほど吸いやすい
  if (evRand(s) >= G.smoke.chance * (1.5 - c.traits.manners)) return;
  const k = s.customers.filter((x) => x.state === 'smoking').length;
  if (k >= 3) return;
  const spot = smokeSpot(s, k);
  c.state = 'smoking';
  c.stateTime = 0;
  // 店を出てから喫煙の場所へ（出口までは startLeaving の道のり）
  const out = c.path.filter((p) => p.z > -1);
  c.path = [...out, spot];
  c.smoke = { until: -1, troubleId: newId(s, 'tr'), annoyed: [], warned: false, ignored: 0, nextCheck: 0 };
  emit(ctx, { type: 'smokeStart', targetId: c.id });
}

function walk(c: Customer, dt: number, speed: number): boolean {
  let left = speed * dt;
  while (left > 0 && c.path.length > 0) {
    const tgt = c.path[0]!;
    const d = dist(c.pos, tgt);
    if (d <= left) {
      c.pos = { x: tgt.x, z: tgt.z };
      c.path.shift();
      left -= d;
    } else {
      c.pos = { x: c.pos.x + ((tgt.x - c.pos.x) / d) * left, z: c.pos.z + ((tgt.z - c.pos.z) / d) * left };
      left = 0;
    }
  }
  return c.path.length === 0;
}

function updateSmoker(s: GameState, c: Customer, dt: number, ctx: SimCtx): void {
  const sm = c.smoke!;
  if (c.path.length > 0) {
    walk(c, dt, BALANCE.customers.walkSpeed);
    if (c.path.length > 0) return;
  }
  if (sm.until < 0) {
    sm.until = s.t + G.smoke.from + (G.smoke.to - G.smoke.from) * evRand(s);
    sm.nextCheck = s.t + 1;
    noteTrouble(s);
    sayEvent(c, s, pickEv(s, SMOKE_LINES.start), 3);
    notify(s, ctx, `smoke:${c.id}`, 'warn', '店の前でタバコを吸っているお客さんがいます（禁煙です）');
  }
  if (s.t >= sm.until) {
    finishSmoking(s, c, ctx);
    return;
  }
  if (s.t < sm.nextCheck) return;
  sm.nextCheck = s.t + G.smoke.every;
  // 近くの客（行列・入口・店の前を通る客）が煙を嫌がる。1人1回だけ
  for (const o of s.customers) {
    if (o.id === c.id || (o.state !== 'queue' && o.state !== 'arriving' && o.state !== 'ticket' && o.state !== 'leaving')) continue;
    if (o.pos.z > 0.4 || dist(o.pos, c.pos) > G.smoke.radius) continue;
    if (o.botheredBy?.includes(sm.troubleId)) continue;
    if (evRand(s) >= 0.35 + 0.65 * o.traits.cleanlinessDemand) {
      // 気にしない客（同じ煙で何度も抽選しない）
      (o.botheredBy ??= []).push(sm.troubleId);
      continue;
    }
    const loss = bother(s, o, sm.troubleId, G.smoke.comfortLoss, 0);
    if (!loss) continue;
    sm.annoyed.push({ id: o.id, comfort: loss.comfort });
    if (evRand(s) < 0.5) sayEvent(o, s, pickEv(s, SMOKE_LINES.victim), 3);
  }
}

function finishSmoking(s: GameState, c: Customer, ctx: SimCtx): void {
  c.smoke = c.smoke ? { ...c.smoke, until: s.t } : null;
  c.state = 'leaving';
  c.stateTime = 0;
  c.path = [{ x: c.pos.x - 2.5, z: c.pos.z - 0.6 }];
  emit(ctx, { type: 'smokeEnd', targetId: c.id });
}

export function smokeBlocked(c: Customer): string | null {
  if (c.state !== 'smoking' || !c.smoke || c.path.length > 0) return 'タバコを吸っていません';
  if (c.smoke.warned) return 'もう声をかけました';
  return null;
}

/** 禁煙をお伝えする: すぐやめる・謝って立ち去る・不満を示す・無視する（性格で変わる） */
export function warnSmoker(s: GameState, ctx: SimCtx, c: Customer, a: Actor): void {
  const sm = c.smoke;
  if (!sm || c.state !== 'smoking') return;
  const S = G.smoke;
  const tr = c.traits;
  const svc = a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
  const pIgnore = clamp01(S.ignore * (1 - tr.manners) * (0.5 + tr.complaintPropensity) / (1 + sm.ignored) * (1.2 - 0.4 * svc));
  const r = evRand(s);
  if (r < pIgnore) {
    sm.ignored += 1;
    sayEvent(c, s, pickEv(s, SMOKE_LINES.ignore), 3);
    emit(ctx, { type: 'smokeIgnore', targetId: c.id });
    return;
  }
  sm.warned = true;
  const r2 = evRand(s);
  const line = r2 < S.displeased * tr.complaintPropensity ? SMOKE_LINES.displeased : r2 < S.displeased * tr.complaintPropensity + S.apologize ? SMOKE_LINES.apologize : SMOKE_LINES.stop;
  sayEvent(c, s, pickEv(s, line), 3);
  // 嫌な思いをした客の不満の一部を戻す（早いほど多く）
  const started = sm.until < 0 ? s.t : sm.until - (S.from + S.to) / 2;
  const f = s.t - Math.max(0, started) <= S.quickWithin ? S.reliefQuick : S.reliefSlow;
  for (const v of sm.annoyed) {
    const o = s.customers.find((x) => x.id === v.id);
    if (o && o.state !== 'left' && o.state !== 'abandoned') o.sat.comfort = clamp01(o.sat.comfort + v.comfort * f);
  }
  sm.annoyed = [];
  noteTroubleHandled(s, c, 'smokeHandled');
  finishSmoking(s, c, ctx);
}

// ───────────────────────── 店員のトラブル ─────────────────────────

/** 店員の口論を見た周りの客（2つ隣まで）の居心地が下がる（同じトラブルで1回だけ） */
export function witnessStaffTrouble(s: GameState, seat: Seat, troubleId: Id): void {
  noteTrouble(s);
  for (const n of neighbors(s, seat, G.witness.seats)) bother(s, n.c, troubleId, G.witness.comfortLoss * (n.d === 1 ? 1 : 0.6), 0);
}

// ───────────────────────── トラブルの記録 ─────────────────────────

export function noteTrouble(s: GameState): void {
  s.today.troubles = (s.today.troubles ?? 0) + 1;
}

/** 対応できたトラブル（同じ客・同じ種類は一度だけ数える） */
function noteTroubleHandled(s: GameState, c: Customer, key: string): void {
  if (c.rolled?.includes(key)) return;
  (c.rolled ??= []).push(key);
  s.today.troublesHandled = (s.today.troublesHandled ?? 0) + 1;
}

// ───────────────────────── 毎ステップ ─────────────────────────

/** 団体の食後・会話、汚い客、喫煙（customers.ts の updateCustomers のあとに呼ぶ） */
export function updateManners(s: GameState, dt: number, ctx: SimCtx): void {
  ensureEvents(s);
  const leaders = new Set<string>();
  for (const c of s.customers) {
    if (c.messy && c.state === 'eating') updateMessy(s, c, dt, ctx);
    if (c.state === 'smoking' && c.smoke) updateSmoker(s, c, dt, ctx);
    if (c.group && c.group.size > 1 && !GONE.has(c.state)) leaders.add(c.group.id);
  }
  for (const gid of leaders) {
    const members = s.customers.filter((x) => x.group?.id === gid && !GONE.has(x.state));
    if (members.length === 0) continue;
    const leader = members.find((m) => m.group!.leader) ?? members[0]!;
    if (!leader.group!.leader) {
      // leader が先に帰った（怒って帰ったなど）: 残った人で引き継ぐ
      leader.group = { ...leader.group!, leader: true };
    }
    updateGroupChat(s, leader, members);
    updateGroupAfterMeal(s, leader, members, ctx);
  }
}

/** この従業員が辛抱を切らしやすいか（テスト・表示用） */
export function staffTemper(e: Employee): number {
  return patienceOf(e);
}
