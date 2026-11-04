// 従業員の雇用形態・シフト・勤怠・辛抱・成長・履歴（第2版の 3〜5）。
// - 採用はアルバイトから（時給・曜日ごとのシフト）。プレイヤーが社員（日給・毎日・仕込みから閉店まで）に昇格させる
// - 隠しパラメータ「勤怠」（遅刻・当日欠勤・サボり・後回し・私的な休憩）と「辛抱」（クレーム対応での口論）。数値は画面に出さない
// - 抽選は 毎朝の出勤確認（遅刻・欠勤）・営業中の一定間隔（サボり・私的な休憩）・仕事を選ぶとき（後回し）・クレーム対応のとき（口論）だけ
// - 抽選はイベント専用の乱数（events.rng）で行い、既存の乱数（s.rng）の並びを変えない
// - 履歴には実際に起きた出来事だけを残す
// - 古いセーブの従業員（雇用形態がない）は社員として扱う（毎日・仕込みから閉店まで・日給。今までの経済と同じ）
//
// 注意: 読むだけの関数（*Of / staffSummary / promotionInfo / attendanceText など）は状態を変えない。client の共同経営の複製からも呼べる。

import { BALANCE } from '../data/balance';
import { stageOf } from '../geometry';
import type { Attendance, Employee, EmployeeSkills, Employment, GameState, ShiftDay, StaffLogEntry, StaffLogKind, StaffRecord } from '../types';
import { clamp01, hashString } from '../util';
import { startArrive, startLeave } from './commute';
import { dropHand } from './interact';
import { evRand } from './events';
import { emit, notify, type SimCtx } from './notices';

const ST = BALANCE.staff;
const MIN_PER_DAY = (BALANCE.closeHour - BALANCE.openHour) * 60;
/** ゲーム内の1分 = 営業の sim 秒 */
export const SEC_PER_MIN = BALANCE.openDuration / MIN_PER_DAY;
/** 退勤が閉店（15:00）のときの退勤時刻。閉店作業まで残る */
const UNTIL_CLOSE = 1e9;

export const WEEKDAY_LABEL = ['月', '火', '水', '木', '金', '土', '日'] as const;
export const EMPLOYMENT_LABEL: Record<Employment, string> = { part: 'アルバイト', full: '社員' };

/** その日の曜日（1日目 = 月曜 = 0） */
export function weekdayOf(day: number): number {
  return (((day - 1) % 7) + 7) % 7;
}

