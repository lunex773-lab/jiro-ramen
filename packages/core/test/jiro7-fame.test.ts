// じろ7 Phase 7: 知名度・評判・話題性・SNS・YouTuber（続く人物・企画・5段の許可・動画）・店の伝説・客どうしの口論（設計書 7〜9・11）
import { afterEach, describe, expect, it } from 'vitest';
import {
  activeChaos,
  addLegend,
  applyAction,
  arrivalRate,
  BALANCE,
  calmQuarrel,
  CHAOS,
  CHAOS_KINDS,
  ensureFame,
  FAME,
  fameDemandFactor,
  forceChaos,
  forceMedia,
  makeCreator,
  makeSaveFile,
  nextDay,
  onDayStartFame,
  onVisitSns,
  parseSave,
  pendingRequests,
  planAllowed,
  postVideo,
  shelfLegends,
  step,
  type Customer,
  type GameState,
  type SimCtx,
  type Video,
} from '../src';
import { addSoloBot, clone, newGame, runDay } from './helpers';

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

function quiet(): void {
  setBal(BALANCE.events.buzz, 'chancePerCheck', 0);
  setBal(BALANCE.events.critic, 'chancePerDay', 0);
  setBal(BALANCE.events.rare, 'coupleChance', 0);
  setBal(BALANCE.events.rare, 'loverChance', 0);
  setBal(BALANCE.events.explosion, 'chancePerDay', 0);
  setBal(BALANCE.events.explosion, 'firstChancePerDay', 0);
  setBal(BALANCE.events.youtuber, 'chancePerDay', 0);
  setBal(BALANCE.events.tv, 'chancePerDay', 0);
  setBal(BALANCE.guests.messy, 'chance', 0);
  setBal(BALANCE.guests.smoke, 'chance', 0);
  setBal(BALANCE.guests.group, 'lingerChance', 0);
  setBal(BALANCE.guests.group, 'sizeWeights', [1, 0, 0, 0]);
  for (const k of CHAOS_KINDS) setBal(CHAOS[k], 'dayChance', 0);
}

function game(seed: number, day = 6): { s: GameState; ctx: SimCtx } {
  const g = newGame(seed);
  g.s.day = day;
  addSoloBot(g.s);
  return g;
}

function open(s: GameState, ctx: SimCtx): void {
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
}

function until(s: GameState, ctx: SimCtx, done: () => boolean, max = 900): void {
  for (let t = 0; t < max && !done(); t += 0.25) step(s, 0.25, ctx);
}

describe('知名度・評判・話題性を分ける（設計書 11・オーナーの判断 Q7）', () => {
  it('知名度は来客を最大 +20%、話題性は最大 +50%。予測（イベントを入れない見込み）には話題性を入れない', () => {
    const { s } = newGame(1);
    expect(fameDemandFactor(s)).toBe(1);
    const base = arrivalRate(s);
    const f = ensureFame(s);
    f.awareness = 100;
    expect(fameDemandFactor(s)).toBeCloseTo(1 + FAME.awarenessMaxBonus, 6);
    f.topic = 100;
    expect(fameDemandFactor(s)).toBeCloseTo((1 + FAME.awarenessMaxBonus) * (1 + FAME.topicMaxBonus), 6);
    expect(fameDemandFactor(s, false)).toBeCloseTo(1 + FAME.awarenessMaxBonus, 6);
    expect(arrivalRate(s) / base).toBeCloseTo((1 + FAME.awarenessMaxBonus) * (1 + FAME.topicMaxBonus), 4);
    // 上限を超える値でも上限のまま
    f.awareness = 1000;
    f.topic = 1000;
    expect(fameDemandFactor(s)).toBeCloseTo((1 + FAME.awarenessMaxBonus) * (1 + FAME.topicMaxBonus), 6);
  });

  it('話題性は毎日薄れ、知名度はゆっくり変わる。ふつうの営業だけでは知名度はほとんど上がらない（ふつうの日の収支はほぼ今のまま）', () => {
    quiet();
    const { s, ctx } = game(2, 2);
    const f = ensureFame(s);
    f.topic = 60;
    for (let d = 0; d < 6; d++) {
      open(s, ctx);
      runDay(s, ctx);
      expect(nextDay(s, ctx).ok).toBe(true);
    }
    // 60 から毎日薄れる（ふつうの投稿でわずかに足される分だけ上乗せ）
    expect(f.topic).toBeLessThan(60 * FAME.topicKeep ** 6 + 1.5);
    expect(f.awareness).toBeLessThan(2);
    expect(fameDemandFactor(s, false)).toBeLessThan(1.005);
    expect(f.history.length).toBe(6);
  });
});

