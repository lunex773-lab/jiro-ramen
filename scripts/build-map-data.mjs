#!/usr/bin/env node
// 出店マップの地図データを作る（docs/STORE_MAP_PLAN.md 3章）。生成物はリポジトリに入れるので、ふだんは実行しなくてよい。
//
// 入力（npm のパッケージ。リポジトリの依存には入れない）:
//   jpn-atlas@1.0.2   … 都道府県・市区町村の境界（TopoJSON・SVG 用に投影済み）。BSD-3-Clause。元は国土地理院「地球地図日本」2016
//   jp-local-gov@2.6.0 … 全国地方公共団体コード（2024年）の名前と、令和2年国勢調査の人口。MIT
// 実行:
//   npm i --no-save jpn-atlas@1.0.2 jp-local-gov@2.6.0
//   node scripts/build-map-data.mjs [--atlas <jpn-atlasのフォルダ>] [--lg <jp-local-govのフォルダ>] [--out <出力のフォルダ>]
// 出力:
//   apps/client/public/map/japan.json        … 都道府県の形（全国）と地方
//   apps/client/public/map/pref-NN.json      … その都道府県の市区町村の形
//   packages/core/src/data/municipalities.ts … 市区町村のコード → 都道府県・名前・人口（core とサーバーが出店の検証と倍率に使う）

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const ATLAS = resolve(arg('--atlas', join(ROOT, 'node_modules/jpn-atlas')));
const LG = resolve(arg('--lg', join(ROOT, 'node_modules/jp-local-gov')));
const OUT = resolve(arg('--out', ROOT));
const PUBLIC = join(OUT, 'apps/client/public/map');
const CORE = join(OUT, 'packages/core/src/data/municipalities.ts');

const REGIONS = {
  北海道: ['01'],
  東北: ['02', '03', '04', '05', '06', '07'],
  関東: ['08', '09', '10', '11', '12', '13', '14'],
  中部: ['15', '16', '17', '18', '19', '20', '21', '22', '23'],
  近畿: ['24', '25', '26', '27', '28', '29', '30'],
  中国: ['31', '32', '33', '34', '35'],
  四国: ['36', '37', '38', '39'],
  '九州・沖縄': ['40', '41', '42', '43', '44', '45', '46', '47'],
};
const regionOf = (pref) => Object.entries(REGIONS).find(([, list]) => list.includes(pref))?.[0] ?? '';

// ── TopoJSON を読む（量子化・差分の arcs → 座標） ──
const topo = JSON.parse(readFileSync(join(ATLAS, 'japan/japan.json'), 'utf8'));
const [sx, sy] = topo.transform.scale;
const [tx, ty] = topo.transform.translate;
const arcs = topo.arcs.map((arc) => {
  let x = 0;
  let y = 0;
  return arc.map(([dx, dy]) => {
    x += dx;
    y += dy;
    return [x * sx + tx, y * sy + ty];
  });
});
const arcPoints = (i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse());
function ring(indexes) {
  const pts = [];
  for (const i of indexes) {
    const p = arcPoints(i);
    pts.push(...(pts.length ? p.slice(1) : p));
  }
  return pts;
}
const polygons = (g) => (g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []);
const r1 = (v) => Math.round(v * 10) / 10;

