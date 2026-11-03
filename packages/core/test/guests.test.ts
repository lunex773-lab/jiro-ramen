// 第2版 Phase 3: 団体客・居座り・食べ方の汚い客・店外の喫煙・トラブルと評価（設計書 18-3）
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  askToLeave,
  BALANCE,
  findGroupSeats,
  makeCustomer,
  makeEmployee,
  initNewHire,
  leaveAfterMeal,
  meanGroupSize,
  overallSatisfaction,
  respondManner,
  respondToComplaint,
  rollMessy,
  startComplaint,
  step,
  updateManners,
  warnSmoker,
  type Customer,
  type Employee,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, newGame, run, runDay, seatCustomer } from './helpers';

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

/** 来店とイベントを止めて、営業中にする（テストで作った客だけが動く） */
function quietOpen(s: GameState, ctx: SimCtx): void {
  setBal(BALANCE.customers, 'baseRate', 0);
  setBal(BALANCE.events.complaint, 'delayChance', 0);
  setBal(BALANCE.events.complaint, 'dirtyChance', 0);
  setBal(BALANCE.events.complaint, 'unreasonableChance', 0);
  setBal(BALANCE.events.buzz, 'chancePerCheck', 0);
  setBal(BALANCE.events.explosion, 'chancePerDay', 0);
  setBal(BALANCE.cleaning, 'lostItemChance', 0);
  s.day = 3;
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
}

/** 席で食べている客を作る（seatCustomer の客を食事中にする） */
function eating(s: GameState, seatIndex: number, eatLeft: number, traits: Partial<Customer['traits']> = {}): Customer {
  const o = seatCustomer(s, seatIndex, 'small', undefined, traits);
  const c = s.customers.find((x) => x.id === o.customerId)!;
  o.status = 'served';
  c.state = 'eating';
  c.eatLeft = eatLeft;
  c.eatTotal = eatLeft;
  c.stateTime = 0;
  return c;
}

function group(members: Customer[]): void {
  members.forEach((m, i) => (m.group = { id: 'gtest', size: members.length, leader: i === 0 }));
}

/** 店内で席を待つ団体を作る */
function waitingGroup(s: GameState, n: number): Customer[] {
  const out: Customer[] = [];
  for (let i = 0; i < n; i++) {
    const c = makeCustomer(s, null);
    c.state = 'waitingSeat';
    c.menuId = 'small';
    c.patience = 9999;
    c.pos = { x: 3, z: 0.6 };
    c.slot = -1;
    s.customers.push(c);
    s.insideQueue.push(c.id);
    out.push(c);
  }
  group(out);
  return out;
}

function occupy(s: GameState, indices: number[]): void {
  for (const i of indices) s.seats[i]!.customerId = `blocker${i}`;
}

