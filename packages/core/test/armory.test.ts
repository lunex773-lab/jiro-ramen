// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い）
import { describe, expect, it } from 'vitest';
import { applyAction, ARMORY_DOOR_ID, ARMORY_RACK_ID, armoryDoorPos, BALANCE, isWalkable, listVerbs, stageOf, step, victimPos, WEAPONS, type GameState, type SimCtx } from '../src';
import { makePlayer } from '../src/state';
import { newGame, run, seatCustomer } from './helpers';

/** 扉の前（路地）に立つ */
function atDoor(s: GameState, id = 'p1') {
  const d = armoryDoorPos(stageOf(s));
  const p = s.players.find((x) => x.id === id)!;
  p.pos = { x: d.x + 0.6, z: d.z };
}

function interact(s: GameState, ctx: SimCtx, targetId: string, verb: string, id = 'p1') {
  return applyAction(s, id, { type: 'interact', targetId, verb }, ctx);
}

/** 照準を客（席の客は席）に向けて、手の武器を使う（FPS 式。オーナーの判断 2026-11-13） */
function shootAt(s: GameState, ctx: SimCtx, customerId: string, id = 'p1', pitch = 0) {
  const p = s.players.find((x) => x.id === id)!;
  const c = s.customers.find((x) => x.id === customerId)!;
  const t = victimPos(s, c);
  return applyAction(s, id, { type: 'useWeapon', yaw: Math.atan2(t.x - p.pos.x, t.z - p.pos.z), pitch }, ctx);
}

/** 営業中の店（8席に2人座っている）で、武器を買って（銃は弾も2発）持つ */
function armed(weapon = 'katana', seed = 51) {
  const { s, ctx } = newGame(seed);
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
  seatCustomer(s, 0);
  seatCustomer(s, 1);
  atDoor(s);
  s.money = 10_000_000;
  expect(interact(s, ctx, ARMORY_DOOR_ID, 'armory_door').ok).toBe(true);
  expect(interact(s, ctx, ARMORY_RACK_ID, `buy_weapon:${weapon}`).ok).toBe(true);
  if (WEAPONS[weapon]!.kind === 'gun') for (let i = 0; i < 2; i++) expect(interact(s, ctx, ARMORY_RACK_ID, `buy_ammo:${weapon}`).ok).toBe(true);
  expect(interact(s, ctx, ARMORY_RACK_ID, `weapon:${weapon}`).ok).toBe(true);
  return { s, ctx };
}

describe('隠し扉と武器庫', () => {
  it('店の外の右の横の壁の前は歩ける（路地）。扉は押すと開き、開くと武器を持てる。チュートリアル中は開かない', () => {
    const { s, ctx } = newGame(50);
    const d = armoryDoorPos(stageOf(s));
    expect(isWalkable(s, { x: d.x + 0.6, z: d.z }, 0.25)).toBe(true);
    atDoor(s);
    expect(listVerbs(s, 'p1', ARMORY_DOOR_ID).map((v) => v.label)).toEqual(['壁を押す']);
    // 閉まっている間は棚の武器は出ない
    expect(listVerbs(s, 'p1', ARMORY_RACK_ID)).toEqual([]);
    expect(interact(s, ctx, ARMORY_DOOR_ID, 'armory_door').ok).toBe(true);
    expect(s.armory!.doorOpen).toBe(true);
    // まだ何も買っていない: 買う操作だけ（じろ2: 値段は案の2倍）
    expect(listVerbs(s, 'p1', ARMORY_RACK_ID).map((v) => v.label)).toEqual([
      '武器の棚を見る',
      '日本刀を買う（¥600,000）',
      '包丁を買う（¥60,000）',
      '金属バットを買う（¥100,000）',
      '鉄パイプを買う（¥80,000）',
      '拳銃を買う（¥2,000,000）',
      '散弾銃を買う（¥3,000,000）',
      '爆弾を買う（¥1,000,000・1個）',
    ]);
    s.tutorial = { step: 0 } as never;
    expect(interact(s, ctx, ARMORY_DOOR_ID, 'armory_door').ok).toBe(false);
  });

  it('共同経営では、ホストだけが扉を開けて武器を持てる', () => {
    const { s, ctx } = newGame(52);
    s.players.push(makePlayer(s, 'p2', 'ゲスト', false));
    atDoor(s, 'p2');
    const r = interact(s, ctx, ARMORY_DOOR_ID, 'armory_door', 'p2');
    expect(r.ok).toBe(false);
  });
});

