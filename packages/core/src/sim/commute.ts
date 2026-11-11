// 出退勤の動き（オーナーの指示）: 店の外から歩いて入店し、キッチンに「おはようございます！」とあいさつして手を洗ってから働き始める。
// 退勤は「お疲れ様でした！」と言って歩いて店の外へ帰る。休憩も「休憩いただきます！」で外へ出て「戻りました！」で戻り、手を洗う。
// 社員も含めて全員（オーナー回答）。出退勤の途中は仕事をしない（手洗いの分、働き始めが少し遅れる）。
// 給与はシフトの時刻で数える（staff.ts。歩いている間・手洗いの間も勤務の時間）。
// 乱数は使わない（あいさつの言葉は人と日で決める）ので、ゲームの乱数の並びは変わらない。

import { BALANCE } from '../data/balance';
import { EQUIPMENT } from '../data/equipment';
import { equipmentCenter, stageOf } from '../geometry';
import type { CommuteKind, Employee, GameState, Vec2 } from '../types';
import { dist, hashString } from '../util';
import { resolveTarget, targetPoints } from './interact';
import type { SimCtx } from './notices';
import { moveAlong, staffRoute, walkSpeed } from './walk';

const C = BALANCE.commute;

export const COMMUTE_LINES: Record<'arrive' | 'return' | 'leave' | 'break', readonly string[]> = {
  arrive: ['おはようございます！', 'おはようございます！よろしくお願いします！', 'おはようございまーす！'],
  return: ['戻りました！', '休憩ありがとうございました！'],
  leave: ['お疲れ様でした！', 'お先に失礼します、お疲れ様でした！', 'お疲れ様でしたー！'],
  break: ['休憩いただきます！', '休憩入ります！'],
};

const NOTE: Record<CommuteKind, string> = {
  arrive: '出勤中',
  return: '休憩から戻るところ',
  back: '持ち場に戻るところ',
  leave: '退勤中',
  break: '休憩に入るところ',
  away: '持ち場を離れている',
  injured: 'けがをして店の外へ逃げている',
};

/** 歩いて来る・帰っていく店の外の場所（order 番目の人ほど遠く） */
export function streetPoint(order = 0): Vec2 {
  return { x: C.streetX - order * C.stagger, z: C.streetZ };
}

/** あいさつする場所（従業員の出入口の近く。厨房の入口） */
function greetPoint(s: GameState): Vec2 {
  const st = stageOf(s);
  return { x: st.staffSpawn.x, z: st.staffSpawn.z };
}

function lineFor(s: GameState, e: Employee, kind: keyof typeof COMMUTE_LINES): string {
  const list = COMMUTE_LINES[kind];
  return list[hashString(`${e.id}:${s.day}:${kind}`) % list.length]!;
}

function say(s: GameState, e: Employee, text: string): void {
  e.say = { text, until: s.t + Math.max(2.4, [...text].length * 0.16), kind: 'greet' };
}

function resetAi(e: Employee): void {
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
  e.ai.stuckTime = 0;
  e.ai.cooldown = 0;
}

/** 出退勤の途中（仕事をしない） */
export function commuting(e: Employee): boolean {
  return !!e.commute;
}

/**
 * 店に入る（出勤・休憩から戻る・持ち場に戻る）。店の外にいる人は歩道から歩いて来る（order 番目の人ほど遠くから）。
 * 店の中にいる人（出ていく途中で戻ることになった人）はその場から
 */
export function startArrive(s: GameState, e: Employee, kind: 'arrive' | 'return' | 'back', order = 0): void {
  if (!e.presentToday) e.pos = streetPoint(order);
  e.presentToday = true;
  resetAi(e);
  e.hand = e.hand.kind === 'none' ? e.hand : { kind: 'none' };
  e.work = null;
  e.commute = { kind, phase: 'walkIn', t: 0, since: s.t };
  e.ai.state = 'moving';
  e.ai.note = NOTE[kind];
}

/** 店を出る（退勤・休憩・持ち場を離れる）。手ぶらで、作業の途中でないこと（呼び出し側が確かめる） */
export function startLeave(s: GameState, e: Employee, kind: 'leave' | 'break' | 'away' | 'injured'): void {
  resetAi(e);
  // 持ち場を離れる・けがをして逃げるときは、あいさつせずにすぐ歩き出す
  if (kind === 'away' || kind === 'injured') {
    e.commute = { kind, phase: 'walkOut', t: 0, since: s.t };
    e.ai.state = 'moving';
  } else {
    e.commute = { kind, phase: 'greet', t: C.greetSec, since: s.t };
    e.ai.state = 'idle';
    say(s, e, lineFor(s, e, kind));
  }
  e.ai.note = NOTE[kind];
}

