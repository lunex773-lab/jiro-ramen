// 隠し扉と武器庫（じろ1 5.12。オーナーの判断: 本物の武器・血の表現あり・罰は軽い）
import { describe, expect, it } from 'vitest';
import { applyAction, ARMORY_DOOR_ID, ARMORY_RACK_ID, armoryDoorPos, BALANCE, isWalkable, listVerbs, stageOf, step, WEAPONS, type GameState, type SimCtx } from '../src';
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

describe('客を襲う（罰は軽い: 評判 −0.4・警察が来てその日の営業は終わる）', () => {
  it('武器を持つと席の客に「斬る」が出る。襲われた客は血を流して逃げ、見ていた客も逃げ、新しい客は来ない', () => {
    const { s, ctx } = armed('katana');
    const seat = s.seats[0]!;
    const p = s.players[0]!;
    p.pos = { x: 2, z: 2.3 };
    const rep = s.reputation;
    expect(listVerbs(s, 'p1', seat.id).some((v) => v.verb === 'attack' && v.label === '日本刀で斬る' && v.enabled)).toBe(true);
    expect(interact(s, ctx, seat.id, 'attack').ok).toBe(true);
    const victim = s.customers.find((c) => c.id === 'ctest0')!;
    expect(victim.hurt).toBe(true);
    expect(victim.state).toBe('leaving');
    expect(s.customers.find((c) => c.id === 'ctest1')!.state).toBe('leaving');
    expect(s.dirt.some((d) => d.kind === 'blood')).toBe(true);
    expect(s.reputation).toBeCloseTo(rep - BALANCE.armory.reputationPenalty, 5);
    expect(s.orders.filter((o) => o.status === 'waiting')).toHaveLength(0);
    // 新しい客は来ない
    run(s, ctx, 5);
    expect(s.customers.filter((c) => !c.hurt && c.state !== 'leaving' && c.state !== 'left')).toHaveLength(0);
  });

  it('警察が来ると武器を取り上げ、扉を閉め、その日の営業は終わって精算になる。2回目の事件で評判はもう下がらない', () => {
    const { s, ctx } = armed('pistol', 53);
    const p = s.players[0]!;
    p.pos = { x: 6, z: 2.3 };
    const rep = s.reputation;
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    expect(interact(s, ctx, 'ctest1', 'attack').ok).toBe(false); // もう逃げている
    expect(s.reputation).toBeCloseTo(rep - BALANCE.armory.reputationPenalty, 5);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 5000) step(s, 0.1, ctx);
    expect(s.incident?.police).toBe(true);
    expect(p.hand.kind).toBe('none');
    expect(s.armory!.doorOpen).toBe(false);
    expect(s.phase).toBe('closed');
    expect(s.notices.find((n) => n.code === 'incident')?.text).toContain('逮捕');
  });

  it('包丁は近くでないと届かない。拳銃は離れていても撃てる。散弾銃は近くの客にも当たる', () => {
    const k = armed('knife', 54);
    k.s.players[0]!.pos = { x: 5, z: 2.3 };
    expect(interact(k.s, k.ctx, k.s.seats[0]!.id, 'attack').reason).toBe('遠すぎます');
    const g = armed('shotgun', 55);
    g.s.players[0]!.pos = { x: 3, z: 3 };
    expect(interact(g.s, g.ctx, g.s.seats[0]!.id, 'attack').ok).toBe(true);
    // 隣の席（0.8m）の客にも当たる
    expect(g.s.customers.filter((c) => c.hurt)).toHaveLength(2);
  });

  it('爆弾は投げると手から離れ、少しあとに爆発して近くの客がけがをする', () => {
    const { s, ctx } = armed('bomb', 56);
    s.players[0]!.pos = { x: 3, z: 3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    expect(s.players[0]!.hand.kind).toBe('none');
    expect(s.customers.filter((c) => c.hurt)).toHaveLength(0);
    run(s, ctx, 2.5);
    expect(s.customers.filter((c) => c.hurt).length).toBeGreaterThanOrEqual(1);
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
    const r = interact(s, ctx, s.seats[0]!.id, 'attack');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('弾がありません');
    atDoor(s);
    expect(interact(s, ctx, ARMORY_RACK_ID, 'buy_ammo:pistol').ok).toBe(true);
    expect(s.armory!.ammo).toEqual({ pistol: 1 });
    s.players[0]!.pos = { x: 6, z: 2.3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
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
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    expect(s.armory!.bombStock).toBe(1);
  });

  it('警察は手の武器を取り上げるが、買った武器は武器庫に残る。事件はイベントの記録に残る', () => {
    const { s, ctx } = armed('katana', 63);
    s.players[0]!.pos = { x: 2, z: 2.3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 5000) step(s, 0.1, ctx);
    expect(s.players[0]!.hand.kind).toBe('none');
    expect(s.armory!.owned).toContain('katana');
    const rec = s.events!.log!.find((r) => r.kind === 'incident')!;
    expect(rec).toMatchObject({ state: 'done', day: s.day, company: s.shopName });
    expect(rec.result).toContain('けが人');
  });
});