/** 形 → SVG のパス（小数1桁）・外接の箱・面積の重心（ラベルと印の位置） */
function shape(geoms) {
  let d = '';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let best = { a: 0, x: 0, y: 0 };
  for (const g of geoms) {
    for (const poly of polygons(g)) {
      poly.forEach((indexes, ri) => {
        const pts = ring(indexes);
        if (pts.length < 3) return;
        let prev = null;
        let seg = '';
        for (const [x, y] of pts) {
          const p = `${r1(x)},${r1(y)}`;
          if (p === prev) continue;
          seg += (seg ? 'L' : 'M') + p;
          prev = p;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
        d += `${seg}Z`;
        // 外側の輪の面積と重心（いちばん大きい島に印を置く）
        if (ri === 0) {
          let a = 0;
          let gx = 0;
          let gy = 0;
          for (let k = 0; k < pts.length - 1; k++) {
            const [ax, ay] = pts[k];
            const [bx, by] = pts[k + 1];
            const c = ax * by - bx * ay;
            a += c;
            gx += (ax + bx) * c;
            gy += (ay + by) * c;
          }
          a /= 2;
          if (Math.abs(a) > 1e-9) {
            const px = gx / (6 * a);
            const py = gy / (6 * a);
            area += Math.abs(a);
            cx += px * Math.abs(a);
            cy += py * Math.abs(a);
            if (Math.abs(a) > best.a) best = { a: Math.abs(a), x: px, y: py };
          }
        }
      });
    }
  }
  return { d, bbox: [r1(x0), r1(y0), r1(x1), r1(y1)], center: [r1(best.a > 0 ? best.x : (x0 + x1) / 2), r1(best.a > 0 ? best.y : (y0 + y1) / 2)], area };
}

// ── 名前と人口（パッケージのコードは実行せず、データのファイルを文字として読む） ──
const text = (p) => readFileSync(join(LG, p), 'utf8');
/** 「{ code: '011002', … key: '値', … }」の並びから、指定した項目を取り出す */
function records(src, keys) {
  const out = [];
  for (const block of src.split(/\{\s*\n/).slice(1)) {
    const rec = {};
    for (const k of ['code', ...keys]) {
      const m = new RegExp(`${k}:\\s*'([^']*)'`).exec(block);
      if (m) rec[k] = m[1];
    }
    if (rec.code) out.push(rec);
  }
  return out;
}
const municipalities = records(text('src/code/data/2024-01-01/municipalities.ts'), ['prefectureName', 'municipalityName']);
const designatedCityWards = records(text('src/code/data/2024-01-01/designatedCityWards.ts'), ['prefectureName', 'cityName']);
const prefectures = records(text('src/code/data/2024-01-01/prefectures.ts'), ['prefectureName']);
const population = {};
for (const m of text('src/population/data/2020.ts').matchAll(/'(\d{6})':\s*(\d+)/g)) population[m[1]] = Number(m[2]);
if (!population['000001'] || municipalities.length < 1000 || prefectures.length !== 47) throw new Error('名前・人口の表を読めません');
const names = new Map();
for (const m of municipalities) names.set(m.code.slice(0, 5), { pref: m.prefectureName, name: m.municipalityName, pop: population[m.code] ?? 0 });
for (const w of designatedCityWards) names.set(w.code.slice(0, 5), { pref: w.prefectureName, name: w.cityName, pop: population[w.code] ?? 0 });
const prefName = new Map(prefectures.map((p) => [p.code.slice(0, 2), p.prefectureName]));

// ── 市区町村（同じコードの形はまとめる） ──
// 2014年の地図のコード → 今のコード（市になった町村・政令指定都市になった市・元のデータのコードの誤り）
const REMAP = {
  '03305': '03216', // 滝沢村 → 滝沢市
  '04423': '04216', // 富谷町 → 富谷市
  '06024': '05464', // 東成瀬村（秋田県。元のデータのコードの誤り）
  '11445': '11246', // 白岡町 → 白岡市
  '12402': '12239', // 大網白里町 → 大網白里市
  '17344': '17212', // 野々市町 → 野々市市
  '23304': '23238', // 長久手町 → 長久手市
  '32588': '32528', // 隠岐の島町（元のデータのコードの誤り）
  '40305': '40231', // 那珂川町 → 那珂川市
  '43201': '43100', // 熊本市（政令指定都市）
};
for (const [from, to] of Object.entries(REMAP)) if (!names.has(to)) throw new Error(`置き換え先のコードがありません: ${from} → ${to}`);
const byCode = new Map();
for (const g of topo.objects.municipalities.geometries) {
  const id = REMAP[g.id] ?? g.id;
  if (!byCode.has(id)) byCode.set(id, []);
  byCode.get(id).push(g);
}
const missing = [];
const munis = [];
for (const [code, geoms] of byCode) {
  const n = names.get(code);
  if (!n) {
    missing.push(code);
    continue;
  }
  const sh = shape(geoms);
  munis.push({ code, pref: code.slice(0, 2), name: n.name, pop: n.pop, ...sh });
}
munis.sort((a, b) => a.code.localeCompare(b.code));

// ── 都道府県 ──
const prefs = topo.objects.prefectures.geometries
  .map((g) => {
    const sh = shape([g]);
    return { code: g.id, name: prefName.get(g.id) ?? g.id, region: regionOf(g.id), d: sh.d, bbox: sh.bbox, center: sh.center };
  })
  .sort((a, b) => a.code.localeCompare(b.code));

// ── 書き出す ──
mkdirSync(PUBLIC, { recursive: true });
const ATTRIBUTION = '地図: 国土地理院「地球地図日本」（jpn-atlas, BSD-3-Clause）／名前・人口: 総務省 全国地方公共団体コード・令和2年国勢調査（jp-local-gov, MIT）';
const [bx0, by0, bx1, by1] = topo.bbox;
const japan = {
  version: 1,
  attribution: ATTRIBUTION,
  viewBox: [Math.floor(bx0) - 10, Math.floor(by0) - 10, Math.ceil(bx1 - bx0) + 20, Math.ceil(by1 - by0) + 20],
  regions: Object.entries(REGIONS).map(([name, list]) => ({ name, prefectures: list })),
  prefectures: prefs,
};
writeFileSync(join(PUBLIC, 'japan.json'), JSON.stringify(japan));
const sizes = { 'japan.json': JSON.stringify(japan).length };
for (const p of prefs) {
  const list = munis.filter((m) => m.pref === p.code).map(({ code, name, pop, d, bbox, center }) => ({ code, name, pop, d, bbox, center }));
  const text = JSON.stringify({ version: 1, code: p.code, name: p.name, municipalities: list });
  writeFileSync(join(PUBLIC, `pref-${p.code}.json`), text);
  sizes[`pref-${p.code}.json`] = text.length;
}
for (const [src, dst] of [
  [join(ATLAS, 'LICENSE'), 'LICENSE-jpn-atlas.txt'],
  [join(LG, 'LICENSE'), 'LICENSE-jp-local-gov.txt'],
]) {
  if (existsSync(src)) copyFileSync(src, join(PUBLIC, dst));
}

// core の表（コード → [都道府県コード, 名前, 人口]）
mkdirSync(dirname(CORE), { recursive: true });
const rows = munis.map((m) => `  '${m.code}': ['${m.pref}', '${m.name.replace(/'/g, "\\'")}', ${m.pop}],`).join('\n');
const prefRows = prefs.map((p) => `  '${p.code}': '${p.name}',`).join('\n');
writeFileSync(
  CORE,
  `// 市区町村（出店マップ。docs/STORE_MAP_PLAN.md）。scripts/build-map-data.mjs が作る（手で直さない）。
// ${ATTRIBUTION}
// 境界は2014年の区域。名前は2024年の全国地方公共団体コード、人口は令和2年（2020年）国勢調査。

/** 都道府県のコード（2桁）→ 名前 */
export const PREFECTURES: Readonly<Record<string, string>> = {
${prefRows}
};

/** 市区町村のコード（5桁）→ [都道府県のコード, 名前, 人口] */
export const MUNICIPALITIES: Readonly<Record<string, readonly [string, string, number]>> = {
${rows}
};
`,
);

const total = Object.values(sizes).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ prefectures: prefs.length, municipalities: munis.length, missingNames: missing.length, missing: missing.slice(0, 30), totalKB: Math.round(total / 1024), japanKB: Math.round(sizes['japan.json'] / 1024), largestPref: Object.entries(sizes).filter(([k]) => k.startsWith('pref')).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${Math.round(v / 1024)}KB`), noPop: munis.filter((m) => !m.pop).map((m) => m.name) }));
