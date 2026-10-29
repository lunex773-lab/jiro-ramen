import { afterEach, describe, expect, it } from 'vitest';
import {
  applyAction,
  arrivalRate,
  BALANCE,
  buzzChance,
  canComplain,
  createGame,
  criticScore,
  ensureEvents,
  listVerbs,
  makeCtx,
  nextDay,
  RARE_LINES,
  startComplaint,
  step,
  type Customer,
  type GameEvent,
  type GameState,
  type SimCtx,
} from '../src';
import { act, addBot, addSoloBot, cookAndServe, newGame, run, runDay, seatCustomer } from './helpers';

// 確率を一時的に変える（テストの最後に戻す）
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

/** すべてのイベントの確率を 0 にする（強制発生だけを起こす） */
function noRandomEvents(): void {
  const e = BALANCE.events;
  setBal(e.buzz, 'chancePerCheck', 0);
  setBal(e.critic, 'chancePerDay', 0);
  setBal(e.rare, 'coupleChance', 0);
  setBal(e.rare, 'loverChance', 0);
  setBal(e.complaint, 'delayChance', 0);
  setBal(e.complaint, 'dirtyChance', 0);
  setBal(e.complaint, 'unreasonableChance', 0);
  setBal(e.explosion, 'chancePerDay', 0);
}

function openDay(s: GameState, ctx: SimCtx, day = 3): void {
  s.day = day;
  const r = applyAction(s, 'p1', { type: 'openShop' }, ctx);
  if (!r.ok) throw new Error(r.reason);
}

function custOf(s: GameState, orderId: string): Customer {
  const o = s.orders.find((x) => x.id === orderId)!;
  return s.customers.find((c) => c.id === o.customerId)!;
}

function events(ctx: SimCtx, type: string): GameEvent[] {
  return ctx.events.filter((e) => e.type === type);
}

describe('イベントの共通部分', () => {
  it('イベントが起きない設定でも通常営業が動き、既存の乱数の並びは変わらない', () => {
    noRandomEvents();
    const play = () => {
      const { s, ctx } = newGame(31);
      addSoloBot(s);
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      return s;
    };
    const a = play();
    const b = play();
    expect(a.phase).toBe('closed');
    expect(a.history.at(-1)!.served).toBeGreaterThan(10);
    expect(a.rng).toBe(b.rng);
    expect(a.money).toBe(b.money);
    // 抽選は記録されるが、発生はしていない
    const st = a.events!.stats;
    expect(Object.values(st).every((x) => x.fired === 0)).toBe(true);
    expect(st.rare_lover!.draws).toBeGreaterThan(0);
  });

  it('チュートリアル中はイベントを起こせない', () => {
    const s = createGame({ seed: 3, tutorial: true });
    const ctx = makeCtx();
    const r = applyAction(s, 'p1', { type: 'debugEvent', kind: 'sns_buzz' }, ctx);
    expect(r.ok).toBe(false);
  });

  it('古いセーブ（イベントの項目がない状態）でもそのまま営業できる', () => {
    const { s, ctx } = newGame(32);
    delete s.events;
    delete s.prepSnapshot;
    addSoloBot(s);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.phase).toBe('closed');
    expect(s.events).toBeDefined();
    // 控えがなかった日は爆発事故を抽選しない
    expect(s.events!.stats.explosion?.draws ?? 0).toBe(0);
    expect(nextDay(s, ctx).ok).toBe(true);
    // 翌日からは仕込み開始時点の控えができる
    const snapshotDay = (x: GameState) => x.prepSnapshot?.day;
    expect(snapshotDay(s)).toBe(s.day);
  });
});

