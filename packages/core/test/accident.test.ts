import { afterEach, describe, expect, it } from 'vitest';
import {
  accidentHalted,
  applyAction,
  BALANCE,
  canonicalJson,
  drawAccident,
  listVerbs,
  makeSaveFile,
  nextDay,
  parseSave,
  step,
  type GameState,
  type SimCtx,
} from '../src';
import { addSoloBot, newGame, run, runDay } from './helpers';

const X = BALANCE.events.explosion;

const restores: (() => void)[] = [];
function setBal(obj: object, key: string, v: unknown): void {
  const o = obj as Record<string, unknown>;
  const old = o[key];
  o[key] = v;
  restores.push(() => (o[key] = old));
}
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/** 1日目を営業して2日目の仕込みに入った店（2日目から事故が起きる） */
function day2(seed: number): { s: GameState; ctx: SimCtx } {
  const { s, ctx } = newGame(seed);
  addSoloBot(s);
  applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
  expect(nextDay(s, ctx).ok).toBe(true);
  expect(s.phase).toBe('prep');
  return { s, ctx };
}

/** 事故を起こして、目覚めるところまで進める */
function explode(s: GameState, ctx: SimCtx): void {
  expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'explosion' }, ctx).ok).toBe(true);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  for (let i = 0; i < 400 && !accidentHalted(s); i++) step(s, 0.1, ctx);
  expect(accidentHalted(s)).toBe(true);
  run(s, ctx, X.faintSec + 0.5);
}

/** 経済・営業の値（リセットで仕込み開始時点に戻るもの） */
function businessOf(s: GameState) {
  return canonicalJson({
    day: s.day, phase: s.phase, t: s.t, openT: s.openT, money: s.money, today: s.today, transactions: s.transactions, arrears: s.arrears, loans: s.loans,
    inventory: s.inventory, deliveries: s.deliveries, equipment: s.equipment, seats: s.seats, bowls: s.bowls, dirt: s.dirt, customers: s.customers, orders: s.orders,
    queue: s.queue, employees: s.employees, reputation: s.reputation, regulars: s.regulars, career: s.career, todayReviews: s.todayReviews, lostItems: s.lostItems,
  });
}

describe('爆発事故の抽選', () => {
  it('開店のときに1日1回だけ抽選し、同じ日に二度抽選しない', () => {
    const { s, ctx } = day2(81);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    const st = s.events!.stats.explosion!;
    const draws = st.draws;
    drawAccident(s);
    drawAccident(s);
    expect(st.draws).toBe(draws);
    // 開店のあとに保存して読み直しても、再抽選しない（開店の操作は二度と行われない）
    const loaded = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 0)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const s2 = loaded.save.state;
      drawAccident(s2);
      expect(s2.events!.stats.explosion!.draws).toBe(draws);
    }
  });

  it('設定どおりの頻度で起きる（実測できるよう抽選と発生を数えている）', () => {
    setBal(X, 'chancePerDay', 0.3);
    const { s } = day2(82);
    const draws0 = s.events!.stats.explosion?.draws ?? 0;
    let fired = 0;
    for (let d = 0; d < 2000; d++) {
      s.day += 1;
      s.prepSnapshot!.day = s.day;
      drawAccident(s);
      if (s.events!.accidentPlan) fired++;
    }
    const st = s.events!.stats.explosion!;
    expect(st.draws - draws0).toBe(2000);
    expect(fired / 2000).toBeGreaterThan(0.26);
    expect(fired / 2000).toBeLessThan(0.34);
  });

  it('初期設定は 0.001%（営業日単位）', () => {
    expect(X.chancePerDay).toBe(0.00001);
  });

  it('仕込み開始時点の控えがない日（古いセーブを途中から続けた日）は起きない', () => {
    const { s, ctx } = day2(83);
    s.prepSnapshot = null;
    const r = applyAction(s, 'p1', { type: 'debugEvent', kind: 'explosion' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('記録がない');
    setBal(X, 'chancePerDay', 1);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(s.events!.accidentPlan).toBeNull();
  });

  it('1日目とチュートリアルでは起きない', () => {
    const { s, ctx } = newGame(84);
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'explosion' }, ctx).ok).toBe(false);
  });
});

