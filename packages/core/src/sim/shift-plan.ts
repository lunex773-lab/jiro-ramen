// アルバイトのシフトを営業時間に合わせて管理する（オーナーの指示 2026-11-11）
//   ・営業時間を変えたら、アルバイトのシフトを新しい営業時間に自動で合わせる（同じ時刻に働くように。外れたら同じ割合の位置へ）
//   ・シフト表: 曜日 × 時間帯の人数と、客の多さの見込みから決めた必要な人数（足りない時間帯に印）
//   ・シフトを自動で組む: 来客の見込み・出られる曜日（希望）・疲れに合わせて、アルバイトの曜日ごとのシフトを組む。
//     店長がいる店は、方針で「店長に任せる」（ない → 任せる）なら、店長が毎週（日曜の閉店後）翌週の分を組み直す
// シフトの時刻は「最初の開店からの営業の分」（枠と枠の間の中休みは数えない）。日にちごとに手で入れた予定は変えない
import { BALANCE } from '../data/balance';
import type { Employee, GameState, ShiftDay, StoreEntry, StoreHours } from '../types';
import { activeStore } from './company';
import { calendarDemand } from './calendar';
import { clockMinuteAt, clockMinuteAtEnd, DEFAULT_HOURS, hourDemand, hoursDemandWeight, openMinutesOf, SEC_PER_MIN, storeHours, todayHours, shiftSpansBreak } from './hours';
import { notify, type SimCtx } from './notices';
import { fatigueOf, isFullShift, isPartTime, shiftProblem, shiftsOf, WEEKDAY_LABEL, weekdayOf } from './staff';

const P = () => BALANCE.shiftPlan;
const STEP = () => BALANCE.staff.shiftStepMin;

// ───────────────────────── 営業時間が変わったときに合わせる ─────────────────────────

/** その日の時刻（分）→ 営業の分（最初の開店から。中休みは数えない）。開店前・中休みの時刻は次の枠の始まり、閉店後は最後 */
export function openMinuteAtClock(h: StoreHours, clock: number): number {
  let acc = 0;
  for (const x of h.sessions) {
    // 枠の前（中休み・開店前）: 次の枠の始まり（= 前の枠の終わり。営業の分では同じ）
    if (clock < x.open) return acc;
    if (clock <= x.close) return acc + (clock - x.open);
    acc += x.close - x.open;
  }
  return acc;
}

const snap = (m: number) => Math.round(m / STEP()) * STEP();

/**
 * 1つのシフトを、前の営業時間から新しい営業時間に合わせる（同じ時刻に働く。新しい営業時間の外にかかる分は削る）。
 * 「仕込みから最後まで」のシフトは新しい営業時間でも最後まで。新しい営業時間に重ならないときは、1日の中の同じ割合の位置へ
 */
export function remapShift(sh: ShiftDay, from: StoreHours, to: StoreHours): ShiftDay {
  const r = remapShiftBody(sh, from, to);
  // 「中休みは休む」は、新しい営業時間でも枠をまたぐときだけ残す
  if (sh.midRest && shiftSpansBreak(to, r.start, r.end)) r.midRest = true;
  return r;
}

function remapShiftBody(sh: ShiftDay, from: StoreHours, to: StoreHours): ShiftDay {
  const oldOpen = openMinutesOf(from);
  const newOpen = openMinutesOf(to);
  // 最後まで（社員と同じ「仕込みから閉店まで」・今日の営業の終わりまで）
  if (isFullShift(sh) || (sh.start === 0 && sh.end >= oldOpen)) return { start: 0, end: newOpen, breakAt: 0, breakLen: 0, fromPrep: sh.fromPrep };
  const cs = clockMinuteAt(from, sh.start * SEC_PER_MIN);
  const ce = clockMinuteAtEnd(from, sh.end * SEC_PER_MIN);
  let start = snap(openMinuteAtClock(to, cs));
  let end = snap(openMinuteAtClock(to, ce));
  if (end - start < STEP()) {
    // 重ならない: 同じ割合の位置・同じ長さ（入りきらなければ短く）
    const len = Math.min(newOpen, Math.max(STEP(), sh.end - sh.start));
    start = snap(Math.min(newOpen - len, (sh.start / Math.max(1, oldOpen)) * newOpen));
    start = Math.max(0, start);
    end = Math.min(newOpen, start + snap(len));
  }
  end = Math.min(end, newOpen);
  if (end - start < STEP()) {
    start = Math.max(0, newOpen - STEP());
    end = newOpen;
  }
  const out: ShiftDay = { start, end, breakAt: 0, breakLen: 0, fromPrep: sh.fromPrep && start === 0 };
  // 休憩: 勤務の途中に入る長さなら真ん中あたりに置く
  if (sh.breakLen > 0 && end - start >= sh.breakLen + 2 * STEP()) {
    const mid = snap(start + (end - start - sh.breakLen) / 2);
    out.breakAt = Math.max(start + STEP(), Math.min(end - sh.breakLen - STEP(), mid));
    out.breakLen = sh.breakLen;
  }
  return shiftProblem(out, newOpen) ? { start: 0, end: newOpen, breakAt: 0, breakLen: 0, fromPrep: sh.fromPrep } : out;
}