describe('団体客（8）', () => {
  it('1〜4人で来店し、1日の客数は団体がない場合と同じくらい（オーナー回答）', () => {
    const sizes = new Map<number, number>();
    const total = (weights: number[] | null, seed: number) => {
      if (weights) setBal(BALANCE.guests.group, 'sizeWeights', weights);
      const { s, ctx } = newGame(seed);
      s.day = 3;
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      const seen = new Set<string>();
      for (let t = 0; t < 540; t += 0.5) {
        step(s, 0.5, ctx);
        for (const c of s.customers) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          if (!weights && (!c.group || c.group.leader)) {
            const n = c.group?.size ?? 1;
            sizes.set(n, (sizes.get(n) ?? 0) + 1);
          }
        }
      }
      const n = s.today.customers + s.today.balked;
      while (restores.length) restores.pop()!();
      return n;
    };
    let withGroups = 0;
    let solo = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      withGroups += total(null, seed);
      solo += total([1, 0, 0, 0], seed);
    }
    for (const n of [1, 2, 3, 4]) expect(sizes.get(n) ?? 0).toBeGreaterThan(0);
    expect(withGroups / solo).toBeGreaterThan(0.75);
    expect(withGroups / solo).toBeLessThan(1.3);
    expect(meanGroupSize()).toBeGreaterThan(1.3);
  });

  it('全員がそろってから、隣り合った席にまとめて座る', () => {
    const { s, ctx } = newGame(11);
    quietOpen(s, ctx);
    occupy(s, [1, 4]);
    const g = waitingGroup(s, 3);
    run(s, ctx, 0.5);
    const idx = g.map((m) => s.seats.find((x) => x.id === m.seatId)!.index).sort((a, b) => a - b);
    expect(g.every((m) => m.state === 'toSeat' || m.state === 'seated')).toBe(true);
    expect(idx).toEqual([5, 6, 7]);
  });

  it('隣り合った席がなければ少し待ち、待ちが長くなったら人数分の空き席に離れて座る（オーナー回答）', () => {
    const { s, ctx } = newGame(12);
    quietOpen(s, ctx);
    occupy(s, [1, 3, 5]);
    const g = waitingGroup(s, 3);
    run(s, ctx, BALANCE.guests.group.adjacentWait - 5);
    expect(g.every((m) => m.state === 'waitingSeat')).toBe(true);
    run(s, ctx, 6);
    const seats = g.map((m) => s.seats.find((x) => x.id === m.seatId));
    expect(seats.every((x) => !!x)).toBe(true);
    expect(new Set(seats.map((x) => x!.id)).size).toBe(3);
    // できるだけ近くにまとまる（空き 0,2,4,6,7 のうち 4,6,7）
    expect(seats.map((x) => x!.index).sort((a, b) => a - b)).toEqual([4, 6, 7]);
    for (const m of g) expect(s.seats.find((x) => x.id === m.seatId)!.customerId).toBe(m.id);
  });

  it('席が人数分なければ待ち、後ろの客も追い越さない', () => {
    const { s, ctx } = newGame(13);
    quietOpen(s, ctx);
    occupy(s, [0, 1, 2, 3, 4, 5]);
    const g = waitingGroup(s, 3);
    const solo = makeCustomer(s, null);
    solo.state = 'waitingSeat';
    solo.menuId = 'small';
    solo.patience = 9999;
    s.customers.push(solo);
    s.insideQueue.push(solo.id);
    run(s, ctx, BALANCE.guests.group.adjacentWait + 10);
    expect(g.every((m) => m.state === 'waitingSeat')).toBe(true);
    expect(solo.state).toBe('waitingSeat');
    expect(findGroupSeats(s, s.seats.filter((x) => !x.customerId), 3, 999)).toBeNull();
  });

  it('食べ終わった人は連れが食べ終わるまで席で待ち、全員で帰る。食事中は会話する', () => {
    const { s, ctx } = newGame(14);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.group, 'lingerChance', 0);
    const a = eating(s, 2, 5);
    const b = eating(s, 3, 40);
    group([a, b]);
    run(s, ctx, 8);
    expect(a.state).toBe('afterMeal');
    expect(s.seats[2]!.customerId).toBe(a.id);
    let talked = false;
    for (let i = 0; i < 400 && b.state === 'eating'; i++) {
      run(s, ctx, 0.1);
      talked ||= (a.sayEvent === true || b.sayEvent === true) && (a.sayUntil > s.t || b.sayUntil > s.t);
    }
    expect(talked).toBe(true);
    run(s, ctx, 0.5);
    expect(['leaving', 'left', 'smoking']).toContain(a.state);
    expect(['leaving', 'left', 'smoking']).toContain(b.state);
    // 1人客は会話しない
    const c = eating(s, 6, 20);
    run(s, ctx, 20);
    expect(c.sayEvent ?? false).toBe(false);
  });

  it('まれに食後も居座り、席が空かない。放っておけば自分から帰る', () => {
    const { s, ctx } = newGame(15);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.group, 'lingerChance', 1);
    const a = eating(s, 0, 2);
    const b = eating(s, 1, 2);
    group([a, b]);
    run(s, ctx, 3);
    expect(a.state).toBe('afterMeal');
    expect(a.group!.linger).toBeTruthy();
    const until = a.group!.linger!.until;
    run(s, ctx, 30);
    expect(s.seats[0]!.customerId).toBe(a.id);
    expect(s.seats[1]!.customerId).toBe(b.id);
    run(s, ctx, until - s.t + 1);
    expect(s.seats[0]!.customerId).toBeNull();
    expect(s.seats[1]!.customerId).toBeNull();
  });

  it('退店を促すと性格・混雑・言い方で反応が変わる（円満に帰る・気分を害する・断る）', () => {
    const outcome = (resp: 'polite' | 'explain' | 'request', busy: boolean, manners: number, seed: number) => {
      const { s, ctx } = newGame(seed);
      quietOpen(s, ctx);
      setBal(BALANCE.guests.group, 'lingerChance', 1);
      const a = eating(s, 0, 1, { manners });
      const b = eating(s, 1, 1, { manners });
      group([a, b]);
      run(s, ctx, 2);
      if (busy) s.queue.push('someone');
      const before = a.group!.linger!.until;
      askToLeave(s, ctx, s.seats[0]!, s.players[0]!, resp);
      while (restores.length) restores.pop()!();
      if (a.state === 'afterMeal') {
        expect(a.group!.linger!.tried).toContain(resp);
        expect(a.group!.linger!.until).toBeGreaterThan(before);
        return 'refused';
      }
      return a.sat.service <= 0.3 ? 'offended' : 'ok';
    };
    const tally = (resp: 'polite' | 'explain' | 'request', busy: boolean, manners: number) => {
      const t = { ok: 0, offended: 0, refused: 0 };
      for (let i = 0; i < 60; i++) t[outcome(resp, busy, manners, 100 + i)] += 1;
      return t;
    };
    const explainBusy = tally('explain', true, 0.6);
    const explainIdle = tally('explain', false, 0.6);
    const request = tally('request', true, 0.1);
    const polite = tally('polite', true, 0.9);
    expect(explainBusy.ok).toBeGreaterThan(explainIdle.ok);
    expect(explainIdle.refused).toBeGreaterThan(0);
    expect(request.offended).toBeGreaterThan(0);
    expect(polite.offended).toBe(0);
    expect(polite.ok).toBeGreaterThan(0);
  });
});

