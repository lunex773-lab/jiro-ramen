// 第2版 Phase 4: YouTuber・テレビ取材・芸能人のサイン（設計書 18-4）
import { afterEach, describe, expect, it } from 'vitest';
import {
  CELEBRITIES,
  TV_SHOWS,
  applyAction,
  arrivalRate,
  BALANCE,
  buzzBoostFactor,
  buzzChance,
  ensureEvents,
  eventDemandFactor,
  forceMedia,
  isHostOnly,
  makeSaveFile,
  nextDay,
  parseSave,
  pendingRequests,
  respondFilm,
  signsOf,
  seatPos,
  STAGES,
  step,
  type Customer,
  type GameState,
  type SimCtx,
} from '../src';
import { addSoloBot, newGame, run, runDay } from './helpers';

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

/** 他のイベントを止める */
function quiet(): void {
  setBal(BALANCE.events.buzz, 'chancePerCheck', 0);
  setBal(BALANCE.events.critic, 'chancePerDay', 0);
  setBal(BALANCE.events.rare, 'coupleChance', 0);
  setBal(BALANCE.events.rare, 'loverChance', 0);
  setBal(BALANCE.events.explosion, 'chancePerDay', 0);
  setBal(BALANCE.events.youtuber, 'chancePerDay', 0);
  setBal(BALANCE.events.tv, 'chancePerDay', 0);
  setBal(BALANCE.guests.messy, 'chance', 0);
  setBal(BALANCE.guests.smoke, 'chance', 0);
  setBal(BALANCE.guests.group, 'lingerChance', 0);
}

function open(s: GameState, ctx: SimCtx, day = 5): void {
  s.day = day;
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
}

/** YouTuber が来るまで進める */
function untilYoutuber(s: GameState, ctx: SimCtx, max = 200): Customer {
  for (let t = 0; t < max; t += 0.5) {
    step(s, 0.5, ctx);
    const c = s.customers.find((x) => x.special?.kind === 'youtuber');
    if (c) return c;
  }
  throw new Error('YouTuber が来なかった');
}

/** 席に着くまで進める（ソロのボットが提供する） */
function untilState(s: GameState, ctx: SimCtx, c: Customer, states: string[], max = 600): void {
  for (let t = 0; t < max && !states.includes(c.state); t += 0.25) step(s, 0.25, ctx);
}

