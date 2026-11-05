// 横画面に固定する（iPhone の横向き専用）。
// 縦向きのスマホ（画面の回転ロック中など）では、ゲームの表示全体を時計回りに 90° 回して横画面として描く。
// 端末を左に倒して持つ（カメラが左、ホームバーが右）と正しい向きになる。
// 回転ロックがオフで端末を横にしたときは、ブラウザ自体が横向きになるので回さない。
// 回している間もタッチの座標（clientX/Y）は画面の向きのままなので、toView で表示の座標に直して使う。

let rotated = false;
/** 回す条件（styles.css の @media と同じ）。lockLandscape の後に使う */
let rotateQuery: { touch: MediaQueryList; portrait: MediaQueryList } | null = null;
/** 今回しているか（メディアクエリをその場で調べる。向きの知らせを待たない） */
const rotatedNow = (): boolean => (rotateQuery ? rotateQuery.touch.matches && rotateQuery.portrait.matches : rotated);
/** 表示の大きさ（回す前の .app の大きさ。CSS が決めた大きさを測る） */
let viewW = typeof window === 'undefined' ? 0 : window.innerWidth;
let viewH = typeof window === 'undefined' ? 0 : window.innerHeight;

/** ホーム画面から開いているか（Safari のバーがない） */
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

/** ゲームの表示を回しているか */
export function isRotated(): boolean {
  return rotatedNow();
}

/** 表示の大きさ（回しているときは画面の縦横が入れ替わる） */
export function viewSize(): { width: number; height: number } {
  return { width: viewW, height: viewH };
}

/** 画面の座標（clientX/Y）を表示の座標に直す */
export function toView(x: number, y: number): { x: number; y: number } {
  // 回しているとき、表示の高さ＝画面の幅
  return rotatedNow() ? { x: y, y: viewH - x } : { x, y };
}

/** 要素の位置と大きさを表示の座標で返す（getBoundingClientRect は回した後の画面上の箱を返すため） */
export function viewRect(el: Element): { left: number; top: number; width: number; height: number } {
  const r = el.getBoundingClientRect();
  if (!rotatedNow()) return { left: r.left, top: r.top, width: r.width, height: r.height };
  return { left: r.top, top: viewH - r.right, width: r.height, height: r.width };
}

/** ずれた表示を元に戻す（iOS は向きを変えたときや文字の入力の後に、固定した画面ごと少しずれたまま残ることがある） */
function resetScroll(): void {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  const se = document.scrollingElement;
  if (se && (se.scrollTop || se.scrollLeft)) {
    se.scrollTop = 0;
    se.scrollLeft = 0;
  }
  if (document.body.scrollTop || document.body.scrollLeft) {
    document.body.scrollTop = 0;
    document.body.scrollLeft = 0;
  }
}

/** iOS が向きを変えた後に拡大したまま戻らないとき、画面の設定（viewport）を入れ直して等倍に戻す */
function resetZoom(): void {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const content = meta.content;
  meta.content = `${content}, minimum-scale=1`;
  window.setTimeout(() => (meta.content = content), 50);
}

/** 文字を入力中か（入力中は iOS がキーボードのぶん画面を動かすので戻さない） */
function typing(): boolean {
  const a = document.activeElement;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable);
}

/**
 * 横画面に固定する。回し方や大きさが変わったら onChange を呼ぶ。
 * 回すかどうかは「縦向き（orientation: portrait）でタッチの端末」のメディアクエリで決め、回した表示の大きさと位置は CSS
 * （styles.css の @media の .app.lock-landscape。画面の大きさの単位 dvw/dvh）で決める。向きを変えた直後は JS の知らせが遅れたり、
 * JS で読む大きさ（innerWidth など）が古いままだったりする端末があり、それを使うと表示が片側に寄ったりはみ出したりするため。
 * .rotated は JS 側の目印（スクロールを自分で動かすなど）。
 */
export function lockLandscape(el: HTMLElement, onChange: () => void): void {
  const touch = matchMedia('(pointer: coarse)');
  const portrait = matchMedia('(orientation: portrait)');
  rotateQuery = { touch, portrait };
  let last = '';
  const measure = () => {
    viewW = el.clientWidth || window.innerWidth;
    viewH = el.clientHeight || window.innerHeight;
  };
  const apply = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    rotated = rotatedNow();
    el.classList.toggle('rotated', rotated);
    // dvw/dvh が使えない古いブラウザ用の大きさ（CSS の予備の値）
    el.style.setProperty('--rot-w', `${h}px`);
    el.style.setProperty('--rot-h', `${w}px`);
    measure();
    if (!typing()) resetScroll();
    const key = `${rotated}|${viewW}|${viewH}`;
    if (key === last) return;
    last = key;
    onChange();
  };
  el.classList.add('lock-landscape');
  el.classList.toggle('standalone', isStandalone());
  // Safari のバーが出入りする間は大きさが少しずつ変わるので、落ち着いてから合わせる
  let timer = 0;
  const later = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(apply, 120);
  };
  window.addEventListener('resize', later);
  window.visualViewport?.addEventListener('resize', later);
  // CSS が決めた表示の大きさが変わったら、すぐに測り直す（タッチの座標の直し方に使う）
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      measure();
      later();
    }).observe(el);
  }
  // 向きを変えた直後は、大きさの報告が遅れる端末がある（すぐ・少し後・もう少し後に合わせ直す）
  const turned = () => {
    apply();
    window.setTimeout(apply, 300);
    window.setTimeout(() => {
      apply();
      resetZoom();
    }, 800);
  };
  portrait.addEventListener('change', turned);
  window.addEventListener('orientationchange', turned);
  touch.addEventListener('change', apply);
  // 画面（body）は動かないはずなので、入力中でなければ動いたぶんを戻す
  window.addEventListener('scroll', () => {
    if (!typing()) resetScroll();
  });
  // キーボードを閉じた後に、画面がずれたまま残らないようにする
  document.addEventListener('focusout', () => window.setTimeout(() => !typing() && resetScroll(), 60));
  apply();
}
