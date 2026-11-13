import { afterEach, describe, expect, it } from 'vitest';
import {
  accidentChecks,
  accidentHalted,
  applyAction,
  BALANCE,
  canonicalJson,
  EQUIPMENT,
  drawAccident,
  listVerbs,
  makeSaveFile,
  nextDay,
  openDurationOf,
  parseSave,
  SEC_PER_MIN,
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

  it('出荷の初回の確率（1日1.0%）で、まだ起きていない店は2000日でおよそ20回当たる（オーナーの指示 2026-11-12）', () => {
    setBal(X, 'firstChancePerDay', Number(process.env.JIRO_EXPLOSION_FIRST));
    expect((X as { firstChancePerDay: number }).firstChancePerDay).toBe(0.01);
    const { s } = day2(83);
    let fired = 0;
    for (let d = 0; d < 2000; d++) {
      s.day += 1;
      s.prepSnapshot!.day = s.day;
      drawAccident(s);
      if (s.events!.accidentPlan) fired++;
    }
    expect(fired).toBeGreaterThanOrEqual(8);
    expect(fired).toBeLessThanOrEqual(36);
  });

  it('設定どおりの頻度で起きる（実測できるよう抽選と発生を数えている）', () => {
    setBal(X, 'chancePerDay', 0.3);
    // 一度も起きていない間は初回の確率を使う（ここでは予約だけで起こさないので、ずっと初回の確率）
    setBal(X, 'firstChancePerDay', 0.3);
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

  it('ゲーム内の10分ごとに抽選し、1日の合計は営業時間に関係なく設定の確率（オーナーの判断 2026-11-13）', () => {
    setBal(X, 'firstChancePerDay', 0.01);
    const { s } = day2(85);
    const { times, perCheck } = accidentChecks(s);
    const slot = 10 * SEC_PER_MIN;
    // 開店から10分・20分…閉店の前まで
    expect(times[0]).toBeCloseTo(slot, 6);
    times.forEach((t, i) => expect(t).toBeCloseTo(slot * (i + 1), 6));
    expect(times[times.length - 1]!).toBeLessThan(openDurationOf(s));
    // n 回のどれかで当たる確率 = 1日の確率
    expect(1 - Math.pow(1 - perCheck, times.length)).toBeCloseTo(0.01, 10);
    // 10分ごとに1%にはしない（4時間で約21%/日になるため）
    expect(perCheck).toBeLessThan(0.001);
    // 当たった日は、どれかの10分の時刻に起きる
    setBal(X, 'firstChancePerDay', 0.5);
    let fired = 0;
    for (let d = 0; d < 400; d++) {
      s.day += 1;
      s.prepSnapshot!.day = s.day;
      drawAccident(s);
      const plan = s.events!.accidentPlan;
      if (!plan) continue;
      fired++;
      expect(times.some((t) => Math.abs(t - plan.atOpenT) < 1e-6)).toBe(true);
    }
    expect(fired / 400).toBeGreaterThan(0.42);
    expect(fired / 400).toBeLessThan(0.58);
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

describe('発火から爆発までの火事（オーナーの指示: 3倍の時間・燃え移る・騒ぐが店に残る・消せない）', () => {
  /** 2日目の営業中に発火させる（予兆が始まったところ） */
  function ignite(seed: number) {
    const { s, ctx } = day2(seed);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    // 店にお客さんが入るまで進める
    for (let i = 0; i < 3000 && !s.customers.some((c) => c.pos.z > 0.5); i++) step(s, 0.1, ctx);
    expect(applyAction(s, 'p1', { type: 'debugEvent', kind: 'explosion' }, ctx).ok).toBe(true);
    for (let i = 0; i < 50 && s.events?.accident?.stage !== 'warning'; i++) step(s, 0.1, ctx);
    expect(s.events!.accident!.stage).toBe('warning');
    return { s, ctx };
  }

  it('発火から15秒で爆発する（以前の3倍）。その間は爆発しない', () => {
    expect(X.warningSec).toBe(15);
    const { s, ctx } = ignite(5);
    const acc = () => s.events!.accident!;
    while (acc().t < X.warningSec - 0.3) step(s, 0.1, ctx);
    expect(acc().stage).toBe('warning');
    run(s, ctx, 0.6);
    expect(acc().stage).toBe('destroyed');
  });

  it('火は発火した設備から近い設備へ順に燃え移り、時間とともに速く広がる。同じ店なら同じ順', () => {
    const a = ignite(5);
    const b = ignite(5);
    const placed = a.s.equipment.filter((e) => e.placed && (EQUIPMENT[e.type]?.w ?? 0) > 0).length;
    const at = (t: number) => {
      const acc = a.s.events!.accident!;
      while (acc.t < t) step(a.s, 0.1, a.ctx);
      return acc.burning!.length;
    };
    expect(a.s.events!.accident!.burning!.map((x) => x.id)).toEqual([a.s.events!.accident!.sourceId]);
    const n3 = at(3);
    const n8 = at(8);
    const n14 = at(14.5);
    expect(n3).toBeGreaterThanOrEqual(1);
    expect(n8).toBeGreaterThan(n3 + 1);
    expect(n14).toBeGreaterThan(n8);
    // 爆発の少し前には店の設備のすべてに火が回る
    expect(n14).toBe(placed);
    // 同じ設備は1回だけ・置いてある設備だけ
    const ids = a.s.events!.accident!.burning!.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(a.s.equipment.find((e) => e.id === id)?.placed).toBe(true);
    // 燃え移る間隔はだんだん短く（1回に燃え移る台数が増える）
    const times = a.s.events!.accident!.burning!.map((x) => x.at);
    const early = times.filter((t) => t > 0 && t < 5).length;
    const lateN = times.filter((t) => t >= 10 && t < 15).length;
    expect(lateN).toBeGreaterThan(early);
    // 乱数を使わないので同じ店なら同じ順
    while (b.s.events!.accident!.t < 14.5) step(b.s, 0.1, b.ctx);
    expect(b.s.events!.accident!.burning).toEqual(a.s.events!.accident!.burning);
  });

  it('お客さんと従業員は火に気づいて騒ぐが、店の中に残る。新しいお客さんは来ない。火を消す操作はない', () => {
    const { s, ctx } = ignite(7);
    const inside0 = s.customers.filter((c) => c.pos.z >= 0.05).map((c) => c.id).sort();
    expect(inside0.length).toBeGreaterThan(0);
    const total0 = s.customers.length;
    let said = 0;
    let staffSaid = 0;
    while (s.events!.accident!.stage === 'warning') {
      step(s, 0.1, ctx);
      said = Math.max(said, s.customers.filter((c) => c.sayEvent && c.sayUntil > s.t && c.pos.z >= 0.05).length);
      if (s.employees.some((e) => e.say && e.say.until > s.t)) staffSaid += 1;
    }
    expect(said).toBeGreaterThan(0);
    expect(staffSaid).toBeGreaterThan(0);
    // 店の中にいた人は全員、爆発のときも店の中にいる
    const inside1 = s.customers.filter((c) => c.pos.z >= 0.05).map((c) => c.id).sort();
    for (const id of inside0) expect(inside1).toContain(id);
    // 新しく来た人はいない（行列にいた人はそのまま）
    expect(s.customers.length).toBeLessThanOrEqual(total0);
    // 火を消す・止める操作はない（どの設備の操作一覧にも出ない）
    for (const e of s.equipment) {
      const verbs = listVerbs(s, 'p1', e.id).map((v) => v.verb);
      expect(verbs.some((v) => /extinguish|fire|消火/.test(v))).toBe(false);
    }
  });
});

describe('イベントの記録（じろ2: 改修設計書05。ID・日時・会社・店・確率・状態・結果・復元の記録）', () => {
  it('爆発は記録に残り（会社・店・結果）、仕込み開始時点に戻すと「戻した」になる。記録は戻しても消えない', () => {
    const { s, ctx } = day2(4711);
    explode(s, ctx);
    const rec = s.events!.log!.find((r) => r.kind === 'explosion')!;
    expect(rec).toMatchObject({ day: s.day, company: s.shopName, storeId: s.company.activeStoreId, forced: true, chance: null, state: 'done' });
    expect(rec.result).toContain('爆発');
    expect(applyAction(s, 'p1', { type: 'accidentReset', accidentId: s.events!.accident!.id }, ctx).ok).toBe(true);
    const after = s.events!.log!.find((r) => r.id === rec.id)!;
    expect(after.state).toBe('restored');
    expect(after.restores).toHaveLength(1);
  });

  it('抽選で起きた爆発は、その日の確率も記録する', () => {
    const { s, ctx } = day2(4712);
    setBal(X, 'chancePerDay', 1);
    setBal(X, 'firstChancePerDay', 1);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    for (let i = 0; i < 4000 && !s.events?.accident; i++) step(s, 0.1, ctx);
    const rec = s.events!.log!.find((r) => r.kind === 'explosion')!;
    expect(rec.forced).toBe(false);
    expect(rec.chance).toBe(1);
    expect(rec.state).toBe('happening');
  });
});
