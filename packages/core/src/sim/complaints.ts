// 怒った客・理不尽なクレーム（設計書 B）。
// 原因: 盛り間違い・品質（提供後）、提供の遅れ・席の汚れ（提供前）、客の性格による理不尽な要求（提供後）。
// 対応: 謝る・作り直す・返金する・状況を説明する・不当な要求を断る。
//   - 売上は提供したときに計上するので、提供前のクレームの「返金」は食券の払い戻し（注文の取り消し・お金は動かない）。作り直しは提供後だけ
//   - 理不尽な要求は受け入れなくてよい。説明する・断るで損失を抑えられる
//   - 謝る・説明する・断るは受け入れてもらえないことがある（接客の上手さと客の性格で決まる）。だめだった対応は、同じクレームの間は選べない

import { BALANCE } from '../data/balance';
import { COMPLAINT_CAUSE_LABEL, COMPLAINT_REPLY, COMPLAINT_RESPONSE_LABEL } from '../data/events';
import type { ComplaintCause, ComplaintResponse, Customer, CustomerComplaint, Employee, GameState, Player, Seat } from '../types';
import { clamp01, newId, pick } from '../util';
import { addReview, leaveAngry, leaveWithoutEating, sayFor } from './customers';
import { cash, recordPL } from './economy';
import { ensureEvents, evRand } from './events';
import { clearNotice, emit, notify, type SimCtx } from './notices';

const C = BALANCE.events.complaint;

type Actor = Player | Employee;

/** この客がこの原因でクレームを言えるか（1回の来店で maxPerVisit 回まで。同じ原因は作り直しのあとだけ） */
export function canComplain(s: GameState, c: Customer, cause: ComplaintCause): boolean {
  if (c.script || c.special?.kind === 'critic') return false;
  const log = c.complaintLog ?? [];
  if (log.length >= C.maxPerVisit) return false;
  const remakes = s.orders.find((o) => o.id === c.orderId)?.remakes ?? 0;
  return !log.some((l) => l.cause === cause && l.remakes >= remakes);
}

/** クレームを言い始める（客は complaint 状態になり、対応を待つ） */
export function startComplaint(s: GameState, ctx: SimCtx, c: Customer, cause: ComplaintCause, text: string, served: boolean, reason = text): void {
  const remakes = s.orders.find((o) => o.id === c.orderId)?.remakes ?? 0;
  c.complaint = { id: newId(s, 'cp'), cause, served, text, tried: [] };
  (c.complaintLog ??= []).push({ cause, remakes });
  c.complaintReason = reason;
  c.state = 'complaint';
  c.stateTime = 0;
  sayFor(c, s, text, 6);
  s.today.complaints += 1;
  const seat = s.seats.find((x) => x.id === c.seatId);
  notify(s, ctx, `complaint:${c.seatId}`, 'danger', `${(seat?.index ?? 0) + 1}番席でクレーム（${COMPLAINT_CAUSE_LABEL[cause]}）: ${reason}`);
  emit(ctx, { type: 'complaint', targetId: c.seatId ?? undefined, text: reason });
}

/** このバージョンより前のセーブで、クレームの中身がない客（提供後の品質のクレームとして扱う。読むだけ） */
function complaintOf(c: Customer): CustomerComplaint {
  return c.complaint ?? { id: `cp-${c.id}`, cause: 'quality', served: true, text: c.complaintReason ?? '', tried: [] };
}

function complainer(s: GameState, seat: Seat): Customer | null {
  const c = s.customers.find((x) => x.id === seat.customerId);
  return c && c.state === 'complaint' ? c : null;
}