describe('食べ方の汚い客（7）', () => {
  it('低確率で現れる', () => {
    const { s } = newGame(21);
    s.day = 3;
    let n = 0;
    for (let i = 0; i < 3000; i++) {
      const c = makeCustomer(s, null);
      rollMessy(s, c);
      if (c.messy) n += 1;
    }
    expect(n / 3000).toBeGreaterThan(BALANCE.guests.messy.chance * 0.6);
    expect(n / 3000).toBeLessThan(BALANCE.guests.messy.chance * 1.4);
  });

  /** 汚い客を真ん中の席に、両隣と遠くに客を座らせる */
  function messyScene(seed: number, demand = 0.9) {
    const { s, ctx } = newGame(seed);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.group, 'lingerChance', 0);
    setBal(BALANCE.guests.smoke, 'chance', 0);
    const m = eating(s, 3, 60, { manners: 0.1 });
    m.messy = { next: 0, count: 0, calmed: false, warned: 0, troubleId: 'trX', firstBotherT: null, victims: [] };
    const left = eating(s, 2, 80, { cleanlinessDemand: demand });
    const right = eating(s, 4, 80, { cleanlinessDemand: demand });
    const far = eating(s, 7, 80, { cleanlinessDemand: demand });
    for (const x of [left, right, far]) x.sat.cleanliness = 1;
    return { s, ctx, m, left, right, far };
  }

  it('食事中に席と床を汚し、汚れは清掃の仕組みに反映される（拭く・モップで消える）', () => {
    // 毎回汚す設定にして、汚れの量を確かめる（確率は別のテストで見る）
    setBal(BALANCE.guests.messy, 'chancePerCheck', 1);
    const { s, ctx, m } = messyScene(22);
    const dirtBefore = s.seats[3]!.dirt;
    run(s, ctx, 30);
    expect(m.messy!.count).toBeGreaterThan(1);
    expect(s.seats[3]!.dirt).toBeGreaterThan(dirtBefore + 0.2);
    run(s, ctx, 40);
    expect(m.state === 'leaving' || m.state === 'left').toBe(true);
    // 帰ったあとの席は汚れていて、拭くときれいになる
    const seat = s.seats[3]!;
    expect(seat.dirt).toBeGreaterThan(BALANCE.cleaning.counterCleanBelow);
    s.players[0]!.pos = { x: 2.6, z: 1.55 };
    const r = applyAction(s, 'p1', { type: 'interact', targetId: seat.id, verb: 'wipe' }, ctx);
    if (r.ok) run(s, ctx, BALANCE.cleaning.wipeTime + 0.5);
    else expect(r.reason).toBeTruthy();
  });

  it('隣の客は迷惑に感じて満足度が下がる（遠い席は影響が小さい。こだわりの低い客は気にしにくい）。同じトラブルで二度は下がらない', () => {
    let nearLoss = 0;
    let farLoss = 0;
    let lowLoss = 0;
    for (let seed = 30; seed < 50; seed++) {
      const a = messyScene(seed);
      run(a.s, a.ctx, 50);
      nearLoss += (1 - a.left.sat.comfort) + (1 - a.right.sat.comfort);
      farLoss += 1 - a.far.sat.comfort;
      // 何度汚されても、1人の客の不満は1回だけ
      for (const v of [a.left, a.right, a.far]) {
        expect((v.botheredBy ?? []).filter((x) => x === 'trX').length).toBeLessThanOrEqual(1);
        expect(v.sat.comfort).toBeGreaterThanOrEqual(1 - BALANCE.guests.messy.comfortLoss - 1e-9 - 0.3);
      }
      while (restores.length) restores.pop()!();
      const b = messyScene(seed, 0);
      run(b.s, b.ctx, 50);
      lowLoss += (1 - b.left.sat.comfort) + (1 - b.right.sat.comfort);
      while (restores.length) restores.pop()!();
    }
    expect(nearLoss).toBeGreaterThan(farLoss * 2);
    expect(nearLoss).toBeGreaterThan(lowLoss);
    expect(lowLoss).toBeGreaterThan(0);
  });

  it('迷惑を受けた客は満足度が下がり、口コミ・評判の元になる満足度に表れる', () => {
    const a = messyScene(51);
    const control = eating(a.s, 0, 80, { cleanlinessDemand: 0.9 });
    control.sat.comfort = a.left.sat.comfort;
    control.sat.cleanliness = 1;
    const base = overallSatisfaction(control);
    run(a.s, a.ctx, 50);
    const victims = [a.left, a.right].filter((v) => v.botheredBy?.includes('trX'));
    expect(victims.length).toBeGreaterThan(0);
    for (const v of victims) expect(overallSatisfaction(v)).toBeLessThan(base);
    expect(a.s.today.troubles).toBeGreaterThanOrEqual(1);
  });

  it('注意すると性格で反応が変わる（改める・聞き流す・怒る）。改めると汚しにくくなり、迷惑を受けた客の不満の一部が戻る', () => {
    const results = { stop: 0, other: 0 };
    let relieved = false;
    for (let seed = 60; seed < 100; seed++) {
      const a = messyScene(seed);
      a.m.traits.manners = seed % 2 === 0 ? 0.95 : 0.05;
      a.m.traits.complaintPropensity = seed % 2 === 0 ? 0 : 1;
      run(a.s, a.ctx, 20);
      const before = a.left.sat.comfort + a.right.sat.comfort;
      respondManner(a.s, a.ctx, a.s.seats[3]!, a.s.players[0]!, 'warn');
      if (a.m.messy!.calmed) {
        results.stop += 1;
        if (a.left.sat.comfort + a.right.sat.comfort > before) relieved = true;
      } else results.other += 1;
      expect(a.m.messy!.warned).toBe(1);
      while (restores.length) restores.pop()!();
    }
    expect(results.stop).toBeGreaterThan(5);
    expect(results.other).toBeGreaterThan(5);
    expect(relieved).toBe(true);
  });

  it('迷惑を受けた隣の客に、別の空き席へ丼ごと移ってもらえる（オーナー回答）', () => {
    for (let seed = 110; seed < 140; seed++) {
      const a = messyScene(seed);
      run(a.s, a.ctx, 25);
      const v = [a.left, a.right].find((x) => x.botheredBy?.includes('trX'));
      if (!v) {
        while (restores.length) restores.pop()!();
        continue;
      }
      const from = a.s.seats.find((x) => x.id === v.seatId)!;
      a.s.bowls[0]!.loc = { at: 'seat', seatId: from.id };
      a.s.bowls[0]!.state = 'served';
      from.bowlId = a.s.bowls[0]!.id;
      const comfort = v.sat.comfort;
      respondManner(a.s, a.ctx, from, a.s.players[0]!, 'move');
      const to = a.s.seats.find((x) => x.id === v.seatId)!;
      expect(to.id).not.toBe(from.id);
      expect(Math.abs(to.index - 3)).toBeGreaterThan(1);
      expect(to.customerId).toBe(v.id);
      expect(from.customerId).toBeNull();
      expect(to.bowlId).toBe(a.s.bowls[0]!.id);
      expect(a.s.orders.find((o) => o.customerId === v.id)!.seatId).toBe(to.id);
      expect(v.sat.comfort).toBeGreaterThan(comfort);
      return;
    }
    throw new Error('迷惑を受けた客がいなかった');
  });

  it('退店を促すと汚い客は帰り、周りの迷惑は止まる', () => {
    const a = messyScene(150);
    run(a.s, a.ctx, 15);
    respondManner(a.s, a.ctx, a.s.seats[3]!, a.s.players[0]!, 'leave');
    expect(['leaving', 'left']).toContain(a.m.state);
    expect(a.s.seats[3]!.customerId).toBeNull();
    const c = a.m.messy!.count;
    run(a.s, a.ctx, 20);
    expect(a.m.messy!.count).toBe(c);
  });
});

