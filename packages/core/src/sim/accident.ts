// 爆発事故（設計書 E）と、事故当日の仕込み開始時点へのリセット。
//
// 営業日・抽選の定義:
//   - 1営業日 = nextDay で仕込み（prep）が始まってから、閉店の精算まで
//   - 抽選は「開店の操作（openShop）の中で1日1回だけ」。抽選した日を events.accidentDrawDay に記録し、同じ日に二度抽選しない。
//     開店のあとに保存して読み直しても、開店の操作は二度と行われないので再抽選しない
//   - 当たったら、その日の営業中の時刻を決めて予約する（accidentPlan）
//
// 仕込み開始時点の控え（prepSnapshot）:
//   - nextDay で仕込みが始まる瞬間と、新しいキャリアの1日目に作る。それ以外（事故のあとの探索中を含む）では作らない
//   - 状態の中に持つので、ローカル・クラウド・ルームのどの保存にも状態と一緒に入る
//   - 控えがない日（このバージョンより前のセーブを途中から続けた日）は抽選しない
//
// 復元（resetAccident）は控えの値で丸ごと置き換える（足し引きしない）ので、二重に実行しても経済の値は変わらない。
// 事故が起きているときだけ受け付け、復元すると事故の記録が消えるので、2回目の要求は何もせずに失敗する。

import { BALANCE } from '../data/balance';
import { STAGES } from '../data/stages';
import { equipmentCenter } from '../geometry';
import type { GameState, Id, ShopEvents } from '../types';
import { newId, randRange } from '../util';
import { defOf } from './equipment';
import { ensureEvents, evRand, noteDraw, noteFire, takeForced } from './events';
import { dropHand } from './interact';
import { emit, notify, type SimCtx } from './notices';

const X = BALANCE.events.explosion;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ───────────────────────── 仕込み開始時点の控え ─────────────────────────

/** その日の仕込み開始時点の控えを作る（nextDay と新規キャリアの1日目からだけ呼ぶ） */
export function takePrepSnapshot(s: GameState): void {
  const { prepSnapshot: _snap, history: _history, reviews: _reviews, players: _players, ...rest } = s;
  s.prepSnapshot = { day: s.day, state: clone(rest) };
}

/** 今日の控えがあるか */
export function hasPrepSnapshot(s: GameState): boolean {
  return !!s.prepSnapshot && s.prepSnapshot.day === s.day && typeof s.prepSnapshot.state === 'object' && s.prepSnapshot.state !== null;
}

// ───────────────────────── 抽選と発生 ─────────────────────────

/** 爆発事故を抽選できる日か（理由を返す。できるなら null） */
function accidentBlocked(s: GameState): string | null {
  if (s.tutorial) return 'チュートリアル中は起きません';
  if (s.day < X.minDay) return `${X.minDay}日目から起きます`;
  if (!hasPrepSnapshot(s)) return '今日の仕込み開始時点の記録がないため起きません（次の営業日から）';
  return null;
}

/** 開店の操作の中で1日1回だけ呼ぶ */
export function drawAccident(s: GameState): void {
  const ev = ensureEvents(s);
  if (ev.accidentDrawDay === s.day) return;
  ev.accidentDrawDay = s.day;
  ev.accidentPlan = null;
  if (accidentBlocked(s)) return;
  const forced = takeForced(s, 'explosion');
  if (!forced) {
    noteDraw(s, 'explosion');
    if (evRand(s) >= X.chancePerDay) return;
  }
  ev.accidentPlan = { id: newId(s, 'ev'), day: s.day, atOpenT: forced ? 3 : randRange(ev, X.atFrom, X.atTo) * BALANCE.openDuration };
  if (forced) ev.forced.push('explosion'); // 発生したときに「強制」として記録する
}

