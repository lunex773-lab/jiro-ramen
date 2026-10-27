import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BALANCE,
  createGame,
  currentTutorialStep,
  makeCtx,
  nextDay,
  seatCounterPoint,
  TASK_KINDS,
  tutorialTarget,
  validateState,
  type Action,
  type GameState,
  type SimCtx,
} from '../src';
import { eqByType, newGame, run, standAt } from './helpers';

const stepId = (s: GameState) => currentTutorialStep(s)?.id ?? null;

function ok(s: GameState, ctx: SimCtx, a: Action) {
  const r = applyAction(s, 'p1', a, ctx);
  if (!r.ok) throw new Error(`${a.type}: ${r.reason}`);
}

/** 対象の前に立つ（設備は正面、席はカウンター越し、床の汚れはその場所） */
function stand(s: GameState, targetId: string) {
  const p = s.players[0]!;
  const seat = s.seats.find((x) => x.id === targetId);
  if (seat) {
    p.pos = seatCounterPoint(s, seat);
    return;
  }
  const d = s.dirt.find((x) => x.id === targetId);
  if (d) {
    p.pos = { ...d.pos };
    return;
  }
  standAt(s, 'p1', targetId);
}

/** 操作して、長押しの作業は終わるまで時間を進める */
function act(s: GameState, ctx: SimCtx, targetId: string, verb: string, args?: Record<string, number>) {
  stand(s, targetId);
  ok(s, ctx, { type: 'interact', targetId, verb, args });
  let guard = 0;
  while (s.players[0]!.work && guard++ < 2000) run(s, ctx, 0.1);
  run(s, ctx, 0.2);
}

/** 指定の手順になるまで時間を進める（客の移動待ちなど） */
function waitFor(s: GameState, ctx: SimCtx, id: string, maxSec = 120) {
  let t = 0;
  while (stepId(s) !== id && t < maxSec) {
    run(s, ctx, 0.5);
    t += 0.5;
  }
  expect(stepId(s)).toBe(id);
}

function next(s: GameState, ctx: SimCtx) {
  ok(s, ctx, { type: 'tutorial', op: 'next', stepId: stepId(s)! });
}

/** 1杯作って提供する（2人目のお客さん用。手順の案内なしで） */
function cookAndServe(s: GameState, ctx: SimCtx, seatId: string) {
  const rack = eqByType(s, 'bowl_rack');
  const asm = eqByType(s, 'assembly');
  const boiler = eqByType(s, 'noodle_boiler');
  act(s, ctx, rack.id, 'bowls_take', { count: 1 });
  act(s, ctx, asm.id, 'bowls_place');
  act(s, ctx, asm.id, 'tare');
  act(s, ctx, asm.id, 'soup');
  act(s, ctx, boiler.id, 'noodles_in');
  act(s, ctx, seatId, 'ask_call');
  run(s, ctx, BALANCE.cooking.noodleIdeal);
  act(s, ctx, boiler.id, 'noodles_up');
  act(s, ctx, asm.id, 'toppings');
  act(s, ctx, asm.id, 'bowl_take');
  act(s, ctx, seatId, 'serve');
}

