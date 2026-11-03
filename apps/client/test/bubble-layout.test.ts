// 第2版 13-3・18-5: 吹き出しは画面からはみ出さず、重ならない
import { describe, expect, it } from 'vitest';
import { layoutBubbles, type BubbleBox } from '../src/ui/bubble-layout';

const W = 750;
const H = 342;

function rects(items: BubbleBox[]) {
  const placed = layoutBubbles(items, W, H);
  return placed.map((p) => {
    const it = items.find((x) => x.id === p.id)!;
    return { ...p, w: Math.min(it.w, W - 12), h: Math.min(it.h, H - 12) };
  });
}

describe('吹き出しの配置', () => {
  it('画面の端に近い吹き出し・長い吹き出しも画面からはみ出さない', () => {
    const items: BubbleBox[] = [
      { id: 'left', x: 5, y: 40, w: 220, h: 40 },
      { id: 'right', x: W - 3, y: 200, w: 260, h: 60 },
      { id: 'top', x: 300, y: 10, w: 120, h: 30 },
      { id: 'huge', x: 400, y: 300, w: 2000, h: 900 },
    ];
    for (const r of rects(items)) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.w).toBeLessThanOrEqual(W);
      expect(r.top + r.h).toBeLessThanOrEqual(H);
    }
  });

  it('同じ場所に出た複数の吹き出しは重ならない', () => {
    const items: BubbleBox[] = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, x: 370 + i * 8, y: 250, w: 150, h: 32, priority: i % 2 }));
    const r = rects(items);
    for (let i = 0; i < r.length; i++) {
      for (let j = i + 1; j < r.length; j++) {
        const a = r[i]!;
        const b = r[j]!;
        const overlap = a.left < b.left + b.w && b.left < a.left + a.w && a.top < b.top + b.h && b.top < a.top + a.h;
        expect(overlap, `${a.id} / ${b.id}`).toBe(false);
      }
    }
  });

  it('上部の表示（日付・資金など）の下に置き、上に重ねない', () => {
    const placed = layoutBubbles(
      Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, x: 300, y: 60, w: 140, h: 30 })),
      W,
      H,
      6,
      46,
    );
    for (const p of placed) expect(p.top).toBeGreaterThanOrEqual(46);
  });

  it('重ならない吹き出しは元の位置（人物の頭の上）のまま', () => {
    const r = rects([
      { id: 'a', x: 100, y: 200, w: 80, h: 30 },
      { id: 'b', x: 500, y: 200, w: 80, h: 30 },
    ]);
    expect(r.find((x) => x.id === 'a')).toMatchObject({ left: 60, top: 170 });
    expect(r.find((x) => x.id === 'b')).toMatchObject({ left: 460, top: 170 });
  });
});
