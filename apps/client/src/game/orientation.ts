// 横画面に固定する（iPhone の横向き専用）。
// 縦向きのスマホ（画面の回転ロック中など）では、ゲームの表示全体を時計回りに 90° 回して横画面として描く。
// 端末を左に倒して持つ（カメラが左、ホームバーが右）と正しい向きになる。
// 回転ロックがオフで端末を横にしたときは、ブラウザ自体が横向きになるので回さない。
// 回している間もタッチの座標（clientX/Y）は画面の向きのままなので、toView で表示の座標に直して使う。

let rotated = false;

/** ホーム画面から開いているか（Safari のバーがない） */
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** ゲームの表示を回しているか */
export function isRotated(): boolean {
  return rotated;
}

/** 表示の大きさ（回しているときは画面の縦横が入れ替わる） */
export function viewSize(): { width: number; height: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  return rotated ? { width: h, height: w } : { width: w, height: h };
}

/** 画面の座標（clientX/Y）を表示の座標に直す */
export function toView(x: number, y: number): { x: number; y: number } {
  return rotated ? { x: y, y: window.innerWidth - x } : { x, y };
}

/** 要素の位置と大きさを表示の座標で返す（getBoundingClientRect は回した後の画面上の箱を返すため） */
export function viewRect(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  if (!rotated) return { left: r.left, top: r.top, width: r.width, height: r.height };
  return { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width };
}

/** 横画面に固定する。回し方や大きさが変わったら onChange を呼ぶ */
export function lockLandscape(el: HTMLElement, onChange: () => void): void {
  const touch = matchMedia('(pointer: coarse)');
  let last = '';
  const apply = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    rotated = touch.matches && h > w;
    const key = `${rotated}|${w}|${h}`;
    if (key === last) return;
    last = key;
    el.classList.toggle('rotated', rotated);
    if (rotated) {
      // 左上を軸に時計回りに 90° 回すと画面の左の外に出るので、画面の幅だけ右へずらす
      el.style.width = `${h}px`;
      el.style.height = `${w}px`;
      el.style.transformOrigin = '0 0';
      el.style.transform = `translateX(${w}px) rotate(90deg)`;
    } else {
      for (const p of ['width', 'height', 'transform-origin', 'transform']) el.style.removeProperty(p);
    }
    onChange();
  };
  el.classList.toggle('standalone', isStandalone());
  // Safari のバーが出入りする間は大きさが少しずつ変わるので、落ち着いてから合わせる
  let timer = 0;
  const later = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  };
  window.addEventListener('resize', later);
  window.visualViewport?.addEventListener('resize', later);
  // 向きを変えた直後は、大きさの報告が遅れる端末がある（すぐ・少し後・もう少し後に合わせ直す）
  const turned = () => {
    apply();
    window.setTimeout(apply, 300);
    window.setTimeout(apply, 800);
  };
  matchMedia('(orientation: portrait)').addEventListener('change', turned);
  window.addEventListener('orientationchange', turned);
  touch.addEventListener('change', apply);
  apply();
}