/** 開店からの分 → 時刻の文字列（0 → 11:00） */
export function shiftTimeText(min: number): string {
  const m = BALANCE.openHour * 60 + min;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

// ───────────────────────── 読むだけ ─────────────────────────

export function employmentOf(e: Employee): Employment {
  return e.profile.employment ?? 'full';
}

export function isPartTime(e: Employee): boolean {
  return employmentOf(e) === 'part';
}

/** 勤怠（社員は安定する）。古いセーブは「信頼性」を初期値として読む */
export function diligenceOf(e: Employee): number {
  const base = e.profile.diligence ?? e.profile.skills.reliability ?? 0.7;
  return clamp01(base + (isPartTime(e) ? 0 : ST.employment.fullTimeDiligenceBonus));
}

/** 辛抱。古いセーブにはないので、ID から決まった値を使う（乱数を使わない・何度読んでも同じ） */
export function patienceOf(e: Employee): number {
  if (e.profile.patience !== undefined) return clamp01(e.profile.patience);
  const h = (hashString(`patience:${e.id}`) % 1000) / 1000;
  return clamp01(ST.patience.mean - ST.patience.spread + 2 * ST.patience.spread * h);
}

/** 毎日・仕込みから閉店まで・休憩なし */
export function fullDayShift(): ShiftDay {
  return { start: 0, end: MIN_PER_DAY, breakAt: 0, breakLen: 0, fromPrep: true };
}

/** 曜日ごとのシフト（7日分）。古いセーブは毎日・全時間。社員は休みの曜日以外は毎日・仕込みから閉店まで */
export function shiftsOf(e: Employee): (ShiftDay | null)[] {
  if (!e.shifts) return Array.from({ length: 7 }, () => fullDayShift());
  if (!isPartTime(e)) return Array.from({ length: 7 }, (_, i) => (e.shifts![i] ? fullDayShift() : null));
  return Array.from({ length: 7 }, (_, i) => e.shifts![i] ?? null);
}

/** 社員の休みの曜日（月=0 … 日=6） */
export function restDaysOf(e: Employee): number[] {
  if (isPartTime(e) || !e.shifts) return [];
  return e.shifts.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
}

/** その曜日が希望の日か（アルバイトの希望シフト。社員・古いデータはいつでも） */
export function isWishDay(e: Employee, weekday: number): boolean {
  if (!isPartTime(e) || !e.profile.wishDays) return true;
  return e.profile.wishDays[weekday] !== false;
}

/** 疲れ（0〜1） */
export function fatigueOf(e: Employee): number {
  return clamp01(e.fatigue ?? 0);
}

/** 満足度（0〜1） */
export function moraleOf(e: Employee): number {
  return clamp01(e.morale ?? ST.morale.base);
}

/** 疲れの言葉（画面に出す） */
export function fatigueText(e: Employee): string {
  const f = fatigueOf(e);
  return f < 0.2 ? '元気' : f < 0.4 ? '少し疲れている' : f < 0.6 ? '疲れている' : 'とても疲れている';
}

/** 満足度の言葉（画面に出す。数値は出さない） */
export function moraleText(e: Employee): string {
  const m = moraleOf(e);
  return m >= 0.7 ? '満足' : m >= 0.55 ? 'ふつう' : m >= ST.morale.quitBelow ? '不満がある' : '辞めたがっている';
}

/** 疲れによる作業の速さの倍率 */
export function fatigueSpeed(e: Employee): number {
  return 1 - ST.fatigue.speedPenalty * fatigueOf(e);
}

/** 社員の休みの曜日を決める（その曜日は来ない・日給もかからない）。週に6日以下にはできない（毎日休みはできない） */
export function setRestDays(s: GameState, ctx: SimCtx, employeeId: string, days: unknown): { ok: boolean; reason?: string } {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  if (isPartTime(e)) return { ok: false, reason: 'アルバイトはシフトで休みを決めます' };
  if (!Array.isArray(days) || days.length > 6 || !days.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) return { ok: false, reason: '休みの曜日が正しくありません（週に1日は出勤）' };
  const rest = new Set(days as number[]);
  const before = shiftFor(e, s.day);
  e.shifts = Array.from({ length: 7 }, (_, i) => (rest.has(i) ? null : fullDayShift()));
  if (rest.size === 0) delete e.shifts;
  if (JSON.stringify(before) !== JSON.stringify(shiftFor(e, s.day))) reapplyToday(s, e, ctx);
  return { ok: true };
}

/** その日のシフト（日にちごとの予定があればそれ、なければ曜日ごとのくりかえし） */
export function shiftFor(e: Employee, day: number): ShiftDay | null {
  // 通常の採用は、採用の2日後から出勤できる（それまでは手続き・研修で来ない）
  if (e.availableFrom !== undefined && day < e.availableFrom) return null;
  if (isPartTime(e) && e.dateShifts && Object.prototype.hasOwnProperty.call(e.dateShifts, String(day))) return e.dateShifts[String(day)] ?? null;
  return shiftsOf(e)[weekdayOf(day)] ?? null;
}

/** その日が日にちごとの予定か（くりかえしと違う予定を入れた日） */
export function hasDateShift(e: Employee, day: number): boolean {
  return isPartTime(e) && !!e.dateShifts && Object.prototype.hasOwnProperty.call(e.dateShifts, String(day));
}

/** 過ぎた日の日にちごとの予定を消す */
export function pruneDateShifts(e: Employee, today: number): void {
  if (!e.dateShifts) return;
  for (const k of Object.keys(e.dateShifts)) if (Number(k) < today) delete e.dateShifts[k];
  if (Object.keys(e.dateShifts).length === 0) delete e.dateShifts;
}

/** シフトの形を確かめる。正しければ null */
export function shiftProblem(sh: ShiftDay): string | null {
  const step = ST.shiftStepMin;
  const ok = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v % step === 0;
  if (!ok(sh.start) || !ok(sh.end) || !ok(sh.breakAt) || !ok(sh.breakLen)) return `時刻は${step}分刻みで指定してください`;
  if (typeof sh.fromPrep !== 'boolean') return 'シフトの形が正しくありません';
  if (sh.start < 0 || sh.end > MIN_PER_DAY || sh.end - sh.start < step) return '出勤から退勤まで30分以上、営業時間（11:00〜15:00）の中で指定してください';
  if (sh.fromPrep && sh.start !== 0) return '仕込みから出勤するときは、営業は11:00からになります';
  if (sh.breakLen < 0 || sh.breakLen > 60) return '休憩は60分までです';
  if (sh.breakLen > 0 && (sh.breakAt <= sh.start || sh.breakAt + sh.breakLen >= sh.end)) return '休憩は勤務の途中に入れてください';
  return null;
}

/** シフトの給与の対象時間（時間） */
export function shiftPaidHours(sh: ShiftDay | null): number {
  if (!sh) return 0;
  return (sh.end - sh.start - (sh.breakLen > 0 ? sh.breakLen : 0)) / 60 + (sh.fromPrep ? ST.employment.prepPaidHours : 0);
}

/** 時給（アルバイト）。古いデータは日給から換算 */
export function hourlyOf(e: Employee): number {
  return e.profile.hourly ?? Math.round(e.profile.wage / ST.employment.fullShiftHours / 10) * 10;
}

/** その日の給与の見込み（予定どおりに働いた場合） */
export function expectedPay(e: Employee, day: number): number {
  if (!isPartTime(e)) return shiftFor(e, day) ? e.profile.wage : 0;
  return Math.round((hourlyOf(e) * shiftPaidHours(shiftFor(e, day))) / 10) * 10;
}

/** 1日分の給与の目安（解雇手当・一覧の表示）。アルバイトは仕込みから閉店まで働いた額 */
export function dailyWageOf(e: Employee): number {
  if (!isPartTime(e)) return e.profile.wage;
  return Math.round((hourlyOf(e) * ST.employment.fullShiftHours) / 10) * 10;
}

/** 社員にしたときの日給 */
export function fullTimeWageFor(e: Employee): number {
  return Math.round((hourlyOf(e) * ST.employment.fullShiftHours * ST.employment.fullTimeRaise) / 500) * 500;
}

/** 実際に働いた分の給与（閉店後の精算） */
export function payDue(e: Employee, s: GameState): number {
  const a = e.att;
  if (!isPartTime(e)) {
    // 社員は休まなければ日給（遅刻しても減らさない）。このバージョンより前の状態（出勤の記録がない）は出勤していれば払う
    if (!a || a.day !== s.day) return e.presentToday ? e.profile.wage : 0;
    // 休みの曜日（今日の予定がない日）は日給なし。工事の休業日は出勤するので払う。休みの日に呼び出したら払う
    if (a.status !== 'closed' && !a.calledIn && a.shift === null) return 0;
    return a.absent ? 0 : e.profile.wage;
  }
  if (!a || a.day !== s.day) return 0;
  const hours = a.workedSec / (60 * SEC_PER_MIN) + (a.prepWorked ? ST.employment.prepPaidHours : 0);
  return Math.round((hourlyOf(e) * hours) / 10) * 10;
}

const EMPTY_RECORD: StaffRecord = { daysWorked: 0, daysScheduled: 0, late: 0, absent: 0, slack: 0, postpone: 0, argue: 0, rude: 0, abandon: 0, calm: 0, complaintsSettled: 0, served: 0, log: [] };

export function recordOf(e: Employee): StaffRecord {
  return e.record ?? EMPTY_RECORD;
}

function countRecent(e: Employee, s: GameState, kinds: StaffLogKind[], days: number): number {
  return recordOf(e).log.filter((l) => kinds.includes(l.kind) && l.day > s.day - days).length;
}

/**
 * 勤務の様子（履歴から作る文。数値の勤怠・辛抱は出さない）。実際に起きた出来事だけから作る
 */
export function staffSummary(e: Employee, s: GameState): string[] {
  const r = recordOf(e);
  const out: string[] = [];
  if (r.daysWorked === 0 && r.log.length === 0) return ['まだ勤務の記録がありません'];
  out.push(`勤務 ${r.daysWorked}日`);
  const recentAbsent = countRecent(e, s, ['absent'], 7);
  if (r.absent === 0) out.push('これまで欠勤はありません');
  else if (recentAbsent >= 2) out.push(`最近、欠勤が続いています（直近7日で${recentAbsent}回）`);
  else out.push(`欠勤 ${r.absent}回`);
  if (r.late === 0) out.push('これまで遅刻はありません');
  else out.push(`遅刻 ${r.late}回${countRecent(e, s, ['late'], 7) >= 2 ? '（最近多い）' : ''}`);
  if (r.slack > 0) out.push(`勤務中にサボっていたことが ${r.slack}回あります`);
  if (r.postpone > 0) out.push('仕事を後回しにすることがあります');
  if (r.calm > 0) out.push(`クレーム対応を冷静にこなしました（${r.calm}回）`);
  if (r.argue > 0) out.push(`客との口論が発生しました（${r.argue}回）`);
  if ((r.rude ?? 0) > 0) out.push(`クレーム対応で客への態度が悪いことがありました（${r.rude}回）`);
  if ((r.abandon ?? 0) > 0) out.push(`クレーム対応を途中で放棄したことがあります（${r.abandon}回）`);
  if (r.served > 0) out.push(`提供 ${r.served}杯`);
  return out;
}

/** 新しい順の履歴 */
export function staffLog(e: Employee, n = 8): StaffLogEntry[] {
  return [...recordOf(e).log].reverse().slice(0, n);
}

/** 担当の仕事の能力 */
export function roleSkill(e: Employee): number {
  const sk = e.profile.skills;
  return e.profile.role === 'cook' || e.profile.role === 'prep' ? sk.cooking : e.profile.role === 'server' ? sk.service : sk.hygiene;
}

export interface PromotionCheck {
  label: string;
  ok: boolean;
}

/** 昇格の参考情報（目安を満たしているか。昇格を決めるのはプレイヤー） */
export function promotionInfo(e: Employee, s: GameState): { checks: PromotionCheck[]; newWage: number; canPromote: string | null } {
  const g = ST.promotionGuide;
  const r = recordOf(e);
  const lateAbsent = countRecent(e, s, ['late', 'absent'], g.recentDays);
  const trouble = r.argue + (r.rude ?? 0) + (r.abandon ?? 0);
  const checks: PromotionCheck[] = [
    { label: `勤務 ${g.minDaysWorked}日以上（${r.daysWorked}日）`, ok: r.daysWorked >= g.minDaysWorked },
    { label: `直近${g.recentDays}日の遅刻・欠勤が${g.maxLateAbsent}回以下（${lateAbsent}回）`, ok: lateAbsent <= g.maxLateAbsent },
    { label: g.maxSlack > 0 ? `サボりが${g.maxSlack}回以下（${r.slack}回）` : `サボりがない（${r.slack}回）`, ok: r.slack <= g.maxSlack },
    { label: g.maxArgue > 0 ? `客との口論・態度の問題が${g.maxArgue}回以下（${trouble}回）` : `客との口論・態度の問題がない（${trouble}回）`, ok: trouble <= g.maxArgue },
    { label: `担当の仕事の能力が ${Math.round(g.minRoleSkill * 100)} 以上（${Math.round(roleSkill(e) * 100)}）`, ok: roleSkill(e) >= g.minRoleSkill },
  ];
  return { checks, newWage: fullTimeWageFor(e), canPromote: promoteProblem(s, e) };
}

function promoteProblem(s: GameState, e: Employee): string | null {
  if (!isPartTime(e)) return 'すでに社員です';
  if (e.profile.temp) return '短期バイトは社員にできません（今日だけ来る人です）';
  if (s.phase === 'open' || s.phase === 'closing') return '営業中は昇格できません';
  return null;
}

export const ATTENDANCE_LABEL: Record<Attendance['status'], string> = {
  off: '休み',
  scheduled: '出勤前',
  late: '遅刻',
  working: '勤務中',
  break: '休憩中',
  left: '退勤',
  absent: '欠勤',
  closed: '休業',
};

/** 当日の出勤の状況（画面の表示） */
export function attendanceText(e: Employee, s: GameState): string {
  const a = e.att;
  if (!a || a.day !== s.day) return e.presentToday ? '勤務中' : '休み';
  const sh = a.shift;
  const hours = sh ? `${sh.fromPrep ? '仕込み' : shiftTimeText(sh.start)}〜${shiftTimeText(sh.end)}` : '';
  switch (a.status) {
    case 'off':
      return e.availableFrom !== undefined && s.day < e.availableFrom ? `${e.availableFrom}日目から出勤（採用の手続き中）` : '今日は休み';
    case 'absent':
      return '当日欠勤';
    case 'closed':
      return '休業日';
    case 'late':
      return `遅刻（${shiftTimeText(Math.round((a.arriveAt < 0 ? 0 : a.arriveAt) / SEC_PER_MIN))}ごろ到着の見込み）`;
    case 'scheduled':
      return `${hours} の予定`;
    case 'break':
      return `休憩中（${shiftTimeText(Math.round(a.breakTo / SEC_PER_MIN))}まで）`;
    case 'left':
      return '退勤済み';
    case 'working':
      if (e.conduct?.kind && e.conduct.until > s.openT) return e.conduct.kind === 'private' ? '持ち場を離れている' : '手が止まっている';
      return `勤務中（${hours}）`;
  }
}

// ───────────────────────── 状態を変える（シミュレーションの中だけ） ─────────────────────────

function ensureRecord(e: Employee): StaffRecord {
  if (!e.record) e.record = { ...EMPTY_RECORD, log: [] };
  return e.record;
}

/** 出来事を記録する（実際に起きたことだけ） */
export function logStaff(s: GameState, e: Employee, kind: StaffLogKind, text: string): void {
  const r = ensureRecord(e);
  switch (kind) {
    case 'late':
    case 'absent':
    case 'slack':
    case 'postpone':
    case 'argue':
    case 'calm':
      r[kind] += 1;
      break;
    case 'rude':
    case 'abandon':
      r[kind] = (r[kind] ?? 0) + 1;
      break;
    case 'private':
      r.slack += 1;
      break;
    default:
      break;
  }
  r.log.push({ day: s.day, kind, text });
  if (r.log.length > ST.logMax) r.log.splice(0, r.log.length - ST.logMax);
}

/** 新しく採用した人の初期値（雇用形態・シフト・時給・隠しパラメータ） */
export function initNewHire(e: Employee): void {
  const p = e.profile;
  p.employment = ST.employment.hireAs;
  p.hourly = p.hourly ?? Math.round(p.wage / ST.employment.fullShiftHours / 10) * 10;
  // 初めのシフトは、希望の曜日だけ・仕込みから閉店まで（希望のない人は毎日）
  e.shifts = Array.from({ length: 7 }, (_, i) => (isWishDay(e, i) ? fullDayShift() : null));
}

/**
 * 勤務を離れる（作業中なら終わるまで待つ）。離れられたら true。
 * あいさつ（退勤・休憩）をしてから歩いて店の外へ出る（commute.ts）。もう店の外にいる人はそのまま
 */
function leaveFloor(s: GameState, e: Employee, ctx: SimCtx, kind: 'leave' | 'break' | 'away'): boolean {
  if (e.work) return false;
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
  if (e.hand.kind !== 'none') dropHand(s, e, ctx);
  e.hand = { kind: 'none' };
  if (!e.presentToday) {
    e.commute = null;
    return true;
  }
  // すでに同じ向きで出ていく途中なら、そのまま
  if (e.commute && (e.commute.kind === 'leave' || e.commute.kind === 'break' || e.commute.kind === 'away') && e.commute.kind === kind) return true;
  startLeave(s, e, kind);
  return true;
}

/** 店に入る（出勤・休憩から戻る・持ち場に戻る）。歩道から歩いて来て、あいさつと手洗いをしてから働き始める */
function arriveFloor(s: GameState, e: Employee, kind: 'arrive' | 'return' | 'back', order = 0): void {
  startArrive(s, e, kind, order);
}

/** その日の予定から時刻を決める（引いた結果 absent / lateMin はそのまま使う） */
function planTimes(a: Attendance, sh: ShiftDay | null): void {
  a.shift = sh;
  if (!sh) {
    a.arriveAt = a.leaveAt = a.breakFrom = a.breakTo = -1;
    return;
  }
  const late = Math.min(a.lateMin, Math.max(0, sh.end - sh.start - 15));
  a.arriveAt = sh.fromPrep && late === 0 ? -1 : (sh.start + late) * SEC_PER_MIN;
  a.leaveAt = sh.end >= MIN_PER_DAY ? UNTIL_CLOSE : sh.end * SEC_PER_MIN;
  if (sh.breakLen > 0) {
    a.breakFrom = sh.breakAt * SEC_PER_MIN;
    a.breakTo = (sh.breakAt + sh.breakLen) * SEC_PER_MIN;
  } else {
    a.breakFrom = a.breakTo = -1;
  }
}

function lastLogDay(e: Employee, kind: StaffLogKind): number {
  const log = recordOf(e).log;
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.kind === kind) return log[i]!.day;
  return -1e9;
}