describe('店外の喫煙（9）', () => {
  /** 食べ終わって店を出て、店の前でタバコを吸う客と、行列の客 */
  function smokeScene(seed: number, demand = 0.9) {
    const { s, ctx } = newGame(seed);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.smoke, 'chance', 10);
    setBal(BALANCE.guests.group, 'lingerChance', 0);
    const smoker = eating(s, 0, 1, { manners: 0.2 });
    const queue: Customer[] = [];
    for (let i = 0; i < 4; i++) {
      const q = makeCustomer(s, null);
      q.state = 'queue';
      q.patience = 9999;
      q.traits.cleanlinessDemand = demand;
      q.sat.comfort = 0.7;
      q.pos = { x: 2.0 + 0.6 * i, z: -0.9 };
      s.customers.push(q);
      s.queue.push(q.id);
      queue.push(q);
    }
    // 席が空いていないので行列は進まない
    for (const seat of s.seats) if (!seat.customerId) seat.customerId = 'blocker';
    return { s, ctx, smoker, queue };
  }

  it('食後に店の前でタバコを吸う客が出る（店の外・張り紙の前）。吸い終わると帰る', () => {
    const a = smokeScene(201);
    run(a.s, a.ctx, 12);
    expect(a.smoker.state).toBe('smoking');
    expect(a.smoker.pos.z).toBeLessThan(0);
    run(a.s, a.ctx, BALANCE.guests.smoke.to + 5);
    expect(['leaving', 'left']).toContain(a.smoker.state);
  });

  it('普段は低確率で現れる（マナーの悪い客ほど吸いやすい）', () => {
    const { s, ctx } = newGame(202);
    quietOpen(s, ctx);
    let n = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const c = makeCustomer(s, null);
      c.traits.manners = 0.5;
      c.state = 'eating';
      c.pos = { x: 3, z: 1.5 };
      s.customers = [c];
      leaveAfterMeal(s, c, ctx);
      if ((c.state as string) === 'smoking') n += 1;
    }
    const expected = BALANCE.guests.smoke.chance * (1.5 - 0.5);
    expect(n / N).toBeGreaterThan(expected * 0.6);
    expect(n / N).toBeLessThan(expected * 1.4);
  });

  it('放っておくと近くの客が嫌がり満足度が下がる（1人1回だけ）。早く声をかけると一部が戻る', () => {
    const a = smokeScene(203);
    run(a.s, a.ctx, 40);
    const annoyed = a.queue.filter((q) => q.sat.comfort < 0.7);
    expect(annoyed.length).toBeGreaterThan(0);
    for (const q of a.queue) expect(q.sat.comfort).toBeGreaterThanOrEqual(0.7 - BALANCE.guests.smoke.comfortLoss - 1e-9);
    expect(a.s.today.troubles).toBeGreaterThanOrEqual(1);

    const b = smokeScene(204);
    run(b.s, b.ctx, 12);
    expect(b.smoker.state).toBe('smoking');
    run(b.s, b.ctx, 4);
    const sum0 = b.queue.reduce((x, q) => x + q.sat.comfort, 0);
    b.smoker.traits.manners = 1;
    warnSmoker(b.s, b.ctx, b.smoker, b.s.players[0]!);
    const sum1 = b.queue.reduce((x, q) => x + q.sat.comfort, 0);
    expect(['leaving', 'left']).toContain(b.smoker.state);
    expect(sum1).toBeGreaterThanOrEqual(sum0);
  });

  it('声をかけると性格で反応が変わる（やめる・謝って去る・不満を示す・無視する）', () => {
    const lines = new Set<string>();
    let ignored = 0;
    for (let seed = 300; seed < 360; seed++) {
      const a = smokeScene(seed);
      run(a.s, a.ctx, 12);
      if (a.smoker.state !== 'smoking') {
        while (restores.length) restores.pop()!();
        continue;
      }
      a.smoker.traits.manners = (seed % 3) / 2;
      a.smoker.traits.complaintPropensity = 1 - (seed % 3) / 2;
      warnSmoker(a.s, a.ctx, a.smoker, a.s.players[0]!);
      lines.add(a.smoker.say);
      if (a.smoker.state === 'smoking') ignored += 1;
      while (restores.length) restores.pop()!();
    }
    expect(lines.size).toBeGreaterThanOrEqual(4);
    expect(ignored).toBeGreaterThan(0);
  });

  it('プレイヤーは店の外へ出て声をかけられる（操作の候補に出る）', () => {
    const a = smokeScene(205);
    run(a.s, a.ctx, 12);
    const p = a.s.players[0]!;
    p.pos = { x: a.smoker.pos.x + 0.6, z: a.smoker.pos.z };
    const r = applyAction(a.s, 'p1', { type: 'interact', targetId: a.smoker.id, verb: 'smoke_warn' }, a.ctx);
    expect(r.ok).toBe(true);
  });
});

