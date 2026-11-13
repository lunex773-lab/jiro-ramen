// 共通市場の画面（docs/MARKET_RANKING_PLAN.md）。
// オーナーの判断: 各社は端末で1日ずつ営業してサーバーへ送り、JST の0時に、いちばん進んだ企業の日付まで全社を自動営業でそろえる。
// 市場用に新しく始める。招待コードで入る。AI で埋めるか・社数（2〜25。じろ2）・期間・企業の扱いは作る人が決める。
// この画面では、各社の進み具合・0時の同期の状態を見て、端末での営業を始める。営業していない間の経営（値段・人・出店）もここで決める。
// 画面は数秒ごとにサーバーから市場の今を読み直す（市場の権威はサーバー。操作は cid つきで送る）。

import {
  cleanStoreName,
  locationLabel,
  locationProblem,
  STORE_NAME_MAX,
  storeDisplayName,
  adBudgetOf,
  companyPolicyOf,
  tempHourly,
  type CompanyPolicy,
  adFactor,
  AI_STRATEGY_LABEL,
  BALANCE,
  expansionAdvice,
  expansionInfo,
  openStoreProblem,
  PROPERTIES,
  PROPERTY_CANDIDATES,
  ROLE_LABEL,
  STAGES,
  storeReport,
  storeStatus,
  totalDebt,
  type Action,
  type AiStrategy,
  type GameState,
  type MarketView,
  type StoreEntry,
  DEFAULT_HOURS,
  locationInfo,
  prefRangeProblem,
  rangeTitle,
  MARKET_SCOPE_LABEL,
  SETTINGS_LABEL,
  settingsText,
  type CreditOp,
  enterpriseValue,
} from '@jiro/core';
import type { App } from '../game/app';
import { Api, ApiError, defaultServerUrl, type Auth, type MyMarket } from '../net/api';
import { serverUrlNote } from './server-url';
import { openStoreMap } from './store-map';
import { hoursDialog, hoursSummary } from './hours-dialog';
import { confirmDialog, confirmNode, h, replace, stars, toast, yenStr } from './dom';
import { codeBlock } from './room-code';
import { cardHead, kpi, kpiRow, meterBar, yenSigned } from './kit';
import { loanControl, loanSummary } from './loan';
import { creditCard } from './market-credit';
import { forecastLines } from './site-lines';
import { storeDaysCard } from './store-days';

/** 市場の画面の上の数字のカード（値の要素に data 属性を付ける。E2E が読む） */
function stat(label: string, attrs: Record<string, string>, value: string, tone = ''): HTMLElement {
  return h('div', { class: `kpi${tone ? ` tone-${tone}` : ''}` }, h('span', { class: 'kpi-label' }, label), h('b', { class: 'kpi-value small', ...attrs }, value));
}

export type MarketScreenView = MarketView & {
  clock: { serverNow: number; nextMidnight: number; nextSyncAt: number | null; syncPending: boolean };
  code: string;
  isOwner: boolean;
  joined: boolean;
  today: string;
};

const PERIOD_LABEL = (d: number | null) => (d === null ? '無期限' : `${d}日`);

/** 市場の画面の上の切り替え（じろ6: 改修設計書06。1枚の長いページをやめる） */
type MarketSub = 'rank' | 'mine' | 'grow' | 'credit' | 'settings';
const MARKET_TABS: [MarketSub, string][] = [
  ['rank', '📊 順位'],
  ['mine', '🏢 自社'],
  ['grow', '🗾 出店と採用'],
  ['credit', '🤝 貸し借り'],
  ['settings', '⚙ 設定'],
];

/**
 * 市場の読み直しの間隔。画面が見えているときだけ読み直す（Free の要求数を使いすぎないため）。
 * 0時の計算中・0時の前後は短くして、計算が済んだらすぐ営業を始められるようにする
 */
const POLL_MS = 20_000;
const POLL_FAST_MS = 8_000;
const POLL_TICK_MS = 2_000;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function cid(): string {
  const r = (globalThis.crypto as Crypto | undefined)?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `c-${r}`.slice(0, 60);
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body as { message?: string } | null;
    return b?.message ?? e.message;
  }
  return (e as Error)?.message ?? String(e);
}

// ───────────────────────── 入口（作る・入る・一覧） ─────────────────────────