/** 遅刻・欠勤の確率（勤怠から） */
export function attendanceChances(e: Employee): { absent: number; late: number } {
  const A = ST.attendance;
  const d = diligenceOf(e);
  // 疲れ・不満で増える（オーナーの判断 12・13）
  const M = ST.morale;
  const tired = 1 + ST.fatigue.absentMult * fatigueOf(e);
  const unhappy = 1 + M.attendanceMult * Math.max(0, (M.base - moraleOf(e)) / M.base);
  const k = tired * unhappy;
  return { absent: clamp01(A.absentMax * Math.pow(1 - d, A.exponent) * k), late: clamp01(A.lateMax * Math.pow(1 - d, A.exponent) * k) };
}

/** サボり・私的な休憩の確率（1回の抽選） */
export function conductChance(e: Employee): number {
  return ST.conduct.chanceMax * Math.pow(1 - diligenceOf(e), ST.attendance.exponent + 0.5);
}

/** 後回しの確率（仕事を選ぶとき1回） */
export function postponeChance(e: Employee): number {
  return ST.conduct.postponeMax * Math.pow(1 - diligenceOf(e), ST.attendance.exponent + 0.5);
}

/** 口論の確率（クレーム対応のとき1回） */
export function argueChance(e: Employee, unreasonable: boolean, complaintPropensity: number): number {
  const T = ST.temper;
  const prop = T.propensityFrom + (T.propensityTo - T.propensityFrom) * clamp01(complaintPropensity);
  return clamp01(T.argueMax * Math.pow(1 - patienceOf(e), T.exponent) * (unreasonable ? T.unreasonableMult : 1) * prop);
}

