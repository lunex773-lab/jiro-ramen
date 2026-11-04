// 第2版 Phase 2: 従業員の雇用形態・シフト・勤怠・辛抱・成長・履歴（設計書 18-2）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  argueChance,
  attendanceChances,
  BALANCE,
  dailyWageOf,
  diligenceOf,
  expectedPay,
  fullTimeWageFor,
  hourlyOf,
  initNewHire,
  isHostOnly,
  makeEmployee,
  patienceOf,
  payDue,
  promotionInfo,
  recordOf,
  refreshCandidates,
  respondToComplaint,
  rollCall,
  SEC_PER_MIN,
  shiftFor,
  shiftsOf,
  hasDateShift,
  staffSummary,
  startComplaint,
  updateAttendance,
  updateCommute,
  wagesDue,
  weekdayOf,
  type Employee,
  type GameState,
  type ShiftDay,
  type SimCtx,
} from '../src';
import { newGame, runDay, seatCustomer } from './helpers';

/** アルバイトを1人入れる（勤怠・辛抱を指定） */
function partTimer(s: GameState, diligence: number, patience: number, role: 'cook' | 'server' | 'cleaner' = 'server', skill = 0.5): Employee {
  const e = makeEmployee(s, {
    id: 'cand-x',
    profile: {
      name: `テスト${s.employees.length}`,
      role,
      skills: { speed: skill, cooking: skill, service: skill, hygiene: skill, movement: skill },
      wage: 9000,
      hireFee: 0,
      experience: 0,
      diligence,
      patience,
    },
  });
  initNewHire(e);
  s.employees.push(e);
  return e;
}

const shift = (start: number, end: number, extra: Partial<ShiftDay> = {}): ShiftDay => ({ start, end, breakAt: 0, breakLen: 0, fromPrep: false, ...extra });

/** 出勤の処理と出退勤の歩き（入店・あいさつ・手洗い／退店）だけを進める（仕事はさせない） */
function tickStaff(s: GameState, dt: number, ctx: SimCtx): void {
  updateAttendance(s, dt, ctx);
  for (const e of s.employees) if (e.presentToday && e.commute) updateCommute(s, e, dt, ctx);
}

/** 朝の出勤確認から営業の終わりまで、出勤の処理だけを1秒ずつ進める（客・調理は動かさない） */
function attendanceDay(s: GameState, ctx: SimCtx): void {
  s.phase = 'prep';
  rollCall(s, ctx);
  s.phase = 'open';
  for (let t = 1; t <= BALANCE.openDuration; t++) {
    s.openT = t;
    s.t += 1;
    tickStaff(s, 1, ctx);
  }
  s.phase = 'closing';
  tickStaff(s, 1, ctx);
}

