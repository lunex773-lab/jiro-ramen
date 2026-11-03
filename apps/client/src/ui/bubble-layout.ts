// 吹き出しの配置（第2版 13-3）。描画に依存しない純粋な計算（単体テストできる）。
// - 画面からはみ出さない（左右・上下の端に寄せる）
// - 複数の吹き出しが重ならない（重なったら上へずらす。上が足りなければ下へ）
// 入力の x, y は吹き出しの「しっぽの先」（人物の頭の上）の画面座標。出力は吹き出しの左上の座標。

export interface BubbleBox {
  id: string;
  /** しっぽの先（中央下）の画面座標 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 優先度（大きいほど元の位置に近く置く。イベントの吹き出しなど） */
  priority?: number;
}

export interface PlacedBubble {
  id: string;
  left: number;
  top: number;
}

const GAP = 4;

function overlaps(a: { left: number; top: number; w: number; h: number }, b: { left: number; top: number; w: number; h: number }): boolean {
  return a.left < b.left + b.w + GAP && b.left < a.left + a.w + GAP && a.top < b.top + b.h + GAP && b.top < a.top + a.h + GAP;
}

/**
 * 吹き出しを置く。margin は画面の端からの余白、top は上の余白（上部の表示＝日付・資金などに重ねない）。
 * 手前（y が大きい = 画面の下、近くの人物）・優先度の高いものから置き、あとのものを重ならない位置へずらす
 */
export function layoutBubbles(items: BubbleBox[], viewW: number, viewH: number, margin = 6, top0 = margin): PlacedBubble[] {
  const order = [...items].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.y - a.y);
  const placed: { id: string; left: number; top: number; w: number; h: number }[] = [];
  const clampX = (left: number, w: number) => Math.max(margin, Math.min(viewW - margin - w, left));
  const clampY = (top: number, h: number) => Math.max(top0, Math.min(viewH - margin - h, top));
  for (const it of order) {
    const w = Math.min(it.w, viewW - margin * 2);
    const h = Math.min(it.h, viewH - margin - top0);
    const left = clampX(it.x - w / 2, w);
    let top = clampY(it.y - h, h);
    // 上へずらして空いている場所を探す。上が足りなければ下へ
    let box = { left, top, w, h };
    let tries = 0;
    while (placed.some((p) => overlaps(box, p)) && tries < 40) {
      const hit = placed.filter((p) => overlaps(box, p));
      const up = Math.min(...hit.map((p) => p.top)) - h - GAP;
      if (up >= top0) top = up;
      else {
        const down = Math.max(...hit.map((p) => p.top + p.h)) + GAP;
        top = down + h <= viewH - margin ? down : clampY(top + h + GAP, h);
      }
      box = { left, top, w, h };
      tries += 1;
    }
    placed.push({ id: it.id, ...box });
  }
  return placed.map(({ id, left, top }) => ({ id, left, top }));
}
