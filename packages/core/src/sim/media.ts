// 第2版 Phase 4: YouTuber の撮影・テレビ取材・芸能人のサイン（設計書 11・12）。
// - ホストに判断を求める確認（撮影の許可・取材を受けるか）。答えがなければ断ったことにする（オーナー回答）
// - YouTuber: 許可の有無（permission）と撮影の状態（filming）を別に持つ。許可して撮影が完了したときだけ、
//   その日から3日間 SNS バズの確率が上がる（重ねられる・上限あり・それぞれ3日で切れる。オーナー回答）。既存のバズの抽選に掛けるだけ
// - 許可のない撮影は周りの客が嫌がる（1人1回だけ）。やめるよう伝える・ルールを説明する・退店を促す
// - テレビ取材: 出演者2・カメラマン2・スタッフ4。出演者だけが通常の流れで並び・注文し・食べる。カメラマンは出演者のそばで撮り、スタッフは店の外で待つ
//   出演者が食べ終えてチーム全員が帰れば完了（オーナー回答）。翌日・翌々日の来客の倍率を確定で上げる（実際の来客で。売上は足さない。同じ日に重ねない）
// - サイン: 取材が完了したら出演者のサインをもらい、壁の決まった場所に自動で飾る（同じ人は1枚で、来店の回数を数える。収益への効果はない）
// - 抽選はイベント専用の乱数。チュートリアル中は起きない

import { openDurationOf } from './hours';
import { BALANCE } from '../data/balance';
import { CELEBRITIES, TV_LINES, TV_SHOWS, YOUTUBER_LINES } from '../data/events';
import { seatPos, stageOf } from '../geometry';
import type { BuzzBoost, CelebritySign, Customer, Employee, FilmState, GameState, HostRequest, Id, Player, Seat, TvVisit, Vec2 } from '../types';
import { clamp01, dist, newId } from '../util';
import { finalizeVisit, makeCustomer, sayEvent, startLeaving } from './customers';
import { addDaily, cooledDown, ensureEvents, eventsAllowed, evRand, noteDraw, noteFire, takeForced } from './events';
import { noteTrouble } from './manners';
import { emit, notify, type SimCtx } from './notices';
import { argueChance } from './staff';
import { addLegend, creatorSnubbed, creatorVisitFactor, makeVideo, pickCreator, pickPlan, planAllowed } from './fame';
import { FILM_LEVEL_LABEL, VIDEO_PLANS, creatorTierLabel } from '../data/fame';
import type { FilmLevel } from '../types';

const Y = BALANCE.events.youtuber;
const T = BALANCE.events.tv;

type Actor = Player | Employee;

function pickEv<T>(s: GameState, list: readonly T[]): T {
  return list[Math.floor(evRand(s) * list.length) % list.length]!;
}

// ───────────────────────── ホストへの確認 ─────────────────────────

/** ホストに判断を求めている確認（読むだけ。client の確認の画面） */
export function pendingRequests(s: GameState): HostRequest[] {
  return s.events?.requests ?? [];
}

function addRequest(s: GameState, ctx: SimCtx, kind: HostRequest['kind'], subjectId: Id, text: string, timeout: number): HostRequest {
  const ev = ensureEvents(s);
  const r: HostRequest = { id: newId(s, 'rq'), kind, subjectId, text, askedAt: s.t, timeoutAt: s.t + timeout };
  (ev.requests ??= []).push(r);
  notify(s, ctx, `request:${r.id}`, 'info', kind === 'filming' ? 'YouTuber が撮影の許可を求めています' : 'テレビ番組の取材の申し込みです');
  emit(ctx, { type: 'hostRequest', targetId: r.id, text: kind });
  return r;
}