export function openMarketLobby(app: App, onBack: () => void): HTMLElement {
  const body = h('div', { class: 'lobby-body' });
  const el = h(
    'div',
    { class: 'screen lobby market-lobby' },
    h('div', { class: 'screen-inner' }, h('h2', null, 'オンライン市場（AI 企業と同じ街で競う）'), body, h('button', { class: 'btn ghost', onclick: onBack }, '← 戻る')),
  );
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  const company = h('input', { class: 'input', value: app.settings.playerName ? `${app.settings.playerName}の店` : '', placeholder: '会社（店）の名前', maxLength: 20 }) as HTMLInputElement;
  const marketName = h('input', { class: 'input', placeholder: '市場の名前（なくてもよい）', maxLength: 20 }) as HTMLInputElement;
  const codeInput = h('input', { class: 'input code', placeholder: '招待コード（6文字）', maxLength: 6 }) as HTMLInputElement;
  const sel = (attr: string, opts: [string, string][], value: string) =>
    h('select', { [attr]: '' }, opts.map(([v, label]) => h('option', { value: v, selected: v === value }, label))) as HTMLSelectElement;
  const aiFill = sel('data-ai-fill', [['1', 'AI 企業で埋める'], ['0', '人だけ（AI なし）']], '1');
  const maxCompanies = sel(
    'data-max-companies',
    Array.from({ length: BALANCE.market.maxCompanies - BALANCE.market.minCompanies + 1 }, (_, i) => {
      const n = BALANCE.market.minCompanies + i;
      return [String(n), `${n}社まで`] as [string, string];
    }),
    // 既定は6社（最大25社。じろ2）
    String(BALANCE.market.defaultCompanies),
  );
  const period = sel('data-period', [['30', '30日'], ['90', '90日'], ['180', '180日'], ['365', '365日'], ['', '無期限']], '');
  const entry = sel('data-entry', [['grown', '育てた企業で参加できる'], ['fresh', '新規の企業だけ']], 'grown');
  const visibility = sel('data-visibility', [['invite', '招待制'], ['public', '公開']], 'invite');
  // 市場の街（市場は1つの街。オーナーの判断）。選ばなければ指定なし（標準の数字）
  let cityCode: string | null = null;
  const cityLabel = h('b', { 'data-city-label': '' }, '指定なし');
  const cityBtn = h(
    'button',
    {
      class: 'btn ghost',
      'data-pick-city': '',
      onclick: () => {
        const map = openStoreMap(app.root, {
          title: '市場の街を選ぶ',
          mode: 'city',
          confirmLabel: 'この街にする',
          cityInfo: (code) => ({ lines: ['全社の店はこの街の駅前・住宅街・郊外にあります。人口で来客と家賃が少し変わります。'], problem: locationProblem(code) }),
          onPick: ({ code }) => {
            cityCode = code;
            cityLabel.textContent = locationLabel(code);
            map.close();
          },
          onClose: () => undefined,
        });
      },
    },
    '🗾 地図で選ぶ',
  );
  const status = h('div', { class: 'note', 'data-lobby-status': '' });
  const list = h('div', { class: 'table market-list' });
  const pubList = h('div', { class: 'table market-public', 'data-public-list': '' }, h('p', { class: 'note' }, '「公開のコミュニティを読み込む」で一覧が出ます'));
  // 参加する会社: 新しい会社か、終わった市場の自分の会社（育てた企業で参加できる市場へ持っていく。オーナーの判断 15）
  const bringSel = h('select', { 'data-bring': '' }, h('option', { value: '' }, '新しい会社で入る（上の名前）')) as HTMLSelectElement;
  const busy = (on: boolean, text = '') => {
    for (const b of Array.from(body.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = on;
    status.textContent = text;
  };
  const connect = async (): Promise<{ api: Api; auth: Auth } | null> => {
    const url = Api.normalize(defaultServerUrl());
    if (!url) {
      status.textContent = 'サーバーが設定されていません。設定の画面で URL を入れてください';
      return null;
    }
    const api = new Api(url);
    const auth = await api.auth(app.settings.playerName || 'プレイヤー');
    return { api, auth };
  };
  const open = (api: Api, auth: Auth, marketId: string) => app.showMarket(api, auth, marketId);
  const marketState = (m: MyMarket): string => {
    const parts: string[] = [];
    if (m.ended) parts.push('競争期間は終了（営業は続けられます）');
    else if (m.endsAt) parts.push(`${endText(m.endsAt)}まで`);
    if (m.companyStatus === 'moved') parts.push('会社は別のコミュニティへ移動済み');
    else if (m.companyStatus === 'retired') parts.push('会社は引退');
    else if (m.companyStatus === 'bankrupt') parts.push('破産');
    return parts.join('・');
  };
  const refreshList = async () => {
    try {
      const c = await connect();
      if (!c) return;
      const r = await c.api.listMarkets(c.auth.token);
      // 持っていける会社（終わった市場で営業している自分の会社）
      const movable = r.markets.filter((m) => m.ended && m.companyStatus === 'active' && m.companyId);
      const keep = bringSel.value;
      replace(
        bringSel,
        h('option', { value: '' }, '新しい会社で入る（上の名前）'),
        movable.map((m) => h('option', { value: `${m.marketId}|${m.companyId}`, selected: keep === `${m.marketId}|${m.companyId}` }, `${m.companyName ?? '会社'}を持っていく（${m.name}から）`)),
      );
      replace(
        list,
        r.markets.length === 0
          ? h('p', { class: 'note' }, '参加している市場はまだありません')
          : r.markets.map((m) =>
              h(
                'div',
                { class: `trow${m.ended ? ' ended' : ''}`, 'data-my-market': m.marketId },
                h('div', { class: 'tname' }, m.name, h('small', null, [`招待コード ${m.code}${m.isOwner ? '・あなたが作った市場' : ''}`, marketState(m)].filter(Boolean).join('・'))),
                h(
                  'div',
                  { class: 'row' },
                  h('button', { class: 'btn', 'data-open-market': m.marketId, onclick: () => open(c.api, c.auth, m.marketId) }, '開く'),
                  m.isOwner
                    ? h(
                        'button',
                        {
                          class: 'btn ghost danger',
                          'data-delete-market': m.marketId,
                          onclick: async () => {
                            if (await confirmDeleteMarket(app.root, m.name, m.otherCompanies ?? 0)) {
                              try {
                                await c.api.deleteMarket(c.auth.token, m.marketId);
                                toast(app.root, `「${m.name}」を消しました`, 'good', 2000);
                              } catch (e) {
                                toast(app.root, errText(e), 'warn');
                              }
                              void refreshList();
                            }
                          },
                        },
                        '消す',
                      )
                    : null,
                ),
              ),
            ),
      );
    } catch (e) {
      replace(list, h('p', { class: 'note bad' }, errText(e)));
    }
  };
  /** 招待コード・公開の市場に入る（持っていく会社を選んでいれば、その会社で） */
  const join = async (to: { code: string } | { marketId: string }) => {
    busy(true, '市場に入っています…');
    try {
      const c = await connect();
      if (!c) return;
      const [bm, bc] = bringSel.value ? bringSel.value.split('|') : [];
      if (bm && bc) {
        const ok = await confirmDialog(
          app.root,
          '育てた会社を持っていく',
          'お金・店・従業員・在庫・評判はそのままで、入る市場の日付に合わせて営業を続けます。\n元の市場では「移った」になり、営業できなくなります（記録は残ります）。',
          '持っていく',
        );
        if (!ok) return;
      }
      const r = await c.api.joinMarket(c.auth.token, to, company.value.trim(), bm && bc ? { marketId: bm, companyId: bc } : undefined);
      open(c.api, c.auth, r.marketId);
    } catch (e) {
      status.textContent = errText(e);
    } finally {
      busy(false, status.textContent ?? '');
    }
  };
  const refreshPublic = async () => {
    try {
      const c = await connect();
      if (!c) return;
      const r = await c.api.publicCommunities(c.auth.token);
      replace(
        pubList,
        r.communities.length === 0
          ? h('p', { class: 'note' }, '入れる公開のコミュニティはいまありません（自分で「公開」の市場を作れます）')
          : r.communities.map((m) =>
              h(
                'div',
                { class: 'trow', 'data-public': m.marketId },
                h(
                  'div',
                  { class: 'tname' },
                  m.name,
                  h(
                    'small',
                    null,
                    `${m.cityName ? `${m.cityName}・` : ''}${m.entry === 'fresh' ? '新規の企業だけ' : '育てた企業も参加できる'}・${m.players}人／${m.maxCompanies}社${m.aiFill ? '（空きは AI 企業）' : ''}・${m.endsAt ? `${endText(m.endsAt)}まで` : '無期限'}`,
                  ),
                  m.description ? h('small', null, m.description) : null,
                ),
                h('button', { class: 'btn', 'data-join-public': m.marketId, onclick: () => void join({ marketId: m.marketId }) }, '入る'),
              ),
            ),
      );
    } catch (e) {
      replace(pubList, h('p', { class: 'note bad' }, errText(e)));
    }
  };
  replace(
    body,
    serverUrlNote(() => app.showSettings(() => app.showMarketLobby())),
    h('p', { class: 'note' }, '各社は自分の端末で1日ずつ営業し、1日の終わりにサーバーへ送ります。毎日0時（日本時間）に、いちばん進んだ会社の日付まで、ほかの会社を自動営業でそろえます。'),
    // 並び（オーナーの指示）: 参加している市場 → 公開の市場（入る） → 市場を作る
    h('section', { class: 'card wide' }, h('h4', null, '参加している市場'), list, h('button', { class: 'btn ghost', onclick: () => void refreshList() }, '一覧を読み込む')),
    status,
    h('section', { class: 'card wide' }, h('h4', null, '公開のコミュニティ'), pubList, h('button', { class: 'btn ghost', 'data-load-public': '', onclick: () => void refreshPublic() }, '公開のコミュニティを読み込む')),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '参加する会社'),
      h('p', { class: 'note' }, '競争期間が終わった市場の会社は、「育てた企業も参加できる」市場へ持っていけます（お金・店・従業員はそのまま。入る市場の日付に合わせます）。'),
      h('div', { class: 'kv' }, h('span', null, '入る会社'), bringSel),
    ),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '招待コードで入る'),
      codeInput,
      h('button', { class: 'btn', 'data-join-market': '', onclick: () => void join({ code: codeInput.value }) }, '入る'),
    ),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '市場を作る'),
      h('p', { class: 'note' }, '全社が資金30万円・8席から。招待コードを配ると友達も入れます（AI で埋めた市場では、入るたびに AI が1社抜けます）。'),
      company,
      marketName,
      h('div', { class: 'kv' }, h('span', null, '空いた枠'), aiFill),
      h('div', { class: 'kv' }, h('span', null, '参加企業数'), maxCompanies),
      h('div', { class: 'kv' }, h('span', null, '競争期間'), period),
      h('div', { class: 'kv' }, h('span', null, '参加できる企業'), entry),
      h('div', { class: 'kv' }, h('span', null, '参加の方法'), visibility),
      h('div', { class: 'kv' }, h('span', null, '市場の街'), h('div', { class: 'row' }, cityLabel, cityBtn)),
      h(
        'button',
        {
          class: 'btn primary big',
          'data-create-market': '',
          onclick: async () => {
            busy(true, '市場を作っています…');
            try {
              const c = await connect();
              if (!c) return;
              const r = await c.api.createMarket(c.auth.token, marketName.value.trim(), company.value.trim(), {
                aiFill: aiFill.value === '1',
                maxCompanies: Number(maxCompanies.value),
                periodDays: period.value === '' ? null : Number(period.value),
                entry: entry.value,
                visibility: visibility.value,
                ...(cityCode ? { cityCode } : {}),
              });
              open(c.api, c.auth, r.marketId);
            } catch (e) {
              status.textContent = errText(e);
            } finally {
              busy(false, status.textContent ?? '');
            }
          },
        },
        '市場を作る',
      ),
    ),
  );
  if (defaultServerUrl()) {
    void refreshList();
    void refreshPublic();
  }
  return el;
}

/** 市場を消す前の確認（消すと元に戻せない。ほかの人の会社も消える。オーナーの判断） */
function confirmDeleteMarket(root: HTMLElement, name: string, others: number): Promise<boolean> {
  return confirmDialog(
    root,
    '市場を消す',
    `「${name}」を消します。\nこの市場の会社・店・お金・記録がすべて消え、元に戻せません。${others > 0 ? `\nほかのプレイヤーの会社 ${others}社も消えます。` : ''}\n受け取った称号は残ります。`,
    '消す',
    true,
  );
}