describe('武器は FPS 式（オーナーの判断 2026-11-13）: 照準の先の人に当たり、客は血を流して死ぬ。警察が来るまでは何人でも', () => {
  it('人に向けた「襲う」ボタンは出ない。武器を持つと照準の先に使え、当たった客は血を流して死に、閉店まで倒れたまま。見ていた客は逃げ、新しい客は来ない', () => {
    const { s, ctx } = armed('katana');
    const seat = s.seats[0]!;
    const p = s.players[0]!;
    p.pos = { x: 2, z: 2.3 };
    const rep = s.reputation;
    expect(listVerbs(s, 'p1', seat.id).some((v) => v.verb === 'attack')).toBe(false);
    const r = shootAt(s, ctx, 'ctest0');
    expect(r.ok).toBe(true);
    expect((r.data as { hit: string | null }).hit).toBe('ctest0');
    const victim = s.customers.find((c) => c.id === 'ctest0')!;
    expect(victim.state).toBe('dead');
    expect(victim.dead).toBeDefined();
    expect(s.customers.find((c) => c.id === 'ctest1')!.state).toBe('leaving');
    expect(s.dirt.some((d) => d.kind === 'blood')).toBe(true);
    // 最初の事件の −0.4 ＋ 死者1人の −0.1
    expect(s.reputation).toBeCloseTo(rep - BALANCE.armory.reputationPenalty - BALANCE.armory.deathPenalty, 5);
    expect(s.incident?.deaths).toBe(1);
    expect(s.orders.filter((o) => o.status === 'waiting')).toHaveLength(0);
    // 新しい客は来ない。死んだ客は倒れたまま残る
    run(s, ctx, 5);
    expect(s.customers.filter((c) => c.state !== 'leaving' && c.state !== 'left' && c.state !== 'dead')).toHaveLength(0);
    expect(s.customers.find((c) => c.id === 'ctest0')?.state).toBe('dead');
  });

  it('外れることがある（照準の先に人がいなければ当たらない）。近接は外れても事件にならない', () => {
    const { s, ctx } = armed('katana', 57);
    s.players[0]!.pos = { x: 2, z: 2.3 };
    const r = applyAction(s, 'p1', { type: 'useWeapon', yaw: 0, pitch: 0 }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { hit: string | null }).hit).toBeNull();
    expect(s.incident ?? null).toBeNull();
  });

  it('警察が来るまでは何人でも撃てる（逃げている客にも）。死者1人ごとに評判が −0.1（合計 −1.5 まで）。警察が来ると使えない', () => {
    const { s, ctx } = armed('pistol', 53);
    const p = s.players[0]!;
    // 1人目の席の正面（2人目の席は射線に入らない）
    const sp0 = victimPos(s, s.customers.find((c) => c.id === 'ctest0')!);
    p.pos = { x: sp0.x, z: sp0.z + 2.5 };
    const rep = s.reputation;
    expect(shootAt(s, ctx, 'ctest0').ok).toBe(true);
    expect(s.customers.find((c) => c.id === 'ctest0')!.state).toBe('dead');
    // 2人目は逃げ始めている（銃声で事件）。続けて使える間隔を待ってから撃つ
    run(s, ctx, 0.5);
    const second = s.customers.find((c) => c.id === 'ctest1')!;
    expect(second.state).toBe('leaving');
    expect(shootAt(s, ctx, 'ctest1').ok).toBe(true);
    expect(second.state).toBe('dead');
    expect(s.incident?.deaths).toBe(2);
    expect(s.reputation).toBeCloseTo(rep - BALANCE.armory.reputationPenalty - 2 * BALANCE.armory.deathPenalty, 5);
    let guard = 0;
    while (!s.incident?.police && guard++ < 400) step(s, 0.1, ctx);
    expect(s.incident?.police).toBe(true);
    const r = applyAction(s, 'p1', { type: 'useWeapon', yaw: 0, pitch: 0 }, ctx);
    expect(r.ok).toBe(false);
    while (s.phase !== 'closed' && guard++ < 5000) step(s, 0.1, ctx);
    expect(p.hand.kind).toBe('none');
    expect(s.armory!.doorOpen).toBe(false);
    expect(s.phase).toBe('closed');
    expect(s.notices.find((n) => n.code === 'incident')?.text).toContain('死者 2人');
  });

  it('評判の下がり方には上限がある（1日の事件で −1.5 まで）', () => {
    const { s, ctx } = armed('pistol', 58);
    const rep = s.reputation;
    s.armory!.ammo = { pistol: 30 };
    for (let i = 2; i < 20; i++) seatCustomer(s, i % s.seats.length === 0 ? 2 : i % s.seats.length);
    const p = s.players[0]!;
    p.pos = { x: 6, z: 2.3 };
    let kills = 0;
    for (let i = 0; i < 40 && kills < 16; i++) {
      const c = s.customers.find((x) => x.state !== 'dead' && x.state !== 'left' && x.state !== 'abandoned');
      if (!c) break;
      p.pos = { x: victimPos(s, c).x, z: victimPos(s, c).z + 1.5 };
      const r = shootAt(s, ctx, c.id);
      if (r.ok && (r.data as { hit: string | null }).hit) kills++;
      run(s, ctx, 0.4);
    }
    expect(s.incident!.penalty!).toBeLessThanOrEqual(BALANCE.armory.penaltyCap + 1e-9);
    expect(rep - s.reputation).toBeLessThanOrEqual(BALANCE.armory.penaltyCap + 1e-9);
  });

  it('包丁は近くでないと届かない。拳銃は離れていても撃てる。散弾銃は近くの客にも当たる', () => {
    const k = armed('knife', 54);
    k.s.players[0]!.pos = { x: 5, z: 2.3 };
    const kr = shootAt(k.s, k.ctx, 'ctest0');
    expect(kr.ok).toBe(true);
    expect((kr.data as { hit: string | null }).hit).toBeNull();
    const g = armed('shotgun', 55);
    g.s.players[0]!.pos = { x: 3, z: 3 };
    expect(shootAt(g.s, g.ctx, 'ctest0').ok).toBe(true);
    // 隣の席（0.8m）の客にも当たる
    expect(g.s.customers.filter((c) => c.state === 'dead')).toHaveLength(2);
  });

  it('爆弾は投げると手から離れ、少しあとに爆発して近くの客が死ぬ', () => {
    const { s, ctx } = armed('bomb', 56);
    s.players[0]!.pos = { x: 3, z: 3 };
    expect(shootAt(s, ctx, 'ctest0').ok).toBe(true);
    expect(s.players[0]!.hand.kind).toBe('none');
    expect(s.customers.filter((c) => c.state === 'dead')).toHaveLength(0);
    run(s, ctx, 2.5);
    expect(s.customers.filter((c) => c.state === 'dead').length).toBeGreaterThanOrEqual(1);
  });

  it('共同経営の仲間に当たると5秒倒れて動けない（死なない）', () => {
    const { s, ctx } = armed('pistol', 59);
    const guest = makePlayer(s, 'p2', 'ゲスト', false);
    guest.connected = true;
    s.players.push(guest);
    const p = s.players[0]!;
    p.pos = { x: 5, z: 4 };
    guest.pos = { x: 5, z: 6 };
    const r = applyAction(s, 'p1', { type: 'useWeapon', yaw: 0, pitch: 0 }, ctx);
    expect((r.data as { hit: string | null }).hit).toBe('p2');
    expect(guest.downUntil).toBeCloseTo(s.t + BALANCE.armory.playerDownSec, 5);
    const before = { ...guest.pos };
    expect(applyAction(s, 'p2', { type: 'move', x: before.x + 0.3, z: before.z, yaw: 1 }, ctx, 100).ok).toBe(true);
    expect(guest.pos).toEqual(before);
    expect(applyAction(s, 'p2', { type: 'interact', targetId: s.seats[0]!.id, verb: 'ask_call' }, ctx).ok).toBe(false);
    expect(guest.yaw).not.toBe(1);
    run(s, ctx, BALANCE.armory.playerDownSec + 0.2);
    // 5秒たつと、また動ける（向きが変わる）
    expect(applyAction(s, 'p2', { type: 'move', x: guest.pos.x, z: guest.pos.z, yaw: 1 }, ctx, 100).ok).toBe(true);
    expect(guest.yaw).toBe(1);
  });
});

