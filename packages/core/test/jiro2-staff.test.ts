// じろ2 段階C（改修設計書02）: 実際の勤務の記録・勤務の予定のおかしさ・客の対応を先にする・仕込みの「人前」・自動仕入れの制約
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  attendanceOn,
  autoOrderEnabled,
  BALANCE,
  INGREDIENTS,
  nextDay,
  pendingOf,
  remapShift,
  shiftSpansBreak,
  step,
  prepPerBowl,
  runAutoOrder,
  shelfLifeCap,
  shiftIssues,
  stockOf,
  TASK_KINDS,
  taskScore,
  type Employee,
  type GameState,
  type Task,
} from '../src';
import { addSoloBot, newGame, run, runDay } from './helpers';

function hirePart(s: GameState, ctx: Parameters<typeof applyAction>[3]): Employee {
  const c = s.candidates[0]!;
  expect(applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok).toBe(true);
  const e = s.employees.at(-1)!;
  e.availableFrom = s.day;
  e.profile.wishDays = [true, true, true, true, true, true, true];
  return e;
}

describe('勤務のカレンダー: 実際の勤務の記録と予定のおかしさ', () => {
  it('閉店後に、その日の予定と実際（遅刻・欠勤・残業）を記録する', () => {
    const { s, ctx } = newGame(301);
    addSoloBot(s);
    const e = hirePart(s, ctx);
    e.availableFrom = s.day + 1;
    e.shifts = Array.from({ length: 7 }, () => ({ start: 0, end: 180, breakAt: 0, breakLen: 0, fromPrep: false }));
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    expect(nextDay(s, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    const r = attendanceOn(e, s.day);
    expect(r).not.toBeNull();
    expect(r!.plannedMin).toBeGreaterThan(0);
    if (!r!.absent) expect(r!.workedMin).toBeGreaterThan(0);
    expect(r!.overtimeMin).toBeGreaterThanOrEqual(0);
  });

  it('6時間を超えるのに休憩45分なし・休憩が勤務の外・7日続けて勤務・定休日の予定を見つける', () => {
    const { s, ctx } = newGame(302);
    const e = hirePart(s, ctx);
    // 11:00〜21:00 の店（600分）にして、休憩なしの7時間のシフト
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: s.company.activeStoreId, hours: { sessions: [{ open: 660, close: 1260 }], closedDays: [] } }, ctx).ok).toBe(true);
    e.shifts = Array.from({ length: 7 }, () => ({ start: 0, end: 420, breakAt: 0, breakLen: 0, fromPrep: false }));
    const issues = shiftIssues(s, s.day, 7);
    expect(issues.some((x) => x.employeeId === e.id && x.text.includes('45分'))).toBe(true);
    expect(issues.some((x) => x.employeeId === e.id && x.text.includes('7日続けて'))).toBe(true);
    // 休憩60分を入れると休憩の注意は消える
    e.shifts = Array.from({ length: 7 }, () => ({ start: 0, end: 420, breakAt: 180, breakLen: 60, fromPrep: false }));
    expect(shiftIssues(s, s.day, 7).some((x) => x.text.includes('休憩'))).toBe(false);
  });
});

describe('接客と仕込みが重なったとき、客の対応を先にする', () => {
  it('できた丼の提供は、仕込み・急ぎの仕込み（店長でも）より先', () => {
    const { s } = newGame(303);
    const e = { pos: { x: 0, z: 0 }, priorities: {} } as unknown as Employee;
    const at = { x: 0, z: 0 };
    const mk = (kind: string): Task => ({ key: kind, kind, steps: [], priority: TASK_KINDS[kind]!.base, at });
    void s;
    expect(taskScore(e, mk('serve'))).toBeGreaterThan(taskScore(e, mk('prep')));
    expect(taskScore(e, mk('serve'))).toBeGreaterThan(taskScore(e, mk('prepUrgent')));
    expect(taskScore(e, mk('serve'), true)).toBeGreaterThan(taskScore(e, mk('prepUrgent'), true));
    expect(taskScore(e, mk('complaint'), true)).toBeGreaterThan(taskScore(e, mk('prepUrgent'), true));
    // 店長の急ぎの仕込みは、コールの確認などよりは先（オーナーの指示 2026-11-11 のまま）
    expect(taskScore(e, mk('prepUrgent'), true)).toBeGreaterThan(taskScore(e, mk('askCall'), true));
  });
});

describe('仕込みの目安を「人前」で見る', () => {
  it('1人前の量は最近の日報の使用量 ÷ 杯数。日報がなければ目安', () => {
    const { s, ctx } = newGame(304);
    expect(prepPerBowl(s, 'yasai')).toBe(250);
    addSoloBot(s);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    const r = s.history.at(-1)!;
    if (r.served > 0 && (r.usedItems?.yasai ?? 0) > 0) expect(prepPerBowl(s, 'yasai')).toBeCloseTo(r.usedItems!.yasai! / r.served, 5);
  });
});