describe('SNS でバズる', () => {
  it('来客の倍率だけが上がり、売上は提供した分だけ（二重計上しない）', () => {
    noRandomEvents();
    const { s, ctx } = newGame(41);
    addSoloBot(s);
    openDay(s, ctx);
    run(s, ctx, 60);
    const before = arrivalRate(s);
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'sns_buzz' }, ctx).ok).toBe(true);
    const buzz = s.events!.buzz!;
    expect(arrivalRate(s)).toBeCloseTo(before * BALANCE.events.buzz.arrivalMult, 5);
    expect(s.notices.some((n) => n.code === 'buzz' && n.level === 'good')).toBe(true);
    run(s, ctx, 30);
    expect(s.customers.some((c) => c.fromBuzz)).toBe(true);
    run(s, ctx, BALANCE.events.buzz.duration);
    expect(s.events!.buzz).toBeNull();
    expect(s.openT).toBeGreaterThan(buzz.endT);
    runDay(s, ctx);
    // 売上の取引の数 = 提供した数、売上 = 売上の取引の合計
    const day = s.history.at(-1)!;
    const sales = s.transactions.filter((t) => t.type === 'sale' && t.day === day.day);
    expect(sales.length).toBe(day.served);
    expect(sales.reduce((a, t) => a + t.amount, 0)).toBe(day.sales);
  });

  it('バズると同じ時間帯の来店が増える', () => {
    noRandomEvents();
    const count = (buzz: boolean) => {
      const { s, ctx } = newGame(42);
      openDay(s, ctx);
      run(s, ctx, 40);
      if (buzz) applyAction(s, 'p1', { type: 'debugEvent', kind: 'sns_buzz' }, ctx);
      const n0 = s.today.customers + s.today.balked;
      run(s, ctx, 100);
      return s.today.customers + s.today.balked - n0;
    };
    expect(count(true)).toBeGreaterThan(count(false) * 1.5);
  });

  it('評判と直近の口コミが良いほど起きやすい', () => {
    const { s } = newGame(43);
    s.reputation = 2.5;
    const low = buzzChance(s);
    s.reputation = 4.2;
    const high = buzzChance(s);
    s.todayReviews.push(...Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, day: 1, stars: 5, text: '', parts: { taste: 1, speed: 1, service: 1, cleanliness: 1, accuracy: 1, stock: 1, value: 1, comfort: 1 }, regular: false })));
    expect(high).toBeGreaterThan(low * 2);
    expect(buzzChance(s)).toBeGreaterThan(high);
  });

  it('1日1回まで、終わってから数日は起きない', () => {
    const { s, ctx } = newGame(44);
    setBal(BALANCE.events.buzz, 'chancePerCheck', 1);
    addSoloBot(s);
    openDay(s, ctx);
    runDay(s, ctx);
    expect(s.events!.stats.sns_buzz!.fired).toBe(1);
    const day = s.day;
    nextDay(s, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    expect(s.events!.stats.sns_buzz!.fired).toBe(1);
    expect(s.events!.stats.sns_buzz!.lastDay).toBe(day);
  });
});