/** 対応の名前と所要時間、できない理由（できるなら reason = null）。状態は変えない */
export function planComplaintResponse(s: GameState, a: Actor, seat: Seat, resp: ComplaintResponse): { reason: string | null; label: string; time: number } {
  const c = complainer(s, seat);
  let label: string = COMPLAINT_RESPONSE_LABEL[resp];
  if (!c) return { reason: 'クレームはありません', label, time: 0 };
  const cp = complaintOf(c);
  let time: number = C.time[resp];
  if (resp === 'apologize' && cp.cause === 'dirty') {
    label = '謝ってカウンターを拭く';
    time = BALANCE.cleaning.wipeTime;
  }
  if (cp.tried.includes(resp)) return { reason: 'さっき受け入れてもらえませんでした', label, time };
  if (resp === 'remake') {
    if (!cp.served) return { reason: 'まだ提供していません', label, time };
    if (!(a.hand.kind === 'none' || (a.hand.kind === 'dirty' && a.hand.bowlIds.length < 5))) return { reason: '手をあけてください（丼を下げます）', label, time };
  }
  if (resp === 'refund' && !cp.served) label = '食券代を払い戻す';
  return { reason: null, label, time };
}

/** 接客の上手さ（プレイヤーは 0.85） */
function serviceSkill(a: Actor): number {
  return a.kind === 'employee' ? 0.5 + 0.5 * a.profile.skills.service : 0.85;
}

/** 謝る・説明する・断るを受け入れてもらえる確率 */
export function acceptChance(s: GameState, c: Customer, cp: CustomerComplaint, resp: ComplaintResponse, svc: number): number {
  if (resp === 'remake' || resp === 'refund') return 1;
  const base = C.accept[cp.cause][resp];
  if (base <= 0) return 0;
  const busy = s.orders.filter((o) => o.status === 'waiting').length >= 3 || s.queue.length >= 3;
  const bonus = resp === 'explain' && cp.cause === 'delay' && busy ? C.explainBusyBonus : 0;
  return clamp01((base + bonus) * (0.75 + 0.5 * svc) * (1.15 - 0.3 * c.traits.complaintPropensity));
}