/** 自動営業の実行状況（仕様書 8.1）: 同期の最中ならその段階、なければ前回の結果 */
function autoStatusText(v: MarketScreenView): string {
  const run = v.sync;
  if (run) {
    if (run.status === 'closing') return `営業中の日が届くのを待っています（${new Date(run.closeDeadline).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })}まで）`;
    if (run.status === 'syncing') return `自動営業でそろえています（${run.targetDate ?? 0}日目まで・${run.autoDays}社日済み）`;
    return '集計を書いています';
  }
  const last = v.lastSync;
  if (!last) return 'まだありません';
  return `前回（${Number(last.periodId.slice(5, 7))}/${Number(last.periodId.slice(8, 10))}の分）: ${last.targetDate ?? 0}日目までそろえた・自動営業 ${last.autoDays}社日`;
}

/** 競争期間の終わり（JST の日付。その日の0時に終わる） */
function endText(endsAt: number): string {
  return `${new Date(endsAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })} 0時`;
}

// ───────────────────────── 市場の画面 ─────────────────────────

export class MarketScreen {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private view: MarketScreenView | null = null;
  private offset = 0;
  private timer: number | null = null;
  private clockTimer: number | null = null;
  private pressing = false;
  private loading = false;
  /** 上の切り替えで選んでいるもの */
  private sub: MarketSub = 'rank';

