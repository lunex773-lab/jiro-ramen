// 店員への攻撃・療養・等速・逮捕（オーナーの指示 2026-11-11）
//   「武器を使い、店員や客に危害を加えた場合強制的に倍速が解除され、警察に逮捕されるアニメーションを追加する。
//     パトカーに乗せられ画面が暗転し、その日の営業が終了する」
//   「店員も襲えるようにし、怪我をした従業員は１週間療養する」「20秒後に警察が来て逮捕」
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  ARMORY_DOOR_ID,
  ARMORY_RACK_ID,
  armoryDoorPos,
  arrestOf,
  BALANCE,
  isArrested,
  listVerbs,
  nextDay,
  policeCarSeat,
  shiftFor,
  speedLocked,
  stageOf,
  step,
  WEAPONS,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, newGame, run, seatCustomer } from './helpers';

function interact(s: GameState, ctx: SimCtx, targetId: string, verb: string, id = 'p1') {
  return applyAction(s, id, { type: 'interact', targetId, verb }, ctx);
}

/** 営業中の店で、武器を買って持つ（店員が1人いる） */
function armed(weapon = 'katana', seed = 81) {
  const { s, ctx } = newGame(seed);
  expect(applyAction(s, 'p1', { type: 'openShop' }, ctx).ok).toBe(true);
  seatCustomer(s, 0);
  const e = addBot(s, 'server');
  e.pos = { x: 3, z: 3.2 };
  const d = armoryDoorPos(stageOf(s));
  s.players[0]!.pos = { x: d.x + 0.6, z: d.z };
  s.money = 10_000_000;
  expect(interact(s, ctx, ARMORY_DOOR_ID, 'armory_door').ok).toBe(true);
  expect(interact(s, ctx, ARMORY_RACK_ID, `buy_weapon:${weapon}`).ok).toBe(true);
  if (WEAPONS[weapon]!.kind === 'gun') expect(interact(s, ctx, ARMORY_RACK_ID, `buy_ammo:${weapon}`).ok).toBe(true);
  expect(interact(s, ctx, ARMORY_RACK_ID, `weapon:${weapon}`).ok).toBe(true);
  return { s, ctx, e };
}

/** 逮捕が終わって精算になるまで進める（かかった秒数を返す） */
function untilClosed(s: GameState, ctx: SimCtx, max = 200): number {
  let t = 0;
  while (s.phase !== 'closed' && t < max) {
    step(s, 0.1, ctx);
    t += 0.1;
  }
  return t;
}

describe('店員を襲う（けがをした店員は1週間療養する）', () => {
  it('武器を持つと店員にも「斬る」が出る。襲われた店員は血を流して店の外へ逃げ、その日は戻らない', () => {
    const { s, ctx, e } = armed('katana');
    s.players[0]!.pos = { x: 3, z: 2.7 };
    const v = listVerbs(s, 'p1', e.id).find((x) => x.verb === 'attack');
    expect(v?.enabled).toBe(true);
    expect(v?.label).toBe('日本刀で斬る');
    expect(interact(s, ctx, e.id, 'attack').ok).toBe(true);
    expect(e.injury).toEqual({ day: s.day, until: s.day + BALANCE.armory.injuryDays });
    expect(e.commute?.kind).toBe('injured');
    expect(e.att?.status).toBe('left');
    expect(s.dirt.some((d) => d.kind === 'blood')).toBe(true);
    expect(s.incident?.staffVictims).toBe(1);
    expect(s.incident?.victims).toBe(1);
    expect(s.notices.some((n) => n.code === `injured:${e.id}` && n.text.includes('療養'))).toBe(true);
    expect(e.record?.log.some((l) => l.kind === 'injured')).toBe(true);
    // 逃げた店員はもう襲えない
    expect(listVerbs(s, 'p1', e.id).find((x) => x.verb === 'attack')?.enabled ?? false).toBe(false);
    run(s, ctx, 15);
    expect(e.presentToday).toBe(false);
  });

  it('けがをした翌日から7日は出勤しない（シフトがあっても）。8日目から戻る', () => {
    const { s, ctx, e } = armed('katana', 82);
    s.players[0]!.pos = { x: 3, z: 2.7 };
    expect(interact(s, ctx, e.id, 'attack').ok).toBe(true);
    const day0 = s.day;
    untilClosed(s, ctx);
    expect(s.phase).toBe('closed');
    for (let d = day0 + 1; d <= day0 + 7; d++) expect(shiftFor(e, d)).toBeNull();
    expect(shiftFor(e, day0 + 8)).not.toBeNull();
    expect(nextDay(s, ctx).ok).toBe(true);
    expect(s.day).toBe(day0 + 1);
    expect(e.att?.status).toBe('off');
    expect(e.presentToday).toBe(false);
    // 出勤の記録: けがをした日
    expect(e.attLog?.find((r) => r.day === day0)?.injured).toBe(true);
  });

  it('散弾銃は近くの店員にも当たる。爆弾は近くの店員も巻き込む', () => {
    const g = armed('shotgun', 83);
    const c = g.s.customers.find((x) => x.id === 'ctest0')!;
    g.e.pos = { x: c.pos.x + 0.4, z: c.pos.z + 0.3 };
    g.s.players[0]!.pos = { x: c.pos.x, z: c.pos.z + 1.6 };
    expect(interact(g.s, g.ctx, g.s.seats[0]!.id, 'attack').ok).toBe(true);
    expect(g.e.injury).toBeDefined();
    const b = armed('bomb', 84);
    const c2 = b.s.customers.find((x) => x.id === 'ctest0')!;
    b.e.pos = { x: c2.pos.x + 0.8, z: c2.pos.z + 0.5 };
    b.s.players[0]!.pos = { x: c2.pos.x, z: c2.pos.z + 2 };
    expect(interact(b.s, b.ctx, b.s.seats[0]!.id, 'attack').ok).toBe(true);
    run(b.s, b.ctx, (WEAPONS.bomb!.fuse ?? 2) + 0.5);
    expect(b.e.injury).toBeDefined();
    expect(b.s.incident?.staffVictims).toBe(1);
  });
});

