import { describe, expect, it } from 'vitest';
import {
  compareSaves,
  deleteSlot,
  listSlots,
  loadFromSlot,
  makeSaveFile,
  MemoryStore,
  parseSave,
  saveToSlot,
  slotKey,
  stateChecksum,
} from '../src';
import { newGame, runDay, addBot } from './helpers';
import { applyAction } from '../src';

describe('セーブ（3スロット）', () => {
  it('保存して読み込むと状態が復元される', () => {
    const { s, ctx } = newGame(81);
    addBot(s, 'cook');
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    runDay(s, ctx);
    const store = new MemoryStore();
    const r = saveToSlot(store, 1, s, 1000);
    expect(r.ok).toBe(true);
    const l = loadFromSlot(store, 1);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.file.state.money).toBe(s.money);
    expect(l.file.state.day).toBe(s.day);
    expect(l.file.meta.shopName).toBe('テスト屋');
    expect(stateChecksum(l.file.state)).toBe(l.file.checksum);
  });

  it('3スロットは独立していて、上書きで他のスロットが壊れない', () => {
    const store = new MemoryStore();
    const a = newGame(1).s;
    const b = newGame(2).s;
    const c = newGame(3).s;
    a.shopName = 'A';
    b.shopName = 'B';
    c.shopName = 'C';
    saveToSlot(store, 1, a);
    saveToSlot(store, 2, b);
    saveToSlot(store, 3, c);
    a.money = 1;
    saveToSlot(store, 1, a);
    const slots = listSlots(store);
    expect(slots.map((x) => x.meta?.shopName)).toEqual(['A', 'B', 'C']);
    expect(slots[0]!.meta!.money).toBe(1);
    expect(slots[1]!.meta!.money).toBe(b.money);
    expect(() => saveToSlot(store, 4, a)).toThrow();
  });

  it('本体が壊れたらバックアップから復旧する', () => {
    const store = new MemoryStore();
    const { s } = newGame(5);
    saveToSlot(store, 2, s);
    s.money = 12345;
    saveToSlot(store, 2, s);
    // 本体を破損させる
    store.set(slotKey(2), store.get(slotKey(2))!.slice(0, 500));
    const l = loadFromSlot(store, 2);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(l.fromBackup).toBe(true);
    expect(l.file.state.money).not.toBe(12345); // 一つ前の世代
  });

  it('保存の途中で中断しても（一時データだけ残っても）読み込める', () => {
    const store = new MemoryStore();
    const { s } = newGame(6);
    const file = makeSaveFile(s, 3, null, 1);
    store.set('jiro.save.slot3.tmp', JSON.stringify(file));
    const l = loadFromSlot(store, 3);
    expect(l.ok).toBe(true);
  });

  it('改ざん・破損はチェックサムで検出する', () => {
    const { s } = newGame(7);
    const file = makeSaveFile(s, 1, null, 1);
    file.state.money = 99_999_999;
    const r = parseSave(JSON.stringify(file));
    expect(r.ok).toBe(false);
  });

  it('古いスキーマのデータは移行して読み込む', () => {
    const { s } = newGame(8);
    const file = makeSaveFile(s, 1, null, 1);
    const old = JSON.parse(JSON.stringify(file.state));
    old.schema = 0;
    delete old.career.daysPlayed;
    const oldFile = { ...file, schema: 0, state: old, checksum: stateChecksum(old) };
    const r = parseSave(JSON.stringify(oldFile));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(true);
    expect(r.save.state.career.daysPlayed).toBe(0);
  });

  it('スロットの削除', () => {
    const store = new MemoryStore();
    saveToSlot(store, 1, newGame().s);
    deleteSlot(store, 1);
    expect(listSlots(store)[0]!.empty).toBe(true);
  });

  it('ゲームオーバー後もセーブは残る', () => {
    const store = new MemoryStore();
    const { s } = newGame();
    s.phase = 'bankrupt';
    s.bankruptcy = { day: 1, cash: 0, debt: 100, reason: 'test' };
    expect(saveToSlot(store, 1, s).ok).toBe(true);
    expect(listSlots(store)[0]!.meta!.bankrupt).toBe(true);
  });

  it('クラウドとローカルの競合を検出する（新しい方を無条件に採用しない）', () => {
    const { s } = newGame();
    const base = makeSaveFile(s, 1, null, 1);
    s.money += 1;
    const local = makeSaveFile(s, 1, base, 2);
    s.money += 1;
    const cloud = makeSaveFile(s, 1, base, 3);
    expect(compareSaves(local, cloud, base.revision)).toBe('diverged');
    expect(compareSaves(local, base, base.revision)).toBe('localNewer');
  });
});

describe('共同経営のセーブ', () => {
  it('ゲストはホストのセーブに残らず、ゲストが持っていた丼は戻される', () => {
    const { s } = newGame(9);
    s.players.push({ ...s.players[0]!, id: 'g1', name: 'ゲスト', isHost: false, hand: { kind: 'clean', bowlIds: [s.bowls[0]!.id] }, work: null });
    s.bowls[0]!.loc = { at: 'hand', actorId: 'g1' };
    const f = makeSaveFile(s, 1, null, 1);
    expect(f.state.players.map((p) => p.id)).toEqual(['p1']);
    expect(f.state.bowls[0]!.loc.at).toBe('rack');
    // 元の状態は変わらない
    expect(s.players).toHaveLength(2);
  });
});
