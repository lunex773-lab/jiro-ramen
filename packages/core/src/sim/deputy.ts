// 店長代理の任命と、店での役目（じろ7 2-3。オーナーの判断: その日だけの任命は「店長代理」）。
// - 店長が休み・欠勤の日に、社員を1人、その日・その店だけ店長代理に任命できる。日が過ぎると消える（ほかの日に引き継がない）
// - 店長代理は、店長がいない間だけ店長の店の仕事をする（何をするかは data/staff-roles.ts の表）。店長が店にいる間はふつうの従業員
// - 任命していない日は、今までどおり（勤務のあるシフトリーダー → いなければ店長がいない店の扱い）
// - 経営の操作（店の売買・設備・借入・出店・企業間の貸し借り・方針）は、どの役目の従業員もしない（店主だけ）

import { BALANCE } from '../data/balance';
import type { StaffAuthority } from '../data/staff-roles';
import type { DeputyAppointment, Employee, GameState, Id, StoreEntry } from '../types';
import { notify, type SimCtx } from './notices';
import { isPartTime, shiftFor } from './staff';

/** 会社の今いる店（プレイヤーがいる店） */
function activeEntry(s: GameState): StoreEntry | null {
  const c = s.company;
  if (!c) return null;
  return c.stores.find((x) => x.id === c.activeStoreId) ?? null;
}

/** 過ぎた日の任命を消す */
export function pruneDeputies(entry: StoreEntry, today: number): void {
  if (!entry.deputies) return;
  entry.deputies = entry.deputies.filter((d) => d.day >= today);
  if (entry.deputies.length === 0) delete entry.deputies;
}

/** その日の任命（なければ null） */
export function deputyAppointment(entry: StoreEntry | null, day: number): DeputyAppointment | null {
  return entry?.deputies?.find((d) => d.day === day) ?? null;
}

/**
 * その日の店長代理（任命されていて、その店の従業員で、その日に勤務の予定がある人）。
 * employees はその店の従業員（プレイヤーがいる店は s.employees、店長の1日の計算では店の中身）
 */
export function deputyOn(entry: StoreEntry | null, employees: readonly Employee[], day: number): Employee | null {
  const ap = deputyAppointment(entry, day);
  if (!ap) return null;
  const e = employees.find((x) => x.id === ap.employeeId);
  if (!e || isPartTime(e) || entry?.managerId === e.id) return null;
  return shiftFor(e, day) !== null ? e : null;
}

/** その日、店長が店を空けるか（店長がいない店・店長の休みの日・当日欠勤の日） */
export function managerAwayOn(entry: StoreEntry | null, employees: readonly Employee[], day: number): boolean {
  if (!entry?.managerId) return true;
  const m = employees.find((x) => x.id === entry.managerId);
  if (!m || shiftFor(m, day) === null) return true;
  return !!(m.att && m.att.day === day && m.att.absent);
}

/**
 * 今いる店の、今日働く店長代理（任命されていて、今日は店長が店を空ける日）。
 * 店長が出勤している日は、任命されていてもふつうの社員（じろ7 2-5「店長が出勤している日は通常権限」）
 */
export function activeDeputy(s: GameState): Employee | null {
  const entry = activeEntry(s);
  const d = deputyOn(entry, s.employees, s.day);
  return d && managerAwayOn(entry, s.employees, s.day) ? d : null;
}

/** 今いる店で、今日この人が店長代理として働くか */
export function isDeputyToday(s: GameState, e: Employee): boolean {
  return activeDeputy(s)?.id === e.id;
}

/** 今日のこの人の役目（店長・店長代理・シフトリーダー・従業員） */
export function authorityOf(s: GameState, e: Employee): StaffAuthority {
  const entry = activeEntry(s);
  if (entry && entry.managerId === e.id) return 'manager';
  if (isDeputyToday(s, e)) return 'deputy';
  if (e.profile.role === 'leader') return 'leader';
  return 'staff';
}