describe('襲うと等速に戻り、20秒後に警察が来て逮捕され、暗くなってその日の営業は終わる', () => {
  it('襲った瞬間から倍速にできない（事件の間）', () => {
    const { s, ctx } = armed('katana', 85);
    expect(speedLocked(s)).toBe(false);
    s.players[0]!.pos = { x: 2, z: 2.3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    expect(speedLocked(s)).toBe(true);
  });

  it('警察官が2人来て、手錠をかけ、パトカーまで連れて行き、乗せる。その間は動けず何もできない', () => {
    const { s, ctx } = armed('katana', 86);
    const p = s.players[0]!;
    p.pos = { x: 2, z: 2.3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    const inc = s.incident!;
    expect(inc.attackerId).toBe('p1');
    expect(inc.policeAt - inc.startT).toBe(20);
    // 警察が来るまでは動ける
    run(s, ctx, 19);
    expect(arrestOf(s)).toBeNull();
    run(s, ctx, 1.2);
    const a = arrestOf(s)!;
    expect(a.phase).toBe('approach');
    expect(a.officers).toHaveLength(2);
    expect(a.officers[0]!.say?.text).toContain('警察');
    expect(isArrested(s, 'p1')).toBe(true);
    // 動けない・何もできない
    const before = { ...p.pos };
    const mv = applyAction(s, 'p1', { type: 'move', x: p.pos.x + 0.3, z: p.pos.z, yaw: 0 }, ctx, 100);
    expect(mv.ok).toBe(true);
    expect(p.pos).toEqual(before);
    expect(interact(s, ctx, s.seats[1]!.id, 'attack').ok).toBe(false);
    // 段階を順に通る
    const phases: string[] = [];
    let t = 0;
    while (s.phase !== 'closed' && t < 120) {
      const ph = arrestOf(s)?.phase;
      if (ph && phases[phases.length - 1] !== ph) phases.push(ph);
      if (ph === 'cuff') expect(p.hand.kind).toBe('none'); // 武器は取り上げられた
      step(s, 0.1, ctx);
      t += 0.1;
    }
    expect(phases).toEqual(['approach', 'cuff', 'escort', 'board', 'fade']);
    expect(s.phase).toBe('closed');
    // 歩いて来る〜暗くなるまで 1 分以内
    expect(t).toBeLessThan(60);
    expect(p.pos).toEqual(policeCarSeat(stageOf(s)));
    expect(s.incident?.arrest?.done).toBe(true);
    expect(s.armory?.doorOpen).toBe(false);
    expect(s.events?.log?.find((x) => x.id === inc.eventId)?.result).toContain('逮捕');
  });

  it('厨房の奥にいても、横の路地にいても、警察官は歩いて来て逮捕する', () => {
    for (const where of ['kitchen', 'alley'] as const) {
      const { s, ctx } = armed('pistol', where === 'kitchen' ? 87 : 88);
      const p = s.players[0]!;
      p.pos = where === 'kitchen' ? { x: 6.5, z: 4.6 } : { x: armoryDoorPos(stageOf(s)).x + 0.6, z: 1.2 };
      expect(interact(s, ctx, 'ctest0', 'attack').ok).toBe(true);
      run(s, ctx, 20.5);
      const a = arrestOf(s)!;
      let t = 0;
      while (a.phase === 'approach' && t < 30) {
        step(s, 0.1, ctx);
        t += 0.1;
      }
      // 着けずに打ち切り（approachMax）になる前に着く
      expect(t).toBeLessThan(BALANCE.armory.arrest.approachMax);
      expect(untilClosed(s, ctx)).toBeLessThan(60);
      expect(s.phase).toBe('closed');
    }
  });

  it('閉店の時刻を過ぎても、逮捕が終わるまで精算しない。暗くなったら客も店員もいなくなってすぐ精算', () => {
    const { s, ctx, e } = armed('katana', 89);
    s.players[0]!.pos = { x: 2, z: 2.3 };
    expect(interact(s, ctx, s.seats[0]!.id, 'attack').ok).toBe(true);
    // 閉店の直前にする
    s.openT = Math.max(s.openT, 1e9);
    run(s, ctx, 21);
    expect(s.phase === 'closing' || s.phase === 'open').toBe(true);
    expect(arrestOf(s)).not.toBeNull();
    untilClosed(s, ctx);
    expect(s.phase).toBe('closed');
    expect(e.presentToday).toBe(false);
  });
});
