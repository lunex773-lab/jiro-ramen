// テスト用: イベントを強制的に起こす（URL に ?debug=1 を付けたときの、ひとりプレイの経営メニューだけに出す）。
// 共同経営のサーバーはこの操作（debugEvent）を受け付けない。

import { EVENT_KINDS, type EventKind, type GameState } from '@jiro/core';
import type { GameHost } from '../game/host';
import { h, toast } from './dom';

const LABELS: Record<EventKind, string> = {
  sns_buzz: '📱 SNSでバズる（営業中）',
  critic: '📰 覆面調査員が来る（次の新規客）',
  rare_couple: '👫 金髪の女性と彼氏（次の来店）',
  rare_lover: '🍜 一人でラーメンを愛する客（次の来店）',
  complaint_unreasonable: '😠 理不尽な要求（次に良い丼を出した客）',
  explosion: '💥 爆発事故（2日目以降・営業中ならすぐ）',
  youtuber: '🎥 YouTuber が来る（次の一人客）',
  tv: '📺 テレビ取材が来る（営業中ならすぐ）',
};

export function debugEventsEnabled(): boolean {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

export function debugEventsCard(s: GameState, host: GameHost, root: HTMLElement, onDone: () => void): HTMLElement {
  const stats = s.events?.stats ?? {};
  return h(
    'section',
    { class: 'card wide' },
    h('h4', null, 'テスト: イベントを起こす'),
    h('p', { class: 'note' }, '確認用の機能です（URL の ?debug=1 のときだけ表示）。抽選の回数と発生した回数（うち強制）も記録しています。'),
    h(
      'div',
      { class: 'debug-events' },
      EVENT_KINDS.map((kind) => {
        const st = stats[kind];
        return h(
          'div',
          { class: 'row wrap' },
          h(
            'button',
            {
              class: 'btn',
              'data-event': kind,
              onclick: () =>
                void host.act({ type: 'debugEvent', kind }).then((r) => {
                  toast(root, r.ok ? `${LABELS[kind]}: 起こしました` : (r.reason ?? '起こせません'), r.ok ? 'good' : 'warn', 2200);
                  if (r.ok) onDone();
                }),
            },
            LABELS[kind],
          ),
          h('small', null, st ? `抽選 ${st.draws}回・発生 ${st.fired}回（強制 ${st.forced ?? 0}）` : '記録なし'),
        );
      }),
    ),
  );
}