/** 対応を実行する（動詞の効果） */
export function respondToComplaint(s: GameState, ctx: SimCtx, seat: Seat, a: Actor, resp: ComplaintResponse): void {
  const c = complainer(s, seat);
  if (!c) return;
  const cp = (c.complaint ??= complaintOf(c));
  const o = s.orders.find((x) => x.id === c.orderId);
  const svc = serviceSkill(a);
  ensureEvents(s);
  if (resp === 'remake') {
    if (!cp.served || !o) return;
    // 提供済みの丼を下げて、同じ注文を作り直す
    const b = s.bowls.find((x) => x.id === seat.bowlId);
    if (b) {
      seat.bowlId = null;
      b.state = 'dirty';
      b.contents = null;
      b.orderId = null;
      b.loc = { at: 'hand', actorId: a.id };
      const ids = a.hand.kind === 'dirty' ? a.hand.bowlIds : [];
      a.hand = { kind: 'dirty', bowlIds: [...ids, b.id] };
    }
    // 先に計上した売上は返金扱いにして、作り直しを提供したときに改めて計上する
    cash(s, 'refund', -o.price, `作り直しのため売上取消（${seat.index + 1}番席）`, `refund:${o.id}:${o.remakes}`, true);
    recordPL(s, 'refunds', o.price);
    o.status = 'waiting';
    o.servedAt = null;
    o.quality = null;
    o.mistakes = [];
    // 売上キーは作り直し回数で区別する（sale:<注文ID>:<回数>）
    o.remakes += 1;
    s.today.remakes += 1;
    c.state = 'seated';
    c.stateTime = 0;
    c.patience = Math.max(c.patience, 60);
    c.sat.service = Math.max(c.sat.service * 0.8, svc * 0.85);
    resolved(s, ctx, c, seat, 'じゃあ作り直しでお願いします', resp);
    emit(ctx, { type: 'complaintRemake', targetId: seat.id });
    return;
  }
  if (resp === 'refund') {
    if (cp.served && o) {
      cash(s, 'refund', -o.price, `返金（${seat.index + 1}番席）`, `refund:${o.id}:${o.remakes}`, true);
      recordPL(s, 'refunds', o.price);
      o.status = 'refunded';
      c.sat.service = Math.max(c.sat.service * 0.7, svc * 0.7);
      c.sat.value = Math.max(c.sat.value, 0.8);
      resolved(s, ctx, c, seat, 'まあ、返金してくれるなら…', resp);
      leaveWithoutEating(s, c, ctx);
      emit(ctx, { type: 'complaintRefund', targetId: seat.id, value: o.price });
    } else {
      // 提供前: 売上はまだ計上していないので、注文を取り消して食券代を返すだけ（お金の記録は動かさない）
      if (o && o.status === 'waiting') o.status = 'cancelled';
      c.sat.service = Math.max(c.sat.service * 0.7, svc * 0.6);
      c.sat.value = Math.max(c.sat.value, 0.6);
      resolved(s, ctx, c, seat, COMPLAINT_REPLY.ticketBack, resp);
      s.today.lost += 1;
      leaveWithoutEating(s, c, ctx);
      emit(ctx, { type: 'complaintRefund', targetId: seat.id, value: 0 });
    }
    return;
  }
  // 謝る・説明する・断る
  const legit = cp.cause !== 'unreasonable';
  if (resp === 'refuse' && legit) {
    // 正当なクレームを突っぱねた: 怒って帰り、必ず悪い口コミを書く（返金はしない）
    c.sat.service = 0;
    c.traits.reviewPropensity = 0;
    addReview(s, c, 1, [COMPLAINT_REPLY.refusedLegit], !!c.regularId);
    resolved(s, ctx, c, seat, pick(ensureEvents(s), COMPLAINT_REPLY.rejected.refuse), resp);
    leaveAngry(s, c, ctx);
    emit(ctx, { type: 'complaintRefused', targetId: seat.id, value: 0 });
    return;
  }
  const ok = evRand(s) < acceptChance(s, c, cp, resp, svc);
  if (!ok) {
    if (resp === 'refuse') {
      // 理不尽な要求を断られて帰る。店の対応は正当なので口コミは書かない（相手にされない）。返金もしない
      c.traits.reviewPropensity = 0;
      resolved(s, ctx, c, seat, pick(ensureEvents(s), COMPLAINT_REPLY.rejected.refuse), resp);
      leaveAngry(s, c, ctx);
      emit(ctx, { type: 'complaintRefused', targetId: seat.id, value: 1 });
      return;
    }
    cp.tried.push(resp);
    c.sat.service *= 0.85;
    sayFor(c, s, pick(ensureEvents(s), COMPLAINT_REPLY.rejected[resp]), 4);
    emit(ctx, { type: 'complaintRejected', targetId: seat.id, text: resp });
    return;
  }
  // 受け入れてもらえた
  if (legit) {
    if (resp === 'apologize') c.sat.service = Math.max(c.sat.service, 0.45 + 0.25 * svc);
    else c.sat.service = Math.max(c.sat.service * 0.9, 0.35);
  }
  if (cp.cause === 'dirty' && resp === 'apologize') {
    seat.dirt = 0;
    c.sat.cleanliness = Math.max(c.sat.cleanliness, 0.75);
  }
  if (cp.served) {
    c.state = 'eating';
  } else {
    c.state = 'seated';
    c.patience += resp === 'apologize' ? C.patienceBack : C.patienceBack * 0.75;
  }
  c.stateTime = 0;
  resolved(s, ctx, c, seat, pick(ensureEvents(s), COMPLAINT_REPLY.accepted[resp]), resp);
}

/** クレームが終わった（受け入れた・帰った） */
function resolved(s: GameState, ctx: SimCtx, c: Customer, seat: Seat, reply: string, resp: ComplaintResponse): void {
  c.complaint = null;
  c.complaintReason = null;
  sayFor(c, s, reply, 3);
  clearNotice(s, `complaint:${seat.id}`);
  emit(ctx, { type: 'complaintResolved', targetId: seat.id, text: resp });
}

/** 従業員が選ぶ対応（原因に合わせ、だめだった対応は避ける） */
export function complaintVerbFor(c: Customer): string {
  const cp = complaintOf(c);
  const order: ComplaintResponse[] =
    cp.cause === 'unreasonable' ? ['explain', 'refuse'] : !cp.served ? ['apologize', 'explain', 'refund'] : ['remake', 'refund'];
  const r = order.find((x) => !cp.tried.includes(x)) ?? 'refund';
  return `complaint_${r}`;
}

export const COMPLAINT_RESPONSES: readonly ComplaintResponse[] = ['apologize', 'remake', 'refund', 'explain', 'refuse'];
