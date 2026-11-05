// 従業員を1日目から雇える（オーナーの判断 2026-11-05）。通常の採用は2日後から出勤、短期バイトはその日から
import { describe, expect, it } from 'vitest';
import { applyAction, createGame, makeSaveFile, nextDay, parseSave, type GameState } from '../src';
import { clone, newGame } from './helpers';

describe('採用は1日目から', () => {
  it('新しく始めると採用が解放されていて、1日目の朝から候補がいる', () => {
    const s = createGame({ seed: 5 });
    expect(s.day).toBe(1);
    expect(s.career.unlocked).toContain('hiring');
    expect(s.candidates.length).toBeGreaterThan(0);
  });

  it('1日目に雇える（通常の採用は2日後から出勤）。短期バイトはその日から働ける', () => {
    const { s, ctx } = newGame(6);
    const c = s.candidates[0]!;
    const r = applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx);
    expect(r.ok, r.reason).toBe(true);
    expect(s.employees).toHaveLength(1);
    const t = applyAction(s, 'p1', { type: 'hireTemp', role: 'cook' }, ctx);
    expect(t.ok, t.reason).toBe(true);
    expect(s.employees.some((e) => e.profile.temp)).toBe(true);
  });

  it('前のセーブ（採用が解放されていない）は、読み込んだときに解放され、準備中なら候補が出る', () => {
    const { s } = newGame(7);
    const old: GameState = clone(s);
    old.career.unlocked = old.career.unlocked.filter((u) => u !== 'hiring');
    old.candidates = [];
    const text = JSON.stringify(makeSaveFile(old, 1, null, 0));
    const r = parseSave(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.save.state.career.unlocked).toContain('hiring');
    expect(r.save.state.candidates.length).toBeGreaterThan(0);
  });

  it('共同経営・共通市場の会社の状態（読み込みを通らない）も、次の日の朝に解放される', () => {
    const { s, ctx } = newGame(8);
    s.career.unlocked = s.career.unlocked.filter((u) => u !== 'hiring');
    s.candidates = [];
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    s.phase = 'closed';
    nextDay(s, ctx);
    expect(s.career.unlocked).toContain('hiring');
    expect(s.career.unlocked.filter((u) => u === 'hiring')).toHaveLength(1);
    expect(s.candidates.length).toBeGreaterThan(0);
  });
});
