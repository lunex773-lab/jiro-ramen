// 通知（設計書 19.3）。同じコードの通知は重複させず最新に置き換える。

import type { GameEvent, GameState, NoticeLevel } from '../types';
import { newId } from '../util';

export interface SimCtx {
  events: GameEvent[];
}

export function makeCtx(): SimCtx {
  return { events: [] };
}

export function emit(ctx: SimCtx, ev: GameEvent): void {
  ctx.events.push(ev);
  if (ctx.events.length > 500) ctx.events.splice(0, ctx.events.length - 500);
}

const MAX_NOTICES = 30;

export function notify(s: GameState, ctx: SimCtx, code: string, level: NoticeLevel, text: string): void {
  const existing = s.notices.findIndex((n) => n.code === code);
  if (existing >= 0) {
    const n = s.notices[existing]!;
    // 同じ文面の連続通知は時刻だけ更新しない（通知の連打を防ぐ）
    if (n.text === text) return;
    s.notices.splice(existing, 1);
  }
  s.notices.push({ id: newId(s, 'n'), code, level, text, t: s.t, day: s.day });
  if (s.notices.length > MAX_NOTICES) s.notices.splice(0, s.notices.length - MAX_NOTICES);
  emit(ctx, { type: 'notice', text, value: level === 'danger' ? 2 : level === 'warn' ? 1 : 0 });
}

export function clearNotice(s: GameState, code: string): void {
  const i = s.notices.findIndex((n) => n.code === code);
  if (i >= 0) s.notices.splice(i, 1);
}
