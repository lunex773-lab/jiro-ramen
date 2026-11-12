// 日ごとの店舗別の売上（オーナーの指示 2026-11-12「何日にどの店舗がどれだけ売り上げたかが見づらい」）。
// 会社の日報（店ごとの行）から、直近の日ごとに、店ごとの売上（純売上）と営業利益を出す。
// 上: 日ごとの売上の積み上げの棒（店ごとに色）。下: 日 × 店の表（売上・営業利益・休業）。ひとりの経営と共通市場で同じ部品
import { storeDisplayName, storeReport, WEEKDAY_LABEL, weekdayOf, type GameState } from '@jiro/core';
import { h, yenStr } from './dom';
import { cardHead, yenSigned } from './kit';

/** 店の色（少ない色で区別する。7店目からは同じ色をくり返す） */
const STORE_COLORS = ['#6fb3e0', '#e0a457', '#7fc98f', '#b48ad6', '#e08a8a', '#c9c27a'];

/** 日ごとの店舗別の売上のカード（2店以上のときだけ。日報がまだなければ案内） */
export function storeDaysCard(s: GameState, days = 14): HTMLElement | null {
  const c = s.company;
  if (c.stores.length < 2) return null;
  const hist = c.history.slice(-days);
  const head = cardHead(
    '日ごとの店舗別の売上',
    '会社の日報から、日ごとに店ごとの売上（純売上）と営業利益を出しています。棒は1日の全店の売上で、色が店です。表の「休」はその日に休業した店（定休日・準備中・店長がいない日）、「—」はまだ店がなかった日です。',
  );
  if (hist.length === 0) return h('section', { class: 'card wide', 'data-store-days': '' }, head, h('p', { class: 'note' }, '次の日へ進むと、日ごとの店舗別の売上がここに出ます'));
  const stores = c.stores;
  const color = (i: number) => STORE_COLORS[i % STORE_COLORS.length]!;
  const max = Math.max(1, ...hist.map((r) => r.stores.reduce((a, l) => a + Math.max(0, l.netSales), 0)));
  // 積み上げの棒（古い日 → 新しい日）
  const bars = h(
    'div',
    { class: 'sd-bars', role: 'img', 'aria-label': `直近${hist.length}日の店舗別の売上` },
    hist.map((r) => {
      const total = r.stores.reduce((a, l) => a + Math.max(0, l.netSales), 0);
      return h(
        'div',
        { class: 'sd-col', title: `${r.day}日目 全店 ${yenStr(total)}\n${r.stores.map((l) => `${storeName(s, l.storeId, l.name)} ${yenStr(l.netSales)}`).join('\n')}` },
        h(
          'div',
          { class: 'sd-stack', style: { height: `${(total / max) * 100}%` } },
          stores.map((entry, i) => {
            const l = r.stores.find((x) => x.storeId === entry.id);
            const v = Math.max(0, l?.netSales ?? 0);
            return v > 0 ? h('div', { class: 'sd-seg', style: { height: `${(v / Math.max(1, total)) * 100}%`, background: color(i) } }) : null;
          }),
        ),
        h('small', { class: 'sd-day' }, String(r.day)),
      );
    }),
  );
  const legend = h(
    'div',
    { class: 'sd-legend' },
    stores.map((entry, i) => h('span', null, h('i', { style: { background: color(i) } }), storeDisplayName(s, entry))),
  );
  // 日 × 店の表（新しい日が上）
  const cols = `minmax(5.4em, 0.8fr) repeat(${stores.length + 1}, minmax(6.4em, 1fr))`;
  const headRow = h(
    'div',
    { class: 'sd-row sd-head', style: { gridTemplateColumns: cols } },
    h('span', null, '日'),
    stores.map((entry, i) => h('span', { class: 'sd-store' }, h('i', { style: { background: color(i) } }), storeDisplayName(s, entry))),
    h('span', { class: 'sd-store' }, '全店'),
  );
  const rows = [...hist].reverse().map((r) =>
    h(
      'div',
      { class: 'sd-row', style: { gridTemplateColumns: cols }, 'data-store-days-row': String(r.day) },
      h('span', { class: 'sd-date' }, `${r.day}日目`, h('small', null, `（${WEEKDAY_LABEL[weekdayOf(r.day)]}）`)),
      stores.map((entry) => {
        const l = r.stores.find((x) => x.storeId === entry.id);
        if (!l) return h('span', { class: 'sd-cell none' }, '—');
        const rep = storeReport(s, entry, r.day);
        if (rep?.managed === 'closed' && l.netSales === 0) return h('span', { class: 'sd-cell closed', 'data-store-day-cell': `${r.day}:${entry.id}` }, h('b', null, '休'), h('small', { class: l.operatingProfit < 0 ? 'tone-bad' : '' }, yenSigned(l.operatingProfit, true)));
        return h(
          'span',
          { class: 'sd-cell', 'data-store-day-cell': `${r.day}:${entry.id}` },
          h('b', null, yenStr(l.netSales)),
          h('small', { class: l.operatingProfit < 0 ? 'tone-bad' : l.operatingProfit > 0 ? 'tone-good' : '' }, yenSigned(l.operatingProfit, true)),
        );
      }),
      h(
        'span',
        { class: 'sd-cell total' },
        h('b', null, yenStr(r.netSales)),
        h('small', { class: r.operatingProfit < 0 ? 'tone-bad' : r.operatingProfit > 0 ? 'tone-good' : '' }, yenSigned(r.operatingProfit, true)),
      ),
    ),
  );
  return h(
    'section',
    { class: 'card wide store-days', 'data-store-days': '' },
    head,
    bars,
    legend,
    h('p', { class: 'note sd-note' }, '表の上の数字は売上、下の小さい数字は営業利益（赤は赤字）。新しい日が上です'),
    h('div', { class: 'sd-table' }, headRow, rows),
  );
}

function storeName(s: GameState, id: string, fallback: string): string {
  const e = s.company.stores.find((x) => x.id === id);
  return e ? storeDisplayName(s, e) : fallback;
}