describe('雇用形態と採用', () => {
  it('アルバイトとして採用され、時給と初めのシフト（毎日・仕込みから閉店まで）が付く。信頼性の数値は持たない', () => {
    const { s, ctx } = newGame(3);
    s.career.unlocked.push('hiring');
    refreshCandidates(s);
    const c = s.candidates[0]!;
    expect(c.profile.skills.reliability).toBeUndefined();
    expect(c.profile.diligence).toBeGreaterThanOrEqual(0);
    expect(c.profile.patience).toBeGreaterThanOrEqual(0);
    expect(applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok).toBe(true);
    const e = s.employees[0]!;
    expect(e.profile.employment).toBe('part');
    expect(hourlyOf(e)).toBe(Math.round(c.profile.wage / BALANCE.staff.employment.fullShiftHours / 10) * 10);
    expect(shiftsOf(e).every((x) => x && x.fromPrep && x.start === 0 && x.end === 240)).toBe(true);
    // 仕込み中に雇ったので今日から働く
    expect(e.presentToday).toBe(true);
    expect(e.att?.prepWorked).toBe(true);
  });

  it('採用の候補には見た目の番号があり、採用したあとも変わらない（同じ種・同じ手順なら同じ番号）', () => {
    const { s, ctx } = newGame(3);
    s.career.unlocked.push('hiring');
    const rng0 = s.rng;
    refreshCandidates(s);
    const looks = s.candidates.map((c) => c.profile.look);
    expect(looks.every((l) => typeof l === 'number')).toBe(true);
    expect(new Set(looks).size).toBe(looks.length);
    // 同じ種・同じ手順なら同じ番号・同じ乱数の進み方
    const b = newGame(3);
    b.s.career.unlocked.push('hiring');
    refreshCandidates(b.s);
    expect(b.s.candidates.map((c) => c.profile.look)).toEqual(looks);
    expect(b.s.rng).toBe(s.rng);
    expect(s.rng).not.toBe(rng0);
    const c = s.candidates[1]!;
    expect(applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok).toBe(true);
    expect(s.employees[0]!.profile.look).toBe(c.profile.look);
  });

  it('古いセーブの従業員（雇用形態がない）は社員として扱い、今までと同じ日給・毎日の勤務。勤怠は以前の信頼性から読む', () => {
    const { s, ctx } = newGame(4);
    const e = makeEmployee(s, { id: 'old', profile: { name: '古株', role: 'cook', skills: { speed: 0.5, cooking: 0.5, service: 0.5, hygiene: 0.5, movement: 0.5, reliability: 0.4 }, wage: 8000, hireFee: 0, experience: 0 } });
    e.presentToday = true;
    s.employees.push(e);
    expect(e.profile.employment).toBeUndefined();
    expect(shiftsOf(e).every((x) => x?.fromPrep && x.end === 240)).toBe(true);
    expect(diligenceOf(e)).toBeCloseTo(0.4 + BALANCE.staff.employment.fullTimeDiligenceBonus);
    // 辛抱は ID から決まった値（何度読んでも同じ・範囲内）
    expect(patienceOf(e)).toBe(patienceOf(e));
    expect(patienceOf(e)).toBeGreaterThanOrEqual(BALANCE.staff.patience.mean - BALANCE.staff.patience.spread - 1e-9);
    // 出勤の記録がない日（このバージョンより前の状態）も、出勤していれば日給を払う
    expect(payDue(e, s)).toBe(8000);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.history[0]!.wages).toBe(e.att?.absent ? 0 : 8000);
  });
});