describe('一般の客の SNS（設計書 8）', () => {
  it('珍事を見て撮影した客は、その話題を投稿しやすい。投稿は翌朝に話題性・知名度へまとまる。客の乱数は使わない', () => {
    const { s, ctx } = newGame(3);
    s.day = 5;
    const rng = s.rng;
    let ufo = 0;
    for (let i = 0; i < 40; i++) {
      const c = { id: `cx${i}`, traits: { sns: 1 }, sat: { taste: 0.8, speed: 0.8, service: 0.6, cleanliness: 1, accuracy: 1, stock: 1, value: 0.7, comfort: 0.7 }, saw: [{ kind: 'ufo', filmed: true }] } as unknown as Customer;
      onVisitSns(s, c, 0.8, false);
    }
    const f = ensureFame(s);
    ufo = f.posts.filter((p) => p.kind === 'ufo').length;
    expect(ufo).toBeGreaterThan(15);
    expect(s.rng).toBe(rng);
    expect(f.today.posts).toBe(f.posts.length);
    // 翌朝にまとめる
    const before = f.topic;
    s.day = 6;
    onDayStartFame(s, ctx);
    expect(f.topic).toBeGreaterThan(before);
    expect(f.topic).toBeLessThanOrEqual(FAME.postTopicCap + before);
    expect(f.today.posts).toBe(0);
  });
});