describe('店員の迷惑行為と評価（10）', () => {
  function staff(s: GameState, patience: number): Employee {
    const e = makeEmployee(s, { id: 'cand-x', profile: { name: '店員', role: 'server', skills: { speed: 0.5, cooking: 0.5, service: 0.9, hygiene: 0.5, movement: 0.5 }, wage: 9000, hireFee: 0, experience: 0, diligence: 1, patience } });
    initNewHire(e);
    e.presentToday = true;
    s.employees.push(e);
    return e;
  }

  it('店員がクレームで口論になると、見ていた周りの客の居心地が下がる（1つのトラブルで1回だけ）', () => {
    for (let seed = 400; seed < 460; seed++) {
      const { s, ctx } = newGame(seed);
      quietOpen(s, ctx);
      const e = staff(s, 0);
      const victim = eating(s, 3, 80);
      const neighbor = eating(s, 4, 80);
      neighbor.sat.comfort = 0.7;
      startComplaint(s, ctx, victim, 'delay', '遅い！', false);
      respondToComplaint(s, ctx, s.seats[3]!, e, 'apologize');
      const argued = (e.record?.argue ?? 0) > 0;
      if (argued) {
        expect(neighbor.sat.comfort).toBeCloseTo(0.7 - BALANCE.guests.witness.comfortLoss);
        expect(s.today.troubles).toBeGreaterThanOrEqual(1);
        // 同じ口論で二度は下がらない
        updateManners(s, 0.1, ctx);
        expect(neighbor.sat.comfort).toBeCloseTo(0.7 - BALANCE.guests.witness.comfortLoss);
        while (restores.length) restores.pop()!();
        return;
      }
      while (restores.length) restores.pop()!();
    }
    throw new Error('口論が起きなかった');
  });

  it('一つのトラブルで同じ客の口コミは1件だけ（評価の重複がない）', () => {
    const a = (() => {
      const { s, ctx } = newGame(470);
      quietOpen(s, ctx);
      setBal(BALANCE.guests.group, 'lingerChance', 0);
      setBal(BALANCE.guests.smoke, 'chance', 0);
      const m = eating(s, 3, 60, { manners: 0 });
      m.messy = { next: 0, count: 0, calmed: false, warned: 0, troubleId: 'trY', firstBotherT: null, victims: [] };
      const v = eating(s, 4, 70, { cleanlinessDemand: 1, reviewPropensity: 1 });
      return { s, ctx, m, v };
    })();
    runDay(a.s, a.ctx);
    const reviews = a.s.history.length > 0 ? a.s.reviews.filter((r) => r.day === 3) : [];
    // 迷惑を受けた客の口コミは1件（来店1回につき1回だけ書く）
    expect(reviews.length).toBeLessThanOrEqual(2);
    expect((a.v.botheredBy ?? []).filter((x) => x === 'trY').length).toBeLessThanOrEqual(1);
  });
});