/** 確認に答える（ホストの操作。共同経営ではサーバーがホストだけに許す） */
export function answerRequest(s: GameState, ctx: SimCtx, requestId: Id, accept: boolean, level?: FilmLevel): { ok: boolean; reason?: string } {
  const ev = ensureEvents(s);
  const r = (ev.requests ?? []).find((x) => x.id === requestId);
  if (!r) return { ok: false, reason: 'この確認はもう終わっています' };
  ev.requests = (ev.requests ?? []).filter((x) => x.id !== requestId);
  // 撮影の許可は5段（じろ7 Phase 7）。段を指定しない答え（前の版の画面・時間切れ）は「全面許可／撮影禁止」
  if (r.kind === 'filming') decideFilming(s, ctx, r.subjectId, level ?? (accept ? 'full' : 'deny'));
  else decideTv(s, ctx, accept);
  return { ok: true };
}

function updateRequests(s: GameState, ctx: SimCtx): void {
  const list = s.events?.requests;
  if (!list || list.length === 0) return;
  for (const r of [...list]) if (s.t >= r.timeoutAt) answerRequest(s, ctx, r.id, false);
}

// ───────────────────────── YouTuber ─────────────────────────

/** 開店時の抽選（1日1回） */
export function drawMediaPlans(s: GameState): void {
  const ev = ensureEvents(s);
  ev.youtuberPlan = null;
  ev.tvPlan = null;
  ev.tv = null;
  ev.requests = [];
  const fy = takeForced(s, 'youtuber');
  if (fy || (eventsAllowed(s, Y.minDay) && cooledDown(s, 'youtuber', Y.cooldownDays))) {
    noteDraw(s, 'youtuber');
    // 大ヒット・大バズの動画を見たほかの YouTuber が来やすい（じろ7 Phase 7。乱数を引く回数は変えない）
    if (fy || evRand(s) < Math.min(0.6, Y.chancePerDay * creatorVisitFactor(s))) ev.youtuberPlan = { day: s.day, afterOpenT: fy ? 0 : (Y.arriveFrom + (Y.arriveTo - Y.arriveFrom) * evRand(s)) * openDurationOf(s), forced: fy };
  }
  const ft = takeForced(s, 'tv');
  if (ft || (eventsAllowed(s, T.minDay) && cooledDown(s, 'tv', T.cooldownDays))) {
    noteDraw(s, 'tv');
    if (ft || evRand(s) < T.chancePerDay) ev.tvPlan = { day: s.day, afterOpenT: ft ? 2 : (T.arriveFrom + (T.arriveTo - T.arriveFrom) * evRand(s)) * openDurationOf(s), forced: ft };
  }
}

/** 来店した客（一人の新規客）を YouTuber にするか（customers.ts の来店から） */
export function maybeYoutuber(s: GameState, c: Customer, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  const plan = ev.youtuberPlan;
  if (!plan || plan.day !== s.day || s.openT < plan.afterOpenT || c.special || c.regularId || c.group || c.script || c.forLostItem) return;
  ev.youtuberPlan = null;
  addDaily(s, 'youtuber');
  noteFire(s, 'youtuber', !!plan.forced);
  const asks = evRand(s) < Y.askChance;
  const film: FilmState = { permission: asks ? 'asking' : 'unasked', filming: 'none', sneaky: !asks && evRand(s) < Y.sneakUnasked, warned: 0, tried: [], requestId: null, troubleId: newId(s, 'tr'), talkAt: 0 };
  // 続く YouTuber と企画（じろ7 Phase 7。名簿と企画は fame の乱数で決める）
  const cr = pickCreator(s);
  film.creatorId = cr.id;
  film.plan = pickPlan(s, cr);
  c.special = { kind: 'youtuber', eventId: newId(s, 'ev'), spoken: false, film };
  // 撮影の相手はクレームを言いにくく、口コミは動画のかわり（書かない）
  c.traits.complaintPropensity = Math.min(c.traits.complaintPropensity, 0.3);
  c.traits.reviewPropensity = 0;
  c.patience *= 1.4;
  if (asks) {
    const text = `${cr.name}（${cr.channel}・登録者 ${cr.subs.toLocaleString('ja-JP')}人・${creatorTierLabel(cr.subs)}）: 「${VIDEO_PLANS[film.plan].label}」の撮影をしてもいいですか？${cr.visits > 0 ? `（${cr.visits + 1}回目の来店）` : ''}`;
    film.requestId = addRequest(s, ctx, 'filming', c.id, text, Y.answerTimeout).id;
    sayEvent(c, s, YOUTUBER_LINES.ask, 5);
  }
  emit(ctx, { type: 'youtuberArrive', targetId: c.id });
}