describe('クレーム', () => {
  it('提供前（遅れ）のクレームで返金すると、食券の払い戻しだけでお金は動かない', () => {
    const { s, ctx } = newGame(51);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0);
    const c = custOf(s, o.id);
    startComplaint(s, ctx, c, 'delay', 'まだですか？', false);
    const seat = s.seats[0]!;
    s.players[0]!.pos = { x: 1.6, z: 2.85 };
    const money = s.money;
    const verbs = listVerbs(s, 'p1', seat.id);
    expect(verbs.find((v) => v.verb === 'complaint_remake')?.reason).toBe('まだ提供していません');
    expect(verbs.find((v) => v.verb === 'complaint_refund')?.label).toBe('食券代を払い戻す');
    act(s, ctx, seat.id, 'complaint_refund');
    expect(s.money).toBe(money);
    expect(s.today.refunds).toBe(0);
    expect(s.transactions.some((t) => t.type === 'refund')).toBe(false);
    expect(o.status).toBe('cancelled');
    expect(c.state).toBe('leaving');
    expect(seat.customerId).toBeNull();
  });

  it('提供後の返金は1回だけ計上される（二重に返金しない）', () => {
    const { s, ctx } = newGame(52);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0, 'small', undefined, { complaintPropensity: 1 });
    cookAndServe(s, ctx, o, false);
    const c = custOf(s, o.id);
    expect(c.state).toBe('complaint');
    expect(c.complaint?.cause).toBe('mistake');
    const money = s.money;
    act(s, ctx, o.seatId, 'complaint_refund');
    expect(s.money).toBe(money - o.price);
    expect(s.today.refunds).toBe(o.price);
    // もう一度は押せない（クレームは終わっている）
    expect(applyAction(s, 'p1', { type: 'interact', targetId: o.seatId, verb: 'complaint_refund' }, ctx).ok).toBe(false);
    expect(s.money).toBe(money - o.price);
  });

  it('理不尽な要求は断っても損をしない。断られて帰る客は口コミを書かない', () => {
    const { s, ctx } = newGame(53);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    setBal(BALANCE.events.complaint.accept.unreasonable, 'refuse', 0);
    const o = seatCustomer(s, 0, 'small', undefined, { reviewPropensity: 1 });
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'complaint_unreasonable' }, ctx).ok).toBe(true);
    cookAndServe(s, ctx, o, true);
    const c = custOf(s, o.id);
    expect(c.state).toBe('complaint');
    expect(c.complaint?.cause).toBe('unreasonable');
    const money = s.money;
    const reviews = s.todayReviews.length;
    act(s, ctx, o.seatId, 'complaint_refuse');
    expect(s.money).toBe(money);
    expect(c.state).toBe('leaving');
    expect(s.todayReviews.length).toBe(reviews);
  });

  it('正当なクレームを断ると、返金はしないが必ず★1の口コミを書かれる', () => {
    const { s, ctx } = newGame(54);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0, 'small', undefined, { complaintPropensity: 1 });
    cookAndServe(s, ctx, o, false);
    const money = s.money;
    act(s, ctx, o.seatId, 'complaint_refuse');
    expect(s.money).toBe(money);
    const bad = s.todayReviews.filter((r) => r.stars === 1);
    expect(bad.length).toBe(1);
    expect(bad[0]!.text).toContain('突っぱね');
  });

  it('謝っても受け入れてもらえないと、そのクレームの間は同じ対応を選べない', () => {
    const { s, ctx } = newGame(55);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    setBal(BALANCE.events.complaint.accept.mistake, 'apologize', 0);
    const o = seatCustomer(s, 0, 'small', undefined, { complaintPropensity: 1 });
    cookAndServe(s, ctx, o, false);
    act(s, ctx, o.seatId, 'complaint_apologize');
    const c = custOf(s, o.id);
    expect(c.state).toBe('complaint');
    expect(c.complaint?.tried).toEqual(['apologize']);
    const v = listVerbs(s, 'p1', o.seatId).find((x) => x.verb === 'complaint_apologize');
    expect(v?.enabled).toBe(false);
    // 作り直しは選べ、作り直すとクレームは終わる
    act(s, ctx, o.seatId, 'complaint_remake');
    expect(c.state).toBe('seated');
    expect(c.complaint).toBeNull();
  });

  it('汚れのクレームは謝って拭くと席がきれいになり、待ちに戻る', () => {
    const { s, ctx } = newGame(56);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    setBal(BALANCE.events.complaint.accept.dirty, 'apologize', 1);
    const o = seatCustomer(s, 0);
    const seat = s.seats[0]!;
    seat.dirt = 0.8;
    const c = custOf(s, o.id);
    startComplaint(s, ctx, c, 'dirty', '汚い', false);
    s.players[0]!.pos = { x: 1.6, z: 2.85 };
    act(s, ctx, seat.id, 'complaint_apologize');
    expect(seat.dirt).toBe(0);
    expect(c.state).toBe('seated');
    expect(o.status).toBe('waiting');
  });

  it('提供前のクレームの最中に丼が届くと、クレームは終わって食べ始める', () => {
    const { s, ctx } = newGame(57);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0);
    const c = custOf(s, o.id);
    startComplaint(s, ctx, c, 'delay', 'まだ？', false);
    cookAndServe(s, ctx, o, true);
    expect(c.complaint).toBeNull();
    expect(c.state).toBe('eating');
  });

  it('同じ客は同じ原因で何度もクレームを言わない（1回の来店で2回まで）', () => {
    const { s, ctx } = newGame(58);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0);
    const c = custOf(s, o.id);
    startComplaint(s, ctx, c, 'delay', 'まだ？', false);
    c.state = 'seated';
    c.complaint = null;
    expect(canComplain(s, c, 'delay')).toBe(false);
    expect(canComplain(s, c, 'dirty')).toBe(true);
    startComplaint(s, ctx, c, 'dirty', '汚い', false);
    expect(canComplain(s, c, 'mistake')).toBe(false);
  });

  it('提供が遅れるとクレームになり、従業員が謝って対応する', () => {
    const { s, ctx } = newGame(59);
    setBal(BALANCE.events.complaint, 'delayChance', 100);
    setBal(BALANCE.events.complaint.accept.delay, 'apologize', 1);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0, 'small', undefined, { patience: 0, complaintPropensity: 0.5 });
    run(s, ctx, 45);
    const c = custOf(s, o.id);
    expect(events(ctx, 'complaint').length).toBe(1);
    expect(c.complaintLog?.[0]?.cause).toBe('delay');
    addBot(s, 'server');
    run(s, ctx, 20);
    expect(events(ctx, 'complaintResolved').length).toBe(1);
    expect(c.state === 'seated' || c.state === 'eating').toBe(true);
  });
});