describe('武器を買う（じろ2: 改修設計書05。値段は案の2倍。一度買った武器は武器庫に残る・弾と爆弾は使うとなくなる）', () => {
  function opened(seed: number, money: number) {
    const { s, ctx } = newGame(seed);
    atDoor(s);
    s.money = money;
    expect(interact(s, ctx, ARMORY_DOOR_ID, 'armory_door').ok).toBe(true);
    return { s, ctx };
  }

  it('値段（包丁6万・鉄パイプ8万・金属バット10万・日本刀60万・拳銃200万＋弾1発10万・散弾銃300万＋弾1発16万・爆弾1個100万）', () => {
    expect(Object.fromEntries(Object.values(WEAPONS).map((w) => [w.id, [w.price, w.ammoPrice ?? 0]]))).toEqual({
      knife: [60_000, 0],
      pipe: [80_000, 0],
      bat: [100_000, 0],
      katana: [600_000, 0],
      pistol: [2_000_000, 100_000],
      shotgun: [3_000_000, 160_000],
      bomb: [1_000_000, 0],
    });
  });

  it('お金が足りなければ買えない。買うとお金が減り、武器庫に残る（戻しても、次の日も持てる）', () => {
    const { s, ctx } = opened(60, 50_000);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:knife').ok).toBe(false);
    s.money = 100_000;
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:knife').ok).toBe(true);
    expect(s.money).toBe(40_000);
    expect(s.transactions.at(-1)).toMatchObject({ type: 'weapon', amount: -60_000 });
    expect(listVerbs(s, 'p1', ARMORY_RACK_ID).map((v) => v.verb)).not.toContain('buy_weapon:knife');
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon:knife').ok).toBe(true);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon_return').ok).toBe(true);
    expect(s.armory!.owned).toEqual(['knife']);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon:knife').ok).toBe(true);
  });

  it('銃は弾がないと撃てない。撃つと弾が1発減る', () => {
    const { s, ctx } = opened(61, 3_000_000);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    seatCustomer(s, 0);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:pistol').ok).toBe(true);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon:pistol').ok).toBe(true);
    s.players[0]!.pos = { x: 6, z: 2.3 };
    const r = shootAt(s, ctx, 'ctest0');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('弾がありません');
    atDoor(s);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_ammo:pistol').ok).toBe(true);
    expect(s.armory!.ammo).toEqual({ pistol: 1 });
    s.players[0]!.pos = { x: 6, z: 2.3 };
    expect(shootAt(s, ctx, 'ctest0').ok).toBe(true);
    expect(s.armory!.ammo).toEqual({ pistol: 0 });
  });

  it('爆弾は1個ずつ買い、持つと武器庫から減り、戻すと戻り、投げるとなくなる', () => {
    const { s, ctx } = opened(62, 2_500_000);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:bomb').ok).toBe(true);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:bomb').ok).toBe(true);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_weapon:bomb').ok).toBe(false);
    expect(s.armory!.bombStock).toBe(2);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon:bomb').ok).toBe(true);
    expect(s.armory!.bombStock).toBe(1);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon_return').ok).toBe(true);
    expect(s.armory!.bombStock).toBe(2);
    expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
    seatCustomer(s, 0);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'weapon:bomb').ok).toBe(true);
    s.players[0]!.pos = { x: 3, z: 3 };
    expect(shootAt(s, ctx, 'ctest0').ok).toBe(true);
    expect(s.armory!.bombStock).toBe(1);
  });

  it('警察は手の武器を取り上げるが、買った武器は武器庫に残る。事件はイベントの記録に残る', () => {
    const { s, ctx } = armed('katana', 63);
    s.players[0]!.pos = { x: 2, z: 2.3 };
    expect(shootAt(s, ctx, 'ctest0').ok).toBe(true);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 5000) step(s, 0.1, ctx);
    expect(s.players[0]!.hand.kind).toBe('none');
    expect(s.armory!.owned).toContain('katana');
    const rec = s.events!.log!.find((r) => r.kind === 'incident')!;
    expect(rec).toMatchObject({ state: 'done', day: s.day, company: s.shopName });
    expect(rec.result).toContain('死者 1人');
  });
});