describe('YouTuber（11）', () => {
  it('YouTuber が来店し、事前に撮影の許可を求めることがある（ホストへの確認。答えがなければ許可しない）', () => {
    quiet();
    setBal(BALANCE.events.youtuber, 'askChance', 1);
    const { s, ctx } = newGame(601);
    forceMedia(s, 'youtuber');
    open(s, ctx);
    const c = untilYoutuber(s, ctx);
    expect(c.special!.film!.permission).toBe('asking');
    const req = pendingRequests(s);
    expect(req).toHaveLength(1);
    expect(req[0]!.kind).toBe('filming');
    expect(isHostOnly('answerRequest')).toBe(true);
    run(s, ctx, BALANCE.events.youtuber.answerTimeout + 1);
    expect(pendingRequests(s)).toHaveLength(0);
    expect(c.special!.film!.permission).toBe('denied');
  });

  it('許可すると席で撮影し、食べ終わると撮影が完了する。完了の日から3日間 SNS バズの確率が上がり、その後は元に戻る', { timeout: 30_000 }, () => {
    quiet();
    setBal(BALANCE.events.youtuber, 'askChance', 1);
    const { s, ctx } = newGame(602);
    addSoloBot(s);
    forceMedia(s, 'youtuber');
    open(s, ctx);
    const c = untilYoutuber(s, ctx);
    const base = buzzChance(s);
    expect(applyAction(s, 'p1', { type: 'answerRequest', requestId: pendingRequests(s)[0]!.id, accept: true }, ctx).ok).toBe(true);
    expect(c.special!.film!.permission).toBe('permitted');
    // 許可しただけでは確率は上がらない
    expect(buzzBoostFactor(s)).toBe(1);
    untilState(s, ctx, c, ['eating']);
    expect(c.special!.film!.filming).toBe('filming');
    untilState(s, ctx, c, ['afterMeal', 'leaving', 'left', 'smoking'], 900);
    expect(c.special!.film!.filming).toBe('done');
    const day = s.day;
    expect(buzzBoostFactor(s)).toBeCloseTo(1 + BALANCE.events.youtuber.buzzBoost);
    expect(buzzChance(s)).toBeCloseTo(base * (1 + BALANCE.events.youtuber.buzzBoost));
    runDay(s, ctx);
    for (let d = 1; d <= 4; d++) {
      expect(nextDay(s, ctx).ok).toBe(true);
      if (d <= BALANCE.events.youtuber.boostDays) expect(buzzBoostFactor(s), `day+${d}`).toBeGreaterThan(1);
      else expect(buzzBoostFactor(s), `day+${d}`).toBe(1);
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
    }
    expect(s.day).toBe(day + 4);
  });

  it('撮影の効果は重ねられ（上限あり）、それぞれ3日で切れる（オーナー回答）', () => {
    const { s } = newGame(603);
    const ev = ensureEvents(s);
    s.day = 10;
    ev.buzzBoosts = [
      { id: 'b1', day: 8, untilDay: 11, add: 1.5 },
      { id: 'b2', day: 10, untilDay: 13, add: 1.5 },
    ];
    expect(buzzBoostFactor(s)).toBe(Math.min(BALANCE.events.youtuber.buzzBoostCap, 4));
    s.day = 12;
    expect(buzzBoostFactor(s)).toBeCloseTo(2.5);
    s.day = 14;
    expect(buzzBoostFactor(s)).toBe(1);
  });

  it('許可していない撮影はやめさせられる（やめる・謝る・不満を示す・続けようとする）。周りの客は嫌がり、許可のない撮影では確率は上がらない', () => {
    const outcomes = new Set<string>();
    let kept = 0;
    for (let seed = 610; seed < 650; seed++) {
      quiet();
      setBal(BALANCE.events.youtuber, 'askChance', 0);
      setBal(BALANCE.events.youtuber, 'sneakUnasked', 1);
      const { s, ctx } = newGame(seed);
      addSoloBot(s);
      // ボットが注意しないように、撮影への声かけは任せない
      s.employees[0]!.priorities.film = -100;
      forceMedia(s, 'youtuber');
      open(s, ctx);
      const c = untilYoutuber(s, ctx);
      c.traits.complaintPropensity = (seed % 4) / 3;
      untilState(s, ctx, c, ['seated', 'eating']);
      run(s, ctx, 0.5);
      const f = c.special!.film!;
      expect(f.filming).toBe('filming');
      expect(f.permission).toBe('unasked');
      const seat = s.seats.find((x) => x.id === c.seatId)!;
      respondFilm(s, ctx, seat, s.players[0]!, seed % 2 === 0 ? 'stop' : 'rules');
      if (f.filming === 'filming') {
        kept += 1;
        outcomes.add('keepOn');
        // 続けたら退店を促せる
        respondFilm(s, ctx, seat, s.players[0]!, 'leave');
        expect(['leaving', 'left']).toContain(c.state);
      } else outcomes.add(c.say);
      expect(buzzBoostFactor(s)).toBe(1);
      while (restores.length) restores.pop()!();
    }
    expect(kept).toBeGreaterThan(0);
    expect(outcomes.size).toBeGreaterThanOrEqual(4);
  });
});

