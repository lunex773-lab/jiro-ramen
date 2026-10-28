import { describe, expect, it } from 'vitest';
import { accessPoint, BALANCE, createGame, equipmentCenter } from '@jiro/core';
import { findFocus, interactableBoxes, rayBox } from '../src/game/targeting';
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

  it('客席から厨房の設備を見ても、手が届かない扱いになる', () => {
    const s = createGame({ seed: 1 });
    const me = s.players[0]!;
    me.pos = { x: 6, z: 1 };
    const f = findFocus(s, me, [6, 1.58, 1], [0, 0, 1]);
    if (f?.target.kind === 'equipment') expect(f.reachable).toBe(false);
  });

  it('カーソルが重なっている設備は、離れていても選ばれ、手が届かない扱いになる', () => {
    const s = createGame({ seed: 1 });
    const me = s.players[0]!;
    const boiler = s.equipment.find((e) => e.type === 'noodle_boiler')!;
    const ap = accessPoint(boiler);
    const c = equipmentCenter(boiler);
    // 厨房の通路を 2.5m 横へ移動してから麺釜を見る（手が届くのは 1.35m まで）
    me.pos = { x: ap.x - 2.5, z: ap.z };
    const f = findFocus(s, me, [me.pos.x, 1.58, me.pos.z], aim([me.pos.x, 1.58, me.pos.z], [c.x, 0.9, c.z]));
    expect(f?.target.id).toBe(boiler.id);
    expect(f?.aimed).toBe(true);
    expect(f?.reachable).toBe(false);
  });

  it('カーソルが少しだけ外れていれば補助で選び、大きく外れていれば選ばない', () => {
    const s = createGame({ seed: 1 });
    const me = s.players[0]!;
    const boiler = s.equipment.find((e) => e.type === 'noodle_boiler')!;
    // 後ろや隣の設備にカーソルが直接当たらないよう、麺釜だけの店で試す
    s.equipment = [boiler];
    const ap = accessPoint(boiler);
    me.pos = ap;
    const eye: [number, number, number] = [ap.x, 1.58, ap.z];
    const box = interactableBoxes(s).find((b) => b.id === boiler.id)!;
    const c = equipmentCenter(boiler);
    // 設備の中心の方向で、見上げていって箱から外れる角度を探し、そこから 2° 上を見る → 重なってはいないが、補助で選ぶ
    let lo = -1.2;
    let hi = 1.2;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (rayBox(eye, dirAt(eye, c, mid), box) < Infinity) lo = mid;
      else hi = mid;
    }
    const near = dirAt(eye, c, hi + (2 * Math.PI) / 180);
    expect(rayBox(eye, near, box)).toBe(Infinity);
    const f = findFocus(s, me, eye, near);
    expect(f?.target.id).toBe(boiler.id);
    expect(f?.aimed).toBe(false);
    // 真上を見る → 何も選ばない（以前は正面に近い物を広く選んでいた）
    expect(findFocus(s, me, eye, [0, 1, 0])).toBeNull();
  });
});

function aim(from: [number, number, number], to: [number, number, number]): [number, number, number] {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  return [d[0]! / l, d[1]! / l, d[2]! / l];
}

/** 目から c の方向（水平）を向き、仰角 ang（ラジアン）で見る */
function dirAt(eye: [number, number, number], c: { x: number; z: number }, ang: number): [number, number, number] {
  const hx = c.x - eye[0];
  const hz = c.z - eye[2];
  const hl = Math.hypot(hx, hz);
  return [(hx / hl) * Math.cos(ang), Math.sin(ang), (hz / hl) * Math.cos(ang)];
}

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
