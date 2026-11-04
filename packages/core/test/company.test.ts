import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  FIRST_STORE_ID,
  loadFromSlot,
  makeSaveFile,
  MemoryStore,
  nextDay,
  originalKey,
  parseSave,
  saveToSlot,
  SCHEMA_VERSION,
  slotKey,
  stateChecksum,
  validateState,
  type GameState,
} from '../src';
import { addSoloBot, newGame, runDay } from './helpers';

/** schema 1（会社がない）のセーブを作る */
function v1SaveText(s: GameState): string {
  const old = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete old.company;
  old.schema = 1;
  const file = makeSaveFile(old as unknown as GameState, 1, null, 1000);
  return JSON.stringify({ ...file, schema: 1, state: old, checksum: stateChecksum(old as unknown as GameState) });
}

describe('会社と店舗（Phase 2-1）', () => {
  it('新しいキャリアは、今の店を1店舗目とする会社から始まる', () => {
    const { s } = newGame(101);
    expect(s.schema).toBe(SCHEMA_VERSION);
    expect(s.company.stores).toHaveLength(1);
    const st = activeStore(s);
    expect(st.id).toBe(FIRST_STORE_ID);
    expect(st.name).toBe(s.shopName);
    expect(st.propertyId).toBe('home');
    expect(st.snapshot).toBeNull();
    expect(validateState(s)).toEqual([]);
  });

  it('古いセーブ（schema 1）は、店の中身・日報・お金を変えずに会社の1店舗目として読み込める', () => {
    const { s, ctx } = newGame(102);
    addSoloBot(s);
    for (let d = 0; d < 2; d++) {
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      nextDay(s, ctx);
    }
    const text = v1SaveText(s);
    const r = parseSave(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.migrated).toBe(true);
    const m = r.save.state;
    expect(m.schema).toBe(SCHEMA_VERSION);
    expect(m.company.stores).toHaveLength(1);
    expect(m.company.activeStoreId).toBe(FIRST_STORE_ID);
    expect(m.company.stores[0]!.name).toBe(s.shopName);
    expect(m.money).toBe(s.money);
    expect(m.history).toEqual(s.history);
    expect(m.equipment).toEqual(s.equipment);
    expect(m.employees).toEqual(s.employees);
    expect(validateState(m)).toEqual([]);
  });

  it('古いセーブを新しい形で上書きするときは、元のデータを別に残す（一度だけ）', () => {
    const { s } = newGame(103);
    const store = new MemoryStore();
    const text = v1SaveText(s);
    store.set(slotKey(1), text);
    const l = loadFromSlot(store, 1);
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    expect(saveToSlot(store, 1, l.file.state, 2000).ok).toBe(true);
    expect(store.get(originalKey(1, 1))).toBe(text);
    // 2回目の保存では元のデータを上書きしない
    expect(saveToSlot(store, 1, l.file.state, 3000).ok).toBe(true);
    expect(store.get(originalKey(1, 1))).toBe(text);
    const again = loadFromSlot(store, 1);
    expect(again.ok && again.file.state.schema).toBe(SCHEMA_VERSION);
  });

  it('会社の日報は店舗の日報の合計（1店舗のうちは店の日報と同じ）', { timeout: 60_000 }, () => {
    const { s, ctx } = newGame(104);
    addSoloBot(s);
    for (let d = 0; d < 3; d++) {
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      nextDay(s, ctx);
    }
    const h = s.company.history;
    expect(h.map((x) => x.day)).toEqual([1, 2, 3]);
    for (const c of h) {
      const r = s.history.find((x) => x.day === c.day)!;
      expect(c.stores).toHaveLength(1);
      expect(c.netSales).toBe(r.netSales);
      expect(c.operatingProfit).toBe(r.operatingProfit);
      expect(c.interest).toBe(r.interest);
      expect(c.finalProfit).toBe(r.finalProfit);
      expect(c.served).toBe(r.served);
      expect(c.cashEnd).toBe(r.cashEnd);
    }
  });

  it('会社のデータが壊れていると読み込まない', () => {
    const { s } = newGame(105);
    const bad = JSON.parse(JSON.stringify(s)) as GameState;
    bad.company.activeStoreId = 'nope';
    expect(validateState(bad).length).toBeGreaterThan(0);
    const bad2 = JSON.parse(JSON.stringify(s)) as GameState;
    bad2.company.stores.push({ ...bad2.company.stores[0]!, id: 'store2', snapshot: null });
    expect(validateState(bad2).length).toBeGreaterThan(0);
  });
});