describe('自動仕入れの制約（食材ごとの有効/無効・保存期間・仕入れの記録）', () => {
  function afterDay(seed: number) {
    const { s, ctx } = newGame(seed);
    addSoloBot(s);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    return { s, ctx };
  }

  it('自動の仕入れを止めた食材は頼まない（目安の量は残る）。戻すとまた頼む', () => {
    const { s, ctx } = afterDay(305);
    const id = 'moyashi';
    expect(applyAction(s, 'p1', { type: 'setAutoOrderItem', itemId: id, enabled: false }, ctx).ok).toBe(true);
    expect(autoOrderEnabled(s, id)).toBe(false);
    const target = s.autoOrder[id];
    s.inventory = s.inventory.filter((l) => l.itemId !== id);
    s.deliveries = s.deliveries.filter((d) => d.itemId !== id);
    s.money = 1_000_000;
    runAutoOrder(s, ctx);
    expect(pendingOf(s, id)).toBe(0);
    expect(s.autoOrder[id]).toBe(target);
    expect(applyAction(s, 'p1', { type: 'setAutoOrderItem', itemId: id, enabled: true }, ctx).ok).toBe(true);
    runAutoOrder(s, ctx);
    expect(pendingOf(s, id)).toBeGreaterThan(0);
  });

  it('保存期間のうちに使い切れない量は頼まない。仕入れは誰が頼んだかと一緒に記録する', () => {
    const { s, ctx } = afterDay(306);
    const id = 'moyashi';
    const cap = shelfLifeCap(s, id);
    expect(Number.isFinite(cap)).toBe(true);
    // 目安をとても多くしても、保存期間で使える量まで
    s.autoOrderMode = 'manual';
    s.autoOrder[id] = 10_000_000;
    s.money = 10_000_000;
    s.inventory = s.inventory.filter((l) => l.itemId !== id);
    s.deliveries = s.deliveries.filter((d) => d.itemId !== id);
    runAutoOrder(s, ctx);
    expect(stockOf(s, id) + pendingOf(s, id)).toBeLessThanOrEqual(cap + INGREDIENTS[id]!.packQty);
    const log = s.purchaseLog!.filter((p) => p.itemId === id);
    expect(log.at(-1)).toMatchObject({ day: s.day, by: 'auto', express: false });
    // 手で頼んだ分は「自分」
    expect(applyAction(s, 'p1', { type: 'orderStock', itemId: 'garlic_raw', packs: 1, express: false }, ctx).ok).toBe(true);
    expect(s.purchaseLog!.at(-1)).toMatchObject({ itemId: 'garlic_raw', packs: 1, by: 'manual' });
    expect(nextDay(s, ctx).ok).toBe(true);
    void BALANCE;
  });
});

describe('中休みにアルバイトを休ませる（営業の枠が2つのとき。オーナーの指示 2026-11-11）', () => {
  it('「中休みは休む」の人は、1つ目の枠のあと店を出て、2つ目の枠の開店で戻る。そうでない人は店に残る', () => {
    const { s, ctx } = newGame(310);
    addSoloBot(s);
    expect(applyAction(s, 'p1', { type: 'setStoreHours', storeId: s.company.activeStoreId, hours: { sessions: [{ open: 660, close: 840 }, { open: 1020, close: 1260 }], closedDays: [] } }, ctx).ok).toBe(true);
    const rest = hirePart(s, ctx);
    const stay = hirePart(s, ctx);
    const full = { start: 0, end: 420, breakAt: 0, breakLen: 0, fromPrep: false };
    // 休まない・遅れない人にする（勤怠は隠しパラメータ）
    for (const e of [rest, stay]) e.profile.diligence = 1;
    rest.shifts = Array.from({ length: 7 }, () => ({ ...full, midRest: true }));
    stay.shifts = Array.from({ length: 7 }, () => ({ ...full }));
    // 営業時間は次の営業日から。1日目を終えて2日目へ（朝の出勤の確認で今日の予定ができる）
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    runDay(s, ctx);
    expect(nextDay(s, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    let guard = 0;
    while (!(s.phase === 'prep' && (s.sessionIdx ?? 0) === 1) && guard++ < 40_000) step(s, 0.25, ctx);
    expect(s.sessionIdx).toBe(1);
    run(s, ctx, 3);
    expect(rest.att!.absent).toBe(false);
    expect(rest.att!.status).toBe('break');
    expect(stay.att!.status).not.toBe('break');
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    run(s, ctx, 3);
    expect(rest.att!.status).toBe('working');
  });

  it('営業時間を変えても、枠をまたぐなら「中休みは休む」は残る', () => {
    const two = { sessions: [{ open: 660, close: 840 }, { open: 1020, close: 1260 }], closedDays: [] };
    const other = { sessions: [{ open: 690, close: 870 }, { open: 1050, close: 1290 }], closedDays: [] };
    const one = { sessions: [{ open: 660, close: 1080 }], closedDays: [] };
    const sh = { start: 0, end: 420, breakAt: 0, breakLen: 0, fromPrep: false, midRest: true };
    expect(remapShift(sh, two, other).midRest).toBe(true);
    expect(remapShift(sh, two, one).midRest).toBeUndefined();
    expect(shiftSpansBreak(two, 60, 300)).toBe(true);
    expect(shiftSpansBreak(two, 0, 180)).toBe(false);
  });
});
