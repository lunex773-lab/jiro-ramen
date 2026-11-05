// 日本地図の出店マップ（docs/STORE_MAP_PLAN.md。オーナーから受け取った「日本地図型・店舗出店マップ実装」を参考にした）。
// 全国 → 地方 → 都道府県 → 市区町村 → 出店候補地（駅前・住宅街・郊外）。境界は同梱の地図データ（public/map）を SVG で描く。
// マウス・タッチで拡大縮小・ドラッグ・ピンチ。選んだ区域を強調し、候補地に印を出す。戻る・パンくず。スマホ（横向き・回した表示）と PC。
// 地図データは都道府県を選んだときに、その都道府県の分だけ読む。

import { candidateSites, locationInfo, populationIndex, PROPERTIES, type LocationInfo } from '@jiro/core';
import { isRotated, toView } from '../game/orientation';
import { h, replace } from './dom';

// ───────────────────────── 地図データ ─────────────────────────

interface PrefShape {
  code: string;
  name: string;
  region: string;
  d: string;
  bbox: [number, number, number, number];
  center: [number, number];
}
interface JapanMap {
  attribution: string;
  viewBox: [number, number, number, number];
  regions: { name: string; prefectures: string[] }[];
  prefectures: PrefShape[];
}
interface MuniShape {
  code: string;
  name: string;
  pop: number;
  d: string;
  bbox: [number, number, number, number];
  center: [number, number];
}

let japanCache: Promise<JapanMap> | null = null;
const prefCache = new Map<string, Promise<MuniShape[]>>();

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, document.baseURI).toString());
  if (!res.ok) throw new Error(`地図データを読めません（HTTP ${res.status}）`);
  return (await res.json()) as T;
}
function loadJapan(): Promise<JapanMap> {
  japanCache ??= fetchJson<JapanMap>('map/japan.json').catch((e: unknown) => {
    japanCache = null;
    throw e;
  });
  return japanCache;
}
function loadPref(code: string): Promise<MuniShape[]> {
  let p = prefCache.get(code);
  if (!p) {
    p = fetchJson<{ municipalities: MuniShape[] }>(`map/pref-${code}.json`)
      .then((x) => x.municipalities)
      .catch((e: unknown) => {
        prefCache.delete(code);
        throw e;
      });
    prefCache.set(code, p);
  }
  return p;
}

// ───────────────────────── 画面 ─────────────────────────

export interface MapPick {
  /** 市区町村のコード（5桁） */
  code: string;
  /** 候補地の物件（station・residential・roadside）。街だけを選ぶ画面では undefined */
  propertyId?: string;
}

export interface StoreMapOptions {
  title: string;
  /** site: 出店の候補地まで選ぶ、city: 市区町村だけ選ぶ（1店目の場所・市場の街） */
  mode: 'site' | 'city';
  /** その街の中だけ（共通市場の出店。市場は1つの街） */
  onlyCity?: string;
  /** 候補地の詳しい数字と、出店できない理由 */
  siteInfo?: (code: string, propertyId: string) => { lines: string[]; problem: string | null };
  /** 街の詳しい数字と、選べない理由 */
  cityInfo?: (code: string) => { lines: string[]; problem: string | null };
  /** 決めるボタンの文字（「ここに出店する」「この街にする」） */
  confirmLabel: string;
  /** 候補地の下に足す部品（店長を選ぶ欄など） */
  extra?: () => HTMLElement | null;
  onPick: (p: MapPick) => void | Promise<void>;
  onClose: () => void;
  /** 「あとで決める」など、決めずに閉じるボタンの文字（なければ「閉じる」） */
  closeLabel?: string;
}

type Level = 'national' | 'region' | 'prefecture' | 'municipality';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const SITE_ICON: Record<string, string> = { station: '🚉', residential: '🏠', roadside: '🚗' };
/** 候補地の印の位置（市区町村の箱の大きさに対する、中心からのずれ） */
const SITE_OFFSET: Record<string, [number, number]> = { station: [0, 0], residential: [-0.18, 0.16], roadside: [0.2, -0.14] };

