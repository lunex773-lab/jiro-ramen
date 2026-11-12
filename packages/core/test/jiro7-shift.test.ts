// じろ7 Phase 2: 当日のシフト変更で退勤扱いになる不具合の修正・社員の単日出勤・店長代理の任命（設計書 2-5・3-5）
import { describe, expect, it } from 'vitest';
import {
  activeDeputy,
  actingManager,
  appointDeputy,
  applyAction,
  attendanceText,
  authorityOf,
  canOperate,
  initNewHire,
  isHostOnly,
  makeEmployee,
  migrate,
  noteManagerAbsence,
  payDue,
  roleOn,
  rollCall,
  SEC_PER_MIN,
  shiftFor,
  STAFF_OPERATIONS,
  step,
  validateState,
  weekdayOf,
  type Employee,
  type GameState,
  type ShiftDay,
  type SimCtx,
} from '../src';
import { activeStore } from '../src/sim/company';
import { storeLead } from '../src/sim/manager';
import { addBot, newGame } from './helpers';

/** アルバイト（遅刻・欠勤しない） */
function partTimer(s: GameState, name: string, role: 'cook' | 'server' | 'cleaner' = 'server'): Employee {
  const e = makeEmployee(s, {
    id: 'cand-x',
    profile: { name, role, skills: { speed: 0.5, cooking: 0.5, service: 0.5, hygiene: 0.5, movement: 0.5 }, wage: 9000, hireFee: 0, experience: 0, diligence: 1, patience: 1 },
  });
  initNewHire(e);
  s.employees.push(e);
  return e;
}
const sh = (start: number, end: number, fromPrep = false): ShiftDay => ({ start, end, breakAt: 0, breakLen: 0, fromPrep });
const once = (s: GameState, ctx: SimCtx, id: string, days: number[], v: ShiftDay | null) => applyAction(s, 'p1', { type: 'setDateShift', employeeId: id, days, shift: v, mode: 'once' }, ctx);
function run(s: GameState, ctx: SimCtx, sec: number) {
  for (let t = 0; t < sec; t += 0.1) step(s, 0.1, ctx);
}
/** 遅刻・欠勤の抽選をしない日の朝（仕込みの時間）にする */
function morning(s: GameState, ctx: SimCtx) {
  delete (s as { tutorial?: unknown }).tutorial;
  s.phase = 'prep';
  s.t = 0;
  s.openT = 0;
  rollCall(s, ctx);
}
const open = (s: GameState, ctx: SimCtx) => expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);