describe('覆面調査員', () => {
  it('評価は満足度の項目（実際の営業）だけで決まる', () => {
    const { s } = newGame(61);
    const o = seatCustomer(s, 0);
    const c = custOf(s, o.id);
    c.sat = { ...c.sat, taste: 0.95, speed: 0.9, service: 0.85, cleanliness: 0.95, accuracy: 1 };
    const good = criticScore(c, true);
    c.sat = { ...c.sat, taste: 0.4, speed: 0.2, service: 0.3, cleanliness: 0.4, accuracy: 0.6 };
    const bad = criticScore(c, true);
    expect(good.stars).toBeGreaterThanOrEqual(4.5);
    expect(good.improve).toEqual([]);
    expect(bad.stars).toBeLessThanOrEqual(2.5);
    expect(bad.improve[0]).toBe('speed');
    // 同じ営業なら同じ評価（運任せにしない）
    expect(criticScore(c, true)).toEqual(bad);
  });

  it('通常の客として来店・注文・食事をし、翌日の仕込みの開始時に記事が公開される', () => {
    noRandomEvents();
    const { s, ctx } = newGame(62);
    addSoloBot(s);
    s.day = 3;
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'critic' }, ctx).ok).toBe(true);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    run(s, ctx, 60);
    const critic = s.customers.find((c) => c.special?.kind === 'critic');
    expect(critic).toBeDefined();
    // 見た目・名前に正体は出さない
    expect(critic!.look ?? null).toBeNull();
    runDay(s, ctx);
    const ev = s.events!;
    expect(ev.critics.length).toBe(1);
    expect(ev.critics[0]!.published).toBe(false);
    expect(s.reviews.some((r) => r.critic)).toBe(false);
    const rep = s.reputation;
    const report = ev.critics[0]!;
    nextDay(s, ctx);
    expect(report.published).toBe(true);
    expect(s.reviews.some((r) => r.critic)).toBe(true);
    expect(s.reputation).toBeCloseTo(Math.min(5, Math.max(1, rep + (report.stars - 3) * BALANCE.events.critic.repPerStar)), 5);
    expect(s.notices.some((n) => n.code === `critic:${report.id}`)).toBe(true);
    // 公開は仕込み開始時点の控えにも入っている（事故のリセットで消えない）
    expect(s.prepSnapshot!.state.events!.critics[0]!.published).toBe(true);
  });

  it('高評価なら数日間お客さんが増え、低評価なら減る', () => {
    const mult = (stars: number) => {
      const { s, ctx } = newGame(63);
      s.day = 3;
      s.phase = 'closed';
      ensureEvents(s).critics.push({ id: 'cr1', day: 3, publishDay: 4, stars, scores: { taste: 1, speed: 1, service: 1, cleanliness: 1, accuracy: 1 }, walkedOut: false, published: false, text: 'x', improve: [] });
      nextDay(s, ctx);
      s.phase = 'open';
      s.openT = 200;
      const withEffect = arrivalRate(s);
      s.events!.effects = [];
      return withEffect / arrivalRate(s);
    };
    expect(mult(4.5)).toBeCloseTo(BALANCE.events.critic.goodMult, 5);
    expect(mult(2)).toBeCloseTo(BALANCE.events.critic.badMult, 5);
    expect(mult(3.5)).toBeCloseTo(1, 5);
  });
});