describe('YouTuber（設計書 7）', () => {
  it('来店した YouTuber は名簿に残り、企画と規模を持つ。5段の許可で答え、撮影が終わると翌日に動画が投稿される', { timeout: 60_000 }, () => {
    quiet();
    setBal(BALANCE.events.youtuber, 'askChance', 1);
    const { s, ctx } = game(4);
    forceMedia(s, 'youtuber');
    open(s, ctx);
    let yt: Customer | undefined;
    until(s, ctx, () => !!(yt = s.customers.find((x) => x.special?.kind === 'youtuber')), 400);
    expect(yt).toBeTruthy();
    const film = yt!.special!.film!;
    const f = ensureFame(s);
    const cr = f.creators.find((x) => x.id === film.creatorId)!;
    expect(cr).toBeTruthy();
    expect(cr.subs).toBeGreaterThanOrEqual(1000);
    expect(film.plan).toBeTruthy();
    const req = pendingRequests(s)[0]!;
    expect(req.text).toContain(cr.channel);
    expect(applyAction(s, 'p1', { type: 'answerRequest', requestId: req.id, accept: true, level: 'full' }, ctx).ok).toBe(true);
    expect(film.level).toBe('full');
    until(s, ctx, () => film.filming === 'done' || yt!.state === 'left', 1500);
    expect(film.filming).toBe('done');
    const v = f.videos.find((x) => x.creatorId === cr.id)!;
    expect(v).toBeTruthy();
    expect(v.posted).toBe(false);
    expect(v.plan).toBe(film.plan);
    runDay(s, ctx);
    expect(nextDay(s, ctx).ok).toBe(true);
    expect(v.posted).toBe(true);
    expect(v.outcome).toBeTruthy();
    expect(v.views).toBeGreaterThan(0);
    expect(cr.visits).toBe(1);
    expect(cr.videos).toContain(v.id);
    // セーブして読み込んでも残る
    const loaded = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 0)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.save.state.fame!.creators.find((x) => x.id === cr.id)?.videos).toContain(v.id);
  });

  it('許可の範囲で撮れない企画は、ふつうの食レポになる（厨房密着は「店内のみ」では撮れない）', () => {
    expect(planAllowed('kitchen', 'dining')).toBe(false);
    expect(planAllowed('kitchen', 'full')).toBe(true);
    expect(planAllowed('kitchen', 'planOnly')).toBe(true);
    expect(planAllowed('bigEat', 'dining')).toBe(true);
    expect(planAllowed('crazy', 'noKitchen')).toBe(false);
    expect(planAllowed('bigEat', 'deny')).toBe(false);
  });

  it('動画の結果は知名度・話題性・評判へ別々に効く。炎上は評判を下げる（最大 -0.3★）。大バズはほかの YouTuber を呼び、伝説になる', () => {
    const outcomes = new Map<string, { rep: number; topic: number; awareness: number; boosts: number; legends: number }>();
    for (let seed = 1; seed < 160 && outcomes.size < 4; seed++) {
      const { s, ctx } = newGame(seed);
      s.day = 8;
      s.reputation = 3.5;
      const f = ensureFame(s);
      const cr = makeCreator(s);
      cr.flameRisk = seed % 2 === 0 ? 1 : 0;
      cr.quality = 0.95;
      f.creators.push(cr);
      const v: Video = {
        id: `v${seed}`, creatorId: cr.id, title: 't', day: 7, postDay: 8, posted: false, plan: seed % 2 === 0 ? 'crazy' : 'bigEat', level: 'full',
        quality: 0.9, fun: 0.9, rarity: seed % 3 === 0 ? 1 : 0.4, featured: seed % 3 === 0 ? ['ufo'] : [], sneaky: false,
        views: 0, likes: 0, comments: 0, spread: 0, outcome: null, effect: { awareness: 0, topic: 0, reputation: 0 },
      };
      f.videos.push(v);
      postVideo(s, ctx, v);
      if (!outcomes.has(v.outcome!)) outcomes.set(v.outcome!, { rep: s.reputation - 3.5, topic: f.topic, awareness: f.awareness, boosts: f.ytBoosts.length, legends: f.legends.length });
    }
    const flame = outcomes.get('flame');
    expect(flame).toBeTruthy();
    expect(flame!.rep).toBeLessThan(0);
    expect(flame!.rep).toBeGreaterThanOrEqual(-FAME.flameMaxRep - 1e-9);
    const big = outcomes.get('viral') ?? outcomes.get('hit');
    expect(big).toBeTruthy();
    expect(big!.rep).toBe(0);
    expect(big!.topic).toBeGreaterThan(0);
    expect(big!.boosts).toBeGreaterThan(0);
    expect(big!.legends).toBeGreaterThan(0);
  });
});

describe('店の伝説（設計書 9）', () => {
  it('点数でランクが決まり、激レア以上で称号を得る。棚にはランクの高い順に飾る。セーブ・読み込みで残る', () => {
    const { s, ctx } = newGame(5);
    s.day = 9;
    const low = addLegend(s, ctx, 'bounce', { summary: 'a' })!;
    const high = addLegend(s, ctx, 'ufo', { summary: 'b', witnesses: 10, films: 5, depth: 1, related: ['x', 'y'], bonus: 0.2 })!;
    expect(['normal', 'rare']).toContain(low.rank);
    expect(['legend', 'myth']).toContain(high.rank);
    expect(high.earnedTitle).toContain('UFO が来た店');
    const f = ensureFame(s);
    expect(f.titles).toContain('UFO が来た店');
    expect(shelfLegends(s)[0]!.id).toBe(high.id);
    expect(f.awareness).toBeGreaterThan(0);
    const loaded = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 0)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.save.state.fame!.legends.map((x) => x.id)).toEqual(f.legends.map((x) => x.id));
  });

  it('UFO の来店が終わると、店の伝説に残る（見た客がいれば）', { timeout: 60_000 }, () => {
    quiet();
    setBal(CHAOS.ufo, 'reactRadius', 40);
    const { s, ctx } = game(6);
    open(s, ctx);
    for (let i = 0; i < 160; i++) step(s, 0.5, ctx);
    forceChaos(s, 'ufo');
    until(s, ctx, () => activeChaos(s).some((r) => r.kind === 'ufo'), 800);
    until(s, ctx, () => !activeChaos(s).some((r) => r.kind === 'ufo'), 2500);
    const f = ensureFame(s);
    const rec = s.events!.log!.find((r) => r.kind === 'ufo')!;
    expect(rec.state).toBe('done');
    if ((rec.witnesses ?? 0) + (rec.films ?? 0) > 0) expect(f.legends.some((l) => l.kind === 'ufo' || l.kind === 'chain')).toBe(true);
  });
});