describe('シフト', () => {
  it('曜日ごとに設定・変更・削除でき、30分刻み・営業時間内・休憩の位置を確かめる', () => {
    const { s, ctx } = newGame(5);
    const e = partTimer(s, 1, 1);
    const set = (weekday: number, sh: ShiftDay | null) => applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday, shift: sh }, ctx);
    expect(set(2, shift(60, 180)).ok).toBe(true);
    expect(shiftsOf(e)[2]).toEqual(shift(60, 180));
    expect(set(2, shift(60, 210, { breakAt: 120, breakLen: 30 })).ok).toBe(true);
    expect(shiftsOf(e)[2]!.breakLen).toBe(30);
    expect(set(3, null).ok).toBe(true);
    expect(shiftsOf(e)[3]).toBeNull();
    // 不正なシフト
    expect(set(2, shift(15, 180)).ok).toBe(false);
    expect(set(2, shift(60, 270)).ok).toBe(false);
    expect(set(2, shift(120, 120)).ok).toBe(false);
    expect(set(2, shift(60, 180, { breakAt: 60, breakLen: 30 })).ok).toBe(false);
    expect(set(2, shift(30, 180, { fromPrep: true })).ok).toBe(false);
    expect(set(7, shift(0, 240)).ok).toBe(false);
    // 社員はシフトを組まない（毎日・全時間）
    s.employees[0]!.profile.employment = 'full';
    expect(set(1, shift(0, 60)).ok).toBe(false);
  });

  it('シフトどおりに出勤・休憩・退勤し、給与は時給 × 働いた時間', () => {
    const { s, ctx } = newGame(6);
    const e = partTimer(s, 1, 1);
    s.day = 2;
    const wd = weekdayOf(s.day);
    // 12:00〜14:00、13:00から30分休憩
    expect(applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday: wd, shift: shift(60, 180, { breakAt: 120, breakLen: 30 }) }, ctx).ok).toBe(true);
    s.phase = 'prep';
    rollCall(s, ctx);
    expect(e.presentToday).toBe(false);
    s.phase = 'open';
    const seen: Record<string, boolean> = {};
    const said: string[] = [];
    for (let t = 1; t <= BALANCE.openDuration; t++) {
      s.openT = t;
      s.t += 1;
      tickStaff(s, 1, ctx);
      if (e.say && e.say.until > s.t && said[said.length - 1] !== e.say.text) said.push(e.say.text);
      const min = t / SEC_PER_MIN;
      if (min < 59) seen.before ||= e.presentToday;
      if (min > 61 && min < 119) seen.working = (seen.working ?? true) && e.presentToday;
      // 休憩と退勤は、あいさつをして店の外まで歩いてから姿が消える（数分かかる）
      if (min > 126 && min < 149) seen.inBreak ||= e.presentToday;
      if (min > 151 && min < 179) seen.after = (seen.after ?? true) && e.presentToday;
      if (min > 186) seen.leftLate ||= e.presentToday;
    }
    expect(seen).toEqual({ before: false, working: true, inBreak: false, after: true, leftLate: false });
    // 出勤・休憩・戻り・退勤のあいさつ
    expect(said.some((x) => x.startsWith('おはようございます'))).toBe(true);
    expect(said.some((x) => x.startsWith('休憩'))).toBe(true);
    expect(said.some((x) => x.startsWith('戻りました') || x.startsWith('休憩ありがとう'))).toBe(true);
    expect(said.some((x) => x.includes('お疲れ様でした'))).toBe(true);
    expect(e.att!.status).toBe('left');
    // 90分 = 1.5時間ぶん（秒の刻みの誤差は 10円の丸めの中）
    expect(payDue(e, s)).toBe(Math.round((hourlyOf(e) * 1.5) / 10) * 10);
    expect(expectedPay(e, s.day)).toBe(Math.round((hourlyOf(e) * 1.5) / 10) * 10);
  });

  it('休みの曜日は来ず給与もかからない。当日に予定を入れると呼び出して出勤する（着くまで時間がかかる）', () => {
    const { s, ctx } = newGame(7);
    const e = partTimer(s, 1, 1);
    s.day = 3;
    const wd = weekdayOf(s.day);
    applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday: wd, shift: null }, ctx);
    s.phase = 'prep';
    rollCall(s, ctx);
    expect(e.att!.status).toBe('off');
    expect(e.presentToday).toBe(false);
    s.phase = 'open';
    s.openT = 100;
    updateAttendance(s, 1, ctx);
    expect(e.presentToday).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday: wd, shift: shift(0, 240) }, ctx).ok).toBe(true);
    expect(e.att!.calledIn).toBe(true);
    updateAttendance(s, 1, ctx);
    expect(e.presentToday).toBe(false);
    s.openT = 100 + BALANCE.staff.attendance.callInMin * SEC_PER_MIN + 1;
    updateAttendance(s, 1, ctx);
    expect(e.presentToday).toBe(true);
    expect(recordOf(e).log.some((l) => l.kind === 'calledIn')).toBe(true);
  });

  it('シフトの変更・昇格はホストだけの操作', () => {
    expect(isHostOnly('setShift')).toBe(true);
    expect(isHostOnly('promote')).toBe(true);
  });
});