/**
 * 毎朝の出勤確認（翌日へ進んで仕込みが始まるとき）。予定のある人だけ、欠勤 → 遅刻 の順に1回だけ引く。
 * 同じ人が続けて欠勤・遅刻しないよう、前に起きた日から一定の日数は引かない
 */
export function rollCall(s: GameState, ctx: SimCtx): void {
  const st = stageOf(s);
  const A = ST.attendance;
  const construction = s.closedForConstruction > 0;
  // 仕込みから来る人は、歩道から順に歩いて来る（遠くから来る人ほど遅れて着く）
  let order = 0;
  for (const e of s.employees) {
    pruneDateShifts(e, s.day);
    e.pos = { x: st.staffSpawn.x + 0.2, z: st.staffSpawn.z + 0.2 };
    e.hand = { kind: 'none' };
    e.work = null;
    e.commute = null;
    e.ai.taskId = null;
    e.ai.steps = [];
    e.ai.path = [];
    e.ai.stuckTime = 0;
    delete e.ai.failed;
    e.say = null;
    const sh = shiftFor(e, s.day);
    const a: Attendance = {
      day: s.day,
      shift: null,
      absent: false,
      lateMin: 0,
      status: 'off',
      arriveAt: -1,
      leaveAt: -1,
      breakFrom: -1,
      breakTo: -1,
      arrived: false,
      workedSec: 0,
      prepWorked: false,
      calledIn: false,
      lateNoted: false,
    };
    e.att = a;
    e.conduct = { nextCheck: ST.conduct.checkEvery * (0.5 + evRand(s)), until: -1, kind: null, lastAt: -1e9, today: 0, day: s.day };
    if (construction) {
      // 工事の休業日: アルバイトは来ない。社員は今までどおり（給与あり）
      a.status = 'closed';
      e.presentToday = false;
      e.ai.state = 'off';
      if (!isPartTime(e)) arriveFloor(s, e, 'arrive', order++);
      continue;
    }
    if (!sh) {
      a.status = 'off';
      e.presentToday = false;
      e.ai.state = 'off';
      continue;
    }
    ensureRecord(e).daysScheduled += 1;
    const ch = attendanceChances(e);
    const tutorial = !!s.tutorial;
    if (!tutorial && s.day - lastLogDay(e, 'absent') > A.absentGapDays && evRand(s) < ch.absent) {
      a.absent = true;
      a.status = 'absent';
      planTimes(a, sh);
      e.presentToday = false;
      e.ai.state = 'absent';
      logStaff(s, e, 'absent', '当日になって欠勤の連絡があった');
      notify(s, ctx, `absent:${e.id}`, 'warn', `${e.profile.name}さんから連絡: 今日は休みます（当日欠勤）`);
      continue;
    }
    if (!tutorial && s.day - lastLogDay(e, 'late') > A.lateGapDays && evRand(s) < ch.late) {
      a.lateMin = Math.round((A.lateMinFrom + (A.lateMinTo - A.lateMinFrom) * evRand(s)) / 5) * 5;
    }
    planTimes(a, sh);
    if (a.arriveAt < 0) {
      // 仕込みから出勤
      a.arrived = true;
      a.prepWorked = true;
      a.status = 'working';
      e.presentToday = false;
      arriveFloor(s, e, 'arrive', order++);
    } else {
      a.status = a.lateMin > 0 ? 'late' : 'scheduled';
      e.presentToday = false;
      e.ai.state = 'off';
    }
  }
}