describe('客どうしの口論（オーナーの判断 Q8）', () => {
  it('主役が席に着くと、となりの客と言い合いになる。仲裁すると収まり、従業員も仲裁しに行く', { timeout: 60_000 }, () => {
    quiet();
    setBal(CHAOS.quarrel, 'reactRadius', 30);
    const { s, ctx } = game(7);
    open(s, ctx);
    for (let i = 0; i < 160; i++) step(s, 0.5, ctx);
    forceChaos(s, 'quarrel');
    let lead: Customer | undefined;
    until(s, ctx, () => {
      const run = activeChaos(s).find((r) => r.kind === 'quarrel');
      lead = run ? s.customers.find((x) => x.id === run.customerIds[0]) : undefined;
      return !!lead?.quarrel;
    }, 1500);
    if (!lead?.quarrel) return; // 空いていて、となりに客がいなかった（起こらない日もある）
    const other = s.customers.find((x) => x.id === lead!.quarrel!.with)!;
    expect(other.quarrel?.with).toBe(lead.id);
    until(s, ctx, () => (lead!.quarrel?.count ?? 0) >= 1, 120);
    expect(lead.quarrel.count).toBeGreaterThanOrEqual(1);
    // 従業員が仲裁しに行く（何度か言い合ったら）か、ここで仲裁する
    until(s, ctx, () => !!lead!.quarrel?.calmed || (lead!.quarrel?.count ?? 0) >= 8 || !lead!.quarrel, 300);
    if (lead.quarrel && !lead.quarrel.calmed && lead.quarrel.count < 8) expect(calmQuarrel(s, lead)).toBe(true);
    expect(lead.quarrel?.calmed || (lead.quarrel?.count ?? 0) >= 8 || !lead.quarrel).toBe(true);
  });
});

describe('古いセーブ', () => {
  it('知名度などの状態がない古いセーブでも、そのまま営業できる', () => {
    const { s, ctx } = newGame(8);
    s.day = 5;
    addLegend(s, ctx, 'ufo', { summary: 'x', witnesses: 3 });
    const old = clone(s);
    delete old.fame;
    for (let i = 0; i < 20; i++) step(old, 0.5, ctx);
    expect(((old as { fame?: { awareness: number } }).fame?.awareness ?? 0) >= 0).toBe(true);
    expect(fameDemandFactor(old)).toBeGreaterThan(0);
  });
});

describe('共通市場の確かめ方（じろ7 Phase 8）', () => {
  it('話題性・知名度がその日に上がった分は、来客の上限に入る（ふつうに遊んだ日を順位から外さない）', async () => {
    const { arrivalBound } = await import('../src/verify');
    const { s } = newGame(9);
    s.day = 5;
    const prev = clone(s);
    const same = clone(s);
    const hot = clone(s);
    const f = ensureFame(hot);
    f.topic = 80;
    f.awareness = 30;
    const b0 = arrivalBound(prev, same, 1);
    const b1 = arrivalBound(prev, hot, 1);
    expect(b1).toBeGreaterThan(b0 * 1.3);
    // 下がったときは広げない
    const cold = clone(s);
    ensureFame(prev).topic = 50;
    expect(arrivalBound(prev, cold, 1)).toBeLessThanOrEqual(arrivalBound(prev, prev, 1) + 1e-9);
  });
});