describe('カレンダーで日にちごとのシフト（オーナー回答「日にちごと＋くりかえしも使える」）', () => {
  const wk = shift(60, 180, { breakAt: 120, breakLen: 30 });
  const once = (s: GameState, ctx: SimCtx, id: string, days: number[], sh: ShiftDay | null, mode: 'once' | 'weekly' | 'reset' = 'once') =>
    applyAction(s, 'p1', { type: 'setDateShift', employeeId: id, days, shift: sh, mode }, ctx);

  it('選んだ日だけの予定は、曜日ごとのくりかえしより優先する。ほかの日はくりかえしのまま', () => {
    const { s, ctx } = newGame(21);
    const e = partTimer(s, 1, 1);
    s.day = 3;
    expect(once(s, ctx, e.id, [5, 6], wk).ok).toBe(true);
    expect(once(s, ctx, e.id, [8], null).ok).toBe(true);
    expect(shiftFor(e, 5)).toEqual(wk);
    expect(shiftFor(e, 6)).toEqual(wk);
    expect(shiftFor(e, 8)).toBeNull();
    expect(hasDateShift(e, 5)).toBe(true);
    // 選ばなかった日・1週間後の同じ曜日はくりかえし（採用したときは毎日・仕込みから閉店まで）
    expect(shiftFor(e, 7)).toEqual(shiftsOf(e)[weekdayOf(7)]);
    expect(shiftFor(e, 12)).toEqual(shiftsOf(e)[weekdayOf(12)]);
    expect(hasDateShift(e, 12)).toBe(false);
    // 給与の見込みもその日の予定から
    expect(expectedPay(e, 5)).toBe(Math.round((hourlyOf(e) * 1.5) / 10) * 10);
    expect(expectedPay(e, 8)).toBe(0);
  });

  it('毎週くりかえすと、選んだ日の曜日のくりかえしになる（選んだ日の「その日だけ」は消える）。くりかえしに戻すこともできる', () => {
    const { s, ctx } = newGame(22);
    const e = partTimer(s, 1, 1);
    s.day = 1;
    expect(once(s, ctx, e.id, [3], null).ok).toBe(true);
    expect(once(s, ctx, e.id, [3, 4], wk, 'weekly').ok).toBe(true);
    expect(shiftsOf(e)[weekdayOf(3)]).toEqual(wk);
    expect(shiftsOf(e)[weekdayOf(4)]).toEqual(wk);
    expect(hasDateShift(e, 3)).toBe(false);
    expect(shiftFor(e, 3 + 7)).toEqual(wk);
    expect(shiftFor(e, 4 + 14)).toEqual(wk);
    // 1日だけ休みにして、くりかえしに戻す
    expect(once(s, ctx, e.id, [10], null).ok).toBe(true);
    expect(shiftFor(e, 10)).toBeNull();
    expect(once(s, ctx, e.id, [10], null, 'reset').ok).toBe(true);
    expect(shiftFor(e, 10)).toEqual(wk);
    expect(e.dateShifts).toBeUndefined();
  });

  it('過ぎた日・4週間より先・正しくない時刻・社員は受け付けない。過ぎた日の予定は朝に消える', () => {
    const { s, ctx } = newGame(23);
    const e = partTimer(s, 1, 1);
    s.day = 5;
    expect(once(s, ctx, e.id, [4], wk).ok).toBe(false);
    expect(once(s, ctx, e.id, [5 + BALANCE.staff.calendarDays], wk).ok).toBe(false);
    expect(once(s, ctx, e.id, [5 + BALANCE.staff.calendarDays - 1], wk).ok).toBe(true);
    expect(once(s, ctx, e.id, [6], shift(60, 75)).ok).toBe(false);
    expect(once(s, ctx, e.id, [], wk).ok).toBe(false);
    expect(once(s, ctx, e.id, [6], wk).ok).toBe(true);
    // 過ぎた日の予定は、その日を過ぎた朝の出勤確認で消える
    s.day = 7;
    s.phase = 'prep';
    rollCall(s, ctx);
    expect(Object.keys(e.dateShifts ?? {})).toEqual([String(5 + BALANCE.staff.calendarDays - 1)]);
    // 社員は毎日・全時間（日にちごとの予定はない）
    e.profile.employment = 'full';
    expect(once(s, ctx, e.id, [8], wk).ok).toBe(false);
    // ホストだけの操作
    expect(isHostOnly('setDateShift')).toBe(true);
  });

  it('日にちごとの予定どおりに出勤・退勤する（くりかえしでは休みの曜日でも、その日に入れた予定で来る）', () => {
    const { s, ctx } = newGame(24);
    const e = partTimer(s, 1, 1);
    s.day = 2;
    expect(applyAction(s, 'p1', { type: 'setShift', employeeId: e.id, weekday: weekdayOf(3), shift: null }, ctx).ok).toBe(true);
    expect(once(s, ctx, e.id, [3], shift(60, 120)).ok).toBe(true);
    s.day = 3;
    attendanceDay(s, ctx);
    expect(e.att!.arrived).toBe(true);
    expect(payDue(e, s)).toBe(Math.round(hourlyOf(e) / 10) * 10);
  });
});