describe('当日のシフト変更で、出勤している人が退勤扱いにならない（じろ7 3）', () => {
  it('B1: 仕込みの時間に今日の予定を一度休みにしてから入れ直すと、退勤のままにならず出勤する', () => {
    const { s, ctx } = newGame(71);
    const a = partTimer(s, 'A');
    once(s, ctx, a.id, [s.day], sh(0, 240, true));
    morning(s, ctx);
    run(s, ctx, 15);
    expect(a.att!.status).toBe('working');
    once(s, ctx, a.id, [s.day], null);
    run(s, ctx, 15);
    expect(a.att!.status).toBe('left');
    once(s, ctx, a.id, [s.day], sh(0, 240, true));
    expect(a.att!.status).toBe('working');
    run(s, ctx, 20);
    expect(a.presentToday).toBe(true);
    open(s, ctx);
    run(s, ctx, 30);
    expect(a.att!.status).toBe('working');
    expect(a.presentToday).toBe(true);
    // 仕込みで働いた実績は残る
    expect(a.att!.prepWorked).toBe(true);
  });

  it('社員の休みの曜日を付けて外しても、退勤のまま来なくなることはない', () => {
    const { s, ctx } = newGame(72);
    const m = addBot(s, 'cook', 0.7, 7000);
    morning(s, ctx);
    run(s, ctx, 15);
    expect(m.att!.status).toBe('working');
    const wd = weekdayOf(s.day);
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: m.id, days: [wd] }, ctx).ok).toBe(true);
    run(s, ctx, 15);
    expect(m.att!.status).toBe('left');
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: m.id, days: [] }, ctx).ok).toBe(true);
    expect(m.att!.status).toBe('working');
    open(s, ctx);
    run(s, ctx, 20);
    expect(m.presentToday).toBe(true);
  });

  it('出勤済みの人がいるときに、別の人のシフトを追加・削除しても、出勤済みの人はそのまま働く', () => {
    const { s, ctx } = newGame(73);
    const a = partTimer(s, 'A');
    const b = partTimer(s, 'B');
    once(s, ctx, a.id, [s.day], sh(0, 240));
    once(s, ctx, b.id, [s.day], null);
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 40);
    expect(a.att!.status).toBe('working');
    // 営業中にシフトを追加（休みの人を呼び出す）
    once(s, ctx, b.id, [s.day], sh(60, 240));
    expect(b.att!.calledIn).toBe(true);
    run(s, ctx, 20);
    expect(a.att!.status).toBe('working');
    // 営業中にシフトを削除
    once(s, ctx, b.id, [s.day], null);
    run(s, ctx, 20);
    expect(a.att!.status).toBe('working');
    expect(a.presentToday).toBe(true);
  });

  it('出勤済みの人の勤務時間を変える: 延ばす・早める（まだ先）はそのまま、もう過ぎた時刻にすると上がる。働いた時間は消えない', () => {
    const { s, ctx } = newGame(74);
    const a = partTimer(s, 'A');
    once(s, ctx, a.id, [s.day], sh(0, 180));
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 60);
    const worked = a.att!.workedSec;
    expect(worked).toBeGreaterThan(30);
    once(s, ctx, a.id, [s.day], sh(0, 240));
    run(s, ctx, 5);
    expect(a.att!.status).toBe('working');
    // 出勤の時刻を今より後にずらしても、勤務を続け、働いた分も数える
    once(s, ctx, a.id, [s.day], sh(120, 240));
    run(s, ctx, 10);
    expect(a.att!.status).toBe('working');
    expect(a.att!.workedSec).toBeGreaterThan(worked);
    // 退勤を、もう過ぎた時刻にする
    const before = a.att!.workedSec;
    once(s, ctx, a.id, [s.day], sh(0, 30));
    run(s, ctx, 15);
    expect(a.att!.status).toBe('left');
    expect(a.att!.workedSec).toBeGreaterThanOrEqual(before);
    expect(a.att!.leftAt).toBeGreaterThan(0);
  });

  it('まだ来ていない人の勤務時間を変えると、新しい時刻に来る。退勤した人の退勤を延ばすと戻ってくる', () => {
    const { s, ctx } = newGame(75);
    const a = partTimer(s, 'A');
    const b = partTimer(s, 'B');
    once(s, ctx, a.id, [s.day], sh(120, 240));
    expect(once(s, ctx, b.id, [s.day], sh(0, 60)).ok).toBe(true);
    morning(s, ctx);
    open(s, ctx);
    once(s, ctx, a.id, [s.day], sh(30, 240));
    expect(a.att!.status).toBe('scheduled');
    run(s, ctx, 30 * SEC_PER_MIN + 5);
    expect(a.att!.status).toBe('working');
    // B は 60 分で上がる
    run(s, ctx, 30 * SEC_PER_MIN + 10);
    expect(b.att!.status).toBe('left');
    once(s, ctx, b.id, [s.day], sh(0, 240));
    run(s, ctx, 15);
    expect(b.att!.status).toBe('working');
    expect(b.presentToday).toBe(true);
  });

  it('閉店作業中（日付が変わる直前）に今日の予定を変えても今日の勤怠は変えず、翌日の予定は朝に使う', () => {
    const { s, ctx } = newGame(76);
    const a = partTimer(s, 'A');
    once(s, ctx, a.id, [s.day, s.day + 1], sh(0, 240));
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 30);
    s.phase = 'closing';
    const st = a.att!.status;
    once(s, ctx, a.id, [s.day], null);
    expect(a.att!.status).toBe(st);
    once(s, ctx, a.id, [s.day + 1], sh(60, 240));
    s.day += 1;
    morning(s, ctx);
    expect(a.att!.shift).toEqual(sh(60, 240));
    expect(a.att!.status).toBe('scheduled');
  });

  it('セーブして読み込んでも勤務の状態は同じ（共同経営のゲストに送る複製の表示も同じ）', () => {
    const { s, ctx } = newGame(77);
    const a = partTimer(s, 'A');
    once(s, ctx, a.id, [s.day], sh(0, 240));
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 30);
    once(s, ctx, a.id, [s.day], sh(0, 200));
    const loaded = migrate(JSON.parse(JSON.stringify(s)) as Record<string, unknown>) as unknown as GameState;
    expect(validateState(loaded)).toEqual([]);
    const la = loaded.employees.find((x) => x.id === a.id)!;
    expect(la.att).toEqual(a.att);
    expect(attendanceText(la, loaded)).toBe(attendanceText(a, s));
    run(loaded, ctx, 20);
    expect(la.att!.status).toBe('working');
  });
});