/**
 * 閉店してお客さんがいなくなったら、店に残っている全員が「お疲れ様でした！」と言って歩いて帰る。
 * 全員が店の外へ出たら（詰まっても打ち切りの秒数を過ぎたら）true（このあと精算する）
 */
export function sendStaffHome(s: GameState, ctx: SimCtx): boolean {
  s.closeWaitSince ??= s.t;
  let staying = 0;
  for (const e of s.employees) {
    if (!e.presentToday) continue;
    if (!(e.commute && e.commute.kind === 'leave')) {
      if (e.conduct?.kind) e.conduct.kind = null;
      leaveFloor(s, e, ctx, 'leave');
    }
    if (e.presentToday) staying += 1;
  }
  if (staying === 0 || s.t - s.closeWaitSince > BALANCE.commute.closeWaitMax) {
    delete s.closeWaitSince;
    for (const e of s.employees) {
      e.commute = null;
      e.presentToday = false;
    }
    return true;
  }
  return false;
}

/** このバージョンより前の状態（出勤の記録がない）で始まった日の従業員に、出勤の記録を補う（出勤していれば一日中いる扱い） */
function ensureAttendance(s: GameState, e: Employee): Attendance {
  if (e.att && e.att.day === s.day) return e.att;
  const sh = e.presentToday ? (shiftFor(e, s.day) ?? fullDayShift()) : null;
  const a: Attendance = {
    day: s.day,
    shift: null,
    absent: !e.presentToday,
    lateMin: 0,
    status: e.presentToday ? 'working' : 'absent',
    arriveAt: -1,
    leaveAt: -1,
    breakFrom: -1,
    breakTo: -1,
    arrived: e.presentToday,
    workedSec: 0,
    prepWorked: e.presentToday,
    calledIn: false,
    lateNoted: false,
  };
  planTimes(a, sh);
  e.att = a;
  return a;
}

/** 採用した日（仕込み中）の出勤の記録 */
export function attendHireDay(s: GameState, e: Employee): void {
  const a: Attendance = {
    day: s.day,
    shift: null,
    absent: false,
    lateMin: 0,
    status: 'off',
    arriveAt: -1,
    leaveAt: -1,
    breakFrom: -1,
    breakTo: -1,
    arrived: false,
    workedSec: 0,
    prepWorked: false,
    calledIn: false,
    lateNoted: false,
  };
  e.att = a;
  e.conduct = { nextCheck: ST.conduct.checkEvery, until: -1, kind: null, lastAt: -1e9, today: 0, day: s.day };
  if (s.phase !== 'prep') {
    e.presentToday = false;
    e.ai.state = 'off';
    return;
  }
  const sh = shiftFor(e, s.day);
  planTimes(a, sh);
  if (!sh) {
    e.presentToday = false;
    e.ai.state = 'off';
    return;
  }
  ensureRecord(e).daysScheduled += 1;
  if (a.arriveAt < 0) {
    a.arrived = true;
    a.prepWorked = true;
    a.status = 'working';
    e.presentToday = false;
    arriveFloor(s, e, 'arrive');
  } else {
    a.status = 'scheduled';
    e.presentToday = false;
    e.ai.state = 'off';
  }
}

/**
 * 出勤・退勤・休憩・サボり（step から毎回呼ぶ。抽選は一定間隔だけ）。presentToday を「今、店で働いている」に保つ
 */
