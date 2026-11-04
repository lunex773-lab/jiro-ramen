import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BALANCE,
  COMMUTE_LINES,
  EQUIPMENT,
  nextDay,
  rollCall,
  SEC_PER_MIN,
  stageOf,
  step,
  weekdayOf,
  type Employee,
  type GameState,
  type ShiftDay,
  type SimCtx,
} from '../src';
import { addBot, addSoloBot, newGame, run, runDay } from './helpers';

/** 仕込みの始まり（全員の出勤確認）から、出退勤の様子を記録しながら進める */
function watch(s: GameState, ctx: SimCtx, seconds: number, dt = 0.1) {
  const log = new Map<string, { pos: { x: number; z: number }; phase: string | null; say: string | null; task: string | null; present: boolean }[]>();
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    step(s, dt, ctx);
    for (const e of s.employees) {
      const arr = log.get(e.id) ?? [];
      arr.push({ pos: { ...e.pos }, phase: e.commute?.phase ?? null, say: e.say && e.say.until > s.t ? e.say.text : null, task: e.ai.taskId, present: e.presentToday });
      log.set(e.id, arr);
    }
  }
  return log;
}

function day2WithStaff(seed: number, n: number): { s: GameState; ctx: SimCtx; staff: Employee[] } {
  const { s, ctx } = newGame(seed);
  const staff = Array.from({ length: n }, (_, i) => addBot(s, i % 2 === 0 ? 'cook' : 'server'));
  // 1人はアルバイト（社員も含めて全員が歩いて来る）
  staff[0]!.profile.employment = 'part';
  addSoloBot(s);
  applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
  expect(nextDay(s, ctx).ok).toBe(true);
  return { s, ctx, staff };
}