describe('テレビ取材（12）', () => {
  function tvScene(seed: number) {
    quiet();
    const { s, ctx } = newGame(seed);
    addSoloBot(s, 0.8);
    forceMedia(s, 'tv');
    open(s, ctx);
    run(s, ctx, 4);
    const tv = ensureEvents(s).tv!;
    expect(tv).toBeTruthy();
    const crew = tv.memberIds.map((id) => s.customers.find((x) => x.id === id)!);
    return { s, ctx, tv, crew };
  }

  it('8人（出演者2・カメラマン2・スタッフ4）で来て、ホストに受けるか聞く', () => {
    const { s, tv, crew } = tvScene(701);
    const kinds = crew.map((c) => c.special!.kind);
    expect(kinds.filter((k) => k === 'tv_performer')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'tv_camera')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'tv_staff')).toHaveLength(4);
    expect(tv.status).toBe('asking');
    expect(pendingRequests(s)[0]!.kind).toBe('tv');
    expect(tv.celebs).toHaveLength(2);
    expect(new Set(tv.celebs).size).toBe(2);
  });

  it('受けると出演者2人だけが並んで食べ、カメラマンはそばで撮り、スタッフは店の外で待つ。完了で翌日・翌々日の客が確定で増え、サインがもらえる', () => {
    const { s, ctx, tv, crew } = tvScene(702);
    applyAction(s, 'p1', { type: 'answerRequest', requestId: pendingRequests(s)[0]!.id, accept: true }, ctx);
    expect(tv.status).toBe('accepted');
    const perf = crew.filter((c) => c.special!.kind === 'tv_performer');
    const cams = crew.filter((c) => c.special!.kind === 'tv_camera');
    const staff = crew.filter((c) => c.special!.kind === 'tv_staff');
    let camNear = false;
    let staffInside = false;
    for (let t = 0; t < 900 && tv.status === 'accepted'; t += 0.25) {
      step(s, 0.25, ctx);
      const eating = perf.filter((p) => p.state === 'eating');
      for (const cam of cams) {
        for (const p of eating) {
          const seat = s.seats.find((x) => x.id === p.seatId)!;
          const sp = seatPos(s, seat);
          if (Math.hypot(cam.pos.x - sp.x, cam.pos.z - sp.z) < 1.2) camNear = true;
        }
      }
      staffInside ||= staff.some((x) => x.pos.z > 0);
      // カメラマン・スタッフは注文しない
      for (const x of [...cams, ...staff]) {
        expect(x.orderId).toBeNull();
        expect(x.menuId).toBeNull();
      }
    }
    expect(tv.status).toBe('done');
    expect(perf.every((p) => p.special!.ate)).toBe(true);
    expect(camNear).toBe(true);
    expect(staffInside).toBe(false);
    // 翌日・翌々日の来客（確定。来店の倍率）
    const day = tv.day;
    const at = (d: number) => {
      const saved = s.day;
      s.day = d;
      const f = eventDemandFactor(s);
      s.day = saved;
      return f;
    };
    expect(at(day)).toBe(1);
    expect(at(day + 1)).toBeCloseTo(BALANCE.events.tv.nextDayMult);
    expect(at(day + 2)).toBeCloseTo(BALANCE.events.tv.dayAfterMult);
    expect(at(day + 3)).toBe(1);
    // サイン
    expect(signsOf(s).map((x) => x.celebId).sort()).toEqual([...tv.celebs].sort());
    // 翌日の実際の来店の倍率
    runDay(s, ctx);
    expect(nextDay(s, ctx).ok).toBe(true);
    s.openT = 200;
    s.phase = 'open';
    const withTv = arrivalRate(s);
    s.events!.effects = [];
    expect(withTv / arrivalRate(s)).toBeCloseTo(BALANCE.events.tv.nextDayMult);
  });

  it('断る・出演者が食べずに帰ると、効果もサインもない', () => {
    const a = tvScene(703);
    applyAction(a.s, 'p1', { type: 'answerRequest', requestId: pendingRequests(a.s)[0]!.id, accept: false }, a.ctx);
    expect(a.tv.status).toBe('declined');
    run(a.s, a.ctx, 10);
    expect(a.s.events!.effects.filter((e) => e.source === 'tv')).toHaveLength(0);
    expect(signsOf(a.s)).toHaveLength(0);
    while (restores.length) restores.pop()!();

    const b = tvScene(704);
    applyAction(b.s, 'p1', { type: 'answerRequest', requestId: pendingRequests(b.s)[0]!.id, accept: true }, b.ctx);
    // 出演者が待ちきれずに帰る
    for (const p of b.crew.filter((c) => c.special!.kind === 'tv_performer')) p.patience = 0;
    run(b.s, b.ctx, 3);
    expect(b.tv.status).toBe('failed');
    expect(b.s.events!.effects.filter((e) => e.source === 'tv')).toHaveLength(0);
    expect(signsOf(b.s)).toHaveLength(0);
  });

  it('続けて取材が来ても同じ日の効果は重ねない（高いほう）。同じ出演者のサインは1枚で回数を数え、セーブ・読み込み・拡張のあとも残る', () => {
    quiet();
    const { s, ctx } = newGame(705);
    addSoloBot(s, 0.8);
    /** 取材を起こして受け、終わるまで進める */
    const runTv = (celebs?: string[]) => {
      forceMedia(s, 'tv');
      run(s, ctx, 1);
      const tv = ensureEvents(s).tv!;
      if (celebs) {
        tv.celebs = [...celebs];
        const perf = tv.memberIds.map((id) => s.customers.find((x) => x.id === id)!).filter((c) => c.special!.kind === 'tv_performer');
        perf.forEach((p, i) => (p.special!.celebId = celebs[i]));
      }
      applyAction(s, 'p1', { type: 'answerRequest', requestId: pendingRequests(s)[0]!.id, accept: true }, ctx);
      for (let t = 0; t < 900 && tv.status === 'accepted'; t += 0.25) step(s, 0.25, ctx);
      expect(tv.status).toBe('done');
      return tv;
    };
    open(s, ctx, 6);
    const first = runTv();
    runDay(s, ctx);
    expect(nextDay(s, ctx).ok).toBe(true);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runTv(first.celebs);
    // 6日目の取材の翌々日（8日目）と、7日目の取材の翌日（8日目）が重なる: 掛け合わせず高いほう
    const tvFx = ensureEvents(s).effects.filter((e) => e.source === 'tv');
    expect(tvFx.filter((e) => e.fromDay === 8)).toHaveLength(1);
    expect(tvFx.find((e) => e.fromDay === 8)!.mult).toBeCloseTo(Math.max(BALANCE.events.tv.nextDayMult, BALANCE.events.tv.dayAfterMult));
    const saved = s.day;
    s.day = 8;
    expect(eventDemandFactor(s)).toBeCloseTo(Math.max(BALANCE.events.tv.nextDayMult, BALANCE.events.tv.dayAfterMult));
    s.day = saved;
    // 同じ出演者: サインは2枚のまま、回数が2
    expect(signsOf(s)).toHaveLength(2);
    expect(signsOf(s).every((x) => x.visits === 2)).toBe(true);
    // 保存と読み込み
    const file = makeSaveFile(s, 1, null, 0);
    const loaded = parseSave(JSON.stringify(file));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.save.state.events?.signs).toEqual(signsOf(s));
    // 拡張（店の段階が変わっても、サインは店の記録として残る）
    runDay(s, ctx);
    s.money = 50_000_000;
    s.career.unlocked.push(...STAGES.map((x) => x.unlock).filter((x): x is string => !!x));
    expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
    expect(s.career.stage).toBe(1);
    expect(signsOf(s)).toHaveLength(2);
  });
});

// オーナーの指示 2026-11-13: 有名人の名前のレパートリーを増やす（すべて架空）
describe('テレビの出演者と番組の種類', () => {
  it('出演者は30人以上・番組は10以上で、名前と id は重ならない（前からいる8人の id は残る）', () => {
    expect(CELEBRITIES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CELEBRITIES.map((c) => c.id)).size).toBe(CELEBRITIES.length);
    expect(new Set(CELEBRITIES.map((c) => c.name)).size).toBe(CELEBRITIES.length);
    for (const id of ['cel_menta', 'cel_mashiko', 'cel_abura', 'cel_karame', 'cel_ninniku', 'cel_tenchi', 'cel_wasshi', 'cel_chashu']) expect(CELEBRITIES.some((c) => c.id === id)).toBe(true);
    expect(TV_SHOWS.length).toBeGreaterThanOrEqual(10);
  });
});
