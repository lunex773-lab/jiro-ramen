// ランキングの画面（共通市場の仕様書 8.3。docs/MARKET_RANKING_PLAN.md）。
// タブ: コミュニティ・全体（新規の企業だけ／育てた企業も可。オーナーの判断 3a）。期間: 週間・月間・年間・累計（JST）。
// 種別: 総合評価・総売上・営業利益・最終利益・顧客満足度・企業価値成長率・市場シェア・従業員満足度・店舗品質。
// 自社の順位・前の期間との順位の変動・称号（報酬）を出す。数値はサーバーが0時の同期で確定した日だけから作る。

import type { Api, Auth } from '../net/api';
import { ApiError } from '../net/api';
import { h, replace, yenStr } from './dom';

export type RankBoardId = 'community' | 'fresh' | 'grown';
export type RankScopeId = 'week' | 'month' | 'year' | 'total';

export interface RankRow {
  rank: number;
  marketId: string;
  companyId: string;
  name: string;
  kind: string;
  value: number;
  days: number;
  flaggedDays: number;
  prevRank: number | null;
  mine: boolean;
}

export interface RankingResponse {
  board: RankBoardId;
  scope: RankScopeId;
  scopeKey: string;
  prevKey: string | null;
  metric: string;
  metricLabel: string;
  perDay: boolean;
  total: number;
  rows: RankRow[];
  mine: RankRow[];
}

const METRICS: [string, string][] = [
  ['overall', '総合評価'],
  ['sales', '総売上'],
  ['op', '営業利益'],
  ['final', '最終利益'],
  ['satisfaction', '顧客満足度'],
  ['growth', '企業価値成長率'],
  ['share', '市場シェア'],
  ['employee', '従業員満足度'],
  ['quality', '店舗品質'],
];
const SCOPES: [RankScopeId, string][] = [
  ['week', '週間'],
  ['month', '月間'],
  ['year', '年間'],
  ['total', '累計'],
];

function fmt(metric: string, v: number, perDay: boolean): string {
  if (metric === 'overall') return `平均 ${v.toFixed(1)}位`;
  if (metric === 'sales' || metric === 'op' || metric === 'final') return `${yenStr(Math.round(v))}${perDay ? '/日' : ''}`;
  if (metric === 'growth') return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  if (metric === 'share') return `${(v * 100).toFixed(1)}%`;
  return `${Math.round(v * 100)}点`;
}

function moveText(r: RankRow): { text: string; cls: string } {
  if (r.prevRank === null) return { text: '初', cls: 'new' };
  const d = r.prevRank - r.rank;
  if (d > 0) return { text: `↑${d}`, cls: 'up' };
  if (d < 0) return { text: `↓${-d}`, cls: 'down' };
  return { text: '→', cls: 'same' };
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { error?: string; message?: string } | null;
    return b?.error ?? b?.message ?? e.message;
  }
  return (e as Error)?.message ?? String(e);
}

/** ランキングの画面（市場の画面から開く。閉じると onBack） */
export class RankingScreen {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private board: RankBoardId = 'community';
  private scope: RankScopeId = 'week';
  private metric = 'overall';

  constructor(
    private api: Api,
    private auth: Auth,
    private marketId: string,
    private marketName: string,
    private onBack: () => void,
  ) {
    this.body = h('div', { class: 'ranking-body' });
    this.el = h(
      'div',
      { class: 'screen ranking' },
      h('div', { class: 'screen-inner wide' }, h('h2', null, `🏆 ランキング（${marketName}）`), this.body, h('button', { class: 'btn ghost', 'data-ranking-back': '', onclick: () => this.close() }, '← 市場の画面へ')),
    );
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    void this.load();
  }

  close(): void {
    this.el.remove();
    this.onBack();
  }