describe('チュートリアル（営業0日目）', () => {
  it('手順どおりに操作すると最後まで進み、練習中は自然なお客さんが来ない', () => {
    const s = createGame({ seed: 3, tutorial: true });
    const ctx = makeCtx();
    expect(s.day).toBe(0);
    expect(validateState(s)).toEqual([]);
    expect(stepId(s)).toBe('welcome');

    next(s, ctx);
    expect(stepId(s)).toBe('move');
    s.players[0]!.pos = { x: s.players[0]!.pos.x + 1.5, z: s.players[0]!.pos.z };
    run(s, ctx, 0.2);

    // 仕込み（開店はまだできない）
    expect(stepId(s)).toBe('prep_pork');
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(false);
    expect(s.phase).toBe('prep');
    const prepTable = eqByType(s, 'prep_table');
    expect(tutorialTarget(s)).toEqual({ id: prepTable.id });
    act(s, ctx, prepTable.id, 'prep:slice_pork');

    // 経営: 在庫と発注（タブを開いたかは画面が判定して「次へ」を送る）
    expect(stepId(s)).toBe('stock_open');
    expect(tutorialTarget(s)).toEqual({ ui: 'menu' });
    next(s, ctx);
    expect(stepId(s)).toBe('stock_order');
    ok(s, ctx, { type: 'orderStock', itemId: 'moyashi', packs: 1, express: false });
    run(s, ctx, 0.2);

    // 経営: 値段
    expect(stepId(s)).toBe('price');
    ok(s, ctx, { type: 'setPrice', menuId: 'small', price: 1000 });
    run(s, ctx, 0.2);

    // 経営: 設備（券売機が劣化している）
    expect(stepId(s)).toBe('equip');
    const tm = eqByType(s, 'ticket_machine');
    expect(tm.status).toBe('worn');
    ok(s, ctx, { type: 'maintenance', equipmentId: tm.id, on: true });
    run(s, ctx, 0.2);

    // 経営: レイアウト
    expect(stepId(s)).toBe('layout');
    ok(s, ctx, { type: 'seatOffset', seatIndex: 7, x: 0.05, z: 0 });
    run(s, ctx, 0.2);
    expect(stepId(s)).toBe('layout_close');
    next(s, ctx);

    // 開店 → 1人目（案内どおりに作る）
    expect(stepId(s)).toBe('open');
    ok(s, ctx, { type: 'openShop' });
    run(s, ctx, 0.2);
    expect(stepId(s)).toBe('customer1');
    waitFor(s, ctx, 'bowl_take');
    const seatId = String(s.tutorial!.mark.seat);
    expect(tutorialTarget(s)).toEqual({ id: eqByType(s, 'bowl_rack').id });

    const rack = eqByType(s, 'bowl_rack');
    const asm = eqByType(s, 'assembly');
    const boiler = eqByType(s, 'noodle_boiler');
    act(s, ctx, rack.id, 'bowls_take', { count: 1 });
    expect(stepId(s)).toBe('bowl_place');
    act(s, ctx, asm.id, 'bowls_place');
    expect(stepId(s)).toBe('tare');
    act(s, ctx, asm.id, 'tare');
    expect(stepId(s)).toBe('soup');
    act(s, ctx, asm.id, 'soup');
    expect(stepId(s)).toBe('noodles_in');
    act(s, ctx, boiler.id, 'noodles_in');
    expect(stepId(s)).toBe('ask_call');
    expect(tutorialTarget(s)).toEqual({ id: seatId });
    act(s, ctx, seatId, 'ask_call');
    expect(stepId(s)).toBe('noodles_up');
    run(s, ctx, BALANCE.cooking.noodleIdeal);
    act(s, ctx, boiler.id, 'noodles_up');
    expect(stepId(s)).toBe('toppings');
    act(s, ctx, asm.id, 'toppings');
    expect(stepId(s)).toBe('bowl_pick');
    act(s, ctx, asm.id, 'bowl_take');
    expect(stepId(s)).toBe('serve');
    act(s, ctx, seatId, 'serve');
    expect(stepId(s)).toBe('eat_wait');
    // チュートリアルのお客さんはクレームを言わずに食べる
    waitFor(s, ctx, 'collect', 60);

    // 片付け
    act(s, ctx, seatId, 'collect');
    expect(stepId(s)).toBe('wash_drop');
    const sink = eqByType(s, 'sink');
    act(s, ctx, sink.id, 'dishes_drop');
    expect(stepId(s)).toBe('wash');
    act(s, ctx, sink.id, 'wash');
    expect(stepId(s)).toBe('wipe');
    act(s, ctx, seatId, 'wipe');
    expect(stepId(s)).toBe('mop_take');
    const locker = eqByType(s, 'locker');
    act(s, ctx, locker.id, 'mop_take');
    expect(stepId(s)).toBe('mop');
    const spill = tutorialTarget(s) as { id: string };
    expect(s.dirt.some((d) => d.id === spill.id)).toBe(true);
    act(s, ctx, spill.id, 'mop');
    expect(stepId(s)).toBe('mop_return');
    act(s, ctx, locker.id, 'mop_return');

    // 2人目は自分で作る
    expect(stepId(s)).toBe('customer2');
    let seat2: string | undefined;
    for (let t = 0; t < 120 && !seat2; t += 0.5) {
      run(s, ctx, 0.5);
      const c2 = s.customers.find((c) => c.id === s.tutorial!.mark.cust2);
      if (c2?.state === 'seated') seat2 = c2.seatId ?? undefined;
    }
    expect(seat2).toBeTruthy();
    cookAndServe(s, ctx, seat2!);
    expect(stepId(s)).toBe('cleanup2');
    for (let t = 0; t < 60; t += 0.5) {
      run(s, ctx, 0.5);
      const b = s.bowls.find((x) => x.state === 'dirty' && x.loc.at === 'seat');
      if (b) break;
    }
    act(s, ctx, seat2!, 'collect');
    act(s, ctx, sink.id, 'dishes_drop');
    act(s, ctx, sink.id, 'wash');
    expect(stepId(s)).toBe('close');

    // 練習の日は、チュートリアルのお客さん2人だけ
    expect(s.today.customers).toBe(2);
    expect(s.today.served).toBe(2);

    // 閉店 → 精算
    ok(s, ctx, { type: 'tutorial', op: 'close', stepId: 'close' });
    waitFor(s, ctx, 'results', 30);
    expect(s.phase).toBe('closed');
    expect(s.history.at(-1)?.day).toBe(0);
    // 練習の結果は本番に残さないので、次の日へは進めない（1日目は画面側で新しく始める）
    expect(applyAction(s, 'p1', { type: 'nextDay' }, ctx).ok).toBe(false);
    next(s, ctx);
    expect(stepId(s)).toBe('finish');
    next(s, ctx);
    expect(s.tutorial!.finished).toBe(true);
    expect(currentTutorialStep(s)).toBeNull();
  });

  it('操作で進む手順は「次へ」では飛ばせない', () => {
    const s = createGame({ seed: 4, tutorial: true });
    const ctx = makeCtx();
    next(s, ctx);
    expect(stepId(s)).toBe('move');
    const r = applyAction(s, 'p1', { type: 'tutorial', op: 'next', stepId: 'move' }, ctx);
    expect(r.ok).toBe(false);
    // 古い手順の「次へ」は無視される（二重送信で飛ばない）
    expect(applyAction(s, 'p1', { type: 'tutorial', op: 'next', stepId: 'welcome' }, ctx).ok).toBe(false);
  });
});

