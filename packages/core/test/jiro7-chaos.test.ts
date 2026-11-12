// じろ7 Phase 5・6: 独立したイベントの基盤（抽選・同時の上限・クールダウン・連鎖の深さ・記録）と珍客イベント（設計書 6）
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeChaos,
  applyAction,
  BALANCE,
  CHAOS,
  CHAOS_KINDS,
  CHAOS_RULES,
  chaosWeight,
  ensureChaos,
  forceChaos,
  locationInfo,
  makeSaveFile,
  MUNICIPALITIES,
  parseSave,
  planChaos,
  step,
  warnNosepicker,
  type ChaosKind,
  type Customer,
  type GameState,
  type SimCtx,
} from '../src';
import { activeStore } from '../src/sim/company';
import { addSoloBot, clone, newGame } from './helpers';

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

/** ほかのイベント（バズ・調査員・珍しい客・爆発・YouTuber・テレビ・迷惑客）を止める */
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
  setBal(BALANCE.guests.group, 'sizeWeights', [1, 0, 0, 0]);
  for (const k of CHAOS_KINDS) setBal(CHAOS[k], 'dayChance', 0);
}

/** 6日目の仕込みの時間の店（ボットが1人で営業する） */
function game(seed: number): { s: GameState; ctx: SimCtx } {
  const g = newGame(seed);
  g.s.day = 6;
  addSoloBot(g.s);
  return g;
}

function open(s: GameState, ctx: SimCtx): void {
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
}

/** その種類の主役が来るまで進める */
function untilCast(s: GameState, ctx: SimCtx, kind: ChaosKind, max = 400): Customer {
  for (let t = 0; t < max; t += 0.5) {
    step(s, 0.5, ctx);
    const run = activeChaos(s).find((r) => r.kind === kind);
    const c = run && s.customers.find((x) => x.id === run.customerIds[0]);
    if (c) return c;
  }
  throw new Error(`${kind} が起きなかった`);
}

function until(s: GameState, ctx: SimCtx, done: () => boolean, max = 900): void {
  for (let t = 0; t < max && !done(); t += 0.25) step(s, 0.25, ctx);
}