describe('勤怠（隠しパラメータ）', () => {
  /** 勤怠の違う2人を何日も働かせ、起きた出来事と記録を比べる */
  function simulate(days: number) {
    const { s, ctx } = newGame(11);
    const low = partTimer(s, 0.05, 1);
    const high = partTimer(s, 0.97, 1);
    const observed = new Map<string, { absent: number; late: number; conduct: number; absentDays: Set<number>; lateDays: Set<number> }>();
    for (const e of s.employees) observed.set(e.id, { absent: 0, late: 0, conduct: 0, absentDays: new Set(), lateDays: new Set() });
    for (let d = 0; d < days; d++) {
      s.day += 1;
      s.phase = 'prep';
      rollCall(s, ctx);
      s.phase = 'open';
      const conductBefore = new Map(s.employees.map((e) => [e.id, e.conduct?.today ?? 0]));
      for (let t = 1; t <= BALANCE.openDuration; t++) {
        s.openT = t;
        s.t += 1;
        tickStaff(s, 1, ctx);
      }
      for (const e of s.employees) {
        const o = observed.get(e.id)!;
        if (e.att!.absent) {
          o.absent += 1;
          o.absentDays.add(s.day);
        }
        if (e.att!.lateMin > 0 && e.att!.arrived) {
          o.late += 1;
          o.lateDays.add(s.day);
        }
        o.conduct += (e.conduct?.today ?? 0) - (conductBefore.get(e.id) ?? 0);
      }
    }
    return { s, low, high, observed };
  }

  it('勤怠が低いと遅刻・欠勤・サボりが起きやすく、高いとほとんど起きない。記録は実際に起きた出来事と一致する', () => {
    const { s, low, high, observed } = simulate(80);
    const lo = observed.get(low.id)!;
    const hi = observed.get(high.id)!;
    expect(lo.absent).toBeGreaterThan(5);
    expect(lo.late).toBeGreaterThan(5);
    expect(lo.conduct).toBeGreaterThan(10);
    expect(hi.absent + hi.late + hi.conduct).toBeLessThanOrEqual(1);
    expect(attendanceChances(low).absent).toBeGreaterThan(attendanceChances(high).absent * 20);
    // 履歴と実際の行動が一致する（数も、記録の種類も）
    for (const e of [low, high]) {
      const r = recordOf(e);
      const o = observed.get(e.id)!;
      expect(r.absent).toBe(o.absent);
      expect(r.late).toBe(o.late);
      expect(r.slack).toBe(o.conduct);
      // 履歴（最新の logMax 件）の出来事は、実際に起きた日と一致する
      // いちばん古い日は件数の上限で一部だけ消えていることがあるので、その次の日から比べる
      const from = r.log[0]?.day ?? Infinity;
      const after = (days: Iterable<number>) => new Set([...days].filter((d) => d > from));
      expect(after(r.log.filter((l) => l.kind === 'absent').map((l) => l.day))).toEqual(after(o.absentDays));
      expect(after(r.log.filter((l) => l.kind === 'late').map((l) => l.day))).toEqual(after(o.lateDays));
    }
    // 1日に起きるサボりは上限まで、間隔をあける
    for (const e of s.employees) expect(e.conduct!.today).toBeLessThanOrEqual(BALANCE.staff.conduct.maxPerDay);
  });

  it('同じ人が続けて欠勤・遅刻しない（欠勤の次の日から決まった日数は欠勤しない）', () => {
    const { low } = simulate(80);
    const days = recordOf(low).log.filter((l) => l.kind === 'absent').map((l) => l.day);
    for (let i = 1; i < days.length; i++) expect(days[i]! - days[i - 1]!).toBeGreaterThan(BALANCE.staff.attendance.absentGapDays);
    const late = recordOf(low).log.filter((l) => l.kind === 'late').map((l) => l.day);
    for (let i = 1; i < late.length; i++) expect(late[i]! - late[i - 1]!).toBeGreaterThan(BALANCE.staff.attendance.lateGapDays);
  });

  it('遅刻した日は遅れて店に着き、その分の給与が減る。欠勤した日は給与がかからない', () => {
    const { s, ctx } = newGame(12);
    const e = partTimer(s, 0, 1);
    let checkedLate = false;
    let checkedAbsent = false;
    for (let d = 0; d < 60 && !(checkedLate && checkedAbsent); d++) {
      s.day += 1;
      attendanceDay(s, ctx);
      const a = e.att!;
      if (a.absent) {
        expect(payDue(e, s)).toBe(0);
        checkedAbsent = true;
      } else if (a.lateMin > 0) {
        expect(a.prepWorked).toBe(false);
        expect(a.workedSec).toBeLessThan(BALANCE.openDuration - a.lateMin * SEC_PER_MIN + 2);
        expect(payDue(e, s)).toBeLessThan(expectedPay(e, s.day));
        checkedLate = true;
      }
    }
    expect(checkedLate && checkedAbsent).toBe(true);
  });

  it('チュートリアル中は遅刻・欠勤・サボりが起きない', () => {
    const { s, ctx } = newGame(13);
    const e = partTimer(s, 0, 1);
    s.tutorial = { kind: 'staff', step: 0, mark: {}, entered: true, finished: false };
    for (let d = 0; d < 20; d++) {
      s.day += 1;
      attendanceDay(s, ctx);
    }
    expect(recordOf(e).absent + recordOf(e).late + recordOf(e).slack).toBe(0);
  });
});