function decideFilming(s: GameState, ctx: SimCtx, customerId: Id, level: FilmLevel): void {
  const c = s.customers.find((x) => x.id === customerId);
  const film = c?.special?.film;
  if (!c || !film || film.permission !== 'asking') return;
  const accept = level !== 'deny';
  film.permission = accept ? 'permitted' : 'denied';
  film.level = level;
  film.requestId = null;
  // 許可の範囲で企画が撮れないときは、ふつうの食レポにする（動画を作るときに決める）。断られると関係が少し下がる
  if (!accept) creatorSnubbed(s, film.creatorId, 0.1);
  else if (film.plan && !planAllowed(film.plan, level)) notify(s, ctx, `filmplan:${c.id}`, 'info', `「${FILM_LEVEL_LABEL[level].label}」では「${VIDEO_PLANS[film.plan].label}」は撮れないため、ふつうの食レポにしてもらいます`);
  // 許可がなくても撮る人がいる（許可の有無と撮影の状態は別）
  film.sneaky = !accept && evRand(s) < Y.sneakDenied;
  sayEvent(c, s, pickEv(s, accept ? YOUTUBER_LINES.permitted : YOUTUBER_LINES.denied), 3);
  emit(ctx, { type: 'filmingAnswer', targetId: c.id, text: accept ? 'yes' : 'no' });
}

/** 許可のない撮影か */
export function unpermittedFilming(c: Customer): boolean {
  const f = c.special?.film;
  return !!f && f.filming === 'filming' && f.permission !== 'permitted';
}

function updateYoutuber(s: GameState, c: Customer, ctx: SimCtx): void {
  const f = c.special!.film!;
  const seated = c.state === 'seated' || c.state === 'eating';
  if (f.filming === 'none' && seated && f.permission !== 'asking') {
    if (f.permission === 'permitted') {
      f.filming = 'filming';
      f.talkAt = s.t + 2;
      // 映り込みへの配慮（じろ7 Phase 7・設計書 7-4）: 生配信はまわりの客がそのまま映るので、となりの席の、迷惑を我慢しにくい客が少し嫌がる。
      // 「店内のみ」の許可では客席を写さないように撮る（嫌がらない）
      if (f.plan === 'live' && f.level !== 'dining') {
        const seat = s.seats.find((x) => x.id === c.seatId);
        for (const o of s.customers) {
          if (o.id === c.id || !o.seatId || !seat) continue;
          const os = s.seats.find((x) => x.id === o.seatId);
          if (!os || Math.abs(os.index - seat.index) > 1 || o.botheredBy?.includes(f.troubleId)) continue;
          const tol = typeof o.traits.tolerance === 'number' ? o.traits.tolerance : 0.5;
          if (tol >= 0.4) continue;
          (o.botheredBy ??= []).push(f.troubleId);
          o.sat.comfort = clamp01(o.sat.comfort - 0.05);
        }
      }
      emit(ctx, { type: 'filmingStart', targetId: c.seatId ?? undefined, text: 'permitted' });
    } else if (f.sneaky) {
      f.filming = 'filming';
      f.talkAt = s.t + 3;
      noteTrouble(s);
      const seat = s.seats.find((x) => x.id === c.seatId);
      notify(s, ctx, `film:${c.id}`, 'warn', `${(seat?.index ?? 0) + 1}番席のお客さんが許可なく撮影しています`);
      // 周りの客（2つ隣まで）が嫌がる（1人1回だけ）
      if (seat) {
        for (const o of s.customers) {
          if (o.id === c.id || !o.seatId) continue;
          const os = s.seats.find((x) => x.id === o.seatId);
          if (!os || Math.abs(os.index - seat.index) > 2 || o.botheredBy?.includes(f.troubleId)) continue;
          (o.botheredBy ??= []).push(f.troubleId);
          o.sat.comfort = Math.max(0, o.sat.comfort - Y.annoyComfort * (0.5 + o.traits.serviceSensitivity));
        }
      }
      emit(ctx, { type: 'filmingStart', targetId: c.seatId ?? undefined, text: 'sneak' });
    }
  }
  if (f.filming === 'filming' && seated && s.t >= f.talkAt) {
    f.talkAt = s.t + Y.talkEvery * (0.8 + 0.4 * evRand(s));
    sayEvent(c, s, pickEv(s, f.permission === 'permitted' ? YOUTUBER_LINES.filming : YOUTUBER_LINES.sneak), 3);
  }
}