export function updateAttendance(s: GameState, dt: number, ctx: SimCtx): void {
  if (s.employees.length === 0) return;
  const t = s.openT;
  for (const e of s.employees) {
    const a = ensureAttendance(s, e);
    if (a.status === 'off' || a.status === 'absent' || a.status === 'closed') continue;
    if (s.phase === 'prep') continue;
    if (s.phase === 'open') {
      if (!a.arrived) {
        if (a.arriveAt >= 0 && t >= a.arriveAt && t < a.leaveAt) {
          a.arrived = true;
          a.status = 'working';
          arriveFloor(s, e, 'arrive');
          if (a.lateMin > 0 && !a.lateNoted) {
            a.lateNoted = true;
            logStaff(s, e, 'late', `${a.lateMin}分遅刻して出勤した`);
            notify(s, ctx, `late:${e.id}`, 'info', `${e.profile.name}さんが${a.lateMin}分遅れて出勤しました`);
          }
          emit(ctx, { type: 'staffArrive', actorId: e.id });
        } else {
          if (a.lateMin > 0 && !a.lateNoted && a.shift && t >= (a.shift.fromPrep ? 0 : a.shift.start * SEC_PER_MIN)) {
            // 出勤の時刻になっても来ていない
            notify(s, ctx, `late:${e.id}`, 'warn', `${e.profile.name}さんがまだ来ていません（遅刻）`);
          }
          continue;
        }
      }
      if (a.status === 'left') continue;
      // 給与の対象の時間: 出勤〜退勤の予定のうち、休憩を除いた部分（時間の刻みに左右されないよう、区間の重なりで数える）
      a.workedSec += paidOverlap(a, t - dt, t);
      // 退勤（「お疲れ様でした！」と言って歩いて帰る）
      if (t >= a.leaveAt) {
        if (e.conduct?.kind) e.conduct.kind = null;
        if (leaveFloor(s, e, ctx, 'leave')) {
          a.status = 'left';
          emit(ctx, { type: 'staffLeave', actorId: e.id });
        }
        continue;
      }
      // 休憩（「休憩いただきます！」で外へ。終わったら「戻りました！」で戻って手を洗う）
      const inBreak = a.breakFrom >= 0 && t >= a.breakFrom && t < a.breakTo;
      if (inBreak && a.status !== 'break') {
        if (e.conduct?.kind) e.conduct.kind = null;
        if (leaveFloor(s, e, ctx, 'break')) a.status = 'break';
      } else if (!inBreak && a.status === 'break') {
        a.status = 'working';
        arriveFloor(s, e, 'return');
      }
      if (a.status === 'break') continue;
      updateConduct(s, e, ctx);
    } else if (s.phase === 'closing') {
      // 閉店作業: 閉店まで働く人だけ残る。休憩中の人は戻る
      if (a.status === 'break') {
        a.status = 'working';
        arriveFloor(s, e, 'return');
      }
      if (e.conduct?.kind) endConduct(s, e);
      if (a.arrived && a.status !== 'left' && a.leaveAt < UNTIL_CLOSE && leaveFloor(s, e, ctx, 'leave')) a.status = 'left';
    }
  }
}

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** [from, to) のうち、出勤してから退勤の予定まで・休憩を除いた時間 */
function paidOverlap(a: Attendance, from: number, to: number): number {
  const inAt = Math.max(0, a.arriveAt);
  const outAt = Math.min(a.leaveAt, BALANCE.openDuration);
  let sec = overlap(from, to, inAt, outAt);
  if (a.breakFrom >= 0) sec -= overlap(from, to, Math.max(inAt, a.breakFrom), Math.min(outAt, a.breakTo));
  return Math.max(0, sec);
}

function endConduct(s: GameState, e: Employee): void {
  const c = e.conduct!;
  const wasPrivate = c.kind === 'private';
  c.kind = null;
  c.until = -1;
  e.ai.state = 'idle';
  // 勝手に持ち場を離れていた人は歩いて戻り、手を洗ってから働く
  if (wasPrivate) arriveFloor(s, e, 'back');
}

/** サボり・私的な休憩（一定間隔で抽選。作業の途中・手に物を持っているときは始めない） */
function updateConduct(s: GameState, e: Employee, ctx: SimCtx): void {
  const C = ST.conduct;
  const c = (e.conduct ??= { nextCheck: s.openT + C.checkEvery, until: -1, kind: null, lastAt: -1e9, today: 0, day: s.day });
  if (c.day !== s.day) {
    c.day = s.day;
    c.today = 0;
  }
  if (c.kind) {
    if (s.openT >= c.until) endConduct(s, e);
    return;
  }
  if (e.commute) return;
  if (s.openT < c.nextCheck) return;
  c.nextCheck = s.openT + C.checkEvery;
  if (s.tutorial || c.today >= C.maxPerDay || s.openT - c.lastAt < C.gap) return;
  if (e.work || e.hand.kind !== 'none' || e.ai.steps.length > 0) return;
  if (evRand(s) >= conductChance(e)) return;
  const kind = evRand(s) < C.privateShare ? 'private' : 'slack';
  c.kind = kind;
  c.until = s.openT + C.durationFrom + (C.durationTo - C.durationFrom) * evRand(s);
  c.lastAt = s.openT;
  c.today += 1;
  e.ai.taskId = null;
  e.ai.steps = [];
  e.ai.path = [];
  e.ai.state = 'slacking';
  if (kind === 'private') {
    // 何も言わずに歩いて店の外へ
    startLeave(s, e, 'away');
    e.ai.note = '持ち場を離れている';
    logStaff(s, e, 'private', '勤務中に勝手に休憩に行った');
    notify(s, ctx, `conduct:${e.id}`, 'info', `${e.profile.name}さんが持ち場を離れました`);
  } else {
    e.ai.note = 'スマホを見ている';
    logStaff(s, e, 'slack', '勤務中にスマホを見てサボっていた');
    notify(s, ctx, `conduct:${e.id}`, 'info', `${e.profile.name}さんの手が止まっています`);
  }
}

/** サボっている間は仕事を選ばない（updateEmployees から） */
export function isSlacking(e: Employee, s: GameState): boolean {
  return !!e.conduct?.kind && e.conduct.until > s.openT && s.phase === 'open';
}

/** 仕事を選ぶときの後回し（当たれば少し待つ）。当たったら true */
export function rollPostpone(s: GameState, e: Employee): boolean {
  if (s.phase !== 'open' || s.tutorial) return false;
  if (evRand(s) >= postponeChance(e)) return false;
  const C = ST.conduct;
  e.ai.cooldown = C.postponeDelayFrom + (C.postponeDelayTo - C.postponeDelayFrom) * evRand(s);
  e.ai.note = '仕事を後回しにしている';
  e.ai.state = 'idle';
  const today = recordOf(e).log.filter((l) => l.kind === 'postpone' && l.day === s.day).length;
  if (today < C.postponeLogPerDay) logStaff(s, e, 'postpone', '指示された仕事を後回しにしていた');
  else ensureRecord(e).postpone += 1;
  return true;
}

/** 閉店後の精算のときの記録（勤務日数・経験） */
export function closeStaffDay(s: GameState): void {
  for (const e of s.employees) {
    const a = e.att;
    const worked = a && a.day === s.day ? !a.absent && (a.workedSec > 0 || a.prepWorked || (a.status === 'closed' && !isPartTime(e))) : e.presentToday;
    const share = a && a.day === s.day ? clamp01((a.workedSec + (a.prepWorked ? BALANCE.openDuration * 0.1 : 0)) / BALANCE.openDuration) : worked ? 1 : 0;
    endOfDayWellbeing(s, e, worked, a?.status === 'closed' ? 1 : share);
    if (!worked) continue;
    ensureRecord(e).daysWorked += 1;
    e.profile.experience = Math.min(1, e.profile.experience + ST.experiencePerDay);
  }
}

