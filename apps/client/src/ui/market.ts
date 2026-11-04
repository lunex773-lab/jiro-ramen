// オンライン市場の画面（統合進化設計書 v2.1 Phase 3+4）。
// オーナーの判断: 市場の1日＝実時間9分（全員が同じサーバーの時計）、市場用に新しく始める、招待コード＋AIだけの市場、AI と合わせて最大6社。
// 市場の中では、すべての店を店長（本店は店主）が営業し、プレイヤーは経営（値段・人・拡張・出店）を決める。
// 画面は数秒ごとにサーバーから市場の今を読み直す（市場の権威はサーバー。操作は cid つきで送る）。

import {
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
} from '@jiro/core';
import type { App } from '../game/app';
import { Api, ApiError, defaultServerUrl, rememberServerUrl, type Auth } from '../net/api';
import { confirmDialog, h, replace, stars, toast, yenStr } from './dom';
import { codeBlock } from './room-code';

export type MarketScreenView = MarketView & {
  clock: { day: number; dayMs: number; nextDayAt: number; serverNow: number };
  code: string;
  isOwner: boolean;
  joined: boolean;
};

const POLL_MS = 8000;
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
  const urlInput = h('input', { class: 'input', value: defaultServerUrl(), placeholder: 'https://jiro-ramen.<アカウント>.workers.dev' }) as HTMLInputElement;
  const company = h('input', { class: 'input', value: app.settings.playerName ? `${app.settings.playerName}の店` : '', placeholder: '会社（店）の名前', maxLength: 20 }) as HTMLInputElement;
  const marketName = h('input', { class: 'input', placeholder: '市場の名前（なくてもよい）', maxLength: 20 }) as HTMLInputElement;
  const codeInput = h('input', { class: 'input code', placeholder: '招待コード（6文字）', maxLength: 6 }) as HTMLInputElement;
  const status = h('div', { class: 'note' });
  const list = h('div', { class: 'table market-list' });
  const busy = (on: boolean, text = '') => {
    for (const b of Array.from(body.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = on;
    status.textContent = text;
  };
  const connect = async (): Promise<{ api: Api; auth: Auth } | null> => {
    const url = Api.normalize(urlInput.value);
    if (!url) {
      status.textContent = 'サーバーの URL を入力してください';
      return null;
    }
    rememberServerUrl(url);
    const api = new Api(url);
    const auth = await api.auth(app.settings.playerName || 'プレイヤー');
    return { api, auth };
  };
  const open = (api: Api, auth: Auth, marketId: string) => app.showMarket(api, auth, marketId);
  const refreshList = async () => {
    try {
      const c = await connect();
      if (!c) return;
      const r = await c.api.listMarkets(c.auth.token);
      replace(
        list,
        r.markets.length === 0
          ? h('p', { class: 'note' }, '参加している市場はまだありません')
          : r.markets.map((m) =>
              h(
                'div',
                { class: 'trow' },
                h('div', { class: 'tname' }, m.name, h('small', null, `招待コード ${m.code}${m.isOwner ? '・あなたが作った市場' : ''}`)),
                h('button', { class: 'btn', 'data-open-market': m.marketId, onclick: () => open(c.api, c.auth, m.marketId) }, '開く'),
              ),
            ),
      );
    } catch (e) {
      replace(list, h('p', { class: 'note bad' }, errText(e)));
    }
  };
  replace(
    body,
    h('section', { class: 'card wide' }, h('h4', null, 'サーバー'), urlInput, h('p', { class: 'note' }, '市場はサーバーの時計で進みます（1日 = 営業9分の周期）。あなたがいない間も、店主と店長が営業し、AI 企業も動き続けます。')),
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '市場を作る'),
      h('p', { class: 'note' }, `あなたの会社と AI 企業${BALANCE.market.maxCompanies - 1}社で始まります。招待コードを配ると友達も入れます（プレイヤーは${BALANCE.market.maxPlayers}社まで。入るたびに AI が1社抜けます）。全社が資金30万円・8席から。`),
      company,
      marketName,
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
              const r = await c.api.createMarket(c.auth.token, marketName.value.trim(), company.value.trim());
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
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, '招待コードで入る'),
      codeInput,
      h(
        'button',
        {
          class: 'btn',
          'data-join-market': '',
          onclick: async () => {
            busy(true, '市場に入っています…');
            try {
              const c = await connect();
              if (!c) return;
              const r = await c.api.joinMarket(c.auth.token, codeInput.value, company.value.trim());
              open(c.api, c.auth, r.marketId);
            } catch (e) {
              status.textContent = errText(e);
            } finally {
              busy(false, status.textContent ?? '');
            }
          },
        },
        '入る',
      ),
    ),
    h('section', { class: 'card wide' }, h('h4', null, '参加している市場'), list, h('button', { class: 'btn ghost', onclick: () => void refreshList() }, '一覧を読み込む')),
    status,
  );
  if (urlInput.value) void refreshList();
  return el;
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

  constructor(
    private root: HTMLElement,
    private api: Api,
    private auth: Auth,
    private marketId: string,
    private onBack: () => void,
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
    this.timer = window.setInterval(() => void this.refresh(true), POLL_MS);
    this.clockTimer = window.setInterval(() => this.renderHead(), 1000);
  }

  private release = (): void => {
    this.pressing = false;
  };

  close(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.clockTimer !== null) window.clearInterval(this.clockTimer);
    window.removeEventListener('pointerup', this.release);
    this.el.remove();
    this.onBack();
  }

  async refresh(auto = false): Promise<void> {
    if (this.loading) return;
    // 選んでいる最中は描き直さない（自動の読み直しのとき）
    if (auto && (this.pressing || (this.el.contains(document.activeElement) && document.activeElement?.tagName === 'SELECT'))) return;
    this.loading = true;
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

  private async act(a: Action, okMsg?: string): Promise<void> {
    try {
      const r = await this.api.actMarket(this.auth.token, this.marketId, cid(), a);
      if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn');
      else if (okMsg) toast(this.root, okMsg, 'good', 1800);
    } catch (e) {
      toast(this.root, errText(e), 'warn');
    }
    await this.refresh();
  }

  private renderHead(): void {
    const v = this.view;
    if (!v) return;
    const now = Date.now() + this.offset;
    const left = Math.max(0, Math.ceil((v.clock.nextDayAt - now) / 1000));
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, '0');
    replace(
      this.head,
      h('h2', null, v.name),
      h('div', { class: 'kv' }, h('span', null, '市場の日'), h('b', { 'data-market-day': String(v.day) }, v.day === 0 ? '1日目の営業中' : `${v.day}日目まで営業済み`)),
      h('div', { class: 'kv' }, h('span', null, '次の日まで'), h('b', null, `${mm}分${ss}秒`)),
      h('div', { class: 'market-code' }, h('span', { class: 'note' }, '招待コード'), codeBlock(this.root, v.code)),
    );
  }

  render(): void {
    const v = this.view;
    if (!v) return;
    this.renderHead();
    const scroll = this.body.scrollTop;
    replace(this.body, h('div', { class: 'grid2' }, this.standings(v), this.mine(v), this.decisions(v)));
    this.body.scrollTop = scroll;
  }

  private standings(v: MarketScreenView): HTMLElement {
    return h(
      'section',
      { class: 'card wide market-standings' },
      h('h4', null, `企業の順位（市場シェア = 直近${BALANCE.market.shareDays}日の純売上の割合）`),
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
            h('div', { class: 'tsub' }, `シェア ${pct(c.share)}`),
            h('div', { class: 'tsub' }, `前日 ${yenStr(c.netSales)}（利益 ${yenStr(c.operatingProfit)}）`),
          ),
        ),
      ),
      h('p', { class: 'note' }, `同じ地域の店どうしで客を取り合います（安い店・評判の良い店ほど客が来る）。出店先の空き: ${PROPERTY_CANDIDATES.map((p) => `${PROPERTIES[p]!.area} ${v.freeSlots[p] ?? 0}件`).join('・')}`),
    );
  }

  private decisions(v: MarketScreenView): HTMLElement {
    const names = new Map(v.companies.map((c) => [c.id, c.name]));
    return h(
      'section',
      { class: 'card wide market-log' },
      h('h4', null, '市場の出来事（AI 企業の判断の理由など）'),
      h('div', { class: 'table' }, [...v.decisions].reverse().slice(0, 24).map((d) => h('div', { class: 'trow' }, h('div', { class: 'tsub' }, `${d.day}日目`), h('div', { class: 'tname' }, h('small', null, names.get(d.companyId) ?? ''), d.text)))),
    );
  }

  private mine(v: MarketScreenView): HTMLElement {
    if (!v.mine) return h('section', { class: 'card wide' }, h('p', { class: 'note' }, 'この市場に企業がありません'));
    const s = v.mine.state;
    const row = (k: string, val: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, val));
    const last = s.company.history[s.company.history.length - 1] ?? null;
    const bankrupt = s.phase === 'bankrupt';
    const finance = h(
      'section',
      { class: 'card market-mine' },
      h('h4', null, `あなたの会社: ${s.shopName}`),
      row('現金', yenStr(s.money), s.money < 50_000 ? 'bad' : ''),
      row('借入・未払金', yenStr(totalDebt(s)), totalDebt(s) > 0 ? 'warn' : ''),
      last ? row(`${last.day}日目の営業利益（全店）`, yenStr(last.operatingProfit), last.operatingProfit < 0 ? 'bad' : 'good') : null,
      row('評判（本店）', `${stars(s.reputation)} ${s.reputation.toFixed(2)}`),
      bankrupt ? h('p', { class: 'note bad' }, '破産しました。市場から消えています') : null,
      s.loans.length === 0 && !bankrupt ? h('button', { class: 'btn ghost', onclick: () => void this.act({ type: 'takeLoan' }, '融資を受けました') }, `融資を受ける（${yenStr(BALANCE.loan.amount)}）`) : null,
    );
    const stores = s.company.stores.map((entry) => this.storeCard(s, entry, v.day));
    return h('div', { class: 'market-mine-col' }, finance, ...stores, this.growth(s, v), this.hiring(s));
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
      h('h4', null, `${entry.name}（${STAGES[st.stage]?.seats.length ?? 8}席）`),
      h('div', { class: 'kv' }, h('span', null, '営業'), h('b', null, entry.snapshot && entry.snapshot.closedForConstruction > 0 ? '🛠 準備・工事中' : leadText)),
      h('div', { class: 'kv' }, h('span', null, '評判'), h('b', null, `${stars(st.reputation)} ${st.reputation.toFixed(2)}`)),
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
            entry.snapshot === null && others.length > 0
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
            h('button', { class: 'btn', 'data-expand': '', disabled: !info.canExpand, onclick: async () => { if (await confirmDialog(this.root, '拡張', `本店を${info.next!.name}に拡張します。工事費 ${yenStr(info.cost)}。工事の日は休業します。`, '拡張する')) await this.act({ type: 'expand' }, '拡張しました'); } }, '拡張する'),
          )
        : null,
      missingSeats.length > 0 ? h('button', { class: 'btn ghost', onclick: async () => { for (const seat of missingSeats) await this.act({ type: 'buySeat', seatIndex: seat.index }); } }, `増えた席の椅子を買う（${missingSeats.length}脚）`) : null,
      s.career.stage >= 1 && fridges < 2 ? h('button', { class: 'btn ghost', onclick: () => void this.act({ type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, '冷蔵庫を買いました') }, '2台目の冷蔵庫を買う（12席で杯数が増えると足りなくなる）') : null,
      h('p', { class: 'note' }, `出店: ${STAGES[BALANCE.company.unlockStage]?.seats.length ?? 12}席以上で評判★${BALANCE.company.unlockReputation.toFixed(1)}以上の店と、店長にする社員（本店から移る）、初期費用＋運転資金 ${yenStr(BALANCE.company.minFundsAfterOpen)} が要ります。物件は全社で取り合います。`),
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