const sameShift = (a: ShiftDay | null, b: ShiftDay | null) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 店の営業時間を変えたときに、その店のアルバイトのシフト（曜日ごと・あす以降の日にちごと）を新しい営業時間に合わせる。
 * 直した人の名前の一覧を返す（変わらなければ空）
 */
export function remapShiftsForHours(list: Employee[], from: StoreHours, to: StoreHours, today: number): string[] {
  if (JSON.stringify(from.sessions) === JSON.stringify(to.sessions)) return [];
  const changed: string[] = [];
  for (const e of list) {
    if (!isPartTime(e)) continue;
    let touched = false;
    if (e.shifts) {
      const week = shiftsOf(e).map((sh) => (sh ? remapShift(sh, from, to) : null));
      if (!week.every((x, i) => sameShift(x, e.shifts![i] ?? null))) touched = true;
      e.shifts = week;
    }
    for (const [k, sh] of Object.entries(e.dateShifts ?? {})) {
      if (Number(k) <= today || !sh) continue;
      const next = remapShift(sh, from, to);
      if (!sameShift(next, sh)) touched = true;
      e.dateShifts![k] = next;
    }
    if (touched) changed.push(e.profile.name);
  }
  return changed;
}

/** その店の従業員（プレイヤーがいる店は s.employees、ほかの店は店の中身） */
export function storeEmployees(s: GameState, entry: StoreEntry): Employee[] {
  if (!s.company || entry.id === s.company.activeStoreId) return s.employees;
  const snap = entry.snapshot as { employees?: Employee[] } | null | undefined;
  return snap?.employees ?? [];
}

// ───────────────────────── シフト表（曜日 × 時間帯） ─────────────────────────

export interface ShiftCell {
  /** その時間帯の始まり（営業の分）と時刻（分） */
  start: number;
  clock: number;
  /** いる人数（店主を入れる）と必要な人数の目安 */
  staff: number;
  need: number;
  /** 1時間あたりの来客の見込み */
  customers: number;
}

export interface ShiftTableRow {
  weekday: number;
  closed: boolean;
  cells: ShiftCell[];
  /** その曜日に入るアルバイト（名前と時刻の文字は画面で作る） */
  partTimers: { id: string; shift: ShiftDay }[];
}

/** 1時間・1曜日あたりの来客の見込みの元（最近の営業日の来客 ÷ その日の曜日・季節 × 営業時間の客の多さ） */
export function customersPerDemandHour(s: GameState): number {
  let cust = 0;
  let w = 0;
  let n = 0;
  const fallbackW = hoursDemandWeight(todayHours(s));
  for (let i = s.history.length - 1; i >= 0 && n < BALANCE.storeManager.recentDays; i--) {
    const r = s.history[i]!;
    if (r.served <= 0) continue;
    cust += r.customers + r.balked;
    w += calendarDemand(r.day) * (r.demandWeight ?? fallbackW);
    n += 1;
  }
  if (n > 0 && w > 0) return cust / w;
  return P().defaultDailyCustomers / hoursDemandWeight(DEFAULT_HOURS);
}

/** 今日から見て次のその曜日の日（今日がその曜日なら来週の同じ曜日） */
function nextDayOfWeekday(today: number, weekday: number): number {
  const d = (weekday - weekdayOf(today) + 7) % 7;
  return today + (d === 0 ? 7 : d);
}

/** シフトがその営業の分にかかるか（休憩を除く） */
export function shiftCovers(sh: ShiftDay, minute: number, openMin: number): boolean {
  const end = isFullShift(sh) || sh.end >= openMin ? openMin : sh.end;
  if (minute < sh.start || minute >= end) return false;
  return !(sh.breakLen > 0 && minute >= sh.breakAt && minute < sh.breakAt + sh.breakLen);
}

/** 店主（プレイヤー）がこの店で働いているか（プレイヤーがいる店。店長の店・ほかの店は数えない） */
function ownerWorks(s: GameState): boolean {
  return s.players.length > 0;
}

/** 必要な人数の目安（1時間あたりの来客 ÷ 1人で回せる来客。最低1人） */
export function staffNeeded(customersPerHour: number): number {
  return Math.max(1, Math.ceil(customersPerHour / P().customersPerStaffHour - 1e-9));
}