/**
 * 1日の終わりの疲れと満足度（細かいシミュレーションの精算と、店長の営業の両方から呼ぶ。同じ規則）。
 * worked: その日に働いたか、share: 働いた割合（0〜1）
 */
export function endOfDayWellbeing(s: GameState, e: Employee, worked: boolean, share: number): void {
  const F = ST.fatigue;
  const M = ST.morale;
  const f = fatigueOf(e);
  e.fatigue = clamp01(worked ? f * F.keepWorking + F.gainPerDay * clamp01(share) : f * F.keepResting);
  let m = moraleOf(e);
  m += (M.base - m) * M.approach;
  if (worked && !isWishDay(e, weekdayOf(s.day))) {
    m -= M.offWishPenalty;
    logStaff(s, e, 'offWish', '希望していない曜日に働いた');
  }
  if (worked) m -= M.fatiguePenalty * e.fatigue;
  e.morale = clamp01(m);
}

/**
 * 不満がたまった人が辞める（毎朝、出勤の確認の前に1回だけ引く）。辞めた人の名前を返す。
 * 解雇ではないので解雇手当はない。辞めた人のその日の給与はない
 */
export function checkQuits(s: GameState, ctx: SimCtx | null): string[] {
  const M = ST.morale;
  const out: string[] = [];
  if (s.tutorial) return out;
  s.employees = s.employees.filter((e) => {
    const m = moraleOf(e);
    if (m >= M.quitBelow) return true;
    if (evRand(s) >= (M.quitBelow - m) * M.quitPerDay) return true;
    out.push(e.profile.name);
    if (ctx) notify(s, ctx, `quit:${e.id}`, 'danger', `${e.profile.name}さんが辞めました（不満がたまっていました。希望していない曜日の勤務や疲れが続くと辞めやすくなります）`);
    return false;
  });
  // 辞めた人が店長だった店は、店長がいなくなる
  if (out.length > 0) {
    const ids = new Set(s.employees.map((e) => e.id));
    for (const st of s.company?.stores ?? []) if (st.managerId && st.snapshot === null && !ids.has(st.managerId)) st.managerId = null;
  }
  return out;
}

/** 給与の合計（閉店後の精算） */
export function wagesDueToday(s: GameState): number {
  return s.employees.reduce((sum, e) => sum + payDue(e, s), 0);
}

/** 当日（または翌日）の給与の見込み */
export function expectedWages(s: GameState, day: number): number {
  return s.employees.reduce((sum, e) => sum + expectedPay(e, day), 0);
}

/** 仕事の経験による成長（作業1回ごと。1日の上限あり） */
export function growFromWork(s: GameState, e: Employee, kind: 'cook' | 'clean' | 'service' | 'general', verb: string): void {
  const per = ST.growth.perUnit;
  const targets: (keyof typeof per)[] = kind === 'cook' ? ['cooking'] : kind === 'clean' ? ['hygiene'] : kind === 'service' ? ['service'] : [];
  // 配膳・運ぶ仕事は速さと移動
  if (verb === 'serve' || verb === 'collect' || verb === 'bowls_take' || verb === 'bowls_return' || kind === 'general') targets.push('speed', 'movement');
  if (targets.length === 0) return;
  const g = (e.growth && e.growth.day === s.day ? e.growth : (e.growth = { day: s.day, gained: {} })).gained;
  for (const k of targets) {
    const sk = e.profile.skills as EmployeeSkills;
    const cur = sk[k];
    const room = ST.growth.dailyCap - (g[k] ?? 0);
    if (room <= 0) continue;
    const inc = Math.min(room, per[k] * (1 - cur));
    if (inc <= 0) continue;
    sk[k] = clamp01(cur + inc);
    g[k] = (g[k] ?? 0) + inc;
  }
}

/** 社員にする */
export function promote(s: GameState, ctx: SimCtx, employeeId: string): { ok: boolean; reason?: string } {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  const p = promoteProblem(s, e);
  if (p) return { ok: false, reason: p };
  e.profile.wage = fullTimeWageFor(e);
  e.profile.employment = 'full';
  // 社員は毎日・仕込みから閉店まで（休みの曜日はあとで決める）
  delete e.shifts;
  delete e.dateShifts;
  logStaff(s, e, 'promoted', `社員になった（日給 ¥${e.profile.wage.toLocaleString('ja-JP')}）`);
  // 今日の予定は社員の勤務（毎日・仕込みから閉店まで）に変える。仕込み中なら今から出勤
  if (s.phase === 'prep') reapplyToday(s, e, ctx);
  emit(ctx, { type: 'promote', text: e.profile.name });
  notify(s, ctx, `promote:${e.id}`, 'good', `${e.profile.name}さんを社員にしました（日給 ¥${e.profile.wage.toLocaleString('ja-JP')}）`);
  return { ok: true };
}

/** シフトを設定する（null で削除＝その曜日は休み）。アルバイトだけ */
export function setShift(s: GameState, ctx: SimCtx, employeeId: string, weekday: number, shift: ShiftDay | null): { ok: boolean; reason?: string } {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  if (!isPartTime(e)) return { ok: false, reason: '社員は毎日、仕込みから閉店まで勤務します' };
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { ok: false, reason: '曜日が正しくありません' };
  let sh: ShiftDay | null = null;
  if (shift) {
    sh = { start: shift.start, end: shift.end, breakAt: shift.breakLen > 0 ? shift.breakAt : 0, breakLen: shift.breakLen, fromPrep: shift.fromPrep };
    const bad = shiftProblem(sh);
    if (bad) return { ok: false, reason: bad };
  }
  const before = shiftFor(e, s.day);
  const list = shiftsOf(e);
  list[weekday] = sh;
  e.shifts = list;
  if (weekday === weekdayOf(s.day) && JSON.stringify(before) !== JSON.stringify(shiftFor(e, s.day))) reapplyToday(s, e, ctx);
  return { ok: true };
}

export type DateShiftMode = 'once' | 'weekly' | 'reset';