describe('爆発事故とリセット', () => {
  it('事故のあとは営業が止まり、歩くこととリセットだけができる', () => {
    const { s, ctx } = day2(85);
    explode(s, ctx);
    const before = businessOf(s);
    const p = s.players[0]!;
    // 営業の処理は進まない（売上・客・従業員・在庫・時刻）
    run(s, ctx, 60);
    expect(businessOf(s)).toBe(before);
    expect(s.events!.accident!.t).toBeGreaterThan(X.faintSec + 60);
    expect(listVerbs(s, 'p1', s.seats[0]!.id)).toEqual([]);
    expect(applyAction(s, 'p1', { type: 'orderStock', itemId: 'noodle', packs: 1, express: true }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'nextDay' }, ctx).ok).toBe(false);
    // 焦げた店内を歩ける
    const from = { ...p.pos };
    expect(applyAction(s, 'p1', { type: 'move', x: from.x, z: from.z + 0.3, yaw: 0 }, ctx, 100).ok).toBe(true);
    expect(p.pos.z).not.toBe(from.z);
  });

  it('気を失っている間は歩けず、リセットもできない', () => {
    const { s, ctx } = day2(86);
    applyAction(s, 'p1', { type: 'debugEvent', kind: 'explosion' }, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    for (let i = 0; i < 400 && !accidentHalted(s); i++) step(s, 0.1, ctx);
    const p = s.players[0]!;
    const from = { ...p.pos };
    applyAction(s, 'p1', { type: 'move', x: from.x + 0.3, z: from.z, yaw: 0 }, ctx, 100);
    expect(p.pos).toEqual(from);
    const id = s.events!.accident!.id;
    const r = applyAction(s, 'p1', { type: 'accidentReset', accidentId: id }, ctx);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('意識');
  });

  it('リセットすると仕込み開始時点に正確に戻り、前日までのデータは変わらない', () => {
    const { s, ctx } = day2(87);
    const snapBusiness = businessOf(s);
    const history = canonicalJson(s.history);
    const reviews = canonicalJson(s.reviews);
    const cashAtDayStart = s.cashAtDayStart;
    // 仕込み中に設備を買ってから開店（買ったお金ごと戻る）
    const owned = s.equipment.length;
    expect(applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'plant' }, ctx).ok).toBe(true);
    explode(s, ctx);
    expect(s.today.served + s.today.customers).toBeGreaterThanOrEqual(0);
    const id = s.events!.accident!.id;
    const nextIdBefore = s.nextId;
    expect(applyAction(s, 'p1', { type: 'accidentReset', accidentId: id }, ctx).ok).toBe(true);
    expect(businessOf(s)).toBe(snapBusiness);
    expect(s.equipment.length).toBe(owned);
    expect(canonicalJson(s.history)).toBe(history);
    expect(canonicalJson(s.reviews)).toBe(reviews);
    expect(s.cashAtDayStart).toBe(cashAtDayStart);
    expect(s.events!.accident).toBeNull();
    expect(s.events!.resets).toBe(1);
    // ID の連番は戻さない（描画や同期で別の物と取り違えない）
    expect(s.nextId).toBeGreaterThanOrEqual(nextIdBefore);
    // 発生の記録は消さない
    expect(s.events!.stats.explosion!.fired).toBe(1);
    expect(s.players[0]!.hand).toEqual({ kind: 'none' });
  });

  it('リセットを2回押しても、2回目は何もしない（二重に戻さない）', () => {
    const { s, ctx } = day2(88);
    explode(s, ctx);
    const id = s.events!.accident!.id;
    expect(applyAction(s, 'p1', { type: 'accidentReset', accidentId: id }, ctx).ok).toBe(true);
    const after = businessOf(s);
    const version = s.version;
    const r = applyAction(s, 'p1', { type: 'accidentReset', accidentId: id }, ctx);
    expect(r.ok).toBe(false);
    expect(businessOf(s)).toBe(after);
    expect(s.version).toBe(version);
  });

  it('リセットしたあとは同じ日に事故は起きず、通常どおり営業して1日を終えられる', () => {
    const { s, ctx } = day2(89);
    explode(s, ctx);
    applyAction(s, 'p1', { type: 'accidentReset', accidentId: s.events!.accident!.id }, ctx);
    setBal(X, 'chancePerDay', 1);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(s.events!.accidentPlan).toBeNull();
    runDay(s, ctx);
    expect(s.phase).toBe('closed');
    expect(s.history.at(-1)!.day).toBe(2);
    expect(s.history.at(-1)!.served).toBeGreaterThan(5);
    // 1日目の日報は1回だけ（二重に記録しない）
    expect(s.history.filter((h) => h.day === 2).length).toBe(1);
    expect(s.history.filter((h) => h.day === 1).length).toBe(1);
  });

  it('探索中に保存して読み込んでも、リセット先が壊れない', () => {
    const { s, ctx } = day2(90);
    const snapBusiness = businessOf(s);
    explode(s, ctx);
    const file = makeSaveFile(s, 1, null, 0);
    const loaded = parseSave(JSON.stringify(file));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const s2 = loaded.save.state;
    expect(accidentHalted(s2)).toBe(true);
    expect(applyAction(s2, 'p1', { type: 'accidentReset', accidentId: s2.events!.accident!.id }, ctx).ok).toBe(true);
    expect(businessOf(s2)).toBe(snapBusiness);
  });

  it('リセットで共同経営の顔ぶれは変わらない（途中で参加した人を消さない）', () => {
    const { s, ctx } = day2(91);
    explode(s, ctx);
    s.players.push({ ...s.players[0]!, id: 'p2', name: 'ゲスト', isHost: false, pos: { x: 3, z: 3 } });
    applyAction(s, 'p1', { type: 'accidentReset', accidentId: s.events!.accident!.id }, ctx);
    expect(s.players.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(s.players[1]!.pos).not.toEqual({ x: 3, z: 3 });
  });
});