/**
 * 店長代理を任命する（employeeId が null なら、その日の任命を取り消す）。今いる店の、今日から先の日だけ。
 * 任命できるのは社員（シフトリーダーも）で、店長ではなく、その日に勤務の予定がある人
 */
export function appointDeputy(s: GameState, ctx: SimCtx, day: unknown, employeeId: Id | null, by = '店主'): { ok: boolean; reason?: string } {
  const entry = activeEntry(s);
  if (!entry) return { ok: false, reason: '店が見つかりません' };
  if (typeof day !== 'number' || !Number.isInteger(day)) return { ok: false, reason: '日にちが正しくありません' };
  const last = s.day + BALANCE.staff.calendarDays - 1;
  if (day < s.day || (day === s.day && s.phase === 'closed')) return { ok: false, reason: '過ぎた日の任命は変えられません' };
  if (day > last) return { ok: false, reason: `任命は${BALANCE.staff.calendarDays}日先まで決められます` };
  pruneDeputies(entry, s.day);
  const list = (entry.deputies ??= []);
  const i = list.findIndex((d) => d.day === day);
  if (employeeId === null) {
    if (i < 0) return { ok: false, reason: 'その日の店長代理はいません' };
    const prev = s.employees.find((x) => x.id === list[i]!.employeeId);
    list.splice(i, 1);
    if (list.length === 0) delete entry.deputies;
    notify(s, ctx, `deputy:${day}`, 'info', `${day}日目の店長代理${prev ? `（${prev.profile.name}さん）` : ''}の任命を取り消しました`);
    return { ok: true };
  }
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  if (isPartTime(e)) return { ok: false, reason: '店長代理にできるのは社員です' };
  if (entry.managerId === e.id) return { ok: false, reason: '店長は店長代理にできません' };
  if (shiftFor(e, day) === null) return { ok: false, reason: `${e.profile.name}さんは${day}日目が休みです。先に「この日だけ」の勤務を入れてください` };
  const ap: DeputyAppointment = { day, employeeId: e.id, by, atDay: s.day, atT: Math.round(s.t) };
  if (i >= 0) list[i] = ap;
  else list.push(ap);
  list.sort((a, b) => a.day - b.day);
  notify(s, ctx, `deputy:${day}`, 'good', `${e.profile.name}さんを${day === s.day ? '今日' : `${day}日目`}の店長代理にしました（店長がいない間、店長の仕事をします）`);
  return { ok: true };
}

/**
 * 朝の出勤確認のあと: 店長の欠勤（当日になって休みの連絡）が決まったら、その日に店を回す人を知らせる（じろ7 2-3「店長の無断欠勤」）。
 * 任命された店長代理 → 勤務のあるシフトリーダー → いなければ店長がいない店の扱い（今までどおり）
 */
export function noteManagerAbsence(s: GameState, ctx: SimCtx): void {
  const entry = activeEntry(s);
  if (!entry?.managerId) return;
  const mgr = s.employees.find((x) => x.id === entry.managerId);
  if (!mgr?.att || mgr.att.day !== s.day || !mgr.att.absent) return;
  const dep = deputyOn(entry, s.employees, s.day);
  const depOk = dep && dep.att && dep.att.day === s.day && !dep.att.absent ? dep : null;
  const leader = depOk ? null : s.employees.find((x) => x.id !== mgr.id && x.profile.role === 'leader' && x.att?.day === s.day && !x.att.absent && x.att.shift !== null);
  const who = depOk
    ? `店長代理の${depOk.profile.name}さんが今日の店を回します`
    : leader
      ? `シフトリーダーの${leader.profile.name}さんが店長の仕事を代わります`
      : '代わりに店を回す人がいません（社員を今日の店長代理に任命できます）';
  notify(s, ctx, `mgrAbsent:${s.day}`, depOk || leader ? 'info' : 'warn', `店長の${mgr.profile.name}さんが今日は欠勤です。${who}`);
}