/** 食べ終わったとき（customers.ts から）: 撮影の完了・取材の出演者が食べ終えた */
export function onMealFinished(s: GameState, c: Customer, ctx: SimCtx): void {
  const sp = c.special;
  if (!sp) return;
  if (sp.kind === 'tv_performer') {
    sp.ate = true;
    return;
  }
  const f = sp.film;
  if (sp.kind !== 'youtuber' || !f || f.filming !== 'filming') return;
  f.filming = 'done';
  // 動画を作り、翌日に投稿する（じろ7 Phase 7）。許可なく撮り終えた動画も投稿される（炎上しやすい）
  makeVideo(s, ctx, c, f.permission !== 'permitted');
  if (f.permission !== 'permitted') return;
  // 許可した撮影が完了した: その日から3日間 SNS バズの確率が上がる（重ねられる）
  const ev = ensureEvents(s);
  const boost: BuzzBoost = { id: newId(s, 'bb'), day: s.day, untilDay: s.day + Y.boostDays, add: Y.buzzBoost };
  (ev.buzzBoosts ??= []).push(boost);
  sayEvent(c, s, YOUTUBER_LINES.done, 4);
  notify(s, ctx, `filmdone:${c.id}`, 'good', `YouTuber の撮影が終わりました。${Y.boostDays}日間（${boost.untilDay}日目まで）SNSで話題になりやすくなります`);
  emit(ctx, { type: 'filmingDone', targetId: c.id });
}

/** SNS バズの確率の倍率（許可した撮影の効果。期限内のものを重ね、上限まで） */
export function buzzBoostFactor(s: GameState): number {
  const list = s.events?.buzzBoosts ?? [];
  const add = list.filter((b) => b.untilDay >= s.day).reduce((a, b) => a + b.add, 0);
  return Math.min(Y.buzzBoostCap, 1 + add);
}

/** 許可のない撮影への対応ができるか */
export function filmBlocked(s: GameState, seat: Seat, kind: 'stop' | 'rules' | 'leave'): string | null {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c || !unpermittedFilming(c)) return '許可のない撮影はしていません';
  const f = c.special!.film!;
  if (kind === 'leave' && f.warned === 0) return '先に撮影をやめるよう伝えてください';
  if (kind !== 'leave' && f.tried.length > 0 && f.tried[f.tried.length - 1] === kind) return 'さっき伝えました（ほかの伝え方を）';
  return null;
}