describe('チュートリアル（3日目: 従業員）', () => {
  function day3(): { s: GameState; ctx: SimCtx } {
    const g = newGame(9);
    g.s.day = 3;
    return g;
  }

  it('受けると採用が解放され、雇う → 担当設定 → 終了 と進む', () => {
    const { s, ctx } = day3();
    expect(s.career.unlocked.includes('hiring')).toBe(false);
    ok(s, ctx, { type: 'tutorial', op: 'staffStart' });
    expect(s.career.staffTutorialOffered).toBe(true);
    expect(s.career.unlocked.includes('hiring')).toBe(true);
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(stepId(s)).toBe('staff_intro');
    next(s, ctx);
    expect(stepId(s)).toBe('staff_open');
    next(s, ctx);
    next(s, ctx);
    expect(stepId(s)).toBe('staff_hire');
    ok(s, ctx, { type: 'hire', candidateId: s.candidates[0]!.id });
    run(s, ctx, 0.2);
    expect(stepId(s)).toBe('staff_roles');
    const e = s.employees[0]!;
    ok(s, ctx, { type: 'setPriority', employeeId: e.id, kind: Object.keys(TASK_KINDS)[0]!, value: -100 });
    run(s, ctx, 0.2);
    expect(stepId(s)).toBe('staff_done');
    next(s, ctx);
    expect(s.tutorial).toBeNull();
    // 一度案内したら、もう案内しない
    expect(applyAction(s, 'p1', { type: 'tutorial', op: 'staffStart' }, ctx).ok).toBe(false);
  });

  it('「今は雇わない」を選ぶと、お金を使わずに終われる', () => {
    const { s, ctx } = day3();
    const money = s.money;
    ok(s, ctx, { type: 'tutorial', op: 'staffStart' });
    next(s, ctx);
    next(s, ctx);
    next(s, ctx);
    ok(s, ctx, { type: 'tutorial', op: 'alt', stepId: 'staff_hire' });
    expect(stepId(s)).toBe('staff_skip');
    next(s, ctx);
    expect(s.tutorial).toBeNull();
    expect(s.money).toBe(money);
    expect(s.employees).toHaveLength(0);
  });

  it('断ると案内済みになり、採用の解放は変わらない', () => {
    const { s, ctx } = day3();
    ok(s, ctx, { type: 'tutorial', op: 'staffDecline' });
    expect(s.career.staffTutorialOffered).toBe(true);
    expect(s.tutorial ?? null).toBeNull();
    expect(s.career.unlocked.includes('hiring')).toBe(false);
  });

  it('2日目までは受けられない', () => {
    const { s, ctx } = newGame(10);
    expect(applyAction(s, 'p1', { type: 'tutorial', op: 'staffStart' }, ctx).ok).toBe(false);
    expect(nextDay(s, ctx).ok).toBe(false); // 準備中なので次の日へは進めない（念のため状態が変わらないこと）
    expect(s.career.staffTutorialOffered ?? false).toBe(false);
  });
});
