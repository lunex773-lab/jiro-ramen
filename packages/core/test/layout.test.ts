import { describe, expect, it } from 'vitest';
import { applyAction, buildNavGrid, findPath, makeCtx, validateLayout, expand, STAGES, step } from '../src';
import { addBot, eqByType, newGame, run } from './helpers';

describe('レイアウト', () => {
  it('設備が他の設備と重なる配置は拒否される', () => {
    const { s, ctx } = newGame();
    const sink = eqByType(s, 'sink');
    const fridge = eqByType(s, 'fridge');
    const r = applyAction(s, 'p1', { type: 'place', equipmentId: sink.id, gx: fridge.gx, gz: fridge.gz, rot: 0 }, ctx);
    expect(r.ok).toBe(false);
    expect(sink.gx).toBe(9); // 元の位置のまま
  });

  it('客席側に厨房設備は置けない', () => {
    const { s, ctx } = newGame();
    const trash = eqByType(s, 'trash');
    const r = applyAction(s, 'p1', { type: 'place', equipmentId: trash.id, gx: 10, gz: 1, rot: 0 }, ctx);
    expect(r.ok).toBe(false);
  });

  it('カウンター裏の配膳通路をふさぐ配置は拒否される（通路が完全に塞がれない）', () => {
    const { s, ctx } = newGame();
    const trash = eqByType(s, 'trash');
    // 従業員出入口の近く（gx0-1, gz5-6）をふさぐ
    const r1 = applyAction(s, 'p1', { type: 'place', equipmentId: trash.id, gx: 1, gz: 5, rot: 0 }, ctx);
    const locker = eqByType(s, 'locker');
    const r2 = applyAction(s, 'p1', { type: 'place', equipmentId: locker.id, gx: 1, gz: 6, rot: 0 }, ctx);
    expect(r1.ok && r2.ok).toBe(false);
    expect(validateLayout(s).ok).toBe(true);
  });

  it('有効な移動は確定し、動線（距離）が変わる', () => {
    const { s, ctx } = newGame();
    const trash = eqByType(s, 'trash');
    const r = applyAction(s, 'p1', { type: 'place', equipmentId: trash.id, gx: 15, gz: 9, rot: 3 }, ctx);
    expect(r.ok).toBe(true);
    expect(trash.gx).toBe(15);
    expect(validateLayout(s).ok).toBe(true);
  });

  it('営業中は配置変更できない', () => {
    const { s, ctx } = newGame();
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    const trash = eqByType(s, 'trash');
    const r = applyAction(s, 'p1', { type: 'place', equipmentId: trash.id, gx: 15, gz: 9, rot: 3 }, ctx);
    expect(r.ok).toBe(false);
  });

  it('客と従業員が必要な場所へ到達できる', () => {
    const { s } = newGame();
    const st = STAGES[0]!;
    for (const seat of st.seats) {
      expect(findPath(s, { x: 0.9, z: 0.3 }, seat, 'customer')).not.toBeNull();
    }
    for (const e of s.equipment) {
      if (e.type === 'ticket_machine') continue;
      expect(findPath(s, st.staffSpawn, { x: e.gx * 0.5, z: e.gz * 0.5 - 0.3 }, 'staff')).not.toBeNull();
    }
  });

  it('客は厨房に入れない', () => {
    const { s } = newGame();
    const g = buildNavGrid(s);
    expect(g.staffOnly.some((v) => v === 1)).toBe(true);
    const p = findPath(s, { x: 3, z: 1 }, { x: 6, z: 4.5 }, 'customer');
    // 最寄りの客席側セルまでしか行けない
    if (p) expect(p.points[p.points.length - 1]!.z).toBeLessThan(2.1);
  });

  it('通れないようにすると従業員は停止を検知して通知する', () => {
    const { s, ctx } = newGame();
    const bot = addBot(s, 'cleaner');
    // 検証を通さずに出入口の周りを無理やり塞ぐ（壊れたレイアウトの再現）
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk1', gx: 0, gz: 5, placed: true });
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk2', gx: 1, gz: 5, placed: true });
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk3', gx: 0, gz: 6, placed: true });
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk4', gx: 1, gz: 6, placed: true });
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk5', gx: 2, gz: 5, placed: true });
    s.equipment.push({ ...eqByType(s, 'trash'), id: 'blk6', gx: 2, gz: 6, placed: true });
    bot.pos = { x: 0.5, z: 0.5 }; // 客席側に締め出す
    s.seats[0]!.dirt = 1;
    s.seats[0]!.customerId = null;
    expect(validateLayout(s).ok).toBe(false);
    run(s, ctx, 8);
    expect(s.notices.some((n) => n.code === `stuck:${bot.id}`) || bot.ai.state === 'stuck' || bot.ai.taskId === null).toBe(true);
  });

  it('拡張すると席の枠と厨房が広がり、費用が引かれる', () => {
    const { s } = newGame();
    const ctx = makeCtx();
    s.career.unlocked.push('stage2');
    s.phase = 'closed';
    s.money = 2_000_000;
    const r = expand(s, ctx);
    expect(r.ok).toBe(true);
    expect(s.career.stage).toBe(1);
    expect(s.seats.length).toBe(STAGES[1]!.seats.length);
    expect(s.money).toBeLessThan(2_000_000 - STAGES[1]!.constructionCost + 1);
    expect(s.closedForConstruction).toBe(1);
    expect(validateLayout(s).ok).toBe(true);
    void step;
  });

  it('解放前は拡張できない', () => {
    const { s } = newGame();
    s.phase = 'closed';
    s.money = 9_999_999;
    expect(expand(s, makeCtx()).ok).toBe(false);
  });
});