/** 許可のない撮影をやめさせる: やめる・謝る・不満を示す・撮影を続けようとする */
export function respondFilm(s: GameState, ctx: SimCtx, seat: Seat, a: Actor, kind: 'stop' | 'rules' | 'leave'): void {
  const c = s.customers.find((x) => x.id === seat.customerId);
  if (!c || !unpermittedFilming(c)) return;
  const f = c.special!.film!;
  if (kind === 'leave') {
    sayEvent(c, s, pickEv(s, YOUTUBER_LINES.leave), 3);
    f.filming = 'stopped';
    c.sat.service = Math.min(c.sat.service, 0.3);
    const o = s.orders.find((x) => x.id === c.orderId);
    if (o && o.status === 'waiting') o.status = 'cancelled';
    const b = s.bowls.find((x) => x.id === seat.bowlId);
    if (b && b.state === 'served') {
      b.state = 'dirty';
      b.contents = null;
    }
    relieveFilmVictims(s, f);
    handled(s, c);
    creatorSnubbed(s, f.creatorId, 0.3);
    finalizeVisit(s, c, ctx, true);
    startLeaving(s, c, ctx, 'left');
    emit(ctx, { type: 'filmLeave', targetId: seat.id });
    return;
  }
  const tr = c.traits;
  const svc = a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
  const harsh = a.kind === 'employee' && evRand(s) < argueChance(a, false, tr.complaintPropensity) * 0.4;
  const base = kind === 'rules' ? Y.keepOnRules : Y.keepOnStop;
  const pKeep = clamp01((base / (1 + f.warned)) * (0.6 + 0.8 * tr.complaintPropensity) * (1.2 - 0.4 * svc) * (harsh ? 1.5 : 1));
  f.warned += 1;
  f.tried.push(kind);
  if (evRand(s) < pKeep) {
    sayEvent(c, s, pickEv(s, YOUTUBER_LINES.keepOn), 3);
    emit(ctx, { type: 'filmKeepOn', targetId: seat.id });
    return;
  }
  f.filming = 'stopped';
  const r = evRand(s);
  if (r < Y.displeased * tr.complaintPropensity || harsh) {
    c.sat.service = Math.min(c.sat.service, 0.35);
    sayEvent(c, s, pickEv(s, YOUTUBER_LINES.displeased), 3);
  } else if (r < Y.displeased * tr.complaintPropensity + Y.apologize) {
    sayEvent(c, s, pickEv(s, YOUTUBER_LINES.apologize), 3);
  } else {
    sayEvent(c, s, pickEv(s, YOUTUBER_LINES.stop), 3);
  }
  relieveFilmVictims(s, f);
  handled(s, c);
  creatorSnubbed(s, f.creatorId, 0.15);
  emit(ctx, { type: 'filmStopped', targetId: seat.id });
}

/** 撮影をやめさせたら、嫌がっていた周りの客の居心地を少し戻す */
function relieveFilmVictims(s: GameState, f: FilmState): void {
  for (const o of s.customers) if (o.botheredBy?.includes(f.troubleId)) o.sat.comfort = clamp01(o.sat.comfort + Y.annoyComfort * 0.5);
}

function handled(s: GameState, c: Customer): void {
  if (c.rolled?.includes('filmHandled')) return;
  (c.rolled ??= []).push('filmHandled');
  s.today.troublesHandled = (s.today.troublesHandled ?? 0) + 1;
}

// ───────────────────────── テレビ取材 ─────────────────────────

/** 店の前の待機の場所（入口の左、店の前の喫煙の場所より奥） */
function crewSpot(k: number): Vec2 {
  return { x: -1.2 - 0.55 * (k % 4), z: -2.5 - 0.5 * Math.floor(k / 4) };
}

function spawnCrew(s: GameState, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  const plan = ev.tvPlan!;
  ev.tvPlan = null;
  addDaily(s, 'tv');
  noteFire(s, 'tv', !!plan.forced);
  const pool = [...CELEBRITIES];
  const celebs: string[] = [];
  for (let i = 0; i < 2; i++) celebs.push(pool.splice(Math.floor(evRand(s) * pool.length) % pool.length, 1)[0]!.id);
  const tv: TvVisit = { id: newId(s, 'tv'), day: s.day, show: pickEv(s, TV_SHOWS), celebs, status: 'asking', requestId: null, memberIds: [], troubleId: newId(s, 'tr') };
  const gid = newId(s, 'g');
  const roles: ('tv_performer' | 'tv_camera' | 'tv_staff')[] = ['tv_performer', 'tv_performer', 'tv_camera', 'tv_camera', 'tv_staff', 'tv_staff', 'tv_staff', 'tv_staff'];
  roles.forEach((kind, i) => {
    const c = makeCustomer(s, null);
    c.special = { kind, eventId: tv.id, spoken: false, celebId: kind === 'tv_performer' ? celebs[i] : undefined };
    c.state = 'crew';
    c.pos = { x: -2.6 - 0.3 * i, z: -2.2 - 0.25 * (i % 2) };
    c.path = [crewSpot(i)];
    c.traits.complaintPropensity = 0;
    c.traits.reviewPropensity = 0;
    c.traits.patience = 1;
    c.patience = BALANCE.customers.patienceBase * 3;
    if (kind === 'tv_performer') c.group = { id: gid, size: 2, leader: i === 0 };
    s.customers.push(c);
    tv.memberIds.push(c.id);
  });
  ev.tv = tv;
  tv.requestId = addRequest(s, ctx, 'tv', tv.id, `${TV_LINES.ask}（番組「${tv.show}」）`, T.answerTimeout).id;
  emit(ctx, { type: 'tvArrive', targetId: tv.id });
}