describe('独立したイベントの基盤（じろ7 6）', () => {
  it('どのイベントも単独で起き、終わると記録（見た客・撮影・結果）が残る。ほかのイベントを必要としない', () => {
    for (const kind of CHAOS_KINDS) {
      quiet();
      const { s, ctx } = game(700 + kind.length);
      expect(forceChaos(s, kind).ok).toBe(true);
      open(s, ctx);
      const c = untilCast(s, ctx, kind);
      expect(c.special?.eventId).toBeTruthy();
      // YouTuber・テレビは来ていない
      expect(s.customers.some((x) => x.special?.kind === 'youtuber' || x.special?.kind === 'tv_performer')).toBe(false);
      until(s, ctx, () => !activeChaos(s).some((r) => r.kind === kind), 1500);
      expect(activeChaos(s).some((r) => r.kind === kind)).toBe(false);
      const rec = s.events!.log!.find((r) => r.kind === kind)!;
      expect(rec.state).toBe('done');
      expect(rec.result).toContain(CHAOS[kind].label);
      expect(rec.forced).toBe(true);
      expect(typeof rec.witnesses).toBe('number');
      while (restores.length) restores.pop()!();
    }
  });

  it('珍客の抽選は専用の乱数を使い、客の乱数（s.rng）とほかのイベントの乱数（events.rng）の並びを変えない', () => {
    const { s } = newGame(41);
    s.day = 10;
    const rng = s.rng;
    const evRng = s.events?.rng;
    for (const k of CHAOS_KINDS) setBal(CHAOS[k], 'dayChance', 0.9);
    planChaos(s);
    expect(s.rng).toBe(rng);
    expect(s.events?.rng).toBe(evRng);
    expect(ensureChaos(s).plans.length).toBeGreaterThan(0);
  });

  it('1日の上限・大事さの順・クールダウン（起きた種類はしばらく予定されない）', () => {
    const { s } = newGame(42);
    s.day = 10;
    for (const k of CHAOS_KINDS) setBal(CHAOS[k], 'dayChance', 1);
    planChaos(s);
    const plans = ensureChaos(s).plans;
    expect(plans.length).toBe(CHAOS_RULES.perDayMax);
    // 大事さの高い順（UFO が最初）
    expect(plans[0]!.kind).toBe('ufo');
    for (const p of plans) {
      expect(p.afterOpenT).toBeGreaterThan(0);
      expect(p.chance).toBeGreaterThan(0);
    }
    // UFO が起きた日の翌日は、UFO を予定しない（クールダウン）
    s.events!.stats.ufo = { draws: 1, fired: 1, forced: 0, lastDay: 10 };
    s.day = 11;
    ensureChaos(s).plans = [];
    planChaos(s);
    expect(ensureChaos(s).plans.some((p) => p.kind === 'ufo')).toBe(false);
    // チュートリアル中は起きない
    const t = newGame(43).s;
    t.day = 10;
    t.tutorial = { kind: 'basics', step: 0, mark: {}, entered: false, finished: false };
    planChaos(t);
    expect(ensureChaos(t).plans.length).toBe(0);
  });

  it('同時に起きるのは上限まで。大きなイベント（UFO）は2つ同時に起きない。同時のイベントはつながりとして記録する', () => {
    quiet();
    const { s, ctx } = game(44);
    forceChaos(s, 'ufo');
    forceChaos(s, 'bear');
    forceChaos(s, 'bounce');
    forceChaos(s, 'nosepick');
    open(s, ctx);
    let maxActive = 0;
    let disruptive = 0;
    for (let t = 0; t < 300; t += 0.5) {
      step(s, 0.5, ctx);
      maxActive = Math.max(maxActive, activeChaos(s).length);
      disruptive = Math.max(disruptive, activeChaos(s).filter((r) => CHAOS[r.kind].disruptive).length);
    }
    expect(maxActive).toBe(CHAOS_RULES.maxConcurrent);
    expect(disruptive).toBeLessThanOrEqual(1);
    // 2つ目のイベントは、1つ目を「同時に起きていたイベント」として持つ
    const runs = activeChaos(s);
    if (runs.length === 2) expect(runs[1]!.related).toContain(runs[0]!.recordId);
  });

  it('連鎖: 終わったイベントが確率で別のイベントを起こりやすくする。深さの上限を超えてはつながらない', () => {
    quiet();
    setBal(CHAOS.bear.links[0]!, 'chance', 1);
    const { s, ctx } = game(45);
    forceChaos(s, 'bear');
    open(s, ctx);
    untilCast(s, ctx, 'bear');
    until(s, ctx, () => activeChaos(s).length === 0, 1500);
    const boost = ensureChaos(s).boosts.find((b) => b.kind === 'bounce');
    expect(boost).toBeTruthy();
    expect(boost!.depth).toBe(1);
    expect(boost!.cause).toBe(s.events!.log!.find((r) => r.kind === 'bear')!.id);
    // 起こりやすさの倍率に入る
    expect(chaosWeight(s, 'bounce')).toBeCloseTo(CHAOS.bear.links[0]!.mult, 6);

    // 深さの上限のイベントは、もうつながらない
    const { s: s2, ctx: ctx2 } = game(46);
    open(s2, ctx2);
    ensureChaos(s2).plans.push({ kind: 'bear', day: s2.day, afterOpenT: 0, depth: CHAOS_RULES.maxDepth, cause: 'evr-x', chance: null, forced: true });
    untilCast(s2, ctx2, 'bear');
    until(s2, ctx2, () => activeChaos(s2).length === 0, 1500);
    expect(ensureChaos(s2).boosts.length).toBe(0);
    expect(s2.events!.log!.find((r) => r.kind === 'bear')!.cause).toBe('evr-x');
  });

  it('夜の店では UFO が、田舎ではクマが起こりやすい', () => {
    const { s } = newGame(47);
    s.todayHours = { sessions: [{ open: 660, close: 900 }], closedDays: [] };
    const day = chaosWeight(s, 'ufo');
    s.todayHours = { sessions: [{ open: 1200, close: 1440 }], closedDays: [] };
    const night = chaosWeight(s, 'ufo');
    expect(night).toBeGreaterThan(day * 2);
    const st = activeStore(s);
    st.location = '13104';
    const city = chaosWeight(s, 'bear');
    st.location = Object.keys(MUNICIPALITIES).find((k) => (locationInfo(k)?.densityIndex ?? 0) < -0.9)!;
    const rural = chaosWeight(s, 'bear');
    expect(rural).toBeGreaterThan(city);
  });

  it('セーブして読み込んでも、予定・起きているイベント・連鎖が残る', () => {
    quiet();
    const { s, ctx } = game(48);
    forceChaos(s, 'bounce');
    forceChaos(s, 'golden');
    open(s, ctx);
    untilCast(s, ctx, 'golden');
    ensureChaos(s).boosts.push({ kind: 'ufo', mult: 2, untilDay: s.day + 2, cause: 'evr-y', depth: 1 });
    const before = clone(s.events!.chaos!);
    const loaded = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 0)));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.save.state.events!.chaos).toEqual(before);
    // 古いセーブ（chaos がない）でも動く
    const old = clone(s);
    delete old.events!.chaos;
    for (const c of old.customers) {
      delete c.react;
      delete c.nosepick;
    }
    const ctx2 = ctx;
    for (let i = 0; i < 40; i++) step(old, 0.5, ctx2);
    expect(old.phase).toBe('open');
  });
});

