// 経営メニューの「話題・伝説」（じろ7 Phase 7）: 知名度・評判・話題性（別々に）、SNS の投稿、YouTuber と動画、店の伝説と称号。
// 状態は読むだけ（共同経営のゲストも同じものを見る）。s.fame がない古いセーブは「まだありません」と出す。

import {
  bestTitle,
  creatorTierLabel,
  CREATOR_GENRE_LABEL,
  CREATOR_PERSONALITY_LABEL,
  CREATOR_STYLE_LABEL,
  FAME,
  fameDemandFactor,
  LEGEND_RANK_LABEL,
  VIDEO_OUTCOMES,
  VIDEO_PLANS,
  type GameState,
  type Legend,
  type SnsPost,
} from '@jiro/core';
import { h } from './dom';
import { cardHead, kpi, kpiRow, meterBar } from './kit';

const SNS_ICON: Record<SnsPost['kind'], string> = {
  photo: '📷',
  review: '💬',
  ufo: '🛸',
  golden: '✨',
  dance: '💃',
  rare: '🧸',
  staff: '🙋',
  nuisance: '😣',
  quarrel: '💢',
  share: '🔁',
};

const RANK_ICON: Record<Legend['rank'], string> = { normal: '🖼️', rare: '🏅', epic: '🥈', legend: '🏆', myth: '👑' };

const pct = (v: number) => `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`;

export function fameView(s: GameState): HTMLElement {
  const f = s.fame;
  const awareness = f?.awareness ?? 0;
  const topic = f?.topic ?? 0;
  const mult = fameDemandFactor(s);
  const title = bestTitle(s);
  const prev = f?.history[f.history.length - 2];
  const trend = (now: number, before: number | undefined) => (before === undefined ? null : `前日 ${before.toFixed(1)}`);
  return h(
    'div',
    { 'data-fame': '1' },
    kpiRow([
      kpi('知名度', awareness.toFixed(1), trend(awareness, prev?.awareness) ?? '店を知っている人の多さ', 'accent', '', { 'data-fame-kpi': 'awareness' }),
      kpi('評判', `★ ${s.reputation.toFixed(2)}`, '口コミの評価', '', '', { 'data-fame-kpi': 'reputation' }),
      kpi('話題性', topic.toFixed(1), trend(topic, prev?.topic) ?? '今の話題の強さ（毎日薄れる）', topic >= 30 ? 'good' : '', '', { 'data-fame-kpi': 'topic' }),
      kpi('来客への効果', pct(mult - 1), `知名度 最大${pct(FAME.awarenessMaxBonus)}・話題性 最大${pct(FAME.topicMaxBonus)}`, mult > 1.01 ? 'good' : '', '', { 'data-fame-kpi': 'demand' }),
    ]),
    h(
      'section',
      { class: 'card wide' },
      cardHead('知名度と話題性', '知名度はゆっくり貯まり、ゆっくり減ります（動画・SNS・テレビ・伝説で上がる）。話題性は今の話題の強さで、毎日半分ほどに薄れます。評判（★）はお客さんの口コミで決まり、炎上で下がることがあります。三つは別々に効きます。'),
      h('div', { class: 'fame-meter' }, h('span', { class: 'note' }, '知名度'), meterBar(awareness / 100, 'accent', `知名度 ${awareness.toFixed(1)} / 100`), h('small', null, `${awareness.toFixed(1)} / 100`)),
      h('div', { class: 'fame-meter' }, h('span', { class: 'note' }, '話題性'), meterBar(topic / 100, topic >= 30 ? 'good' : 'accent', `話題性 ${topic.toFixed(1)} / 100`), h('small', null, `${topic.toFixed(1)} / 100`)),
      title ? h('p', { class: 'note', 'data-fame-title': '1' }, `称号: 「${title}」`) : h('p', { class: 'note' }, '称号はまだありません（激レア以上の伝説で得られます）'),
    ),
    legendsCard(s),
    youtubeCard(s),
    snsCard(s),
  );
}

function legendsCard(s: GameState): HTMLElement {
  const list = [...(s.fame?.legends ?? [])].reverse();
  const hasShelf = s.equipment.some((e) => e.type === 'legend_shelf');
  return h(
    'section',
    { class: 'card wide', 'data-legends': String(list.length) },
    cardHead(`店の伝説（${list.length}件）`, '珍事件を店の歴史として残します。ランクは 通常・希少・激レア・伝説・神話級。記念品の棚（設備）を置くと、ランクの高いものから店内に飾ります。'),
    !hasShelf && list.length > 0 ? h('p', { class: 'note' }, '記念品の棚がありません。「店舗」のレイアウトで「記念品の棚」を置くと、伝説を店内に飾れます。') : null,
    list.length === 0
      ? h('p', { class: 'note' }, 'まだ伝説はありません。珍しいお客さん・動画の大ヒット・SNS の大拡散・テレビ取材などで生まれます。')
      : h(
          'div',
          { class: 'list' },
          list.slice(0, 20).map((l) =>
            h(
              'div',
              { class: `row wrap legend rank-${l.rank}`, 'data-legend': l.id },
              h('span', null, `${RANK_ICON[l.rank]} ${LEGEND_RANK_LABEL[l.rank]}`),
              h('b', null, l.title),
              h('small', null, `${l.day}日目・${l.storeName}`),
              h('small', { class: 'note' }, l.summary),
              l.earnedTitle ? h('small', { class: 'good' }, `称号「${l.earnedTitle}」`) : null,
            ),
          ),
        ),
  );
}