describe('くりかえしを書き換えても今日の予定は変えない（じろ7 B2・B3）', () => {
  it('営業中に「シフトを自動で組む」と、今日の予定は前のまま残り、画面の予定と実際の勤務が一致する', () => {
    const { s, ctx } = newGame(78);
    const a = partTimer(s, 'A');
    partTimer(s, 'B');
    once(s, ctx, a.id, [s.day + 1], null);
    delete a.dateShifts;
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 20);
    const planned = a.att!.shift;
    expect(applyAction(s, 'p1', { type: 'autoShifts' }, ctx).ok).toBe(true);
    // 今日は前の予定（あすから新しい予定）
    expect(shiftFor(a, s.day)).toEqual(planned);
    expect(a.att!.shift).toEqual(planned);
    expect(a.att!.status).toBe('working');
    expect(a.shiftLog?.some((c) => c.kind === 'auto')).toBe(true);
  });

  it('営業中に営業時間を変えても、今日の予定と勤務は変わらない（あすから新しい営業時間）', () => {
    const { s, ctx } = newGame(79);
    const a = partTimer(s, 'A');
    morning(s, ctx);
    open(s, ctx);
    run(s, ctx, 20);
    const planned = shiftFor(a, s.day);
    const st = activeStore(s);
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: st.id, hours: { sessions: [{ open: 18 * 60, close: 23 * 60 }], closedDays: [] } }, ctx).ok).toBe(true);
    expect(shiftFor(a, s.day)).toEqual(planned);
    // そのあと今日の予定を少し変えても、今日の営業時間で読むので、勤務中のまま
    once(s, ctx, a.id, [s.day], { ...planned!, end: 200, fromPrep: false });
    run(s, ctx, 10);
    expect(a.att!.status).toBe('working');
  });

  it('予定の変更は記録に残り、版が進む。古い版からの保存は断る', () => {
    const { s, ctx } = newGame(80);
    const a = partTimer(s, 'A');
    const rev = a.shiftRev ?? 0;
    expect(applyAction(s, 'p1', { type: 'setDateShift', employeeId: a.id, days: [s.day + 2], shift: sh(0, 120), mode: 'once', baseRev: rev }, ctx).ok).toBe(true);
    expect(a.shiftRev).toBe(rev + 1);
    const last = a.shiftLog![a.shiftLog!.length - 1]!;
    expect(last).toMatchObject({ kind: 'once', target: s.day + 2, after: sh(0, 120), by: s.players[0]!.name });
    const r = applyAction(s, 'p1', { type: 'setDateShift', employeeId: a.id, days: [s.day + 3], shift: null, mode: 'once', baseRev: rev }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('ほかの操作');
  });
});

describe('社員の単日出勤（じろ7 2-2）', () => {
  it('休みの曜日の社員を、その日だけ出勤させられる。ほかの日には使わない。給与はその日だけ', () => {
    const { s, ctx } = newGame(81);
    const m = addBot(s, 'cook', 0.7, 7000);
    const wd = weekdayOf(s.day + 1);
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: m.id, days: [wd] }, ctx).ok).toBe(true);
    expect(shiftFor(m, s.day + 1)).toBeNull();
    expect(once(s, ctx, m.id, [s.day + 1], sh(0, 240, true)).ok).toBe(true);
    expect(shiftFor(m, s.day + 1)).not.toBeNull();
    expect(shiftFor(m, s.day + 8)).toBeNull();
    s.day += 1;
    morning(s, ctx);
    expect(m.att!.status).toBe('working');
    expect(payDue(m, s)).toBeGreaterThan(0);
    // 翌週の同じ曜日は休み
    s.day += 7;
    morning(s, ctx);
    expect(m.att!.status).toBe('off');
    expect(payDue(m, s)).toBe(0);
  });

  it('その日だけの担当を決められる（調理担当をこの日だけ接客担当に）', () => {
    const { s, ctx } = newGame(82);
    const a = partTimer(s, 'A', 'cook');
    expect(once(s, ctx, a.id, [s.day], { ...sh(0, 240, true), role: 'server' }).ok).toBe(true);
    morning(s, ctx);
    expect(roleOn(a, s.day)).toBe('server');
    expect(roleOn(a, s.day + 1)).toBe('cook');
    // シフトリーダーはその日だけにはできない
    expect(once(s, ctx, a.id, [s.day + 1], { ...sh(0, 240, true), role: 'leader' }).ok).toBe(false);
  });
});