function crewOf(s: GameState, tv: TvVisit): Customer[] {
  return tv.memberIds.map((id) => s.customers.find((x) => x.id === id)).filter((x): x is Customer => !!x);
}

function decideTv(s: GameState, ctx: SimCtx, accept: boolean): void {
  const tv = s.events?.tv;
  if (!tv || tv.status !== 'asking') return;
  tv.requestId = null;
  const crew = crewOf(s, tv);
  const staff = crew.find((c) => c.special?.kind === 'tv_staff');
  if (!accept) {
    tv.status = 'declined';
    if (staff) sayEvent(staff, s, pickEv(s, TV_LINES.declined), 3);
    for (const c of crew) crewLeave(s, c);
    notify(s, ctx, 'tv', 'info', 'テレビ取材をお断りしました');
    return;
  }
  tv.status = 'accepted';
  if (staff) sayEvent(staff, s, pickEv(s, TV_LINES.accepted), 3);
  // 出演者は2人で行列の先頭に入る（取材は予定の時間で動くため）。注文・食事は通常の流れ
  const performers = crew.filter((c) => c.special?.kind === 'tv_performer');
  for (const p of [...performers].reverse()) {
    p.state = 'queue';
    p.stateTime = 0;
    p.path = [];
    s.queue.unshift(p.id);
  }
  s.today.customers += performers.length;
  notify(s, ctx, 'tv', 'good', `テレビ取材を受けます（番組「${tv.show}」）。出演者2人にラーメンを出しましょう`);
  emit(ctx, { type: 'tvAccepted', targetId: tv.id });
}

function crewLeave(s: GameState, c: Customer): void {
  if (c.state === 'left' || c.state === 'leaving' || c.state === 'abandoned' || c.state === 'dead') return;
  c.state = 'leaving';
  c.stateTime = 0;
  const st = stageOf(s);
  const doorX = (st.door.x0 + st.door.x1) / 2;
  c.path = c.pos.z > 0 ? [{ x: doorX, z: 0.35 }, { x: doorX, z: -0.5 }, { x: -3, z: -2.4 }] : [{ x: -3, z: c.pos.z - 0.3 }];
}

function walk(c: Customer, dt: number): void {
  let left = BALANCE.customers.walkSpeed * dt;
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
}

/** カメラマンの撮影の場所（出演者の席の後ろ。通路の端に寄せて、席・待ち場所をふさがない） */
function cameraSpot(s: GameState, seat: Seat, k: number): Vec2 {
  const p = seatPos(s, seat);
  return { x: p.x + (k === 0 ? -0.55 : 0.55), z: Math.max(0.35, p.z - 0.65) };
}

