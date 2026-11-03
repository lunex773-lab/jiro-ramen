import { describe, expect, it } from 'vitest';
import type { AccidentState } from '@jiro/core';
import { accidentView, EYE } from '../src/ui/accident';

const acc = (stage: AccidentState['stage'], t: number): AccidentState => ({ id: 'ev1', day: 2, stage, t, sourceId: null, pos: { x: 2, z: 2 } });

describe('爆発事故の画面の演出', () => {
  it('事故がなければ何も出さない', () => {
    const v = accidentView(null, 9);
    expect(v).toMatchObject({ burned: false, awake: true, flash: 0, black: 0, eyeY: EYE, caption: '' });
  });

  it('予兆の間は営業の画面のまま（焼け跡にしない）', () => {
    const v = accidentView(acc('warning', 2), 9);
    expect(v.warning).toBe(true);
    expect(v.burned).toBe(false);
    expect(v.awake).toBe(true);
  });

  it('閃光 → 倒れる → 暗転 → 数時間後 → 目覚め の順に進み、目覚めるまで動けない', () => {
    const at = (t: number) => accidentView(acc('destroyed', t), 9);
    expect(at(0).flash).toBe(1);
    expect(at(0).shake).toBeGreaterThan(0);
    expect(at(0.1).burned).toBe(true);
    expect(at(2.2).eyeY).toBeLessThan(0.5);
    expect(at(4).black).toBe(1);
    expect(at(4).caption).toBe('……');
    expect(at(5.5).caption).toBe('――数時間後');
    expect(at(8.9).awake).toBe(false);
    expect(at(9).awake).toBe(true);
    expect(at(9).black).toBe(0);
    expect(at(9).eyeY).toBeCloseTo(EYE, 5);
    expect(at(9).roll).toBeCloseTo(0, 5);
    expect(at(60).caption).toBe('');
  });

  it('目覚めるまでの秒数の設定に合わせて伸び縮みする', () => {
    expect(accidentView(acc('destroyed', 17.9), 18).awake).toBe(false);
    expect(accidentView(acc('destroyed', 18), 18).awake).toBe(true);
    expect(accidentView(acc('destroyed', 8), 18).black).toBe(1);
  });
});