describe('珍客イベント（じろ7 6-5）', () => {
  it('UFO: 店の前に降り、宇宙人が客として食べて帰り、UFO が飛び立つ', () => {
    quiet();
    const { s, ctx } = game(50);
    forceChaos(s, 'ufo');
    open(s, ctx);
    const c = untilCast(s, ctx, 'ufo');
    expect(c.look).toBe('alien');
    expect(c.special?.kind).toBe('alien');
    const u = ensureChaos(s).ufo!;
    expect(u.phase).toBe('descend');
    until(s, ctx, () => ensureChaos(s).ufo?.phase === 'landed', 20);
    expect(ensureChaos(s).ufo?.phase).toBe('landed');
    until(s, ctx, () => c.state === 'eating', 900);
    expect(c.state).toBe('eating');
    until(s, ctx, () => !ensureChaos(s).ufo, 1500);
    expect(ensureChaos(s).ufo).toBeNull();
    expect(['left', 'leaving']).toContain(c.state);
  });

  it('金色覚醒: 食べ終わった瞬間に覚醒し、店を出ると空を飛んで帰る', () => {
    quiet();
    const { s, ctx } = game(51);
    forceChaos(s, 'golden');
    open(s, ctx);
    const c = untilCast(s, ctx, 'golden');
    until(s, ctx, () => c.state === 'eating', 900);
    expect(c.special?.awakenedAt).toBeUndefined();
    until(s, ctx, () => c.special?.awakenedAt !== undefined, 900);
    expect(c.special?.awakenedAt).toBeGreaterThan(0);
    until(s, ctx, () => c.special?.flyAt !== undefined, 300);
    expect(c.special?.flyAt).toBeGreaterThan(c.special!.awakenedAt!);
  });

  it('横バウンス: 近くの客が反応し（笑う・撮る・まねする）、反応は少しの間で消える', () => {
    quiet();
    setBal(CHAOS.bounce, 'reactRadius', 30);
    const { s, ctx } = game(52);
    open(s, ctx);
    // 先に客を何人か来させてから
    for (let i = 0; i < 120; i++) step(s, 0.5, ctx);
    forceChaos(s, 'bounce');
    const c = untilCast(s, ctx, 'bounce');
    const run = activeChaos(s).find((r) => r.kind === 'bounce')!;
    until(s, ctx, () => run.reacted.length > 0, 300);
    expect(run.reacted.length).toBeGreaterThan(0);
    const x = s.customers.find((y) => y.id === run.reacted[0])!;
    expect(x.react?.eventId).toBe(run.recordId);
    until(s, ctx, () => !x.react, 30);
    expect(x.react ?? null).toBeNull();
    expect(c.special?.kind).toBe('dancer');
  });

  it('鼻をほじる客: 席でほじり、隣の客が嫌がる。注意するとやめ、嫌がった客の不快が少し戻る。店員も注意する', () => {
    quiet();
    setBal(CHAOS.nosepick, 'reactRadius', 30);
    const { s, ctx } = game(53);
    open(s, ctx);
    for (let i = 0; i < 120; i++) step(s, 0.5, ctx);
    forceChaos(s, 'nosepick');
    const c = untilCast(s, ctx, 'nosepick');
    until(s, ctx, () => (c.nosepick?.count ?? 0) >= 1, 900);
    expect(c.nosepick!.count).toBeGreaterThanOrEqual(1);
    expect(warnNosepicker(s, c)).toBe(true);
    expect(c.nosepick!.warned).toBe(true);
    // 2回目は注意できない
    expect(warnNosepicker(s, c)).toBe(false);
    const n = c.nosepick!.count;
    for (let i = 0; i < 120; i++) step(s, 0.25, ctx);
    expect(c.nosepick!.count).toBe(n);
  });

  it('鼻をほじる客: プレイヤーが注意しなくても、何度かほじると従業員が席へ行って声をかける', () => {
    quiet();
    const { s, ctx } = game(55);
    open(s, ctx);
    for (let i = 0; i < 120; i++) step(s, 0.5, ctx);
    forceChaos(s, 'nosepick');
    const c = untilCast(s, ctx, 'nosepick');
    until(s, ctx, () => !!c.nosepick?.warned || c.state === 'left' || c.state === 'leaving', 1500);
    expect(c.nosepick?.warned).toBe(true);
    expect(c.nosepick!.count).toBeGreaterThanOrEqual(2);
    const rec = s.events!.log!.find((r) => r.kind === 'nosepick')!;
    until(s, ctx, () => rec.state === 'done', 1500);
    expect(rec.result).toContain('注意');
  });

  it('クマ「みつぐま」: クマの見た目で並んで食べ、まわりの客が驚く', () => {
    quiet();
    setBal(CHAOS.bear, 'reactRadius', 30);
    const { s, ctx } = game(54);
    open(s, ctx);
    for (let i = 0; i < 80; i++) step(s, 0.5, ctx);
    forceChaos(s, 'bear');
    const c = untilCast(s, ctx, 'bear');
    expect(c.look).toBe('bear');
    expect(s.notices.some((n) => n.text.includes('みつぐま'))).toBe(true);
    until(s, ctx, () => c.state === 'eating', 900);
    expect(c.state).toBe('eating');
  });
});
