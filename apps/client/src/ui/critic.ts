// 覆面調査員（グルメ評論家）の記事。来店の翌日の仕込みの開始時に公開され、その朝に一度だけ見せる。

import { BALANCE, CRITIC_ITEMS, type CriticItem, type CriticReport } from '@jiro/core';
import { h, stars } from './dom';

export function showCriticReport(root: HTMLElement, r: CriticReport): void {
  const items = Object.keys(CRITIC_ITEMS) as CriticItem[];
  const overlay = h(
    'div',
    { class: 'modal-overlay' },
    h(
      'div',
      { class: 'modal critic' },
      h('h3', null, '📰 グルメサイトに記事が載りました'),
      h('p', { class: 'note' }, `${r.day}日目に、グルメ評論家が覆面で来店していました`),
      h('div', { class: 'critic-stars' }, `${stars(r.stars)} ★${r.stars.toFixed(1)}`),
      h('p', { class: 'critic-text' }, `「${r.text}」`),
      h(
        'div',
        { class: 'critic-scores' },
        items.map((k) =>
          h(
            'div',
            { class: `critic-row ${r.scores[k] < BALANCE.events.critic.improveBelow ? 'bad' : ''}` },
            h('span', null, CRITIC_ITEMS[k].name),
            h('span', { class: 'bar' }, h('i', { style: `width:${Math.round(Math.max(0, Math.min(1, r.scores[k])) * 100)}%` })),
          ),
        ),
      ),
      r.improve.length > 0
        ? h('p', { class: 'note' }, `改善点: ${r.improve.map((k) => `${CRITIC_ITEMS[k].name}（${CRITIC_ITEMS[k].improve}）`).join('、')}`)
        : h('p', { class: 'note' }, '指摘された改善点はありません'),
      h(
        'p',
        { class: 'note' },
        r.stars >= BALANCE.events.critic.goodStars ? 'しばらくお客さんが増えそうです' : r.stars <= BALANCE.events.critic.badStars ? 'しばらくお客さんが減るかもしれません' : '',
      ),
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: () => overlay.remove() }, '閉じる')),
    ),
  );
  root.appendChild(overlay);
}