/**
 * シフト表: 曜日ごと・時間帯（slotMin 分ごと）の、いる人数と必要な人数の目安と来客の見込み（曜日ごとのくりかえしの予定で数える）
 */
export function shiftTable(s: GameState, hours: StoreHours = storeHours(s), slotMin = 60): ShiftTableRow[] {
  const open = openMinutesOf(hours);
  const base = customersPerDemandHour(s);
  const owner = ownerWorks(s) ? 1 : 0;
  const rows: ShiftTableRow[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const closed = hours.closedDays.includes(wd);
    const cal = calendarDemand(nextDayOfWeekday(s.day, wd));
    const cells: ShiftCell[] = [];
    const partTimers: ShiftTableRow['partTimers'] = [];
    for (const e of s.employees) {
      const sh = shiftsOf(e)[wd];
      if (sh && isPartTime(e)) partTimers.push({ id: e.id, shift: sh });
    }
    if (!closed) {
      for (let m = 0; m < open; m += slotMin) {
        const mid = Math.min(open - 1, m + slotMin / 2);
        const clock = clockMinuteAt(hours, m * SEC_PER_MIN);
        const customers = base * hourDemand(clockMinuteAt(hours, mid * SEC_PER_MIN)) * cal;
        let staff = owner;
        for (const e of s.employees) {
          const sh = shiftsOf(e)[wd];
          if (!sh) continue;
          if (!isPartTime(e) || shiftCovers(sh, mid, open)) staff += 1;
        }
        cells.push({ start: m, clock, staff, need: staffNeeded(customers), customers: Math.round(customers * 10) / 10 });
      }
    }
    rows.push({ weekday: wd, closed, cells, partTimers });
  }
  return rows;
}

// ───────────────────────── 自動で組む ─────────────────────────

export interface AutoShiftResult {
  ok: boolean;
  reason?: string;
  /** シフトが変わったアルバイトの数と、1週間の勤務の回数 */
  changed: number;
  shifts: number;
  /** 組んだあとも人が足りない時間帯の数（30分ごと・1週間） */
  shortSlots: number;
}

/**
 * アルバイトの曜日ごとのシフトを組む。曜日ごとに、30分ごとの「必要な人数 − 店主と社員」の足りない分を、
 * 出られる曜日（希望）のアルバイトで埋める（足りない分をいちばん多く埋める時間に1人ずつ。1つの営業の枠の中・2〜6時間）。
 * 週に入る回数は疲れに合わせて少なめに。日にちごとに手で入れた予定は変えない
 */
export function buildShifts(s: GameState, hours: StoreHours = storeHours(s), withOwner = ownerWorks(s), day = s.day): { week: Map<string, (ShiftDay | null)[]>; shortSlots: number } {
  const L = P();
  const step = STEP();
  const open = openMinutesOf(hours);
  const base = customersPerDemandHour(s);
  const owner = withOwner ? 1 : 0;
  const parts = s.employees.filter(isPartTime);
  const week = new Map<string, (ShiftDay | null)[]>(parts.map((e) => [e.id, Array.from({ length: 7 }, () => null as ShiftDay | null)]));
  const days = new Map<string, number>(parts.map((e) => [e.id, 0]));
  const maxDays = (e: Employee) => (fatigueOf(e) >= L.tiredFatigue ? L.maxDaysTired : L.maxDaysPerWeek);
  // 枠ごとの営業の分の範囲
  const spans: { a: number; b: number }[] = [];
  let acc = 0;
  for (const x of hours.sessions) {
    spans.push({ a: acc, b: acc + (x.close - x.open) });
    acc += x.close - x.open;
  }
  const slots = Math.ceil(open / step);
  const need: number[][] = [];
  const order: number[] = [];
  for (let wd = 0; wd < 7; wd++) {
    const r: number[] = Array.from({ length: slots }, () => 0);
    if (!hours.closedDays.includes(wd)) {
      const cal = calendarDemand(nextDayOfWeekday(day, wd));
      const fixed = owner + s.employees.filter((e) => !isPartTime(e) && shiftsOf(e)[wd]).length;
      for (let i = 0; i < slots; i++) {
        const mid = Math.min(open - 1, i * step + step / 2);
        const customers = base * hourDemand(clockMinuteAt(hours, mid * SEC_PER_MIN)) * cal;
        r[i] = staffNeeded(customers) - fixed;
      }
      order.push(wd);
    }
    need.push(r);
  }
  // 足りない分の多い曜日から
  order.sort((a, b) => need[b]!.reduce((x, v) => x + Math.max(0, v), 0) - need[a]!.reduce((x, v) => x + Math.max(0, v), 0));
  for (const wd of order) {
    const r = need[wd]!;
    for (;;) {
      // いちばん多く埋められる時間（1つの枠の中・minShift〜maxShift）
      let best: { a: number; b: number; gain: number } | null = null;
      for (const sp of spans) {
        const spanLen = sp.b - sp.a;
        const minLen = Math.min(spanLen, L.minShiftMin);
        for (let len = minLen; len <= Math.min(spanLen, L.maxShiftMin); len += step) {
          for (let a = sp.a; a + len <= sp.b; a += step) {
            let gain = 0;
            for (let m = a; m < a + len; m += step) gain += r[Math.floor(m / step)]! > 0 ? 1 : 0;
            if (!best || gain > best.gain || (gain === best.gain && len < best.b - best.a)) best = { a, b: a + len, gain };
          }
        }
      }
      if (!best || best.gain * step < L.minGainMin) break;
      // 入れる人: 出られる曜日で、週の回数が少ない人・疲れていない人・能力の高い人から
      const cand = parts
        .filter((e) => (e.profile.wishDays ? e.profile.wishDays[wd] !== false : true) && !week.get(e.id)![wd] && days.get(e.id)! < maxDays(e))
        .sort((x, y) => days.get(x.id)! - days.get(y.id)! || fatigueOf(x) - fatigueOf(y) || y.profile.skills.speed - x.profile.skills.speed);
      const e = cand[0];
      if (!e) break;
      const fromPrep = best.a === 0 && r[0]! > 0 && owner === 0;
      week.get(e.id)![wd] = { start: best.a, end: best.b, breakAt: 0, breakLen: 0, fromPrep };
      days.set(e.id, days.get(e.id)! + 1);
      for (let m = best.a; m < best.b; m += step) r[Math.floor(m / step)]! -= 1;
    }
  }
  let shortSlots = 0;
  for (const wd of order) shortSlots += need[wd]!.filter((v) => v > 0).length;
  return { week, shortSlots };
}