/**
 * 日にちを選んでシフトを決める（カレンダー。オーナー回答「日にちごと＋くりかえしも使える」）。
 *   once:   選んだ日だけ（shift が null なら休み）。曜日ごとのくりかえしより優先する
 *   weekly: 選んだ日の曜日のくりかえしにする（選んだ日の「その日だけ」の予定は消して、くりかえしに合わせる）
 *   reset:  選んだ日を、くりかえしの予定に戻す
 * 選べるのは今日から calendarDays 日先まで（過ぎた日は変えられない）
 */
export function setDateShift(s: GameState, ctx: SimCtx, employeeId: string, days: unknown, shift: ShiftDay | null, mode: DateShiftMode): { ok: boolean; reason?: string } {
  const e = s.employees.find((x) => x.id === employeeId);
  if (!e) return { ok: false, reason: '従業員が見つかりません' };
  if (!isPartTime(e)) return { ok: false, reason: '社員は毎日、仕込みから閉店まで勤務します' };
  if (mode !== 'once' && mode !== 'weekly' && mode !== 'reset') return { ok: false, reason: '保存のしかたが正しくありません' };
  const last = s.day + ST.calendarDays - 1;
  if (!Array.isArray(days) || days.length === 0 || days.length > ST.calendarDays) return { ok: false, reason: '日にちを選んでください' };
  const list = [...new Set(days as unknown[])];
  if (!list.every((d) => typeof d === 'number' && Number.isInteger(d))) return { ok: false, reason: '日にちが正しくありません' };
  const nums = list as number[];
  if (nums.some((d) => d < s.day)) return { ok: false, reason: '過ぎた日のシフトは変えられません' };
  if (nums.some((d) => d > last)) return { ok: false, reason: `シフトは${ST.calendarDays}日先まで決められます` };
  if (e.availableFrom !== undefined && nums.some((d) => d < e.availableFrom!)) return { ok: false, reason: `${e.availableFrom}日目から出勤できます（採用の手続き中）` };
  let sh: ShiftDay | null = null;
  if (mode !== 'reset' && shift) {
    sh = { start: shift.start, end: shift.end, breakAt: shift.breakLen > 0 ? shift.breakAt : 0, breakLen: shift.breakLen, fromPrep: shift.fromPrep };
    const bad = shiftProblem(sh);
    if (bad) return { ok: false, reason: bad };
  }
  pruneDateShifts(e, s.day);
  const before = shiftFor(e, s.day);
  const map = (e.dateShifts ??= {});
  if (mode === 'once') {
    for (const d of nums) map[String(d)] = sh ? { ...sh } : null;
  } else {
    if (mode === 'weekly') {
      const week = shiftsOf(e);
      for (const wd of new Set(nums.map(weekdayOf))) week[wd] = sh ? { ...sh } : null;
      e.shifts = week;
    }
    for (const d of nums) delete map[String(d)];
  }
  if (Object.keys(map).length === 0) delete e.dateShifts;
  // 今日の予定が変わったら、すぐに反映する
  const after = shiftFor(e, s.day);
  if (JSON.stringify(before) !== JSON.stringify(after)) reapplyToday(s, e, ctx);
  return { ok: true };
}

/** 今日の予定が変わったときに、出勤の状況を作り直す（朝に引いた結果は引き直さない） */
function reapplyToday(s: GameState, e: Employee, ctx: SimCtx): void {
  if (s.phase !== 'prep' && s.phase !== 'open') return;
  const a = ensureAttendance(s, e);
  if (a.absent || a.status === 'closed') return;
  const sh = shiftFor(e, s.day);
  const wasOff = a.status === 'off' && !a.arrived;
  planTimes(a, sh);
  if (!sh) {
    // 今日の予定を消した: 店にいれば上がる
    if (a.arrived && e.presentToday) leaveFloor(s, e, ctx, 'leave');
    else if (!a.arrived && e.presentToday) leaveFloor(s, e, ctx, 'leave');
    if (!e.work) {
      a.status = a.arrived ? 'left' : 'off';
      if (!e.presentToday) e.ai.state = 'off';
    }
    return;
  }
  if (wasOff) {
    // 休みの人を呼び出した
    a.calledIn = true;
    ensureRecord(e).daysScheduled += 1;
    logStaff(s, e, 'calledIn', '休みの日に呼び出されて出勤した');
    if (s.phase === 'open') a.arriveAt = Math.max(a.arriveAt < 0 ? 0 : a.arriveAt, s.openT + ST.attendance.callInMin * SEC_PER_MIN);
  }
  if (s.phase === 'prep') {
    if (a.arriveAt < 0 && !a.arrived) {
      a.arrived = true;
      a.prepWorked = true;
      a.status = 'working';
      arriveFloor(s, e, 'arrive');
    } else if (a.arriveAt >= 0 && a.arrived) {
      // 仕込みから来ていた人の出勤を遅らせた: いったん上がり、出勤の時刻に来る
      leaveFloor(s, e, ctx, 'leave');
      a.arrived = false;
      a.prepWorked = false;
      a.status = a.lateMin > 0 ? 'late' : 'scheduled';
      e.ai.state = 'off';
    } else if (!a.arrived) {
      a.status = a.lateMin > 0 ? 'late' : 'scheduled';
    }
    return;
  }
  // 営業中
  if (!a.arrived) a.status = a.lateMin > 0 ? 'late' : 'scheduled';
  else if (a.status === 'left' && s.openT < a.leaveAt) {
    // 上がった人の退勤を延ばした: 戻る
    a.status = 'working';
    arriveFloor(s, e, 'arrive');
  }
}

/** 共通の出来事の文（口論・冷静な対応） */
export function noteComplaintHandled(s: GameState, e: Employee, calm: boolean): void {
  if (calm) {
    ensureRecord(e).complaintsSettled += 1;
    logStaff(s, e, 'calm', 'クレーム対応を冷静にこなした');
  } else {
    logStaff(s, e, 'argue', '客との口論になった');
  }
}

/** 辛抱が切れて態度が悪かった・対応を放棄した */
export function noteTemper(s: GameState, e: Employee, kind: 'rude' | 'abandon'): void {
  logStaff(s, e, kind, kind === 'rude' ? 'クレーム対応で客への態度が悪かった' : 'クレーム対応を途中で放棄した');
}

export function noteServed(e: Employee): void {
  ensureRecord(e).served += 1;
}
