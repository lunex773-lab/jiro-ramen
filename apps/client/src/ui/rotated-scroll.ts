// 表示を 90° 回しているとき（縦向きの Safari）のスクロール。
// Safari に任せると、回した向きとずれた方向にスクロールしたり、動かなかったりするので、
// 指の動きを表示の座標に直して、スクロールできる要素（経営メニュー・設定・結果画面など）を自分で動かす。
// 回していないときは何もしない（ブラウザのスクロールのまま）。

import { isRotated, toView } from '../game/orientation';

/** 指を離した後も滑る速さの減り方（1 フレームあたり） */
const FRICTION = 0.94;

export function installRotatedScroll(root: HTMLElement): void {
  /** 指を置いた要素（スクロールする向きが決まったら、その向きにスクロールできる祖先を探す） */
  let from: Element | null = null;
  let el: HTMLElement | null = null;
  let id = -1;
  let axis: 'x' | 'y' | null = null;
  let start = { x: 0, y: 0 };
  let last = { x: 0, y: 0 };
  let lastT = 0;
  let vel = 0;
  let raf = 0;

  const glide = () => {
    if (!el || !axis || Math.abs(vel) < 0.02) return;
    const target = el;
    const a = axis;
    let v = vel * 16;
    const step = () => {
      if (Math.abs(v) < 0.4) return;
      if (a === 'y') target.scrollTop -= v;
      else target.scrollLeft -= v;
      v *= FRICTION;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };

  root.addEventListener(
    'touchstart',
    (e) => {
      if (!isRotated() || from) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const target = e.target as Element | null;
      if (!scroller(target, root, 'x') && !scroller(target, root, 'y')) return;
      cancelAnimationFrame(raf);
      from = target;
      el = null;
      id = t.identifier;
      axis = null;
      start = last = toView(t.clientX, t.clientY);
      lastT = performance.now();
      vel = 0;
    },
    { passive: true },
  );

  root.addEventListener(
    'touchmove',
    (e) => {
      if (!from) return;
      const t = Array.from(e.changedTouches).find((x) => x.identifier === id);
      if (!t) return;
      const p = toView(t.clientX, t.clientY);
      // 最初に大きく動いた向きで、その向きにスクロールできる一番近い要素を動かす
      if (!axis) {
        const dx = p.x - start.x;
        const dy = p.y - start.y;
        if (Math.hypot(dx, dy) < 6) return;
        axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
        el = scroller(from, root, axis);
      }
      if (!el) return;
      const d = axis === 'y' ? p.y - last.y : p.x - last.x;
      const now = performance.now();
      vel = d / Math.max(1, now - lastT);
      lastT = now;
      last = p;
      if (axis === 'y') el.scrollTop -= d;
      else el.scrollLeft -= d;
      e.preventDefault();
    },
    { passive: false },
  );

  const end = (e: TouchEvent) => {
    if (!from || !Array.from(e.changedTouches).some((x) => x.identifier === id)) return;
    // 指を止めてから離したときは滑らせない
    if (performance.now() - lastT > 80) vel = 0;
    if (el) glide();
    from = null;
    el = null;
    axis = null;
  };
  root.addEventListener('touchend', end, { passive: true });
  root.addEventListener('touchcancel', end, { passive: true });
}

/** タッチした場所から一番近い、その向きにスクロールできる要素 */
function scroller(from: Element | null, root: HTMLElement, axis: 'x' | 'y'): HTMLElement | null {
  for (let e = from as HTMLElement | null; e && e !== root; e = e.parentElement) {
    // 3D の画面と入力欄（スライダーなど）は、それぞれの操作に任せる
    if (e.tagName === 'CANVAS' || e.tagName === 'INPUT' || e.tagName === 'SELECT' || e.tagName === 'TEXTAREA') return null;
    const st = getComputedStyle(e);
    const ok =
      axis === 'y'
        ? (st.overflowY === 'auto' || st.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 1
        : (st.overflowX === 'auto' || st.overflowX === 'scroll') && e.scrollWidth > e.clientWidth + 1;
    if (ok) return e;
  }
  return null;
}