function youtubeCard(s: GameState): HTMLElement {
  const f = s.fame;
  const creators = [...(f?.creators ?? [])].sort((a, b) => b.lastVisitDay - a.lastVisitDay);
  const videos = [...(f?.videos ?? [])].reverse();
  return h(
    'section',
    { class: 'card wide', 'data-youtube': String(creators.length) },
    cardHead('YouTuber と動画', 'YouTuber は一度来ても名簿に残り、また来ることがあります（店への興味と関係しだい）。撮影の許可は5段です。撮った動画は翌日に公開され、結果（普通〜大バズ・炎上）が知名度・話題性・評判に別々に効きます。'),
    creators.length === 0
      ? h('p', { class: 'note' }, 'まだ YouTuber は来ていません。')
      : h(
          'div',
          { class: 'list' },
          creators.slice(0, 8).map((c) =>
            h(
              'div',
              { class: 'row wrap', 'data-creator': c.id },
              h('b', null, c.name),
              h('span', null, `${c.channel}・登録者 ${c.subs.toLocaleString('ja-JP')}人（${creatorTierLabel(c.subs)}）`),
              h('small', { class: 'note' }, `${CREATOR_GENRE_LABEL[c.genre]}・${CREATOR_PERSONALITY_LABEL[c.personality]}・${CREATOR_STYLE_LABEL[c.style]}・来店 ${c.visits}回・動画 ${c.videos.length}本`),
              h('small', { class: c.relation >= 0.2 ? 'good' : c.relation <= -0.2 ? 'bad' : 'note' }, `店との関係 ${c.relation >= 0.2 ? 'よい' : c.relation <= -0.2 ? 'よくない' : 'ふつう'}`),
            ),
          ),
        ),
    videos.length > 0
      ? h(
          'div',
          { class: 'list' },
          videos.slice(0, 8).map((v) => {
            const cr = f?.creators.find((x) => x.id === v.creatorId);
            const o = v.outcome ? VIDEO_OUTCOMES[v.outcome] : null;
            return h(
              'div',
              { class: 'row wrap', 'data-video': v.id },
              h('span', null, '🎬'),
              h('b', null, v.title),
              h('small', null, `${cr?.name ?? ''}・${VIDEO_PLANS[v.plan].label}`),
              v.posted && o
                ? h('small', { class: v.outcome === 'flame' || v.outcome === 'sour' ? 'bad' : v.outcome === 'normal' ? 'note' : 'good' }, `${o.label}・再生 ${v.views.toLocaleString('ja-JP')}回・高評価 ${v.likes.toLocaleString('ja-JP')}・コメント ${v.comments.toLocaleString('ja-JP')}（知名度 ${v.effect.awareness >= 0 ? '+' : ''}${v.effect.awareness}・話題性 +${v.effect.topic}${v.effect.reputation < 0 ? `・評判 ${v.effect.reputation}★` : ''}）`)
                : h('small', { class: 'note' }, `${v.postDay}日目に公開予定`),
            );
          }),
        )
      : null,
  );
}

function snsCard(s: GameState): HTMLElement {
  const posts = [...(s.fame?.posts ?? [])].reverse();
  return h(
    'section',
    { class: 'card wide', 'data-sns': String(posts.length) },
    cardHead('SNS の投稿（最近）', 'お客さんは帰るときに SNS に投稿することがあります（ラーメンの写真・感想・見た珍事・店員の対応・迷惑な客）。珍事の投稿ほど話題になります。投稿の話題は翌朝に話題性・知名度へまとまります。'),
    posts.length === 0
      ? h('p', { class: 'note' }, 'まだ投稿はありません。')
      : h(
          'div',
          { class: 'list' },
          posts.slice(0, 12).map((p) =>
            h(
              'div',
              { class: 'row wrap', 'data-post': p.id },
              h('span', null, SNS_ICON[p.kind]),
              h('small', null, `${p.author}・${p.day}日目`),
              h('span', { class: p.favor < 0 ? 'bad' : '' }, p.text),
              h('small', { class: 'note' }, `反応 ${p.reactions.toLocaleString('ja-JP')}`),
            ),
          ),
        ),
  );
}