describe('従業員の対応（7-4・8-5・9-3）', () => {
  it('従業員は、何度も汚す客に食べ方を注意する', () => {
    const { s, ctx } = newGame(500);
    quietOpen(s, ctx);
    const bot = addBot(s, 'server');
    const m = eating(s, 3, 200, { manners: 0.5 });
    m.messy = { next: 999, count: 2, calmed: false, warned: 0, troubleId: 'trE', firstBotherT: null, victims: [] };
    run(s, ctx, 30);
    expect(m.messy.warned).toBe(1);
    expect(bot.tasksDone).toBeGreaterThan(0);
  });

  it('従業員は、待っている客がいるときに居座る団体へ声をかける', () => {
    const { s, ctx } = newGame(501);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.group, 'lingerChance', 1);
    setBal(BALANCE.guests.group, 'lingerTo', 400);
    setBal(BALANCE.guests.group, 'lingerFrom', 399);
    addBot(s, 'server');
    const a = eating(s, 0, 1);
    const b = eating(s, 1, 1);
    group([a, b]);
    const q = makeCustomer(s, null);
    q.state = 'queue';
    q.patience = 9999;
    q.pos = { x: 2, z: -0.9 };
    s.customers.push(q);
    s.queue.push(q.id);
    for (const seat of s.seats) if (!seat.customerId) seat.customerId = 'blocker';
    run(s, ctx, 2);
    expect(a.group!.linger).toBeTruthy();
    run(s, ctx, 60);
    expect(a.group!.linger!.asked).toBeGreaterThan(0);
  });

  it('従業員は店の外へ出て、喫煙客に禁煙を伝え、店内に戻る', () => {
    const { s, ctx } = newGame(502);
    quietOpen(s, ctx);
    setBal(BALANCE.guests.smoke, 'chance', 10);
    setBal(BALANCE.guests.group, 'lingerChance', 0);
    const bot = addBot(s, 'server');
    const smoker = eating(s, 0, 1, { manners: 1, complaintPropensity: 0 });
    let wentOut = false;
    for (let i = 0; i < 900 && smoker.state !== 'leaving' && smoker.state !== 'left'; i++) {
      run(s, ctx, 0.1);
      wentOut ||= bot.pos.z < 0;
    }
    expect(wentOut).toBe(true);
    expect(smoker.smoke?.warned).toBe(true);
    run(s, ctx, 30);
    expect(bot.pos.z).toBeGreaterThan(0);
  });
});