/** 店の外まで出たとき（姿を消す） */
function gone(e: Employee): void {
  const kind = e.commute?.kind;
  e.commute = null;
  e.presentToday = false;
  e.ai.path = [];
  e.ai.state = kind === 'break' ? 'break' : kind === 'away' ? 'slacking' : 'off';
  if (kind !== 'away') e.ai.note = '';
}

/** 働き始める */
function ready(e: Employee): void {
  e.commute = null;
  e.ai.state = 'idle';
  e.ai.note = '';
  e.ai.cooldown = 0;
  e.ai.path = [];
}

/** 近くの洗い場で手を洗う位置（なければ null） */
function sinkPoint(s: GameState, e: Employee): { at: Vec2; face: Vec2; path: Vec2[] } | null {
  let best: { at: Vec2; face: Vec2; path: Vec2[]; cost: number } | null = null;
  for (const q of s.equipment) {
    if (!q.placed || EQUIPMENT[q.type]?.role !== 'sink') continue;
    const t = resolveTarget(s, q.id);
    if (!t) continue;
    for (const p of targetPoints(s, t)) {
      const r = staffRoute(s, e.pos, p);
      if (r && (!best || r.cost < best.cost)) best = { at: p, face: equipmentCenter(q), path: r.points, cost: r.cost };
    }
  }
  return best;
}

/** 毎ステップ（updateEmployees から。出退勤の途中の人だけ） */
export function updateCommute(s: GameState, e: Employee, dt: number, _ctx: SimCtx): void {
  const c = e.commute;
  if (!c) return;
  // 詰まったとき（レイアウトで通れないなど）は打ち切る
  if (s.t - c.since > C.giveUpSec) {
    if (c.kind === 'leave' || c.kind === 'break' || c.kind === 'away' || c.kind === 'injured') gone(e);
    else {
      const g = greetPoint(s);
      e.pos = { x: g.x, z: g.z };
      ready(e);
    }
    return;
  }
  switch (c.phase) {
    case 'walkIn': {
      const g = greetPoint(s);
      if (e.ai.path.length === 0 && dist(e.pos, g) > 0.05) {
        const r = staffRoute(s, e.pos, g);
        e.ai.path = r ? r.points : [g];
      }
      e.ai.state = 'moving';
      if (moveAlong(e, dt, walkSpeed(s, e)) || dist(e.pos, g) <= 0.05) {
        e.ai.path = [];
        // 厨房の方（右）を向いてあいさつ
        e.yaw = Math.PI / 2;
        if (c.kind === 'back') {
          c.phase = 'toSink';
        } else {
          c.phase = 'greet';
          c.t = C.greetSec;
          say(s, e, lineFor(s, e, c.kind === 'return' ? 'return' : 'arrive'));
        }
      }
      return;
    }
    case 'greet': {
      e.ai.state = 'idle';
      c.t -= dt;
      if (c.t > 0) return;
      c.phase = c.kind === 'leave' || c.kind === 'break' || c.kind === 'away' || c.kind === 'injured' ? 'walkOut' : 'toSink';
      return;
    }
    case 'toSink': {
      if (e.ai.path.length === 0) {
        const sp = sinkPoint(s, e);
        if (!sp || sp.path.length === 0 || dist(e.pos, sp.at) < 0.05) {
          c.phase = 'wash';
          c.t = C.washSec;
          if (sp) e.yaw = Math.atan2(sp.face.x - e.pos.x, sp.face.z - e.pos.z);
          return;
        }
        e.ai.path = sp.path;
      }
      e.ai.state = 'moving';
      e.ai.note = '手を洗いに行く';
      if (moveAlong(e, dt, walkSpeed(s, e))) {
        const sp = sinkPoint(s, e);
        if (sp) e.yaw = Math.atan2(sp.face.x - e.pos.x, sp.face.z - e.pos.z);
        c.phase = 'wash';
        c.t = C.washSec;
      }
      return;
    }
    case 'wash': {
      e.ai.state = 'working';
      e.ai.note = '手を洗っている';
      c.t -= dt;
      if (c.t <= 0) ready(e);
      return;
    }
    case 'walkOut': {
      const out = streetPoint(0);
      if (e.ai.path.length === 0) {
        const r = staffRoute(s, e.pos, out);
        e.ai.path = r ? r.points : [out];
      }
      e.ai.state = 'moving';
      // けがをした人は急いで逃げる
      if (moveAlong(e, dt, walkSpeed(s, e) * (c.kind === 'injured' ? 1.5 : 1))) gone(e);
      return;
    }
  }
}