describe('辛抱（隠しパラメータ）', () => {
  /** クレームに何度も対応させ、口論と冷静な対応を数える */
  function handle(patience: number, trials: number) {
    const { s, ctx } = newGame(21);
    const e = partTimer(s, 1, patience, 'server', 0.9);
    e.presentToday = true;
    s.phase = 'open';
    let argued = 0;
    let calm = 0;
    let rude = 0;
    let abandoned = 0;
    for (let i = 0; i < trials; i++) {
      s.customers = [];
      s.orders = [];
      for (const seat of s.seats) seat.customerId = null;
      seatCustomer(s, 0, 'small', undefined, { complaintPropensity: 0.5 });
      const c = s.customers[0]!;
      startComplaint(s, ctx, c, 'delay', '遅い！', false);
      const before = { ...recordOf(e) };
      respondToComplaint(s, ctx, s.seats[0]!, e, 'apologize');
      const r = recordOf(e);
      if (r.argue > before.argue) {
        argued += 1;
        expect(c.state).not.toBe('complaint');
        expect(c.complaint).toBeNull();
      } else if (r.abandon > before.abandon) {
        // 放棄: クレームは続き、従業員はしばらく仕事に戻らない
        abandoned += 1;
        expect(c.complaint).not.toBeNull();
        expect(e.ai.cooldown).toBeGreaterThan(5);
      } else if (r.rude > before.rude) rude += 1;
      else if (!c.complaint) calm += 1;
    }
    return { e, argued, calm, rude, abandoned, s };
  }

  it('辛抱が低い従業員はクレームで言い返して揉めやすく、高い従業員は冷静に対応する（接客の能力が高くても別）', () => {
    const low = handle(0, 200);
    const high = handle(1, 200);
    expect(low.argued).toBeGreaterThan(30);
    expect(low.rude).toBeGreaterThan(5);
    expect(low.abandoned).toBeGreaterThan(3);
    expect(high.argued + high.rude + high.abandoned).toBe(0);
    expect(recordOf(low.e).rude).toBe(low.rude);
    expect(recordOf(low.e).abandon).toBe(low.abandoned);
    expect(high.calm).toBeGreaterThan(low.calm);
    // 履歴と一致する
    expect(recordOf(low.e).argue).toBe(low.argued);
    expect(recordOf(high.e).calm).toBe(high.calm);
    expect(argueChance(low.e, true, 1)).toBeGreaterThan(argueChance(low.e, false, 0));
  });

  it('口論になった客は帰り、悪い口コミを1件だけ書く（評判への影響を重ねない）', () => {
    const { s, ctx } = newGame(22);
    const e = partTimer(s, 1, 0, 'server');
    e.presentToday = true;
    s.phase = 'open';
    for (let i = 0; i < 50; i++) {
      s.customers = [];
      s.orders = [];
      s.todayReviews = [];
      for (const seat of s.seats) seat.customerId = null;
      seatCustomer(s, 0, 'small', undefined, { complaintPropensity: 1 });
      const c = s.customers[0]!;
      startComplaint(s, ctx, c, 'unreasonable', '量が少ない！', true);
      const before = recordOf(e).argue;
      respondToComplaint(s, ctx, s.seats[0]!, e, 'explain');
      if (recordOf(e).argue > before) {
        expect(s.todayReviews.filter((r) => r.text.includes('店員に言い返された')).length).toBe(1);
        expect(s.todayReviews.length).toBe(1);
        expect(e.say?.text).toBeTruthy();
        return;
      }
    }
    throw new Error('口論が一度も起きなかった');
  });
});