/**
 * 組んだシフトを入れる（アルバイトの曜日ごとのくりかえし）。by = 'manager' は店長が組んだ（知らせの文が変わる）。
 * opts: owner = 店主を1人と数えるか（ない → プレイヤーがいる店なら数える）、hours = 営業時間（ない → 店の営業時間）、silent = 知らせない
 */
export function autoShifts(
  s: GameState,
  ctx: SimCtx,
  by: 'player' | 'manager' = 'player',
  opts: { owner?: boolean; hours?: StoreHours; silent?: boolean; day?: number } = {},
): AutoShiftResult {
  const parts = s.employees.filter(isPartTime);
  if (parts.length === 0) return { ok: false, reason: 'アルバイトがいません', changed: 0, shifts: 0, shortSlots: 0 };
  const { week, shortSlots } = buildShifts(s, opts.hours ?? storeHours(s), opts.owner ?? ownerWorks(s), opts.day ?? s.day);
  let changed = 0;
  let shifts = 0;
  for (const e of parts) {
    const next = week.get(e.id)!;
    shifts += next.filter(Boolean).length;
    if (!next.every((x, i) => sameShift(x, shiftsOf(e)[i] ?? null))) changed += 1;
    e.shifts = next;
  }
  if (!opts.silent) {
    const who = by === 'manager' ? `店長の${managerName(s)}さんが` : '';
    const short = shortSlots > 0 ? `。まだ人が足りない時間があります（${Math.round((shortSlots * STEP()) / 60)}時間分）。アルバイトを増やすと埋まります` : '';
    notify(
      s,
      ctx,
      'autoShifts',
      shortSlots > 0 ? 'warn' : 'good',
      `${who}来客の見込みと出られる曜日に合わせて、アルバイト${parts.length}人のシフトを組みました（週${shifts}回・${changed}人を変更。あすから）${short}`,
    );
  }
  return { ok: true, changed, shifts, shortSlots };
}

function managerName(s: GameState): string {
  const id = s.company ? activeStore(s).managerId : null;
  return s.employees.find((e) => e.id === id)?.profile.name ?? '';
}

/** 店長にシフトを任せているか（店長がいて、方針で「自分で組む」にしていない店） */
export function managerPlansShifts(s: GameState): boolean {
  if (!s.company) return false;
  const st = activeStore(s);
  if (!st.managerId || st.policy.shiftBy === 'self') return false;
  return s.employees.some((e) => e.id === st.managerId);
}

/** 店長の毎週のシフト（日曜の閉店後に、翌週の分を組み直す） */
export function managerWeeklyShifts(s: GameState, ctx: SimCtx): void {
  if (s.tutorial || weekdayOf(s.day) !== 6 || !managerPlansShifts(s)) return;
  if (!s.employees.some(isPartTime)) return;
  autoShifts(s, ctx, 'manager');
}

/** 曜日の文字（「月」） */
export function weekdayText(wd: number): string {
  return WEEKDAY_LABEL[wd] ?? '';
}