  private tabs(): HTMLElement {
    const tab = <T extends string>(attr: string, cur: T, list: [T, string][], set: (v: T) => void) =>
      h(
        'div',
        { class: 'tabs' },
        list.map(([v, label]) => h('button', { class: `tab ${v === cur ? 'on' : ''}`, [attr]: v, onclick: () => set(v) }, label)),
      );
    return h(
      'div',
      { class: 'ranking-tabs' },
      tab<RankBoardId>('data-board', this.board, [['community', 'コミュニティ'], ['fresh', '全体（新規の企業）'], ['grown', '全体（育てた企業も可）']], (v) => {
        this.board = v;
        void this.load();
      }),
      tab<RankScopeId>('data-scope', this.scope, SCOPES, (v) => {
        this.scope = v;
        void this.load();
      }),
      h(
        'select',
        { 'data-metric': '', onchange: (ev: Event) => { this.metric = (ev.target as HTMLSelectElement).value; void this.load(); } },
        METRICS.map(([v, label]) => h('option', { value: v, selected: v === this.metric }, label)),
      ),
    );
  }

  async load(): Promise<void> {
    replace(this.body, this.tabs(), h('p', { class: 'note' }, '読み込んでいます…'));
    try {
      const [r, rw] = await Promise.all([
        this.api.rankings<RankingResponse>(this.auth.token, { board: this.board, scope: this.scope, metric: this.metric, marketId: this.board === 'community' ? this.marketId : undefined }),
        this.api.rewards<{ rewards: { key: string; title: string; createdAt: number }[] }>(this.auth.token),
      ]);
      this.render(r, rw.rewards);
    } catch (e) {
      replace(this.body, this.tabs(), h('p', { class: 'note bad' }, errText(e)));
    }
  }

  private render(r: RankingResponse, rewards: { key: string; title: string }[]): void {
    const mine = r.mine[0];
    const head = h(
      'section',
      { class: 'card wide ranking-mine' },
      h('h4', null, `${r.metricLabel}・${SCOPES.find((x) => x[0] === r.scope)?.[1] ?? ''}（${r.scopeKey === 'T' ? '累計' : r.scopeKey.slice(1)}）`),
      mine
        ? h('p', { 'data-my-rank': String(mine.rank) }, h('b', null, `あなたの会社: ${mine.rank}位`), ` / ${r.total}社（${fmt(r.metric, mine.value, r.perDay)}・${moveText(mine).text === '初' ? '前の期間は記録なし' : `前の期間から ${moveText(mine).text}`}）`)
        : h('p', { class: 'note' }, 'この期間には、あなたの会社の確定した日がまだありません（0時の同期のあとに入ります）'),
      h('p', { class: 'note' }, r.perDay ? '全体ランキングは、コミュニティごとに進んだ日数が違うため、売上・利益はゲーム内の1日あたりで比べます。' : 'コミュニティ内は全社が同じ日数なので、期間の合計で比べます。総合評価は8つの種別の順位を同じ重みで平均したものです。'),
    );
    const table = h(
      'section',
      { class: 'card wide ranking-table' },
      r.rows.length === 0
        ? h('p', { class: 'note' }, 'まだ記録がありません')
        : h(
            'div',
            { class: 'table' },
            r.rows.map((x) => {
              const mv = moveText(x);
              return h(
                'div',
                { class: `trow${x.mine ? ' mine' : ''}`, 'data-rank-row': x.companyId },
                h('div', { class: 'rank' }, String(x.rank)),
                h('div', { class: 'tname' }, `${x.name}${x.mine ? '（あなた）' : ''}`, h('small', null, `${x.kind === 'ai' ? 'AI' : 'プレイヤー'}・${x.days}日${x.flaggedDays > 0 ? `（${x.flaggedDays}日は数えていません）` : ''}`)),
                h('div', { class: 'tsub' }, fmt(r.metric, x.value, r.perDay)),
                h('div', { class: `tsub move ${mv.cls}` }, mv.text),
              );
            }),
          ),
    );
    const titles = h(
      'section',
      { class: 'card wide ranking-rewards' },
      h('h4', null, '称号（報酬）'),
      rewards.length === 0 ? h('p', { class: 'note' }, 'まだありません。週・月・年の終わりに、総合評価の上位3社に称号が付きます。') : h('ul', null, rewards.map((x) => h('li', { 'data-reward': x.key }, x.title))),
    );
    replace(this.body, this.tabs(), head, table, titles);
  }
}
