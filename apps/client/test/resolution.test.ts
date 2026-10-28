import { describe, expect, it } from 'vitest';
import { ResolutionGovernor } from '../src/render/resolution';

/** 間隔 interval のフレームを sec 秒ぶん流す。最後の時刻を返す */
function run(g: ResolutionGovernor, interval: number, sec: number, t0: number): number {
  let t = t0;
  for (let i = 0; i < Math.round(sec / interval); i++) {
    t += interval;
    g.sample(interval, t);
  }
  return t;
}

describe('描画の解像度の自動調整', () => {
  it('重い（30fps）と 2 秒ごとに 0.25 ずつ下げ、下限で止まる', () => {
    const g = new ResolutionGovernor(() => 1.5, 0.75);
    expect(g.ratio).toBe(1.5);
    let t = run(g, 1 / 30, 2.05, 0);
    expect(g.ratio).toBe(1.25);
    t = run(g, 1 / 30, 6.1, t);
    expect(g.ratio).toBe(0.75);
    run(g, 1 / 30, 4, t);
    expect(g.ratio).toBe(0.75);
  });

  it('軽くなっても、下げてから 20 秒は上げない。その後は 6 秒ごとに 0.25 上げ、上限で止まる', () => {
    const g = new ResolutionGovernor(() => 1.5, 0.75);
    let t = run(g, 1 / 30, 2.05, 0);
    expect(g.ratio).toBe(1.25);
    t = run(g, 1 / 60, 12, t);
    expect(g.ratio).toBe(1.25);
    t = run(g, 1 / 60, 14, t);
    expect(g.ratio).toBe(1.5);
    run(g, 1 / 60, 20, t);
    expect(g.ratio).toBe(1.5);
  });

  it('60fps 出ていれば下げない。裏に回っていた間の長い間隔は数えない', () => {
    const g = new ResolutionGovernor(() => 2, 0.75);
    let t = run(g, 1 / 60, 10, 0);
    expect(g.ratio).toBe(2);
    for (let i = 0; i < 20; i++) g.sample(1.5, (t += 1.5));
    expect(g.ratio).toBe(2);
  });

  it('画質の設定を変えると上限から測り直す', () => {
    let cap = 1.5;
    const g = new ResolutionGovernor(() => cap, 0.75);
    run(g, 1 / 30, 4.1, 0);
    expect(g.ratio).toBe(1);
    cap = 2;
    g.reset();
    expect(g.ratio).toBe(2);
  });
});