function updateTv(s: GameState, dt: number, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  if (ev.tvPlan && ev.tvPlan.day === s.day && s.phase === 'open' && s.openT >= ev.tvPlan.afterOpenT && !ev.tv && !s.tutorial) spawnCrew(s, ctx);
  const tv = ev.tv;
  if (!tv) return;
  const crew = crewOf(s, tv);
  // 待機・撮影の場所への移動（帰るときの移動は customers.ts の leaving が行う）
  for (const c of crew) if (c.state === 'crew') walk(c, dt);
  if (tv.status !== 'accepted') return;
  const performers = crew.filter((c) => c.special?.kind === 'tv_performer');
  const cams = crew.filter((c) => c.special?.kind === 'tv_camera');
  // カメラマン: 出演者が席に着いたら、そばで撮る（それまでは入口の外で待つ）
  const seatedP = performers.filter((p) => p.seatId && (p.state === 'seated' || p.state === 'eating' || p.state === 'afterMeal' || p.state === 'toSeat'));
  cams.forEach((cam, k) => {
    if (cam.state !== 'crew') return;
    const target = seatedP[k % Math.max(1, seatedP.length)];
    const seat = target ? s.seats.find((x) => x.id === target.seatId) : undefined;
    if (seat && cam.path.length === 0 && cam.pos.z < 0) {
      const st = stageOf(s);
      const doorX = (st.door.x0 + st.door.x1) / 2;
      cam.path = [{ x: doorX, z: -0.5 }, { x: doorX, z: 0.35 }, cameraSpot(s, seat, k)];
    }
    if (seat && cam.pos.z > 0 && evRand(s) < dt * 0.05) sayEvent(cam, s, pickEv(s, TV_LINES.camera), 3);
  });
  // 出演者の食レポ
  for (const p of performers) if (p.state === 'eating' && s.t >= p.sayUntil + 4 && evRand(s) < dt * 0.25) sayEvent(p, s, pickEv(s, TV_LINES.performer), 3);
  // スタッフは店の外で待機（ときどき）
  for (const st of crew.filter((c) => c.special?.kind === 'tv_staff')) if (st.state === 'crew' && s.t >= st.sayUntil + 8 && evRand(s) < dt * 0.03) sayEvent(st, s, pickEv(s, TV_LINES.staff), 3);
  // カメラマンが店内にいる間、座っている通常の客の居心地が少し下がる（店が狭く混んでいるほど大きい。1人1回だけ）
  if (cams.some((c) => c.pos.z > 0.2)) {
    const nSeats = stageOf(s).seats.length;
    const occupied = s.seats.filter((x) => x.customerId).length;
    const loss = T.crowdComfort * (0.4 + occupied / nSeats) * Math.sqrt(8 / nSeats);
    for (const o of s.customers) {
      if (o.special?.eventId === tv.id || !o.seatId || o.botheredBy?.includes(tv.troubleId)) continue;
      if (o.state !== 'seated' && o.state !== 'eating') continue;
      (o.botheredBy ??= []).push(tv.troubleId);
      o.sat.comfort = Math.max(0, o.sat.comfort - loss);
    }
  }
  // 完了・失敗
  const gone = (c: Customer) => c.state === 'leaving' || c.state === 'left' || c.state === 'abandoned' || c.state === 'dead';
  if (performers.length === 2 && performers.every((p) => gone(p) && p.special?.ate)) {
    finishTv(s, ctx, tv, true);
  } else if (performers.length < 2 || performers.some((p) => gone(p) && !p.special?.ate)) {
    finishTv(s, ctx, tv, false);
  }
}

function finishTv(s: GameState, ctx: SimCtx, tv: TvVisit, ok: boolean): void {
  tv.status = ok ? 'done' : 'failed';
  const crew = crewOf(s, tv);
  const staff = crew.find((c) => c.special?.kind === 'tv_staff');
  if (staff) sayEvent(staff, s, ok ? TV_LINES.done : TV_LINES.failed, 4);
  for (const c of crew) if (c.special?.kind !== 'tv_performer') crewLeave(s, c);
  if (!ok) {
    notify(s, ctx, 'tv', 'warn', '出演者が食べられず、テレビ取材は撮影できませんでした（放送はありません）');
    emit(ctx, { type: 'tvFailed', targetId: tv.id });
    return;
  }
  addTvEffects(s, tv);
  const got = collectSigns(s, tv);
  // 店の伝説（じろ7 Phase 7）: テレビ取材
  const names = tv.celebs.map((id) => CELEBRITIES.find((x) => x.id === id)?.name ?? id);
  addLegend(s, ctx, 'tv', { title: `テレビ取材「${tv.show}」`, summary: `「${tv.show}」の取材で${names.join('さん・')}さんが来店し、ラーメンを食べた`, people: names, related: [tv.id], bonus: 0.05 });
  notify(s, ctx, 'tv', 'good', `テレビ取材が終わりました。放送は明日。明日と明後日はお客さんが大幅に増えます（食材と人手の準備を）。${got}`);
  emit(ctx, { type: 'tvDone', targetId: tv.id });
}