describe('出退勤の動き（歩いて入店 → あいさつ → 手洗い → 仕事 /「お疲れ様でした」→ 歩いて退店）', () => {
  it('仕込みの始まりに、社員もアルバイトも全員が店の外から入口を通って歩いて来て、あいさつし、手を洗ってから仕事を始める', () => {
    const { s, ctx, staff } = day2WithStaff(3, 3);
    expect(s.phase).toBe('prep');
    for (const e of staff) {
      expect(e.presentToday).toBe(true);
      expect(e.commute?.kind).toBe('arrive');
      expect(e.pos.z).toBeLessThan(0);
    }
    const log = watch(s, ctx, 40);
    const st = stageOf(s);
    for (const e of staff) {
      const l = log.get(e.id)!;
      // 入口（正面の壁の開口）を通って店に入る
      const cross = l.findIndex((x, i) => i > 0 && l[i - 1]!.pos.z < 0 && x.pos.z >= 0);
      expect(cross).toBeGreaterThan(0);
      const xAt = l[cross]!.pos.x;
      expect(xAt).toBeGreaterThanOrEqual(st.door.x0 - 0.1);
      expect(xAt).toBeLessThanOrEqual(st.door.x1 + 0.1);
      // あいさつ →（洗い場へ）→ 手洗い → 仕事 の順
      const greet = l.findIndex((x) => x.say && COMMUTE_LINES.arrive.includes(x.say));
      const wash = l.findIndex((x) => x.phase === 'wash');
      const done = l.findIndex((x, i) => i > wash && x.phase === null);
      expect(greet).toBeGreaterThan(cross);
      expect(wash).toBeGreaterThan(greet);
      expect(done).toBeGreaterThan(wash);
      // 手洗いは決まった秒数
      const washSteps = l.filter((x) => x.phase === 'wash').length;
      expect(washSteps * 0.1).toBeGreaterThanOrEqual(BALANCE.commute.washSec - 0.2);
      // 手洗いは洗い場で
      const sink = s.equipment.find((q) => q.placed && EQUIPMENT[q.type]?.role === 'sink');
      if (sink) {
        const p = l[wash]!.pos;
        expect(Math.hypot(p.x - (sink.gx * 0.5), p.z - (sink.gz * 0.5))).toBeLessThan(3);
      }
      // 出退勤の途中は仕事をしない
      expect(l.slice(0, done).every((x) => x.task === null)).toBe(true);
      expect(e.commute).toBeNull();
    }
    // 何人も同時に来るときは、少しずつずれて着く（いっせいに着かない）
    const arrivals = staff.map((e) => log.get(e.id)!.findIndex((x) => x.say && COMMUTE_LINES.arrive.includes(x.say)));
    expect(new Set(arrivals).size).toBe(arrivals.length);
  });

  it('シフトの退勤の時刻になると「お疲れ様でした」と言って歩いて店の外へ出て、姿が消える。休憩も外へ出て、戻ると手を洗う', () => {
    const { s, ctx, staff } = day2WithStaff(4, 1);
    const e = staff[0]!;
    // 今日は 12:00〜14:00、13:00 から 30 分休憩
    const sh: ShiftDay = { start: 60, end: 180, breakAt: 120, breakLen: 30, fromPrep: false };
    expect(applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday: weekdayOf(s.day), shift: sh }, ctx).ok).toBe(true);
    s.phase = 'prep';
    rollCall(s, ctx);
    expect(e.presentToday).toBe(false);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    const said: string[] = [];
    let sawOutside = false;
    let washesAfterBreak = 0;
    let inBreak = false;
    while (s.openT < 186 * SEC_PER_MIN && (s.phase as string) === 'open') {
      step(s, 0.1, ctx);
      const t = e.say && e.say.until > s.t ? e.say.text : null;
      if (t && said[said.length - 1] !== t) said.push(t);
      const min = s.openT / SEC_PER_MIN;
      if (min > 126 && min < 149) inBreak ||= e.presentToday;
      if (min > 150 && e.commute?.phase === 'wash') washesAfterBreak += 1;
      if (min > 180 && e.presentToday && e.pos.z < 0) sawOutside = true;
    }
    expect(said.some((x) => COMMUTE_LINES.arrive.includes(x))).toBe(true);
    expect(said.some((x) => COMMUTE_LINES.break.includes(x))).toBe(true);
    expect(said.some((x) => COMMUTE_LINES.return.includes(x))).toBe(true);
    expect(said.some((x) => COMMUTE_LINES.leave.includes(x))).toBe(true);
    // 休憩中は店にいない、戻ったら手を洗う
    expect(inBreak).toBe(false);
    expect(washesAfterBreak).toBeGreaterThan(0);
    // 歩いて店の外へ出てから消える
    expect(sawOutside).toBe(true);
    expect(e.presentToday).toBe(false);
    expect(e.att!.status).toBe('left');
  });

  it('閉店してお客さんがいなくなると、残っている全員が「お疲れ様でした」と言って歩いて帰り、全員が出てから精算する', () => {
    const { s, ctx, staff } = day2WithStaff(5, 2);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    const said = new Map<string, string[]>();
    let closingSeen = false;
    let presentAtSettle = -1;
    for (let i = 0; i < 30000 && s.phase !== 'closed'; i++) {
      const before = s.phase;
      step(s, 0.1, ctx);
      if (s.phase === 'closing') closingSeen = true;
      for (const e of staff) {
        if (e.say && e.say.until > s.t) {
          const arr = said.get(e.id) ?? [];
          if (arr[arr.length - 1] !== e.say.text) arr.push(e.say.text);
          said.set(e.id, arr);
        }
      }
      if (before === 'closing' && (s.phase as string) === 'closed') presentAtSettle = staff.filter((e) => e.presentToday).length;
    }
    expect(closingSeen).toBe(true);
    expect(s.phase).toBe('closed');
    expect(presentAtSettle).toBe(0);
    for (const e of staff) expect((said.get(e.id) ?? []).some((x) => COMMUTE_LINES.leave.includes(x))).toBe(true);
  });

  it('洗い場がなくても手洗いはその場ですませて働き始める（止まらない）。出退勤は乱数を使わない（同じ種なら同じ）', () => {
    const run2 = () => {
      const { s, ctx, staff } = day2WithStaff(6, 2);
      for (const q of s.equipment) if (EQUIPMENT[q.type]?.role === 'sink') q.placed = false;
      run(s, ctx, 40);
      return { s, staff };
    };
    const a = run2();
    for (const e of a.staff) expect(e.commute).toBeNull();
    const b = run2();
    expect(b.s.rng).toBe(a.s.rng);
    expect(b.staff.map((e) => e.pos)).toEqual(a.staff.map((e) => e.pos));
  });
});