const people = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(n >= 100_000 ? 0 : 1)}万人` : `${n.toLocaleString('ja-JP')}人`);
const pctOf = (x: number) => `${x >= 1 ? '+' : '−'}${Math.round(Math.abs(x - 1) * 100)}%`;

/** 出店マップを開く（root の上に重ねる）。閉じると取り除く */
export function openStoreMap(root: HTMLElement, o: StoreMapOptions): { el: HTMLElement; close(): void } {
  const svg = svgEl('svg', { class: 'store-map-svg', xmlns: NS, preserveAspectRatio: 'xMidYMid meet' }) as SVGSVGElement;
  const layer = svgEl('g') as SVGGElement;
  svg.appendChild(layer);
  const crumbs = h('div', { class: 'map-crumbs', 'data-map-crumbs': '' });
  const side = h('div', { class: 'map-side' });
  const status = h('div', { class: 'map-status note' }, '地図を読み込んでいます…');
  const stage = h('div', { class: 'map-stage', 'data-map-stage': '' }, svg, status);
  const backBtn = h('button', { class: 'btn ghost mini', 'data-map-back': '', onclick: () => back() }, '← 戻る');
  const el = h(
    'div',
    { class: 'screen store-map', 'data-store-map': '' },
    h(
      'div',
      { class: 'store-map-inner' },
      h(
        'div',
        { class: 'map-panel' },
        h('div', { class: 'map-head' }, h('h3', null, o.title), crumbs),
        h(
          'div',
          { class: 'map-toolbar' },
          backBtn,
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn ghost mini', 'data-map-zoom-out': '', onclick: () => zoomBy(1.25) }, '−'),
            h('button', { class: 'btn ghost mini', 'data-map-zoom-in': '', onclick: () => zoomBy(0.8) }, '＋'),
            h('button', { class: 'btn ghost mini', 'data-map-reset': '', onclick: () => fit() }, '全体'),
          ),
        ),
        stage,
      ),
      side,
    ),
  );
  el.addEventListener('pointerdown', (e) => e.stopPropagation());

  const state: {
    level: Level;
    japan: JapanMap | null;
    region: string | null;
    pref: string | null;
    munis: MuniShape[];
    muni: string | null;
    site: string | null;
    filter: string;
  } = { level: 'national', japan: null, region: null, pref: null, munis: [], muni: null, site: null, filter: '' };

  // ── 表示の範囲（viewBox） ──
  let vb = { x: 0, y: 0, w: 1000, h: 800 };
  let home = { ...vb };
  const applyVb = () => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const fitBox = (b: [number, number, number, number], pad = 0.08) => {
    const w = Math.max(4, b[2] - b[0]);
    const hh = Math.max(4, b[3] - b[1]);
    vb = { x: b[0] - w * pad, y: b[1] - hh * pad, w: w * (1 + 2 * pad), h: hh * (1 + 2 * pad) };
    home = { ...vb };
    applyVb();
    restyle();
  };
  const fit = () => {
    vb = { ...home };
    applyVb();
    restyle();
  };
  /** 拡大縮小（factor < 1 で拡大）。中心は表示の中心か、指・マウスの位置（SVG の座標） */
  const zoomBy = (factor: number, cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2) => {
    const nw = Math.min(home.w * 4, Math.max(home.w / 40, vb.w * factor));
    const f = nw / vb.w;
    vb = { x: cx - (cx - vb.x) * f, y: cy - (cy - vb.y) * f, w: vb.w * f, h: vb.h * f };
    applyVb();
    restyle();
  };
  /** 線と文字の太さ・大きさを、表示の範囲に合わせる */
  const restyle = () => {
    const unit = vb.w / Math.max(200, svg.clientWidth || 600);
    svg.style.setProperty('--map-unit', String(unit));
    for (const t of Array.from(layer.querySelectorAll<SVGTextElement>('text'))) {
      t.setAttribute('font-size', String(unit * Number(t.dataset.px ?? 11)));
      // 文字の縁取りは表示の大きさに合わせる（拡大しても太くならない）
      t.setAttribute('stroke-width', String(unit * 2.5));
    }
    for (const c of Array.from(layer.querySelectorAll<SVGCircleElement>('circle[data-px]'))) c.setAttribute('r', String(unit * Number(c.dataset.px ?? 8)));
  };

  // ── 描く ──
  const draw = () => {
    layer.replaceChildren();
    const j = state.japan;
    if (!j) return;
    if (state.level === 'national' || state.level === 'region') {
      const inRegion = (p: PrefShape) => !state.region || p.region === state.region;
      for (const p of j.prefectures) {
        if (o.onlyCity && p.code !== o.onlyCity.slice(0, 2)) continue;
        const path = svgEl('path', { d: p.d, class: `map-shape region-${regionIndex(j, p.region)}${state.region && !inRegion(p) ? ' dim' : ''}`, 'data-pref': p.code });
        path.addEventListener('click', () => (state.level === 'national' ? openRegion(p.region) : inRegion(p) ? void openPref(p.code) : openRegion(p.region)));
        layer.appendChild(path);
      }
      if (state.level === 'region') {
        for (const p of j.prefectures.filter(inRegion)) layer.appendChild(label(p.center, p.name, 11));
      }
    } else {
      const sel = state.muni;
      for (const m of state.munis) {
        if (o.onlyCity && m.code !== o.onlyCity) continue;
        const info = locationInfo(m.code);
        const closed = !info || info.population <= 0;
        const path = svgEl('path', { d: m.d, class: `map-shape muni pop-${popClass(m.pop)}${m.code === sel ? ' selected' : ''}${closed ? ' closed' : ''}`, 'data-muni': m.code });
        path.addEventListener('click', () => openMuni(m.code));
        layer.appendChild(path);
      }
      // 名前（人口の多い市区町村から。選んだ市区町村はいつも）
      const big = [...state.munis].sort((a, b) => b.pop - a.pop).slice(0, state.level === 'prefecture' ? 14 : 0);
      for (const m of big) if (m.code !== sel) layer.appendChild(label(m.center, m.name, 9));
      const cur = state.munis.find((m) => m.code === sel);
      if (cur) {
        layer.appendChild(label([cur.center[0], cur.bbox[1] + (cur.bbox[3] - cur.bbox[1]) * 0.08], cur.name, 12, 'map-label strong'));
        if (o.mode === 'site') {
          for (const s of candidateSites(cur.code)) layer.appendChild(siteMarker(cur, s.propertyId));
        } else {
          const c = svgEl('circle', { cx: cur.center[0], cy: cur.center[1], class: 'map-pin', 'data-px': 7 });
          layer.appendChild(c);
        }
      }
    }
    restyle();
  };
  const label = (at: [number, number], text: string, px: number, cls = 'map-label') => {
    const t = svgEl('text', { x: at[0], y: at[1], class: cls }) as SVGTextElement;
    t.dataset.px = String(px);
    t.textContent = text;
    return t;
  };
  const siteMarker = (m: MuniShape, propertyId: string) => {
    const [ox, oy] = SITE_OFFSET[propertyId] ?? [0, 0];
    const w = m.bbox[2] - m.bbox[0];
    const hh = m.bbox[3] - m.bbox[1];
    const x = m.center[0] + ox * w;
    const y = m.center[1] + oy * hh;
    const g = svgEl('g', { class: `map-site${state.site === propertyId ? ' selected' : ''}`, 'data-site': propertyId });
    const c = svgEl('circle', { cx: x, cy: y, 'data-px': 13 }) as SVGCircleElement;
    const t = svgEl('text', { x, y, class: 'map-site-icon', 'dominant-baseline': 'central' }) as SVGTextElement;
    t.dataset.px = '11';
    t.textContent = SITE_ICON[propertyId] ?? '●';
    g.append(c, t);
    g.addEventListener('click', (e) => {
      e.stopPropagation();
      pickSite(propertyId);
    });
    return g;
  };

  // ── 横の一覧と詳しい数字 ──
  const renderSide = () => {
    const j = state.japan;
    const list: HTMLElement[] = [];
    let info: HTMLElement | null = null;
    if (!j) {
      replace(side, status.cloneNode(true) as HTMLElement);
      return;
    }
    if (state.level === 'national') {
      info = h('p', { class: 'note' }, '地図か一覧から地方を選んでください。');
      for (const r of j.regions) list.push(h('button', { class: 'btn map-item', 'data-map-region': r.name, onclick: () => openRegion(r.name) }, r.name));
    } else if (state.level === 'region') {
      info = h('p', { class: 'note' }, `${state.region}: 都道府県を選んでください。`);
      for (const p of j.prefectures.filter((x) => x.region === state.region)) list.push(h('button', { class: 'btn map-item', 'data-map-pref': p.code, onclick: () => void openPref(p.code) }, p.name));
    } else {
      const filtered = state.munis
        .filter((m) => !o.onlyCity || m.code === o.onlyCity)
        .filter((m) => !state.filter || m.name.includes(state.filter))
        .sort((a, b) => b.pop - a.pop);
      if (state.level === 'prefecture') info = h('p', { class: 'note' }, '市区町村を選んでください（人口の多い順）。');
      if (state.level === 'municipality') info = muniInfo();
      if (!o.onlyCity) {
        const search = h('input', { class: 'input map-search', placeholder: '市区町村名で探す', value: state.filter, 'data-map-search': '' }) as HTMLInputElement;
        search.addEventListener('input', () => {
          state.filter = search.value.trim();
          renderSide();
          const again = side.querySelector<HTMLInputElement>('[data-map-search]');
          again?.focus();
          if (again) again.setSelectionRange(again.value.length, again.value.length);
        });
        list.push(search);
      }
      for (const m of filtered) {
        const l = locationInfo(m.code);
        list.push(
          h(
            'button',
            { class: `btn map-item${m.code === state.muni ? ' on' : ''}`, 'data-map-muni': m.code, disabled: !l || l.population <= 0, onclick: () => openMuni(m.code) },
            m.name,
            h('small', null, l && l.population > 0 ? people(l.population) : '出店できません'),
          ),
        );
      }
    }
    replace(
      side,
      h('h4', null, state.level === 'municipality' ? (state.munis.find((m) => m.code === state.muni)?.name ?? '') : state.level === 'prefecture' ? (j.prefectures.find((p) => p.code === state.pref)?.name ?? '') : state.region ?? '日本全国'),
      info,
      state.level === 'municipality' ? null : h('div', { class: 'map-list' }, list),
      state.level === 'municipality' && !o.onlyCity ? h('div', { class: 'map-list short' }, list) : null,
      h('div', { class: 'map-foot' }, h('button', { class: 'btn ghost', 'data-map-close': '', onclick: () => close(true) }, o.closeLabel ?? '閉じる'), h('p', { class: 'note map-credit' }, j.attribution)),
    );
  };

  /** 選んだ市区町村の詳しい数字・候補地・決めるボタン */
  const muniInfo = (): HTMLElement => {
    const l = locationInfo(state.muni);
    if (!l) return h('p', { class: 'note bad' }, 'この市区町村の情報がありません');
    const rows = [
      h('div', { class: 'kv' }, h('span', null, '人口'), h('b', null, people(l.population))),
      h('div', { class: 'kv' }, h('span', null, '来客・家賃'), h('b', null, `来客 ${pctOf(l.demand)}・家賃 ${pctOf(l.rent)}`)),
    ];
    if (o.mode === 'city') {
      const ci = o.cityInfo?.(l.code) ?? { lines: [], problem: null };
      return h(
        'div',
        { class: 'map-detail' },
        rows,
        ci.lines.map((x) => h('p', { class: 'note' }, x)),
        ci.problem ? h('p', { class: 'note bad' }, ci.problem) : null,
        h('button', { class: 'btn primary', 'data-map-confirm': l.code, disabled: !!ci.problem || l.population <= 0, onclick: () => void confirm({ code: l.code }) }, o.confirmLabel),
      );
    }
    const sites = candidateSites(l.code).map((s) => {
      const si = o.siteInfo?.(l.code, s.propertyId) ?? { lines: [], problem: null };
      const prop = PROPERTIES[s.propertyId]!;
      const on = state.site === s.propertyId;
      return h(
        'div',
        { class: `map-site-card${on ? ' on' : ''}`, 'data-map-site': s.propertyId },
        h('button', { class: `btn map-item map-site-btn${on ? ' on' : ''}`, onclick: () => pickSite(s.propertyId) }, h('span', null, `${SITE_ICON[s.propertyId] ?? ''} ${s.name}`), h('small', null, prop.name)),
        on ? h('div', null, h('p', { class: 'note' }, prop.description), si.lines.map((x) => h('p', { class: 'note' }, x)), si.problem ? h('p', { class: 'note bad' }, si.problem) : null) : null,
      );
    });
    const chosen = state.site;
    const problem = chosen ? (o.siteInfo?.(l.code, chosen).problem ?? null) : '候補地を選んでください';
    return h(
      'div',
      { class: 'map-detail' },
      rows,
      h('p', { class: 'note' }, '出店候補地（地図の印か一覧から選ぶ）'),
      sites,
      chosen ? (o.extra?.() ?? null) : null,
      h('button', { class: 'btn primary', 'data-map-confirm': chosen ?? '', disabled: !!problem, onclick: () => chosen && void confirm({ code: l.code, propertyId: chosen }) }, o.confirmLabel),
    );
  };

  // ── 移動 ──
  const renderCrumbs = () => {
    const j = state.japan;
    const items: { label: string; go: (() => void) | null }[] = [{ label: '全国', go: o.onlyCity ? null : () => goNational() }];
    if (state.region) items.push({ label: state.region, go: o.onlyCity ? null : () => openRegion(state.region!) });
    if (state.pref) items.push({ label: j?.prefectures.find((p) => p.code === state.pref)?.name ?? '', go: () => void openPref(state.pref!) });
    if (state.muni) items.push({ label: state.munis.find((m) => m.code === state.muni)?.name ?? '', go: () => openMuni(state.muni!) });
    if (state.site) items.push({ label: PROPERTIES[state.site]?.area ?? '', go: null });
    replace(
      crumbs,
      items.flatMap((it, i) => [
        h('span', { class: `crumb${it.go ? ' link' : ''}`, 'data-crumb': String(i), onclick: it.go ?? undefined }, it.label),
        i < items.length - 1 ? h('span', { class: 'sep' }, ' / ') : null,
      ]),
    );
    backBtn.disabled = state.level === 'national' || (!!o.onlyCity && state.level === 'municipality');
  };
  const update = () => {
    draw();
    renderSide();
    renderCrumbs();
  };
  const goNational = () => {
    Object.assign(state, { level: 'national', region: null, pref: null, munis: [], muni: null, site: null, filter: '' });
    if (state.japan) fitBox(boundsOf(state.japan.prefectures), 0.03);
    update();
  };
  const openRegion = (region: string) => {
    const j = state.japan;
    if (!j) return;
    Object.assign(state, { level: 'region', region, pref: null, munis: [], muni: null, site: null, filter: '' });
    fitBox(boundsOf(j.prefectures.filter((p) => p.region === region)));
    update();
  };
  const openPref = async (code: string) => {
    const j = state.japan;
    if (!j) return;
    const p = j.prefectures.find((x) => x.code === code);
    if (!p) return;
    status.textContent = `${p.name}の地図を読み込んでいます…`;
    status.hidden = false;
    try {
      const munis = await loadPref(code);
      Object.assign(state, { level: 'prefecture', region: p.region, pref: code, munis, muni: null, site: null, filter: '' });
      status.hidden = true;
      fitBox(p.bbox);
      update();
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  const openMuni = (code: string) => {
    const m = state.munis.find((x) => x.code === code);
    if (!m) return;
    state.level = 'municipality';
    state.muni = code;
    state.site = null;
    fitBox(m.bbox, 0.35);
    update();
  };
  const pickSite = (propertyId: string) => {
    state.site = propertyId;
    update();
  };
  const back = () => {
    if (state.level === 'municipality') {
      if (state.site) {
        state.site = null;
        update();
        return;
      }
      if (o.onlyCity) return;
      void openPref(state.pref!);
    } else if (state.level === 'prefecture') openRegion(state.region!);
    else if (state.level === 'region') goNational();
  };
  const confirm = async (p: MapPick) => {
    try {
      await o.onPick(p);
    } catch (e) {
      status.textContent = (e as Error).message;
      status.hidden = false;
    }
  };
  const close = (cancel: boolean) => {
    el.remove();
    if (cancel) o.onClose();
  };

  // ── 拡大縮小・ドラッグ・ピンチ（回した表示でも指の向きを合わせる） ──
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; vb: typeof vb; moved: boolean } | null = null;
  let pinch: { d: number; w: number } | null = null;
  const pos = (e: PointerEvent) => toView(e.clientX, e.clientY);
  /** 画面の点 → SVG の座標（回していないとき。回しているときは中心） */
  const toSvg = (e: { clientX: number; clientY: number }) => {
    if (isRotated()) return { x: vb.x + vb.w / 2, y: vb.y + vb.h / 2 };
    const r = svg.getBoundingClientRect();
    const s = Math.max(vb.w / r.width, vb.h / r.height);
    const ox = (r.width - vb.w / s) / 2;
    const oy = (r.height - vb.h / s) / 2;
    return { x: vb.x + (e.clientX - r.left - ox) * s, y: vb.y + (e.clientY - r.top - oy) * s };
  };
  const unitPerPx = () => Math.max(vb.w / Math.max(1, svg.clientWidth), vb.h / Math.max(1, svg.clientHeight));
  svg.addEventListener('pointerdown', (e) => {
    svg.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, pos(e));
    if (pointers.size === 1) drag = { ...pos(e), vb: { ...vb }, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y), w: vb.w };
      drag = null;
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, pos(e));
    if (pointers.size === 1 && drag) {
      const p = pos(e);
      const k = unitPerPx();
      const dx = (p.x - drag.x) * k;
      const dy = (p.y - drag.y) * k;
      if (Math.abs(p.x - drag.x) + Math.abs(p.y - drag.y) > 6) drag.moved = true;
      if (drag.moved) {
        vb = { ...drag.vb, x: drag.vb.x - dx, y: drag.vb.y - dy };
        applyVb();
        svg.classList.add('dragging');
      }
    } else if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (d > 0 && pinch.d > 0) zoomBy((pinch.w * (pinch.d / d)) / vb.w);
    }
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      svg.classList.remove('dragging');
      // ドラッグしたときは、指を離した場所の区域を選ばない
      if (drag?.moved) {
        const stop = (ev: Event) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        svg.addEventListener('click', stop, { capture: true, once: true });
        setTimeout(() => svg.removeEventListener('click', stop, { capture: true }), 0);
      }
      drag = null;
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const c = toSvg(e);
      zoomBy(e.deltaY < 0 ? 0.88 : 1.14, c.x, c.y);
    },
    { passive: false },
  );
  // 回した表示のスクロール（rotated-scroll）に地図のドラッグを渡さない
  stage.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  // ── 始める ──
  root.appendChild(el);
  renderCrumbs();
  void loadJapan()
    .then(async (j) => {
      state.japan = j;
      status.hidden = true;
      if (o.onlyCity) {
        const l = locationInfo(o.onlyCity);
        if (l) {
          state.region = j.prefectures.find((p) => p.code === l.prefCode)?.region ?? null;
          await openPref(l.prefCode);
          openMuni(o.onlyCity);
          return;
        }
      }
      goNational();
    })
    .catch((e: unknown) => {
      status.textContent = `地図を読み込めませんでした（${(e as Error).message}）`;
    });
  return { el, close: () => close(false) };
}

function boundsOf(ps: { bbox: [number, number, number, number] }[]): [number, number, number, number] {
  return [Math.min(...ps.map((p) => p.bbox[0])), Math.min(...ps.map((p) => p.bbox[1])), Math.max(...ps.map((p) => p.bbox[2])), Math.max(...ps.map((p) => p.bbox[3]))];
}

function regionIndex(j: JapanMap, region: string): number {
  return Math.max(0, j.regions.findIndex((r) => r.name === region));
}

/** 人口の大きさの段階（色分け） */
function popClass(pop: number): number {
  if (pop <= 0) return 0;
  return Math.round((populationIndex(pop) + 1) * 2) + 1; // 1〜5
}

export type { LocationInfo };