describe('店長代理（じろ7 2-3。その日だけの任命）', () => {
  function storeWithManager(seed: number) {
    const { s, ctx } = newGame(seed);
    s.career.unlocked.push('hiring');
    const m = addBot(s, 'cook', 0.7, 7000);
    m.id = 'mgr';
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: m.id }, ctx).ok).toBe(true);
    const d = addBot(s, 'server', 0.6, 7000);
    d.id = 'dep';
    const p = partTimer(s, 'P');
    return { s, ctx, m, d, p };
  }

  it('店長の休みの日に社員を任命すると、その日だけ店長代理として店長の仕事をし、翌日はふつうに戻る', () => {
    const { s, ctx, m, d } = storeWithManager(83);
    const day = s.day + 1;
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: m.id, days: [weekdayOf(day)] }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'appointDeputy', day, employeeId: d.id }, ctx).ok).toBe(true);
    expect(activeStore(s).deputies).toHaveLength(1);
    // 今日（店長が出勤）はふつうの社員
    morning(s, ctx);
    expect(authorityOf(s, d)).toBe('staff');
    // 任命した日
    s.day = day;
    morning(s, ctx);
    expect(authorityOf(s, d)).toBe('deputy');
    expect(activeDeputy(s)?.id).toBe(d.id);
    run(s, ctx, 20);
    expect(actingManager(s)).toMatchObject({ e: { id: d.id }, authority: 'deputy' });
    // 翌日は任命が消え、ふつうの社員に戻る
    s.day = day + 1;
    s.phase = 'closed';
    expect(applyAction(s, 'p1', { type: 'nextDay' }, ctx).ok || s.day === day + 2).toBe(true);
    expect(activeStore(s).deputies ?? []).toHaveLength(0);
    expect(authorityOf(s, d)).toBe('staff');
  });

  it('店長が欠勤した日は任命した店長代理が回す（知らせる）。任命がなければ今までどおり（シフトリーダー → いない）', () => {
    const { s, ctx, m, d } = storeWithManager(84);
    expect(applyAction(s, 'p1', { type: 'appointDeputy', day: s.day, employeeId: d.id }, ctx).ok).toBe(true);
    morning(s, ctx);
    // 店長が出勤している日は店長
    run(s, ctx, 20);
    expect(actingManager(s)?.e.id).toBe(m.id);
    expect(authorityOf(s, d)).toBe('staff');
    // 店長の当日欠勤
    m.att!.absent = true;
    m.att!.status = 'absent';
    m.presentToday = false;
    noteManagerAbsence(s, ctx);
    expect(s.notices.find((n) => n.code === `mgrAbsent:${s.day}`)?.text).toContain('店長代理');
    expect(authorityOf(s, d)).toBe('deputy');
    expect(actingManager(s)).toMatchObject({ e: { id: d.id }, authority: 'deputy' });
    // 任命を取り消すと、代わりがいない
    expect(applyAction(s, 'p1', { type: 'appointDeputy', day: s.day, employeeId: null }, ctx).ok).toBe(true);
    noteManagerAbsence(s, ctx);
    expect(s.notices.find((n) => n.code === `mgrAbsent:${s.day}`)?.text).toContain('代わりに店を回す人がいません');
    expect(actingManager(s)).toBeNull();
  });

  it('プレイヤーがいない店（店長の1日の計算）でも、店長の休みの日は任命した店長代理が回す', () => {
    const { s, ctx, m, d } = storeWithManager(85);
    const entry = activeStore(s);
    const day = s.day + 1;
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: m.id, days: [weekdayOf(day)] }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'appointDeputy', day, employeeId: d.id }, ctx).ok).toBe(true);
    s.day = day;
    expect(storeLead(s, entry)?.id).toBe(d.id);
  });

  it('任命できるのは社員で、店長でなく、その日に勤務がある人。過ぎた日は変えられない。ホストだけの操作', () => {
    const { s, ctx, m, d, p } = storeWithManager(86);
    expect(appointDeputy(s, ctx, s.day, p.id).reason).toContain('社員');
    expect(appointDeputy(s, ctx, s.day, m.id).reason).toContain('店長は');
    const day = s.day + 2;
    expect(applyAction(s, 'p1', { type: 'setRestDays', employeeId: d.id, days: [weekdayOf(day)] }, ctx).ok).toBe(true);
    expect(appointDeputy(s, ctx, day, d.id).reason).toContain('休み');
    expect(appointDeputy(s, ctx, s.day - 1, d.id).ok).toBe(false);
    expect(isHostOnly('appointDeputy')).toBe(true);
  });

  it('経営の操作（売買・設備・借入・出店・貸し借り・方針）は、どの役目の従業員にもない', () => {
    for (const a of ['manager', 'deputy', 'leader', 'staff'] as const) {
      expect(STAFF_OPERATIONS[a]).toEqual([]);
      for (const op of ['storeTrade', 'equipment', 'loan', 'openStore', 'credit', 'policy'] as const) expect(canOperate(a, op)).toBe(false);
    }
  });
});