/** テスト用の強制発生（営業中ならすぐに予兆、仕込み中なら開店の3秒後） */
export function forceAccident(s: GameState, ctx: SimCtx): { ok: boolean; reason?: string } {
  const blocked = accidentBlocked(s);
  if (blocked) return { ok: false, reason: blocked };
  const ev = ensureEvents(s);
  if (ev.accident) return { ok: false, reason: 'すでに事故が起きています' };
  if (s.phase === 'open') {
    ev.accidentPlan = { id: newId(s, 'ev'), day: s.day, atOpenT: s.openT };
    ev.forced.push('explosion');
    startWarning(s, ctx, ev);
    return { ok: true };
  }
  if (s.phase === 'prep') {
    if (!ev.forced.includes('explosion')) ev.forced.push('explosion');
    // 今日の抽選を済ませていれば、予約を直接入れる
    if (ev.accidentDrawDay === s.day) ev.accidentPlan = { id: newId(s, 'ev'), day: s.day, atOpenT: 3 };
    return { ok: true };
  }
  return { ok: false, reason: '仕込み中か営業中に起こせます' };
}

/** 異常を起こす設備（寸胴 → 麺釜 → 何でも） */
function accidentSource(s: GameState): { id: Id | null; pos: { x: number; z: number } } {
  const placed = s.equipment.filter((e) => e.placed && defOf(e).w > 0);
  const e = placed.find((x) => defOf(x).role === 'soup') ?? placed.find((x) => defOf(x).role === 'boiler') ?? placed[0];
  if (!e) {
    const st = STAGES[s.career.stage]!;
    return { id: null, pos: { x: st.playerSpawn.x, z: st.playerSpawn.z } };
  }
  return { id: e.id, pos: equipmentCenter(e) };
}

function startWarning(s: GameState, ctx: SimCtx, ev: ShopEvents): void {
  const plan = ev.accidentPlan;
  if (!plan) return;
  const src = accidentSource(s);
  ev.accident = { id: plan.id, day: s.day, stage: 'warning', t: 0, sourceId: src.id, pos: src.pos };
  ev.accidentPlan = null;
  noteFire(s, 'explosion', takeForced(s, 'explosion'));
  notify(s, ctx, 'accident', 'danger', '⚠ ガスのにおいがする…寸胴の様子がおかしい！');
  emit(ctx, { type: 'accidentWarning', targetId: src.id ?? undefined, pos: src.pos });
}

/** 爆発。店は壊滅し、店員と客は動かなくなり、プレイヤーは気を失う。営業処理はここで止まる */
function blast(s: GameState, ctx: SimCtx, ev: ShopEvents): void {
  const acc = ev.accident!;
  acc.stage = 'destroyed';
  acc.t = 0;
  for (const p of s.players) dropHand(s, p, ctx);
  for (const e of s.employees) {
    dropHand(s, e, ctx);
    e.ai.steps = [];
    e.ai.taskId = null;
    e.ai.path = [];
  }
  ev.buzz = null;
  notify(s, ctx, 'accident', 'danger', '店が爆発した');
  emit(ctx, { type: 'explosion', targetId: acc.sourceId ?? undefined, pos: acc.pos });
}

/** step から（営業処理の前）: 予約の時刻になったら予兆を始め、予兆が終わったら爆発させる */
export function updateAccident(s: GameState, dt: number, ctx: SimCtx): void {
  const ev = s.events;
  if (!ev) return;
  if (ev.accidentPlan && !ev.accident && s.phase === 'open' && ev.accidentPlan.day === s.day && s.openT >= ev.accidentPlan.atOpenT) startWarning(s, ctx, ev);
  const acc = ev.accident;
  if (acc?.stage === 'warning') {
    acc.t += dt;
    if (acc.t >= X.warningSec) blast(s, ctx, ev);
  }
}

/** 壊滅している間の step: 事故の経過時間だけを進める（売上・客・従業員・在庫は変えない） */
export function stepHalted(s: GameState, dt: number): void {
  const acc = s.events?.accident;
  if (acc) acc.t = Math.min(acc.t + dt, 1e6);
}