describe('珍しい客', () => {
  it('カップル: 2人で並び、彼女が彼氏に向けて一度だけ話し、2人とも普通に食べて帰る', () => {
    noRandomEvents();
    const { s, ctx } = newGame(71);
    addSoloBot(s);
    addBot(s, 'server');
    applyAction(s, 'p1', { type: 'debugEvent', kind: 'rare_couple' }, ctx);
    openDay(s, ctx, 2);
    run(s, ctx, 30);
    const her = s.customers.find((c) => c.special?.kind === 'couple_her')!;
    const him = s.customers.find((c) => c.special?.kind === 'couple_him')!;
    expect(her.look).toBe('blonde_woman');
    expect(him.look).toBe('boyfriend');
    expect(her.partyId).toBe(him.id);
    const herId = her.id;
    const himId = him.id;
    let lines = events(ctx, 'rareLine').length;
    let ate = 0;
    for (let i = 0; i < 4000 && s.phase !== 'closed'; i++) {
      ctx.events.length = 0;
      step(s, 0.1, ctx);
      lines += ctx.events.filter((e) => e.type === 'rareLine').length;
      for (const id of [herId, himId]) if (s.customers.find((c) => c.id === id)?.state === 'eating') ate |= id === herId ? 1 : 2;
      if (!s.customers.some((c) => c.id === herId || c.id === himId)) break;
    }
    expect(lines).toBe(1);
    expect(ate).toBe(3);
    expect(s.customers.some((c) => c.id === herId || c.id === himId)).toBe(false);
  });

  it('一人客: 食事の途中で一度だけ、小声で話す（満足しているときだけ）', () => {
    noRandomEvents();
    const { s, ctx } = newGame(72);
    openDay(s, ctx);
    s.arrivalAcc = -1e9;
    const o = seatCustomer(s, 0);
    const c = custOf(s, o.id);
    c.special = { kind: 'ramen_lover', eventId: 'ev1', spoken: false };
    cookAndServe(s, ctx, o, true);
    expect(c.state).toBe('eating');
    let said = 0;
    for (let i = 0; i < 600 && c.state === 'eating'; i++) {
      ctx.events.length = 0;
      step(s, 0.1, ctx);
      if (c.say === RARE_LINES.lover && ctx.events.some((e) => e.type === 'rareLine')) {
        said++;
        expect(c.sayStyle).toBe('whisper');
      }
    }
    expect(said).toBe(1);
    expect(c.state === 'leaving' || c.state === 'left').toBe(true);
  });
});