  constructor(
    private root: HTMLElement,
    private api: Api,
    private auth: Auth,
    private marketId: string,
    private onBack: () => void,
    private onPlay: () => void,
    private onRanking: () => void = () => undefined,
  ) {
    this.head = h('div', { class: 'market-head' });
    this.body = h('div', { class: 'market-body' });
    this.el = h('div', { class: 'screen market' }, h('div', { class: 'screen-inner wide' }, this.head, this.body, h('button', { class: 'btn ghost', onclick: () => this.close() }, '← 市場から出る')));
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.pressing = true;
    });
    window.addEventListener('pointerup', this.release);
    replace(this.body, h('p', { class: 'note' }, '市場を読み込んでいます…'));
    void this.refresh();
    this.timer = window.setInterval(() => this.poll(), POLL_TICK_MS);
    document.addEventListener('visibilitychange', this.onVisible);
    this.clockTimer = window.setInterval(() => this.tickClock(), 1000);
  }

  private release = (): void => {
    this.pressing = false;
  };

  private lastFetch = 0;

  /** 見えているときだけ、間隔が来たら読み直す */
  private poll(): void {
    if (document.hidden) return;
    const v = this.view;
    const now = Date.now() + this.offset;
    // 0時の直前・計算中（0時を過ぎて同期が残っている間）は短く
    const fast = !!v && (v.clock.syncPending || !!v.sync || v.clock.nextMidnight - now < 60_000);
    if (Date.now() - this.lastFetch >= (fast ? POLL_FAST_MS : POLL_MS)) void this.refresh(true);
  }

  /** 画面に戻ってきたら、すぐ読み直す */
  private onVisible = (): void => {
    if (!document.hidden && Date.now() - this.lastFetch >= POLL_FAST_MS) void this.refresh(true);
  };

  /** 読み直しをやめる（営業を始めるとき・画面を閉じるとき） */
  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    this.timer = null;
    this.clockTimer = null;
    window.removeEventListener('pointerup', this.release);
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  close(): void {
    this.stop();
    this.el.remove();
    this.onBack();
  }

  async refresh(auto = false): Promise<void> {
    if (this.loading) return;
    // 選んでいる最中は描き直さない（自動の読み直しのとき）
    if (auto && (this.pressing || (this.el.contains(document.activeElement) && (document.activeElement?.tagName === 'SELECT' || document.activeElement?.tagName === 'INPUT')))) return;
    this.loading = true;
    this.lastFetch = Date.now();
    try {
      const v = await this.api.viewMarket<MarketScreenView>(this.auth.token, this.marketId);
      this.offset = v.clock.serverNow - Date.now();
      this.view = v;
      this.render();
    } catch (e) {
      if (!auto) replace(this.body, h('p', { class: 'note bad' }, errText(e)));
    } finally {
      this.loading = false;
    }
  }

  /** 送っている最中の操作（同じ操作を二重に送らない。じろ6） */
  private inFlight = new Set<string>();

  /** 同じ操作を続けて押しても1回だけ送る。送っている間は画面を少し薄くする */
  private async once(key: string, run: () => Promise<void>): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.body.classList.add('busy');
    try {
      await run();
    } finally {
      this.inFlight.delete(key);
      if (this.inFlight.size === 0) this.body.classList.remove('busy');
    }
  }

  private async act(a: Action, okMsg?: string): Promise<void> {
    await this.once(`act:${JSON.stringify(a)}`, async () => {
      try {
        const r = await this.api.actMarket(this.auth.token, this.marketId, cid(), a);
        if (!r.ok) toast(this.root, `${r.reason ?? 'できませんでした'}`, 'warn', 4000);
        else if (okMsg) toast(this.root, okMsg, 'good', 1800);
      } catch (e) {
        toast(this.root, `送れませんでした: ${errText(e)}（通信を確かめて、もう一度押してください）`, 'warn', 5000);
      }
      await this.refresh();
    });
  }

  /** 同期の欄の文（次の0時までの時間など） */
  private syncText(v: MarketScreenView): string {
    const now = Date.now() + this.offset;
    const left = Math.max(0, Math.ceil((v.clock.nextMidnight - now) / 1000));
    const hh = Math.floor(left / 3600);
    const mm = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    return v.ended
      ? '競争期間は終わりました（0時の同期・ランキングはありません）'
      : v.clock.syncPending
        ? '0時の計算中（終わるまで新しい日は始められません）'
        : `次の0時まで ${hh}時間${mm}分`;
  }

  /** 1秒ごと: 時計の文だけ書き換える（見出し全体を作り直すと、押そうとしたボタンが入れ替わってしまう） */
  private tickClock(): void {
    const v = this.view;
    if (!v) return;
    const el = this.head.querySelector<HTMLElement>('[data-sync]');
    const t = this.syncText(v);
    if (el && el.textContent !== t) el.textContent = t;
  }

  private renderHead(): void {
    const v = this.view;
    if (!v) return;
    const mine = v.mine;
    const playing = !!mine?.openDay;
    const bankrupt = mine ? mine.state.phase === 'bankrupt' : true;
    const myDay = mine ? mine.progress.lastProcessedGameDate + 1 : 0;
    const syncText = this.syncText(v);
    // じろ6: 先頭に自分の順位・シェア・売上・企業価値（どの切り替えでも見える）。同期の様子は小さく1行に
    const myIdx = v.companies.findIndex((c) => c.mine);
    const me = myIdx >= 0 ? v.companies[myIdx]! : null;
    const alive = v.companies.filter((c) => !c.bankrupt).length;
    const rankIn = (rep: (typeof v.history)[number] | undefined) => {
      if (!rep || !mine) return -1;
      return [...rep.companies].filter((c) => !c.bankrupt).sort((a, b) => b.share - a.share).findIndex((c) => c.id === mine.companyId);
    };
    const cur = rankIn(v.history.at(-1));
    const prev = rankIn(v.history.at(-2));
    const move = cur >= 0 && prev >= 0 ? prev - cur : null;
    const lastEvent = v.decisions.at(-1) ?? null;
    const names = new Map(v.companies.map((c) => [c.id, c.name]));
    replace(
      this.head,
      h(
        'div',
        { class: 'market-title' },
        h('h2', null, v.name),
        h('div', { class: 'market-code' }, h('span', { class: 'note' }, '招待コード'), codeBlock(this.root, v.code)),
        h(
          'button',
          {
            class: 'btn',
            'data-open-ranking': '',
            onclick: () => {
              this.stop();
              this.onRanking();
            },
          },
          '🏆 全国の順位',
        ),
        // いちばん押してほしいボタン（黄色）は見出しの行の右に
        mine
          ? h(
              'button',
              {
                class: 'btn primary big',
                'data-market-play': '',
                disabled: bankrupt || v.clock.syncPending,
                onclick: () => {
                  this.stop();
                  this.onPlay();
                },
              },
              bankrupt ? '破産しています' : playing ? `${myDay}日目の営業を続ける（初めから）` : `${myDay}日目を営業する`,
            )
          : null,
      ),
      me && mine
        ? kpiRow(
            [
              kpi('順位（この市場）', me.bankrupt ? '—' : `${myIdx + 1}位 / ${alive}社`, move === null ? '前日との比較はまだありません' : move > 0 ? `前日から ▲${move}` : move < 0 ? `前日から ▼${-move}` : '前日と同じ', 'accent', move !== null && move > 0 ? 'good' : move !== null && move < 0 ? 'bad' : '', { 'data-my-market-rank': String(myIdx + 1) }),
              kpi('シェア', pct(me.share), `直近${BALANCE.market.shareDays}日の純売上の割合`),
              kpi('売上', v.commonMarketDate > 0 ? yenStr(me.netSales) : '—', v.commonMarketDate > 0 ? `${v.commonMarketDate}日目・営業利益 ${yenSigned(me.operatingProfit, true)}` : 'まだ全社がそろった日がありません', '', me.operatingProfit < 0 ? 'bad' : ''),
              kpi('企業価値', yenSigned(enterpriseValue(mine.state)), '現金＋設備＋在庫−借入（純資産）'),
            ],
            'market-my-kpis',
          )
        : null,
      h(
        'div',
        { class: 'market-status' },
        stat('全社が営業済み', { 'data-market-day': String(v.commonMarketDate) }, v.commonMarketDate === 0 ? 'まだ0日' : `${v.commonMarketDate}日目まで`),
        stat('いちばん進んだ会社', { 'data-leader-day': String(v.leaderDay) }, `${v.leaderDay}日目まで`),
        stat('同期', { 'data-sync': v.ended ? 'ended' : v.clock.syncPending ? 'pending' : 'idle' }, syncText, v.clock.syncPending ? 'warn' : ''),
        stat('自動営業', { 'data-auto-status': v.sync ? v.sync.status : 'idle' }, autoStatusText(v)),
      ),
      lastEvent ? h('p', { class: 'note market-event', 'data-market-event': '' }, `📣 市場の出来事（${lastEvent.day}日目）: ${names.get(lastEvent.companyId) ?? ''} ${lastEvent.text}`) : null,
      v.ended
        ? h(
            'p',
            { class: 'note warn', 'data-market-ended': '' },
            '🏁 この市場の競争期間は終わりました。営業は続けられます（ほかの会社とは同期しません）。上位3社には大会の称号が届きます。会社は「育てた企業も参加できる」別のコミュニティへ持っていけます（入口の「参加する会社」で選びます）。',
          )
        : null,
      !mine && v.myStatus === 'moved' ? h('p', { class: 'note', 'data-my-status': 'moved' }, 'あなたの会社は別のコミュニティへ移りました（この市場の記録は残ります）') : null,
      !mine && v.myStatus === 'retired' ? h('p', { class: 'note', 'data-my-status': 'retired' }, 'あなたの会社は引退しました（この市場の記録は残ります）') : null,
      playing
        ? h('p', { class: 'note', 'data-playing-note': '' }, `端末で${myDay}日目を営業中です。この画面で変えたこと（値段・人・出店・融資など）は、営業を続けるときに入ります（その日は初めからやり直します）。`)
        : null,
      mine
        ? h(
            'p',
            { class: 'note' },
            v.ended
              ? `あなたの会社は ${mine.progress.lastProcessedGameDate}日目まで営業済み。`
              : `あなたの会社は ${mine.progress.lastProcessedGameDate}日目まで営業済み（今日 手動で ${mine.progress.manualProgressDays}日）。0時に、遅れている会社は自動営業で ${v.leaderDay}日目までそろいます。`,
          )
        : null,
      h(
        'div',
        { class: 'market-tabs', role: 'tablist', 'aria-label': '市場の画面の切り替え' },
        MARKET_TABS.map(([id, label]) =>
          h(
            'button',
            {
              class: `mtab${this.sub === id ? ' on' : ''}`,
              role: 'tab',
              'aria-selected': String(this.sub === id),
              'data-market-tab': id,
              onclick: () => {
                this.sub = id;
                this.render();
                this.el.querySelector('.screen-inner')?.scrollTo({ top: 0 });
              },
            },
            label,
          ),
        ),
      ),
    );
  }

  render(): void {
    const v = this.view;
    if (!v) return;
    this.renderHead();
    const scroll = this.body.scrollTop;
    const bankrupt = !v.mine || v.mine.state.phase === 'bankrupt';
    const content: (HTMLElement | null)[] =
      this.sub === 'rank'
        ? [this.standings(v), this.decisions(v), this.history(v)]
        : this.sub === 'mine'
          ? this.mineCards(v)
          : this.sub === 'grow'
            ? v.mine
              ? [this.rangeCard(v), this.growth(v.mine.state, v), this.hiring(v.mine.state)]
              : [h('section', { class: 'card wide' }, h('p', { class: 'note' }, 'この市場に企業がありません'))]
            : this.sub === 'credit'
              ? [bankrupt ? h('section', { class: 'card wide' }, h('p', { class: 'note' }, '企業間の貸し借りは、市場で営業している会社だけができます')) : creditCard(this.root, v, { op: (op, okMsg) => this.credit(op, okMsg) })]
              : this.settingsCards(v);
    replace(this.body, h('div', { class: 'grid2', 'data-market-sub': this.sub }, content));
    this.body.scrollTop = scroll;
  }

  private standings(v: MarketScreenView): HTMLElement {
    return h(
      'section',
      { class: 'card wide market-standings' },
      cardHead('企業の順位（市場シェア）', `市場シェア = 全社がそろった日までの直近${BALANCE.market.shareDays}日の純売上の割合。右の数字は全社がそろった日の純売上と営業利益です。同じ市区町村・同じ場所の店どうしで客を取り合います（安い店・評判の良い店ほど客が来る）。`),
      h(
        'div',
        { class: 'table' },
        v.companies.map((c, i) =>
          h(
            'div',
            { class: `trow${c.mine ? ' mine' : ''}${c.bankrupt ? ' gone' : ''}`, 'data-company': c.id },
            h('div', { class: 'rank' }, c.bankrupt ? '—' : String(i + 1)),
            h(
              'div',
              { class: 'tname' },
              `${c.name}${c.mine ? '（あなた）' : ''}`,
              h('small', null, `${c.kind === 'ai' ? `AI・${AI_STRATEGY_LABEL[(c.strategy ?? 'standard') as AiStrategy] ?? ''}` : 'プレイヤー'}・${c.stores.map((s) => `${s.area}${s.seats}席★${s.reputation.toFixed(1)}`).join('／')}${c.bankrupt ? '・撤退' : ''}`),
            ),
            h('div', { class: 'tsub share-cell' }, meterBar(c.share, c.mine ? 'accent' : c.kind === 'ai' ? 'info' : 'good', `シェア ${pct(c.share)}`), h('span', null, `シェア ${pct(c.share)}`)),
            h('div', { class: 'tsub', 'data-progress': String(c.lastDay) }, `${c.lastDay}日目まで${c.manualDays > 0 ? `（今日 手動${c.manualDays}日）` : ''}${c.playing ? '・営業中' : ''}`),
            h(
              'div',
              { class: 'tsub' },
              v.commonMarketDate > 0 ? `${v.commonMarketDate}日目 ${yenStr(c.netSales)}` : '—',
              v.commonMarketDate > 0 ? h('b', { class: c.operatingProfit < 0 ? 'tone-bad' : c.operatingProfit > 0 ? 'tone-good' : '' }, ` ${yenSigned(c.operatingProfit, true)}`) : null,
            ),
          ),
        ),
      ),
      h('p', { class: 'note' }, `市場の街の出店先の空き: ${PROPERTY_CANDIDATES.map((p) => `${PROPERTIES[p]!.area} ${v.freeSlots[p] ?? 0}件`).join('・')}`),
    );
  }

  /** 競争の記録（仕様書 8.4）: 0時の同期ごとに、どの日付まで全社をそろえ、何日分を自動営業したか */
  private history(v: MarketScreenView): HTMLElement {
    const log = v.syncLog ?? [];
    return h(
      'section',
      { class: 'card wide market-history', 'data-history': '' },
      cardHead('競争の記録（0時の同期）', '0時の同期ごとに、どの日付まで全社をそろえ、遅れていた会社の何日分を自動営業したかの記録です。'),
      h(
        'p',
        { class: 'note' },
        `競争の開始 ${new Date(v.settings.startsAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })}・${v.settings.endsAt ? `終わり ${endText(v.settings.endsAt)}` : '無期限'}${v.ended ? '（終わりました。ランキングの「累計」が大会の結果です）' : ''}`,
      ),
      log.length === 0
        ? h('p', { class: 'note' }, 'まだ同期はありません（誰かが営業した日の次の0時に同期します）')
        : h(
            'div',
            { class: 'table' },
            log.map((r) =>
              h(
                'div',
                { class: 'trow', 'data-sync-run': r.periodId },
                h('div', { class: 'tsub' }, `${Number(r.periodId.slice(5, 7))}/${Number(r.periodId.slice(8, 10))}の分`),
                h('div', { class: 'tname' }, `${r.targetDate ?? 0}日目まで全社をそろえた`),
                h('div', { class: 'tsub' }, `自動営業 ${r.autoDays}社日${r.expiredDays > 0 ? `・届かず無効 ${r.expiredDays}日` : ''}`),
              ),
            ),
          ),
    );
  }

  private decisions(v: MarketScreenView): HTMLElement {
    const names = new Map(v.companies.map((c) => [c.id, c.name]));
    return h(
      'section',
      { class: 'card wide market-log' },
      cardHead('市場の出来事', 'AI 企業の出店・値下げ・採用などの判断と、その理由です（新しい順）。'),
      h('div', { class: 'table' }, [...v.decisions].reverse().slice(0, 24).map((d) => h('div', { class: 'trow' }, h('div', { class: 'tsub' }, `${d.day}日目`), h('div', { class: 'tname' }, h('small', null, names.get(d.companyId) ?? ''), d.text)))),
    );
  }

  /** 自社: お金（借入の内訳・融資）・店・自動経営の方針・店ごとの設定 */
  private mineCards(v: MarketScreenView): (HTMLElement | null)[] {
    if (!v.mine) return [h('section', { class: 'card wide' }, h('p', { class: 'note' }, 'この市場に企業がありません'))];
    const s = v.mine.state;
    const last = s.company.history[s.company.history.length - 1] ?? null;
    const bankrupt = s.phase === 'bankrupt';
    const finance = h(
      'section',
      { class: 'card market-mine' },
      h('h4', null, `あなたの会社: ${s.shopName}`),
      bankrupt ? null : this.renameRow('屋号', s.shopName, 'data-rename-shop', '', (v) => void this.act({ type: 'rename', name: v }, `店名を「${v}」にしました`)),
      kpiRow([
        kpi('現金', yenSigned(s.money), null, s.money < 50_000 ? 'bad' : ''),
        kpi('返済の残り（借入・未払金）', yenSigned(totalDebt(s)), `借入の総額 ${yenStr(s.loans.reduce((a, l) => a + l.principal, 0))}`, totalDebt(s) > 0 ? 'warn' : ''),
        last ? kpi(`${last.day}日目の営業利益（全店）`, yenSigned(last.operatingProfit, true), `純売上 ${yenSigned(last.netSales)}`, last.operatingProfit < 0 ? 'bad' : 'good') : null,
        kpi('評判（本店）', `★ ${s.reputation.toFixed(2)}`, stars(s.reputation), 'accent'),
      ]),
      // あなたの店（店ごとの最後の日の売上と営業利益。色の点で黒字・赤字。オーナーの指示 2026-11-12「どの店舗がどれだけ売り上げたか」）
      h('div', { class: 'store-line store-line-head' }, h('span', { class: 'dot' }), h('span', { class: 'store-line-name' }, '店（席・運営）'), h('span', { class: 'store-line-sales' }, '売上'), h('b', null, '営業利益')),
      h(
        'div',
        { class: 'store-list', 'data-store-list': '' },
        s.company.stores.map((entry) => {
          const day = v.mine!.progress.lastProcessedGameDate;
          const r = day > 0 ? storeReport(s, entry, day) : null;
          const stt = storeStatus(s, entry);
          const lead = entry.managerId ? stt.employees.find((e) => e.id === entry.managerId) : null;
          const deputy = !lead && stt.employees.some((e) => e.profile.role === 'leader');
          const who = lead ? '店長' : s.company.ownerStoreId === entry.id ? '店主' : deputy ? '店長代理' : '店長なし';
          const op = r ? r.operatingProfit : null;
          return h(
            'div',
            { class: 'store-line' },
            h('span', { class: `dot ${op === null ? '' : op < 0 ? 'bad' : 'good'}` }),
            h('span', { class: 'store-line-name' }, `${storeDisplayName(s, entry)}（${STAGES[stt.stage]?.seats.length ?? 8}席・${who}）`),
            h('span', { class: 'store-line-sales', 'data-store-line-sales': entry.id }, r ? yenStr(r.netSales ?? r.sales - r.refunds) : '—'),
            h('b', { class: op === null ? '' : op < 0 ? 'tone-bad' : 'tone-good' }, op === null ? '—' : yenSigned(op, true)),
          );
        }),
      ),
      bankrupt ? h('p', { class: 'note bad' }, '破産しました。市場から消えています') : null,
      h('h5', null, '🏦 銀行の借入'),
      loanSummary(s),
      !bankrupt ? loanControl(this.root, s, (amount) => this.act({ type: 'takeLoan', amount }, '融資を受けました')) : null,
    );
    const stores = s.company.stores.map((entry) => this.storeCard(s, entry, v.mine!.progress.lastProcessedGameDate));
    return [finance, storeDaysCard(s), this.autoPolicy(s), ...stores];
  }

  /** 設定: この市場の決まり・設定の変更の記録・市場の設定を変える／消す（作った人）・市場を抜ける（危ない操作は奥に） */
  private settingsCards(v: MarketScreenView): (HTMLElement | null)[] {
    const row = (k: string, val: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, val));
    const st = v.settings;
    const bankrupt = !v.mine || v.mine.state.phase === 'bankrupt';
    const rules = h(
      'section',
      { class: 'card market-rules' },
      h('h4', null, 'この市場の決まり'),
      st.description ? h('p', { class: 'note', 'data-description': '' }, st.description) : null,
      row('街', st.cityCode ? `${locationLabel(st.cityCode)}（全社の店はこの街。人口で来客と家賃が少し変わる）` : '指定なし（標準の数字）'),
      row('参加企業数', `${st.maxCompanies}社まで${st.aiFill ? '（空いた枠は AI 企業）' : '（人だけ）'}`),
      row('競争期間', st.endsAt ? `${PERIOD_LABEL(st.periodDays)}（${new Date(st.endsAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' })} 0時まで）` : PERIOD_LABEL(st.periodDays)),
      row('参加できる企業', st.entry === 'fresh' ? '新規の企業だけ' : '育てた企業も参加できる'),
      row('参加の方法', st.visibility === 'public' ? '公開（一覧から誰でも）' : '招待コード'),
      row('終わったあと', 'この市場で営業を続けられる（同期・順位なし）／別のコミュニティへ移せる／上位3社に称号'),
      h('p', { class: 'note' }, '営業していない間の経営（値段・人・出店）は、この画面で決められます。拡張の工事は、営業の画面で閉店後に決めます。'),
      v.isOwner ? h('button', { class: 'btn ghost', 'data-edit-market': '', onclick: () => void this.editSettings(v) }, '⚙ 市場の設定を変える') : null,
    );
    // 危ない操作（市場を抜ける・市場を消す）は、いちばん下にまとめて、必ず確認を出す
    const danger = h(
      'section',
      { class: 'card market-danger', 'data-market-danger': '' },
      h('h4', null, '⚠ 取り消せない操作'),
      v.mine ? h('p', { class: 'note' }, '市場を抜けると、この市場ではもう営業できません（記録と順位は残ります）。') : null,
      v.mine ? h('button', { class: 'btn ghost danger', 'data-retire': '', onclick: () => void this.retire(bankrupt, !!v.ended) }, bankrupt || v.ended ? '会社を引退させる' : '市場を抜ける（引退）') : null,
      v.isOwner ? h('p', { class: 'note' }, '市場を消すと、この市場の会社・店・お金・記録がすべて消えます。') : null,
      v.isOwner ? h('button', { class: 'btn ghost danger', 'data-delete-this-market': '', onclick: () => void this.deleteMarket(v) }, '🗑 この市場を消す') : null,
    );
    return [rules, this.settingsLog(v), v.mine || v.isOwner ? danger : null];
  }

  /** 企業間の貸し借りの操作（同じ操作の ID は一度だけ） */
  private async credit(op: CreditOp, okMsg: string): Promise<void> {
    await this.once(`credit:${JSON.stringify(op)}`, async () => {
      try {
        const r = await this.api.creditMarket(this.auth.token, this.marketId, cid(), op);
        if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn', 4000);
        else toast(this.root, okMsg, 'good', 1800);
      } catch (e) {
        toast(this.root, `送れませんでした: ${errText(e)}（通信を確かめて、もう一度押してください）`, 'warn', 5000);
      }
      await this.refresh();
    });
  }

  /** 市場の設定の変更の記録（いつ・誰が・何を。新しい順） */
  private settingsLog(v: MarketScreenView): HTMLElement | null {
    const log = v.settingsLog ?? [];
    if (log.length === 0) return null;
    return h(
      'details',
      { class: 'card market-settings-log', 'data-settings-log': '' },
      h('summary', null, `市場の設定の変更の記録（${log.length}件）`),
      h(
        'ul',
        null,
        log.slice(0, 20).map((e) =>
          h(
            'li',
            null,
            `${new Date(e.at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}・作った人（${e.by.slice(0, 8)}）・市場の${e.day}日目: `,
            e.changes.map((c) => `${SETTINGS_LABEL[c.key] ?? c.key} ${c.from} → ${c.to}`).join('／'),
          ),
        ),
      ),
    );
  }

  /**
   * 出店の範囲（じろ1 Q13）: 市場の街 → 同じ都道府県 → 同じ地方 → 全国。今の範囲と、次の範囲へ広がる条件の様子
   */
  private rangeCard(v: MarketScreenView): HTMLElement | null {
    const r = v.mine?.range;
    if (!r) return null;
    return h(
      'section',
      { class: 'card market-range', 'data-market-range': r.scope },
      h('h4', null, `🗾 出店の範囲: ${MARKET_SCOPE_LABEL[r.scope]}`),
      r.next
        ? h(
            'div',
            null,
            h('p', { class: 'note' }, `次は「${MARKET_SCOPE_LABEL[r.next]}」${r.either ? '（上の2つ、または一番下を満たすと広がる）' : '（全部を満たすと広がる）'}`),
            h('ul', { class: 'range-checks' }, r.checks.map((c) => h('li', { class: c.ok ? 'ok' : 'ng', 'data-range-check': c.key }, `${c.ok ? '✓' : '・'} ${c.label}`))),
          )
        : h('p', { class: 'note' }, '全国に出店できます'),
      h('p', { class: 'note' }, '市場の街の外は、同じ市区町村の店どうしで客を取り合います。広がった範囲は戻りません（AI 企業は市場の街だけ）'),
    );
  }

  /**
   * 地図で出店先を選ぶ。市場の店も、ひとりの経営と同じ範囲（本店 = 市場の街から。2〜5店目は同じ都道府県…）に出せる（じろ1 Q11）。
   * 物件は市区町村ごとに全社で取り合い、客の取り合いも同じ市区町村の店どうし
   */
  private openCityMap(s: GameState, v: MarketScreenView): void {
    const city = v.settings.cityCode;
    if (!city) return;
    const homeFull = s.employees.filter((e) => e.profile.employment === 'full');
    let managerId = homeFull[0]?.id ?? '';
    const used = (code: string, pid: string) => (v.sites ?? []).filter((x) => x.location === code && x.propertyId === pid).length;
    const map = openStoreMap(this.root, {
      title: `出店先を選ぶ（${rangeTitle(s)}）`,
      mode: 'site',
      // 市場の街を開いた状態で始める（ほかの市区町村へも移れる）
      startAt: city,
      confirmLabel: 'ここに出店する',
      rangeProblem: (pref) => prefRangeProblem(s, pref),
      siteInfo: (code, pid) => {
        const p = PROPERTIES[pid]!;
        const free = Math.max(0, (BALANCE.market.branchSlots[pid] ?? 0) - used(code, pid));
        const has = s.company.stores.some((x) => x.propertyId === pid && (x.location ?? city) === code);
        const l = locationInfo(code);
        const rent = Math.round((STAGES[p.stage]?.rent ?? 0) * p.rentMult * (l?.rent ?? 1));
        return {
          lines: [
            `空き ${free}件・初期費用 ${yenStr(p.initialCost)}・家賃 ${yenStr(rent)}/日・準備 ${p.openingDays}日${code === city ? '' : '（市場の街の外: この市区町村の店どうしで客を取り合う）'}`,
            // 見込み（全社の店の場所で競合を数える。自分の店も v.sites に入っている）
            ...forecastLines(s, code, pid, v.sites ?? [], false),
          ],
          problem: has
            ? 'この場所のこの物件にはもう出店しています'
            : free <= 0
              ? '物件が空いていません（ほかの企業が出店しています）'
              : !managerId
                ? '店長にする社員がいません'
                : (locationProblem(code) ?? openStoreProblem(s, pid, managerId, code)),
        };
      },
      extra: () =>
        homeFull.length > 0
          ? h(
              'div',
              { class: 'kv' },
              h('span', null, '店長'),
              h('select', { 'data-open-mgr': '', onchange: (ev: Event) => (managerId = (ev.target as HTMLSelectElement).value) }, homeFull.map((e) => h('option', { value: e.id, selected: e.id === managerId }, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`))),
            )
          : null,
      onPick: async ({ code, propertyId }) => {
        if (!propertyId) return;
        const p = PROPERTIES[propertyId]!;
        if (!(await confirmDialog(this.root, '出店', `${locationLabel(code)}の${p.area}（${p.name}）に出店します。初期費用 ${yenStr(p.initialCost)}。`, '出店する'))) return;
        map.close();
        await this.act({ type: 'openStore', propertyId, managerId, location: code }, '出店しました');
      },
      // 閉じただけなら何も変わっていないので読み直さない（出店したときは出店の操作のあとで読み直す）
      onClose: () => undefined,
    });
  }

  /**
   * 市場の設定を変える（作った人だけ。オーナーの指示）。名前・説明・公開・AI で埋めるか・会社の数の上限。
   * 期間・街・参加の種類は途中で変えない（公平のため）
   */
  private async editSettings(v: MarketScreenView): Promise<void> {
    const humans = v.companies.filter((c) => c.kind === 'player' && c.status === 'active').length;
    const name = h('input', { class: 'input', value: v.name, maxLength: 20, 'data-edit-name': '' }) as HTMLInputElement;
    const desc = h('textarea', { class: 'input', rows: 2, maxLength: 200, 'data-edit-desc': '' }) as HTMLTextAreaElement;
    desc.value = v.settings.description ?? '';
    const sel = (attr: string, opts: [string, string][], value: string) =>
      h('select', { class: 'select', [attr]: '' }, opts.map(([val, label]) => h('option', { value: val, selected: val === value }, label))) as HTMLSelectElement;
    const vis = sel('data-edit-visibility', [['invite', '招待コードだけ'], ['public', '公開（一覧に出す）']], v.settings.visibility);
    const ai = sel('data-edit-ai', [['1', '空きは AI 企業で埋める'], ['0', '人だけ（AI なし）']], v.settings.aiFill ? '1' : '0');
    const opts: [string, string][] = [];
    for (let n = Math.max(BALANCE.market.minCompanies, humans); n <= BALANCE.market.maxCompanies; n++) opts.push([String(n), `${n}社まで`]);
    const max = sel('data-edit-max', opts, String(Math.max(v.settings.maxCompanies, humans)));
    const body = h(
      'div',
      { class: 'edit-market' },
      h('label', null, '市場の名前', name),
      h('label', null, '説明', desc),
      h('label', null, '公開', vis),
      h('label', null, 'AI 企業', ai),
      h('label', null, '会社の数の上限', max),
      h('p', { class: 'note' }, `上限はプレイヤーの会社の数（今 ${humans}社）より少なくできません。上限を下げると、市場シェアの小さい AI 企業から撤退します。期間・街・参加の種類は途中では変えられません。`),
    );
    if (!(await confirmNode(this.root, '市場の設定', body, '次へ'))) return;
    const patch = {
      name: name.value.trim(),
      description: desc.value,
      visibility: (vis.value === 'public' ? 'public' : 'invite') as 'public' | 'invite',
      aiFill: ai.value === '1',
      maxCompanies: Number(max.value),
    };
    // 変える内容を確かめてから送る（じろ2: 変更の確認）
    const before = settingsText(v);
    const after = settingsText({ name: patch.name, settings: { ...v.settings, description: patch.description.trim(), visibility: patch.visibility, aiFill: patch.aiFill, maxCompanies: patch.maxCompanies } });
    const diff = Object.keys(after).filter((k) => after[k] !== before[k]);
    if (diff.length === 0) {
      toast(this.root, '変わった設定はありません', 'info', 1800);
      return;
    }
    const lines = diff.map((k) => `・${SETTINGS_LABEL[k] ?? k}: ${before[k]} → ${after[k]}`).join('\n');
    const warnAi = diff.includes('maxCompanies') && patch.maxCompanies < v.settings.maxCompanies ? '\n\n上限を下げると、市場シェアの小さい AI 企業から撤退します。' : '';
    if (!(await confirmDialog(this.root, '設定の変更の確認', `次のように変えます。\n${lines}${warnAi}\n\n変更は記録に残り、参加している人にも見えます。`, '変更する'))) return;
    try {
      await this.api.updateMarketSettings(this.auth.token, this.marketId, patch);
      toast(this.root, '市場の設定を保存しました', 'good', 2000);
      void this.refresh();
    } catch (e) {
      toast(this.root, errText(e), 'warn');
    }
  }

  /** この市場を消す（作った人だけ）。消したら入口へ戻る */
  private async deleteMarket(v: MarketScreenView): Promise<void> {
    const others = v.companies.filter((c) => c.kind === 'player' && !c.mine).length;
    if (!(await confirmDeleteMarket(this.root, v.name, others))) return;
    try {
      await this.api.deleteMarket(this.auth.token, this.marketId);
      toast(this.root, `「${v.name}」を消しました`, 'good', 2000);
      this.close();
    } catch (e) {
      toast(this.root, errText(e), 'warn');
    }
  }

  /** 名前を変える欄（入力と「変更」。Enter でも変える） */
  private renameRow(label: string, current: string, attr: string, id: string, submit: (name: string) => void): HTMLElement {
    const input = h('input', { class: 'input rename-input', value: current, maxLength: STORE_NAME_MAX, [attr]: id, 'aria-label': label }) as HTMLInputElement;
    const go = () => {
      const v = cleanStoreName(input.value);
      if (!v) {
        toast(this.root, '店名を入力してください', 'warn');
        input.value = current;
        return;
      }
      if (v !== current) submit(v);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        go();
      }
    });
    return h('div', { class: 'kv rename-row' }, h('span', null, label), h('div', { class: 'row' }, input, h('button', { class: 'btn', [`${attr}-ok`]: id, onclick: go }, '変更')));
  }

  /**
   * 会社を引退させる（記録は残り、1人が持てる会社の数から外れる）。じろ2（オーナーの判断「引退として抜ける」）: 競争中でも抜けられる。
   * 店は市場から消え、同じ会社では戻れない（新しい会社なら入り直せる）。企業間の借金は現金から返せるだけ返し、残りは貸し手の損
   */
  private async retire(bankrupt: boolean, ended: boolean): Promise<void> {
    const midway = !bankrupt && !ended;
    const ok = await confirmDialog(
      this.root,
      midway ? '市場を抜ける（引退）' : '会社を引退させる',
      midway
        ? `この会社は引退し、市場から抜けます。
・店は市場から消え、この会社ではもう営業できません（戻れません）
・この市場の記録と順位は残ります
・企業間の借金は今の現金から返せるだけ返し、残りは貸し手の損になります。返事待ちの申し込みは取り消します
・新しい会社なら、招待コードでこの市場に入り直せます
・1人が持てる会社（${BALANCE.market.maxCompaniesPerPlayer}社）の数から外れます`
        : `${bankrupt ? '破産した会社を' : 'この会社を'}引退させます。この市場では営業できなくなり、別のコミュニティへも持っていけなくなります（記録・称号は残ります）。\n1人が持てる会社（${BALANCE.market.maxCompaniesPerPlayer}社）の数から外れます。`,
      midway ? '抜ける' : '引退させる',
      true,
    );
    if (!ok) return;
    try {
      await this.api.retireCompany(this.auth.token, this.marketId);
      toast(this.root, midway ? '市場を抜けました（会社は引退）' : '会社を引退させました', 'good', 1800);
    } catch (e) {
      toast(this.root, errText(e), 'warn');
    }
    await this.refresh();
  }

  /**
   * 自動経営の方針（会社全体。仕様書 4.3・8.2）。変える前と後を見せ、重大な判断（借入・拡張の許可）は確認してから変える。
   * 自動営業（0時に遅れを補う日）と、プレイヤーがいない店に使う
   */
  private autoPolicy(s: GameState): HTMLElement {
    const pol = companyPolicyOf(s);
    const yesNo = (v: boolean) => (v ? '許可する' : '許可しない');
    const deficitText = (v: CompanyPolicy['deficit']) => (v === 'cutCosts' ? '3日続けて赤字なら広告と短期バイトを止める' : '何もしない');
    const change = async (label: string, before: string, after: string, patch: Partial<CompanyPolicy>, major: string | null) => {
      if (before === after) return;
      if (major && !(await confirmDialog(this.root, `${label}を変える`, `変更前: ${before}\n変更後: ${after}\n\n${major}`, '変更する', true))) {
        this.render();
        return;
      }
      await this.act({ type: 'setCompanyPolicy', policy: patch }, `${label}: ${before} → ${after}`);
    };
    const sel = (attr: string, value: string, opts: [string, string][], onChange: (v: string) => void) =>
      h('select', { [attr]: '', onchange: (ev: Event) => onChange((ev.target as HTMLSelectElement).value) }, opts.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
    return h(
      'section',
      { class: 'card market-auto' },
      h('h4', null, '自動経営の方針（会社全体）'),
      h('p', { class: 'note' }, '0時に、いちばん進んだ会社の日付まで自動営業するときと、あなたがいない店で使います。店ごとの方針（値段・広告・短期バイト・在庫・修理）は店の欄で決めます。'),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '借入'),
        sel('data-pol-loan', String(pol.allowLoan), [['false', '許可しない'], ['true', '許可する']], (v) =>
          void change('借入', yesNo(pol.allowLoan), yesNo(v === 'true'), { allowLoan: v === 'true' }, v === 'true' ? '期限を過ぎた未払金を払えない日に、自動で緊急の融資を受けます（返済と利息がかかります）。' : '許可しないと、自動営業で未払金を払えない日に破産することがあります。'),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '本店の拡張'),
        sel('data-pol-expand', String(pol.allowExpansion), [['false', '許可しない'], ['true', '許可する']], (v) =>
          void change('本店の拡張', yesNo(pol.allowExpansion), yesNo(v === 'true'), { allowExpansion: v === 'true' }, v === 'true' ? '資金に余裕があるとき（工事費・席・冷蔵庫・工事後の手元資金・余裕の資金がたまったとき）、自動営業の日に本店を12席に拡張します。工事の日は休業します。' : null),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '赤字のとき'),
        sel('data-pol-deficit', pol.deficit, [['cutCosts', '広告と短期バイトを止める'], ['none', '何もしない']], (v) =>
          void change('赤字のとき', deficitText(pol.deficit), deficitText(v as CompanyPolicy['deficit']), { deficit: v as CompanyPolicy['deficit'] }, null),
        ),
      ),
      h('div', { class: 'kv' }, h('span', null, '営業時間'), h('b', null, '店ごとに決める（下の各店の「🕒 営業時間」）')),
      h('div', { class: 'kv' }, h('span', null, '株式発行・企業買収'), h('b', null, 'まだありません（しない）')),
    );
  }

  private storeCard(s: GameState, entry: StoreEntry, day: number): HTMLElement {
    const st = storeStatus(s, entry);
    const r = day > 0 ? storeReport(s, entry, day) : null;
    const fulls = st.employees.filter((e) => e.profile.employment === 'full');
    const lead = entry.managerId ? st.employees.find((e) => e.id === entry.managerId) : null;
    const leadText = lead ? `店長 ${lead.profile.name}` : s.company.ownerStoreId === entry.id ? '店主（あなた）が営業' : '店長がいないため休業';
    const others = s.company.stores.filter((x) => x.id !== entry.id);
    return h(
      'section',
      { class: 'card store-card', 'data-store': entry.id },
      h('h4', null, `${storeDisplayName(s, entry)}（${STAGES[st.stage]?.seats.length ?? 8}席）`),
      entry.propertyId !== 'home' ? this.renameRow('店名', entry.name, 'data-rename-store', entry.id, (v) => void this.act({ type: 'renameStore', storeId: entry.id, name: v }, `店名を「${v}」にしました`)) : null,
      h('div', { class: 'kv' }, h('span', null, '営業'), h('b', null, entry.snapshot && entry.snapshot.closedForConstruction > 0 ? '🛠 準備・工事中' : leadText)),
      h('div', { class: 'kv' }, h('span', null, '評判'), h('b', null, `${stars(st.reputation)} ${st.reputation.toFixed(2)}`)),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '営業時間'),
        h('b', { 'data-store-hours': entry.id }, hoursSummary(entry.hours ?? DEFAULT_HOURS)),
      ),
      h(
        'button',
        {
          class: 'mini',
          'data-edit-hours': entry.id,
          onclick: async () => {
            const next = await hoursDialog(this.root, `営業時間 — ${storeDisplayName(s, entry)}`, entry.hours ?? DEFAULT_HOURS);
            if (next) await this.act({ type: 'setStoreHours', storeId: entry.id, hours: next }, '営業時間を決めました（次の営業日から）');
          },
        },
        '🕒 営業時間を変える',
      ),
      r ? h('div', { class: 'kv' }, h('span', null, `${r.day}日目`), h('b', null, `${r.served}杯・来客${r.customers}人（帰った客 ${r.lost + r.balked}人）・利益 ${yenStr(r.operatingProfit)}`)) : null,
      h(
        'div',
        { class: 'kv' },
        h('span', null, '値段'),
        h(
          'select',
          { 'data-price': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { priceMult: Number((ev.target as HTMLSelectElement).value) } }) },
          [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3].map((m) => h('option', { value: String(m), selected: Math.abs(m - entry.policy.priceMult) < 1e-6 }, m === 1 ? '定価' : `定価の${Math.round(m * 100)}%`)),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '人手が足りない日'),
        h(
          'select',
          { 'data-temp-policy': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { tempWhenShort: (ev.target as HTMLSelectElement).value === '1' } }, '短期バイトの方針を変えました') },
          h('option', { value: '0', selected: !entry.policy.tempWhenShort }, '短期バイトを呼ばない'),
          h('option', { value: '1', selected: !!entry.policy.tempWhenShort }, `短期バイトを1人呼ぶ（時給${yenStr(tempHourly())}）`),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '在庫の安全基準'),
        h(
          'select',
          { 'data-safety': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { safetyStock: Number((ev.target as HTMLSelectElement).value) } }, '在庫の安全基準を変えました') },
          [0.9, 1, 1.2, 1.5].map((v) => h('option', { value: String(v), selected: Math.abs(v - (entry.policy.safetyStock ?? 1)) < 1e-6 }, v === 1 ? 'ふつう' : v < 1 ? '少なめ（廃棄が減る・品切れしやすい）' : `多め（×${v}・品切れしにくい・廃棄が増える）`)),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '広告'),
        h(
          'select',
          { 'data-ads': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { adBudget: Number((ev.target as HTMLSelectElement).value) } }) },
          BALANCE.ads.choices.map((v) => h('option', { value: String(v), selected: v === adBudgetOf(entry) }, v === 0 ? '出さない' : `1日${yenStr(v)}（来客 +${Math.round((adFactor(v) - 1) * 100)}%）`)),
        ),
      ),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '店長'),
        h(
          'select',
          { onchange: (ev: Event) => { const val = (ev.target as HTMLSelectElement).value; void this.act({ type: 'assignManager', storeId: entry.id, employeeId: val === '' ? null : val }); } },
          h('option', { value: '', selected: !lead }, s.company.ownerStoreId === entry.id ? '（なし: 店主が営業）' : '（なし: 休業）'),
          fulls.map((e) => h('option', { value: e.id, selected: e.id === entry.managerId }, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`)),
        ),
      ),
      h(
        'div',
        { class: 'table staff-list' },
        st.employees.map((e) =>
          h(
            'div',
            { class: 'trow' },
            h('div', { class: 'tname' }, e.profile.name, h('small', null, `${ROLE_LABEL[e.profile.role]}・${e.profile.employment === 'full' ? '社員' : 'アルバイト'}`)),
            e.profile.employment !== 'full' ? h('button', { class: 'mini', onclick: () => void this.act({ type: 'promote', employeeId: e.id }, '社員にしました') }, '社員にする') : null,
            others.length > 0 && !e.profile.temp
              ? h('select', { onchange: (ev: Event) => { const to = (ev.target as HTMLSelectElement).value; if (to) void this.act({ type: 'transferEmployee', employeeId: e.id, toStoreId: to }, '異動しました'); } }, h('option', { value: '' }, '異動…'), others.map((x) => h('option', { value: x.id }, x.name)))
              : null,
          ),
        ),
      ),
    );
  }

  private growth(s: GameState, v: MarketScreenView): HTMLElement {
    const info = expansionInfo(s);
    const adv = expansionAdvice(s);
    const st = STAGES[s.career.stage]!;
    const missingSeats = s.seats.filter((x) => !x.installed && x.index < st.seats.length);
    const fridges = s.equipment.filter((e) => e.type === 'fridge' || e.type === 'fridge_l').length;
    const homeFull = s.employees.filter((e) => e.profile.employment === 'full');
    const props = PROPERTY_CANDIDATES.filter((p) => !s.company.stores.some((x) => x.propertyId === p));
    return h(
      'section',
      { class: 'card wide market-growth' },
      h('h4', null, '拡張と出店'),
      info.next
        ? h(
            'div',
            null,
            h('div', { class: 'kv' }, h('span', null, `本店を${info.next.name}に`), h('b', null, `工事費 ${yenStr(info.cost)}${adv ? `（席・冷蔵庫・手元資金を含めた目安 ${yenStr(adv.total)}）` : ''}`)),
            info.reason ? h('p', { class: 'note' }, info.reason) : null,
            h('p', { class: 'note' }, '拡張の工事は、営業の画面で閉店後に「経営」から決めます（工事の日は休業します）。'),
          )
        : null,
      missingSeats.length > 0 ? h('button', { class: 'btn ghost', onclick: async () => { for (const seat of missingSeats) await this.act({ type: 'buySeat', seatIndex: seat.index }); } }, `増えた席の椅子を買う（${missingSeats.length}脚）`) : null,
      s.career.stage >= 1 && fridges < 2 ? h('button', { class: 'btn ghost', onclick: () => void this.act({ type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, '冷蔵庫を買いました') }, '2台目の冷蔵庫を買う（12席で杯数が増えると足りなくなる）') : null,
      h('p', { class: 'note' }, `出店: ${STAGES[BALANCE.company.unlockStage]?.seats.length ?? 12}席以上で評判★${BALANCE.company.unlockReputation.toFixed(1)}以上の店と、店長にする社員（本店から移る）、初期費用＋運転資金 ${yenStr(BALANCE.company.minFundsAfterOpen)} が要ります。物件は全社で取り合います。`),
      v.settings.cityCode
        ? h('button', { class: 'btn primary', 'data-market-open-map': '', onclick: () => this.openCityMap(s, v) }, `🗾 ${locationLabel(v.settings.cityCode)}の地図で出店先を選ぶ`)
        : null,
      h(
        'div',
        { class: 'table' },
        props.map((pid) => {
          const p = PROPERTIES[pid]!;
          const free = v.freeSlots[pid] ?? 0;
          const sel = h('select', null, homeFull.map((e) => h('option', { value: e.id }, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`))) as HTMLSelectElement;
          const reason = free <= 0 ? '物件が空いていません' : homeFull.length === 0 ? '店長にする社員がいません' : openStoreProblem(s, pid, homeFull[0]!.id);
          return h(
            'div',
            { class: 'trow', 'data-market-property': pid },
            h('div', { class: 'tname' }, `${p.name}（空き ${free}件）`, h('small', null, `初期費用 ${yenStr(p.initialCost)}・${p.description}`)),
            homeFull.length > 0 ? sel : null,
            h('button', { class: 'mini', disabled: !!reason, onclick: async () => { if (await confirmDialog(this.root, '出店', `${p.name}に出店します。初期費用 ${yenStr(p.initialCost)}。`, '出店する')) await this.act({ type: 'openStore', propertyId: pid, managerId: sel.value }, '出店しました'); } }, '出店する'),
            reason ? h('small', { class: 'note' }, reason) : null,
          );
        }),
      ),
    );
  }

  private hiring(s: GameState): HTMLElement {
    const unlocked = s.career.unlocked.includes('hiring');
    return h(
      'section',
      { class: 'card wide market-hire' },
      h('h4', null, '採用（本店に入ります。ほかの店へは異動で送ります）'),
      !unlocked
        ? h('p', { class: 'note' }, '1日の営業利益が黒字になると採用できるようになります')
        : s.candidates.length === 0
          ? h('p', { class: 'note' }, '今日の候補はいません（毎日入れ替わります）')
          : h(
              'div',
              { class: 'table' },
              s.candidates.slice(0, 4).map((c) =>
                h(
                  'div',
                  { class: 'trow' },
                  h('div', { class: 'tname' }, c.profile.name, h('small', null, `${ROLE_LABEL[c.profile.role]}・日給の目安 ${yenStr(c.profile.wage)}・採用費 ${yenStr(c.profile.hireFee)}`)),
                  h('button', { class: 'mini', 'data-hire': c.id, onclick: () => void this.act({ type: 'hire', candidateId: c.id }, `${c.profile.name}さんを採用しました`) }, '採用する'),
                ),
              ),
            ),
    );
  }
}
