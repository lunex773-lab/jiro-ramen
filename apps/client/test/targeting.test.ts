import { describe, expect, it } from 'vitest';
import { accessPoint, BALANCE, createGame, equipmentCenter } from '@jiro/core';
import { findFocus, rayBox } from '../src/game/targeting';
import { clockText } from '../src/ui/hud';

describe('注視対象', () => {
  it('レイと箱の交差', () => {
    const box = { id: 'x', min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    expect(rayBox([-1, 0.5, 0.5], [1, 0, 0], box)).toBeCloseTo(1);
    expect(rayBox([-1, 2, 0.5], [1, 0, 0], box)).toBe(Infinity);
  });

  it('設備の正面に立って見ると、その設備が選ばれる', () => {
    const s = createGame({ seed: 1 });
    const me = s.players[0]!;
    const boiler = s.equipment.find((e) => e.type === 'noodle_boiler')!;
    const ap = accessPoint(boiler);
    me.pos = ap;
    const c = equipmentCenter(boiler);
    const d = [c.x - ap.x, 0.9 - 1.58, c.z - ap.z];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    const f = findFocus(s, me, [ap.x, 1.58, ap.z], [d[0]! / len, d[1]! / len, d[2]! / len]);
    expect(f?.target.id).toBe(boiler.id);
  });

  it('遠くの設備は選ばれない', () => {
    const s = createGame({ seed: 1 });
    const me = s.players[0]!;
    me.pos = { x: 6, z: 1 };
    const f = findFocus(s, me, [6, 1.58, 1], [0, 0, 1]);
    // 客席から厨房の設備には手が届かない（カウンターの席なら届く）
    if (f) expect(f.target.kind).toBe('seat');
  });
});

describe('時計表示', () => {
  it('営業中は 11:00〜15:00 に写像される', () => {
    const s = createGame({ seed: 1 });
    expect(clockText(s)).toBe('仕込み中');
    s.phase = 'open';
    s.openT = 0;
    expect(clockText(s)).toBe('11:00');
    s.openT = BALANCE.openDuration / 2;
    expect(clockText(s)).toBe('13:00');
  });
});