/** 翌日・翌々日の来客の倍率（確定。同じ日に重ねない＝高いほうを使う） */
function addTvEffects(s: GameState, tv: TvVisit): void {
  const ev = ensureEvents(s);
  const add = (day: number, mult: number) => {
    const same = ev.effects.find((e) => e.source === 'tv' && e.fromDay === day && e.untilDay === day);
    if (same) same.mult = Math.max(same.mult, mult);
    else ev.effects.push({ id: newId(s, 'fx'), source: 'tv', mult, fromDay: day, untilDay: day });
  };
  add(tv.day + 1, T.nextDayMult);
  add(tv.day + 2, T.dayAfterMult);
}

/** サインをもらう（同じ人は1枚で、来店の回数を数える） */
function collectSigns(s: GameState, tv: TvVisit): string {
  const ev = ensureEvents(s);
  const signs = (ev.signs ??= []);
  const got: string[] = [];
  for (const id of tv.celebs) {
    const cel = CELEBRITIES.find((x) => x.id === id);
    if (!cel) continue;
    const have = signs.find((x) => x.celebId === id);
    if (have) {
      have.visits += 1;
      have.lastDay = s.day;
    } else {
      const sign: CelebritySign = { celebId: id, name: cel.name, show: tv.show, day: s.day, visits: 1, lastDay: s.day };
      signs.push(sign);
      got.push(cel.name);
    }
  }
  return got.length > 0 ? `${got.join('さん・')}さんのサインをもらい、壁に飾りました` : '同じ出演者のサインはもう飾ってあります';
}

/** 飾ってあるサイン（読むだけ） */
export function signsOf(s: GameState): CelebritySign[] {
  return s.events?.signs ?? [];
}

// ───────────────────────── 毎ステップ・日の区切り ─────────────────────────

export function updateMedia(s: GameState, dt: number, ctx: SimCtx): void {
  if (!s.events) return;
  updateRequests(s, ctx);
  for (const c of s.customers) if (c.special?.kind === 'youtuber' && c.special.film) updateYoutuber(s, c, ctx);
  updateTv(s, dt, ctx);
}

/** 翌日の朝: 期限の切れた撮影の効果を消し、放送の日を知らせる */
export function onDayStartMedia(s: GameState, ctx: SimCtx): void {
  const ev = ensureEvents(s);
  if (ev.buzzBoosts) ev.buzzBoosts = ev.buzzBoosts.filter((b) => b.untilDay >= s.day);
  ev.requests = [];
  ev.tv = null;
  const tvToday = ev.effects.find((e) => e.source === 'tv' && e.fromDay === s.day);
  if (tvToday) notify(s, ctx, 'tvAir', 'good', `テレビ放送の反響で、今日はお客さんが大幅に増えます（約${tvToday.mult.toFixed(1)}倍）`);
}

/** テスト用: 次の来店・開店で起こす */
export function forceMedia(s: GameState, kind: 'youtuber' | 'tv'): { ok: boolean; reason?: string } {
  const ev = ensureEvents(s);
  if (s.phase === 'open') {
    if (kind === 'youtuber') ev.youtuberPlan = { day: s.day, afterOpenT: 0, forced: true };
    else {
      if (ev.tv) return { ok: false, reason: 'すでに取材が来ています' };
      ev.tvPlan = { day: s.day, afterOpenT: s.openT, forced: true };
    }
    return { ok: true };
  }
  if (!ev.forced.includes(kind)) ev.forced.push(kind);
  return { ok: true };
}