/** 気を失っている（爆発から faintSec 秒まで） */
export function accidentFainted(s: GameState): boolean {
  const acc = s.events?.accident;
  return !!acc && acc.stage === 'destroyed' && acc.t < X.faintSec;
}

// ───────────────────────── リセット ─────────────────────────

/**
 * 事故当日の仕込み開始時点に戻す。
 * 戻すもの: 店・設備・在庫・客と注文・当日の売上と支出・従業員・当日のイベント・時刻と営業日の進行（控えの中身）
 * 戻さないもの: 前日までの日報・口コミ（控えと同じ）、プレイヤーの顔ぶれ、ID の連番、乱数、イベントの発生記録、状態の版番号
 */
export function resetAccident(s: GameState, actorId: Id, accidentId: unknown, ctx: SimCtx): { ok: boolean; reason?: string } {
  const ev = s.events;
  const acc = ev?.accident;
  if (!ev || !acc) return { ok: false, reason: 'リセットする事故はありません' };
  if (typeof accidentId === 'string' && accidentId !== acc.id) return { ok: false, reason: 'この事故はすでにリセットされています' };
  if (acc.stage !== 'destroyed') return { ok: false, reason: 'まだ爆発していません' };
  if (acc.t < X.faintSec) return { ok: false, reason: 'まだ意識が戻っていません' };
  const actor = s.players.find((p) => p.id === actorId);
  const snap = s.prepSnapshot;
  if (!snap || snap.day !== acc.day || snap.day !== s.day || typeof snap.state !== 'object' || snap.state === null) {
    // 控えがない（起きないはずだが、進めなくならないように）: 事故を消して営業を続ける
    ev.accident = null;
    notify(s, ctx, 'accident', 'warn', '仕込み開始時点の記録が見つからないため、事故の前には戻せませんでした');
    emit(ctx, { type: 'accidentReset', actorId });
    return { ok: true };
  }
  const keep = {
    players: s.players,
    history: s.history,
    reviews: s.reviews,
    prepSnapshot: snap,
    version: s.version,
    nextId: Math.max(s.nextId, snap.state.nextId),
    rng: s.rng,
    paused: s.paused,
  };
  const kept = { rng: ev.rng, stats: ev.stats, resets: ev.resets + 1 };
  const restored = clone(snap.state) as Partial<GameState>;
  for (const k of Object.keys(s) as (keyof GameState)[]) {
    if (!(k in restored) && !(k in keep)) delete (s as unknown as Record<string, unknown>)[k];
  }
  Object.assign(s, restored, keep);
  const nev = ensureEvents(s);
  nev.rng = kept.rng;
  nev.stats = kept.stats;
  nev.resets = kept.resets;
  // 同じ日に二度抽選しない（控えは抽選の前の状態なので、ここで記録し直す）
  nev.accidentDrawDay = s.day;
  nev.accidentPlan = null;
  nev.accident = null;
  // プレイヤーは今の顔ぶれのまま、仕込みの開始時と同じ位置・手ぶらに戻す
  const st = STAGES[s.career.stage]!;
  s.players.forEach((p, i) => {
    p.pos = { x: st.playerSpawn.x + i * 0.6, z: st.playerSpawn.z };
    p.yaw = Math.PI;
    p.hand = { kind: 'none' };
    p.work = null;
  });
  for (const b of s.bowls) {
    if (b.loc.at === 'hand' && s.players.some((p) => b.loc.at === 'hand' && p.id === b.loc.actorId)) {
      b.loc = { at: 'rack' };
      b.state = 'clean';
      b.contents = null;
      b.orderId = null;
    }
  }
  const who = actor && s.players.length > 1 ? `${actor.name}さんが` : '';
  notify(s, ctx, 'accident', 'info', `${who}リセットしました。${s.day}日目の仕込みの開始時点に戻りました`);
  emit(ctx, { type: 'accidentReset', actorId, text: actor?.name });
  return { ok: true };
}