describe('成長と昇格', () => {
  it('仕事の経験で担当の能力が伸びる（1日の上限あり）。勤務した日ごとに経験も増える', () => {
    const { s, ctx } = newGame(31);
    // 全部を一人でこなすアルバイト
    const e = partTimer(s, 1, 1, 'cook', 0.4);
    for (const k of ['spill', 'complaint', 'noodlesUp', 'discard', 'serve', 'toppings', 'askCall', 'lostReturn']) e.priorities[k] = 1;
    e.presentToday = true;
    e.att = undefined;
    const before = { ...e.profile.skills };
    const exp0 = e.profile.experience;
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    const after = e.profile.skills;
    expect(after.cooking).toBeGreaterThan(before.cooking);
    expect(after.service + after.hygiene + after.speed).toBeGreaterThan(before.service + before.hygiene + before.speed);
    for (const k of ['cooking', 'service', 'hygiene', 'speed', 'movement'] as const) {
      expect(after[k] - before[k]).toBeLessThanOrEqual(BALANCE.staff.growth.dailyCap + 1e-9);
    }
    expect(e.profile.experience).toBeCloseTo(exp0 + BALANCE.staff.experiencePerDay);
    expect(recordOf(e).daysWorked).toBe(1);
  });

  it('昇格の参考情報（複数の項目）を見て、プレイヤーが社員にできる。社員は日給で毎日・全時間、勤怠が安定する', () => {
    const { s, ctx } = newGame(32);
    const e = partTimer(s, 0.5, 0.5, 'server', 0.7);
    const info = promotionInfo(e, s);
    expect(info.checks.length).toBeGreaterThanOrEqual(5);
    expect(info.checks.map((c) => c.label).join('|')).toMatch(/勤務.*遅刻・欠勤.*サボり.*口論.*能力/);
    expect(info.canPromote).toBeNull();
    const d0 = diligenceOf(e);
    // 営業中は昇格できない
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(applyAction(s, 'p1', { type: 'promote', employeeId: e.id }, ctx).ok).toBe(false);
    runDay(s, ctx);
    const wage = fullTimeWageFor(e);
    expect(applyAction(s, 'p1', { type: 'promote', employeeId: e.id }, ctx).ok).toBe(true);
    expect(e.profile.employment).toBe('full');
    expect(e.profile.wage).toBe(wage);
    expect(wage).toBeGreaterThan(dailyWageOf({ ...e, profile: { ...e.profile, employment: 'part' } }));
    expect(diligenceOf(e)).toBeCloseTo(d0 + BALANCE.staff.employment.fullTimeDiligenceBonus);
    expect(shiftsOf(e).every((x) => x?.fromPrep && x.end === 240)).toBe(true);
    expect(applyAction(s, 'p1', { type: 'promote', employeeId: e.id }, ctx).ok).toBe(false);
    expect(recordOf(e).log.some((l) => l.kind === 'promoted')).toBe(true);
    // 翌日の給与は日給
    applyAction(s, 'p1', { type: 'nextDay' }, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.history[s.history.length - 1]!.wages).toBe(e.att!.absent ? 0 : wage);
    expect(wagesDue(s)).toBe(e.att!.absent ? 0 : wage);
  });
});

describe('隠しパラメータの表示', () => {
  it('勤務の様子は出来事の文だけで、勤怠・辛抱の数値や名前を出さない', () => {
    const { s, ctx } = newGame(41);
    const e = partTimer(s, 0.05, 0.05);
    for (let d = 0; d < 25; d++) {
      s.day += 1;
      attendanceDay(s, ctx);
      for (const x of s.employees) if (x.att && !x.att.absent && (x.att.workedSec > 0 || x.att.prepWorked)) x.record!.daysWorked += 1;
    }
    const text = [...staffSummary(e, s), ...promotionInfo(e, s).checks.map((c) => c.label)].join('\n');
    expect(text).not.toMatch(/勤怠|辛抱|diligence|patience/);
    expect(text).not.toContain(String(e.profile.diligence));
    expect(text).not.toContain(String(e.profile.patience));
    expect(staffSummary(e, s).some((l) => /欠勤|遅刻|サボ/.test(l))).toBe(true);
    // 何も起きていない人には「ありません」と出る
    const { s: s2 } = newGame(42);
    const g = partTimer(s2, 1, 1);
    g.record = { daysWorked: 3, daysScheduled: 3, late: 0, absent: 0, slack: 0, postpone: 0, argue: 0, rude: 0, abandon: 0, calm: 0, complaintsSettled: 0, served: 0, log: [] };
    expect(staffSummary(g, s2)).toContain('これまで遅刻はありません');
    expect(staffSummary(g, s2)).toContain('これまで欠勤はありません');
  });
});
