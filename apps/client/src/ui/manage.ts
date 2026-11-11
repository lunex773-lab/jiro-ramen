// 経営メニュー（設計書 14.6 経営ダッシュボード、19.1 在庫/従業員/設備/拡張/キャリア）。

import {
  cleanStoreName,
  locationInfo,
  locationLabel,
  locationProblem,
  storeDemandMult,
  storeRentMult,
  STORE_NAME_MAX,
  BALANCE,
  BOWL_PACK,
  CALLS,
  EQUIPMENT,
  expansionAdvice,
  expansionInfo,
  fixedCosts,
  forecastText,
  fridgeCapacity,
  fridgeUsage,
  GOALS,
  INGREDIENTS,
  isUnlocked,
  loanAvailable,
  maintenanceCost,
  MAINTENANCE_THRESHOLD,
  MENU,
  operatingProfit,
  pendingOf,
  packPriceOf,
  resaleValue,
  ROLE_LABEL,
  SEAT_PRICE,
  soldOut,
  STAGES,
  STATUS_LABEL,
  stockOf,
  TASK_KINDS,
  UNLOCK_NAMES,
  ATTENDANCE_LABEL,
  EMPLOYMENT_LABEL,
  WEEKDAY_LABEL,
  attendanceText,
  adBudgetOf,
  adFactor,
  tempHourly,
  fatigueSpeed,
  fatigueText,
  isWishDay,
  moraleText,
  restDaysOf,
  buzzBoostFactor,
  signsOf,
  dailyWageOf,
  employmentOf,
  expectedPay,
  hourlyOf,
  isPartTime,
  promotionInfo,
  shiftPaidHours,
  shiftProblem,
  shiftsOf,
  autoOrderTarget,
  shiftFor,
  hasDateShift,
  shiftTimeText,
  staffLog,
  staffSummary,
  weekdayOf,
  activeStore,
  enterStoreProblem,
  openStoreProblem,
  PROPERTIES,
  PROPERTY_CANDIDATES,
  storeDisplayName,
  storeProperty,
  storeReport,
  storeStatus,
  totalDebt,
  type Action,
  type Employee,
  type EmployeeRole,
  type GameState,
  type ShiftDay,
  leaderWageFor,
  prepTargetItems,
  promoteLeaderProblem,
  storeHours,
  shiftTable,
  openMinutesOf,
  sessionSpans,
  SEC_PER_MIN,
  fullTimePayFor,
  clockText as clockLabel,
  todayHours,
  DEFAULT_HOURS,
  type StoreEntry,
  prefRangeProblem,
  rangeTitle,
} from '@jiro/core';
import type { GameHost } from '../game/host';

/** 「会社」のタブを出すか: 店を2つ以上持っている、または出店の条件（12席以上・評判★4.0以上の店）を満たしている */
function companyTabVisible(s: GameState): boolean {
  if (!s.company || s.tutorial) return false;
  if (s.company.stores.length > 1) return true;
  const B = BALANCE.company;
  return s.career.stage >= B.unlockStage && s.reputation >= B.unlockReputation;
}
import { confirmDialog, confirmNode, h, replace, stars, toast, yenStr } from './dom';
import { openStoreMap } from './store-map';
import { hoursDialog, hoursSummary } from './hours-dialog';
import { loanControl } from './loan';
import { alertBox, cardHead, delta, flowBar, kpi, kpiRow, profitBars, yenSigned } from './kit';
import { debugEventsCard, debugEventsEnabled } from './debug-events';
import { lookSeedOf, staffLook, staffLookText } from '../render/staff-look';

export type ManageTab = 'dash' | 'company' | 'stock' | 'menu' | 'equip' | 'staff' | 'layout' | 'career' | 'system';

const TABS: [ManageTab, string][] = [
  ['dash', '経営'],
  ['company', '会社'],
  ['stock', '在庫・発注'],
  ['menu', 'メニュー'],
  ['equip', '設備'],
  ['staff', '従業員'],
  ['layout', '店舗'],
  ['career', 'キャリア'],
  ['system', 'セーブ・設定'],
];

export interface ManageCallbacks {
  onClose(): void;
  onLayoutEditor(): void;
  onSave(): void;
  onCloudSave(): void;
  onCloudLoad(): void;
  onSettings(): void;
  onTitle(): void;
  onHelp(): void;
}

/** 閲覧専用: 操作の部品をすべて押せなくする（data-guest-ok の付いた表示だけの部品は除く） */
function lockControls(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select, textarea')) {
    if (el.closest('[data-guest-ok]')) continue;
    el.disabled = true;
  }
}

export class ManageMenu {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private tab: ManageTab = 'dash';
  private timer: number | null = null;
  /** 開いている従業員の欄（シフト・記録・担当設定） */
  private empPanel: { id: string; kind: 'shift' | 'record' | 'prio' } | null = null;
  /** シフトのカレンダーで選んでいる日と編集中の内容（保存するまで状態は変えない。自動更新で消えないようここに持つ） */
  private shiftEdit: { id: string; days: number[]; draft?: ShiftDay | null } | null = null;
  /** みんなの勤務のカレンダーで選んだ日 */
  private teamDay: number | null = null;
  private tabButtons = new Map<ManageTab, HTMLElement>();
  /** 押している最中は自動更新しない（押した要素が差し替わるとタップが外れる） */
  private pressing = false;
  /** 閲覧専用の印（共同経営のゲスト） */
  private badge: HTMLElement;
  /** 最後に描いたときの状態の版（ゲストはホストの更新を受けたら描き直す） */
  private renderedVersion = -1;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: ManageCallbacks,
  ) {
    // タブは一度だけ作り、選択中の表示だけ切り替える
    this.tabsEl = h(
      'div',
      { class: 'tabs' },
      TABS.map(([id, label]) => {
        const b = h('button', { class: 'tab', onclick: () => { this.tab = id; this.render(); this.body.scrollTop = 0; } }, label);
        this.tabButtons.set(id, b);
        return b;
      }),
    );
    this.body = h('div', { class: 'manage-body' });
    this.el = h(
      'div',
      { class: 'manage' },
      h(
        'div',
        { class: 'manage-head' },
        h('div', { class: 'manage-title' }, '経営メニュー'),
        (this.badge = h('div', { class: 'readonly-badge', hidden: true }, '👀 閲覧専用（経営はホストが行います）')),
        h('button', { class: 'btn ghost close', onclick: () => cb.onClose() }, '✕ 閉じる'),
      ),
      this.tabsEl,
      this.body,
    );
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.pressing = true;
    });
  }

  private release = (): void => {
    this.pressing = false;
  };

  open(tab: ManageTab = this.tab): void {
    this.tab = tab;
    this.root.appendChild(this.el);
    this.render();
    if (this.timer === null) this.timer = window.setInterval(() => this.render(true), 1000);
    window.addEventListener('pointerup', this.release);
    window.addEventListener('pointercancel', this.release);
  }

  close(): void {
    this.el.remove();
    this.pressing = false;
    window.removeEventListener('pointerup', this.release);
    window.removeEventListener('pointercancel', this.release);
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  get isOpen(): boolean {
    return this.el.isConnected;
  }

  get currentTab(): ManageTab {
    return this.tab;
  }

  /** チュートリアルで開いてほしいタブを目立たせる */
  highlightTab(tab: string | null): void {
    for (const [id, b] of this.tabButtons) b.classList.toggle('tut-pulse', id === tab && id !== this.tab);
  }

  /**
   * 閲覧専用か（共同経営のゲスト）。ゲストは店で働く従業員と同じ扱いで、経営の操作はホストだけ（第2版 2-2）。
   * 画面は表示するが操作ボタンは押せず、操作はサーバーへ送らない（送ってもサーバーが拒否する）
   */
  get readOnly(): boolean {
    return this.host.mode === 'remote' && !this.host.isHost;
  }

  /** 出店先を地図で選ぶ（候補地 → 店長 → 確認 → 出店） */
  private openStoreMapForNew(s: GameState): void {
    const fullStaff = s.employees.filter((e) => e.profile.employment === 'full');
    let managerId = fullStaff[0]?.id ?? '';
    const closed = s.phase === 'closed';
    const map = openStoreMap(this.root, {
      title: `出店先を選ぶ（${rangeTitle(s)}）`,
      mode: 'site',
      confirmLabel: 'ここに出店する',
      // 出店の範囲（じろ1 5.6）: 2〜5店目は本店と同じ都道府県、6〜10店目は同じ地方、11店目から全国。範囲の外は薄く出す
      rangeProblem: (pref) => prefRangeProblem(s, pref),
      // 本店の街を開いた状態で始める
      startAt: activeStore(s).location ?? s.company.stores[0]?.location ?? undefined,
      siteInfo: (code, propertyId) => {
        const p = PROPERTIES[propertyId]!;
        const l = locationInfo(code);
        const rent = Math.round((STAGES[p.stage]?.rent ?? 0) * p.rentMult * (l?.rent ?? 1));
        return {
          lines: [`初期費用 ${yenStr(p.initialCost)}・家賃 ${yenStr(rent)}/日・来客 ×${(p.demand * (l?.demand ?? 1)).toFixed(2)}・準備 ${p.openingDays}日`],
          problem: !closed ? '閉店後に出店できます' : managerId ? (locationProblem(code) ?? openStoreProblem(s, propertyId, managerId, code)) : '店長にする社員がいません',
        };
      },
      extra: () =>
        fullStaff.length > 0
          ? h(
              'div',
              { class: 'kv' },
              h('span', null, '店長'),
              h(
                'select',
                { 'data-open-mgr': '', onchange: (ev: Event) => (managerId = (ev.target as HTMLSelectElement).value) },
                fullStaff.map((e) => h('option', { value: e.id, selected: e.id === managerId }, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`)),
              ),
            )
          : null,
      onPick: async ({ code, propertyId }) => {
        if (!propertyId) return;
        const p = PROPERTIES[propertyId]!;
        const m = s.employees.find((e) => e.id === managerId);
        if (!m) return;
        const where = `${locationLabel(code)}の${p.area}`;
        if (!(await confirmDialog(this.root, '出店', `${where}（${p.name}）に出店します。初期費用 ${yenStr(p.initialCost)}。${m.profile.name}さんが店長として移ります。準備の${p.openingDays}日のあと、店長の営業で開きます。`, '出店する'))) return;
        if (await this.act({ type: 'openStore', propertyId, managerId, location: code }, '出店しました')) map.close();
      },
      onClose: () => this.render(),
    });
  }

  /** 場所のない店（1店目・前のセーブの店）の場所を決める（1回だけ） */
  private openLocationMap(storeId: string): void {
    const map = openStoreMap(this.root, {
      title: '店の場所を決める（1回だけ）',
      mode: 'city',
      confirmLabel: 'この街にする',
      cityInfo: (code) => ({ lines: ['決めたあとは変えられません。人口で来客と家賃が少し変わります。'], problem: locationProblem(code) }),
      onPick: async ({ code }) => {
        if (!(await confirmDialog(this.root, '店の場所', `${locationLabel(code)}にします。あとで変えられません。`, '決める'))) return;
        if (await this.act({ type: 'setStoreLocation', storeId, location: code }, `場所を${locationLabel(code)}にしました`)) map.close();
      },
      onClose: () => this.render(),
    });
  }

  /** 名前を変える欄（入力と「変更」。Enter でも変える）。ゲストは変えられない */
  private renameRow(label: string, current: string, attr: string, id: string, submit: (name: string) => void): HTMLElement {
    const can = this.host.isHost;
    const input = h('input', { class: 'input rename-input', value: current, maxLength: STORE_NAME_MAX, [attr]: id, disabled: !can, 'aria-label': label }) as HTMLInputElement;
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
    return h('div', { class: 'kv rename-row' }, h('span', null, label), h('div', { class: 'row' }, input, h('button', { class: 'btn', [`${attr}-ok`]: id, disabled: !can, onclick: go }, '変更')));
  }

  private async act(a: Action, okMsg?: string): Promise<boolean> {
    if (this.readOnly) {
      toast(this.root, '経営の操作はホストだけができます', 'warn');
      return false;
    }
    const r = await this.host.act(a);
    if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn');
    else if (okMsg) toast(this.root, okMsg, 'good', 1600);
    this.render();
    return r.ok;
  }

  render(live = false): void {
    const ro = this.readOnly;
    const s = this.host.state;
    // 自動更新: ホストは経営・従業員のタブだけ（入力中・押している最中は描き直さない）。
    // ゲストは押せる入力がないので、どのタブもホストの更新（状態の版が変わったとき）を受けて描き直す
    if (live && !ro && this.tab !== 'dash' && this.tab !== 'staff') return;
    if (live && ro && s.version === this.renderedVersion) return;
    if (live && this.el.contains(document.activeElement) && (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'SELECT')) return;
    if (live && this.pressing) return;
    this.renderedVersion = s.version;
    const scroll = this.body.scrollTop;
    // 「会社」は、2店舗目を出せるようになるか、店を2つ以上持ってから出す（1店舗のうちは今までどおり）
    const showCompany = companyTabVisible(s);
    const ct = this.tabButtons.get('company');
    if (ct && ct.hidden === showCompany) ct.hidden = !showCompany;
    if (this.tab === 'company' && !showCompany) this.tab = 'dash';
    for (const [id, b] of this.tabButtons) b.classList.toggle('on', id === this.tab);
    if (this.badge.hidden !== !ro) this.badge.hidden = !ro;
    this.el.classList.toggle('readonly', ro);
    let content: HTMLElement;
    try {
      content =
        this.tab === 'dash' ? this.dash(s)
        : this.tab === 'company' ? this.company(s)
        : this.tab === 'stock' ? this.stock(s)
        : this.tab === 'menu' ? this.menu(s)
        : this.tab === 'equip' ? this.equip(s)
        : this.tab === 'staff' ? this.staff(s)
        : this.tab === 'layout' ? this.layout(s)
        : this.tab === 'career' ? this.career(s)
        : this.system(s);
    } catch (e) {
      // 表示に失敗しても、メニューが中途半端なまま固まらないようにする（タブの切り替え・閉じるは使える）
      console.error('manage render failed', e);
      content = h('section', { class: 'card wide' }, h('p', { class: 'note bad' }, 'この画面を表示できませんでした。ほかのタブを開くか、メニューを閉じてください。'));
    }
    replace(this.body, content);
    if (ro) lockControls(this.body);
    this.body.scrollTop = scroll;
  }

  // ───────────────── 会社（Phase 2: 店舗一覧・店舗別損益・会社の財務・出店・店長・方針） ─────────────────
  private company(s: GameState): HTMLElement {
    const c = s.company;
    const row = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
    const last = c.history[c.history.length - 1] ?? null;
    const week = c.history.slice(-7);
    const weekOp = week.reduce((a, x) => a + x.operatingProfit, 0);
    const closed = s.phase === 'closed';
    const fullStaff = s.employees.filter((e) => e.profile.employment === 'full');
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const finance = h(
      'section',
      { class: 'card' },
      cardHead(`会社の財務 — ${s.day}日目`, 'お金・借入・キャリアは会社のものです。プレイヤーがいない店は店長が営業し、1日ごとに計算します（細かい動きは見えません）。'),
      kpiRow([
        kpi('現金（会社）', yenSigned(s.money), null, s.money < 50_000 ? 'bad' : ''),
        kpi('借入・未払金', yenSigned(totalDebt(s)), null, totalDebt(s) > 0 ? 'warn' : ''),
        kpi('店の数', `${c.stores.length}店`, null),
        last ? kpi(`${last.day}日目の営業利益（全店）`, yenSigned(last.operatingProfit, true), `純売上 ${yenSigned(last.netSales)}${last.interest > 0 ? `・利息 −${yenStr(last.interest)}` : ''}`, last.operatingProfit < 0 ? 'bad' : 'good') : null,
      ]),
      week.length > 0 ? row(`直近${week.length}日の営業利益（全店）`, yenSigned(weekOp, true), weekOp < 0 ? 'bad' : 'good') : null,
      c.history.length > 1 ? profitBars(c.history.slice(-14).map((r) => ({ day: r.day, value: r.operatingProfit }))) : null,
    );
    const storeCards = c.stores.map((entry) => {
      const st = storeStatus(s, entry);
      const active = entry.id === c.activeStoreId;
      const r = last ? storeReport(s, entry, last.day) : null;
      const mgr = st.employees.find((e) => e.id === entry.managerId) ?? null;
      const prop = storeProperty(entry);
      const name = storeDisplayName(s, entry);
      const status = active ? '🧑‍🍳 いまここ（あなたが営業）' : entry.snapshot && entry.snapshot.closedForConstruction > 0 ? '🛠 準備中' : mgr ? '👔 店長が営業' : '⛔ 店長がいないため休業';
      const fulls = st.employees.filter((e) => e.profile.employment === 'full');
      const pol = entry.policy;
      const problem = active ? null : enterStoreProblem(s, entry.id);
      return h(
        'section',
        { class: 'card store-card', 'data-store': entry.id },
        h('h4', null, name),
        entry.propertyId !== 'home'
          ? this.renameRow('店名', entry.name, 'data-rename-store', entry.id, (v) => void this.act({ type: 'renameStore', storeId: entry.id, name: v }, `店名を「${v}」にしました`))
          : null,
        row('状態', status),
        row('場所', entry.location ? locationLabel(entry.location) : '未設定（標準の数字）'),
        row('立地', `${prop.area}（来客 ×${storeDemandMult(entry).toFixed(2)}・家賃 ×${storeRentMult(entry).toFixed(2)}）`),
        !entry.location && this.host.isHost
          ? h('button', { class: 'btn ghost', 'data-set-location': entry.id, onclick: () => this.openLocationMap(entry.id) }, '🗾 この店の場所を決める（1回だけ）')
          : null,
        row('広さ', STAGES[st.stage]?.name ?? ''),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '営業時間'),
          h('b', { 'data-store-hours': entry.id }, hoursSummary(entry.hours ?? DEFAULT_HOURS)),
        ),
        this.host.isHost ? h('button', { class: 'mini', 'data-edit-hours': entry.id, onclick: () => void this.editHours(entry) }, '🕒 営業時間を変える') : null,
        row('評判', `${stars(st.reputation)} ${st.reputation.toFixed(2)}`),
        row('従業員', `${st.employees.length}人`),
        r ? row(`${r.day}日目`, `純売上 ${yenStr(r.netSales ?? r.sales - r.refunds)}・営業利益 ${yenStr(r.operatingProfit)}・${r.served}杯${r.managed === 'manager' ? '（店長）' : r.managed === 'closed' ? '（休業）' : ''}`, r.operatingProfit < 0 ? 'bad' : '') : null,
        h(
          'div',
          { class: 'kv' },
          h('span', null, '店長'),
          h(
            'select',
            {
              'data-manager': entry.id,
              onchange: (ev: Event) => {
                const v = (ev.target as HTMLSelectElement).value;
                void this.act({ type: 'assignManager', storeId: entry.id, employeeId: v === '' ? null : v }, v === '' ? '店長を外しました' : undefined);
              },
            },
            h('option', { value: '', selected: !mgr }, active ? '（なし: あなたが営業）' : '（なし: 休業）'),
            fulls.map((e) => h('option', { value: e.id, selected: e.id === entry.managerId }, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`)),
          ),
        ),
        fulls.length === 0 ? h('p', { class: 'note' }, '店長は社員から選びます（従業員のタブでアルバイトを社員にできます）') : null,
        h('p', { class: 'note' }, '店長の営業の方針（プレイヤーがいない日に使う）'),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '価格'),
          h(
            'select',
            { 'data-policy-price': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { priceMult: Number((ev.target as HTMLSelectElement).value) } }) },
            [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3].map((m) => h('option', { value: String(m), selected: Math.abs(m - pol.priceMult) < 1e-6 }, m === 1 ? '定価' : `定価の${pct(m)}`)),
          ),
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '定期メンテ'),
          h('input', { type: 'checkbox', checked: pol.maintenance, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { maintenance: (ev.target as HTMLInputElement).checked } }) }),
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '1日の広告費'),
          h(
            'select',
            { 'data-policy-ads': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { adBudget: Number((ev.target as HTMLSelectElement).value) } }) },
            BALANCE.ads.choices.map((v) => h('option', { value: String(v), selected: v === adBudgetOf(entry) }, v === 0 ? '出さない' : yenStr(v))),
          ),
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '人手が足りない日'),
          h(
            'select',
            { 'data-policy-temp': entry.id, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { tempWhenShort: (ev.target as HTMLSelectElement).value === '1' } }) },
            h('option', { value: '0', selected: !pol.tempWhenShort }, '短期バイトを呼ばない'),
            h('option', { value: '1', selected: !!pol.tempWhenShort }, '短期バイトを1人呼ぶ'),
          ),
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '在庫の安全基準'),
          h(
            'select',
            { onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { safetyStock: Number((ev.target as HTMLSelectElement).value) } }) },
            [0.9, 1, 1.2, 1.5].map((v) => h('option', { value: String(v), selected: Math.abs(v - (pol.safetyStock ?? 1)) < 1e-6 }, v === 1 ? 'ふつう' : v < 1 ? '少なめ' : `多め（×${v}）`)),
          ),
        ),
        h(
          'div',
          { class: 'kv' },
          h('span', null, '1日の修理費の上限'),
          h(
            'select',
            { onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { repairCap: Number((ev.target as HTMLSelectElement).value) } }) },
            [5_000, 10_000, 30_000, 60_000, 100_000].map((v) => h('option', { value: String(v), selected: v === pol.repairCap }, yenStr(v))),
          ),
        ),
        active
          ? null
          : h(
              'button',
              {
                class: 'btn primary',
                'data-enter': entry.id,
                disabled: !!problem,
                onclick: async () => {
                  const cur = activeStore(s);
                  const leave = cur.managerId ? '店長の営業になります' : '店長がいないので休業になります（家賃などはかかります）';
                  if (await confirmDialog(this.root, '店に入る', `明日は${name}で営業します。${storeDisplayName(s, cur)}は${leave}。`, 'この店に入る')) await this.act({ type: 'enterStore', storeId: entry.id }, `${name}に入りました`);
                },
              },
              'この店に入る（明日からここで営業）',
            ),
        problem && !active ? h('p', { class: 'note' }, problem) : null,
      );
    });
    // 出店
    const used = new Set(c.stores.map((x) => x.propertyId));
    const candidates = PROPERTY_CANDIDATES.filter((id) => !used.has(id)).map((id) => PROPERTIES[id]!);
    const B = BALANCE.company;
    const openCard = h(
      'section',
      { class: 'card wide' },
      h('h4', null, '出店（2店舗目以降）'),
      h('p', { class: 'note' }, `条件: ${STAGES[B.unlockStage]?.seats.length ?? 12}席以上で評判★${B.unlockReputation.toFixed(1)}以上の店があること、店長にする社員（今の店から移ります）、初期費用＋運転資金 ${yenStr(B.minFundsAfterOpen)}。閉店後に出店できます。`),
      fullStaff.length === 0 ? h('p', { class: 'note' }, '店長にする社員がいません（従業員のタブでアルバイトを社員にできます）') : null,
      h(
        'button',
        { class: 'btn primary', 'data-open-map': '', disabled: !this.host.isHost || fullStaff.length === 0 || candidates.length === 0, onclick: () => this.openStoreMapForNew(s) },
        '🗾 地図で出店先を選ぶ',
      ),
      h('p', { class: 'note' }, '全国の市区町村に、駅前・住宅街・郊外の3つの候補地があります。人口の多い街は客が少し多く、家賃も少し高くなります。'),
    );
    // 異動（今の店の従業員をほかの店へ）
    const others = c.stores.filter((x) => x.id !== c.activeStoreId);
    const moveCard =
      others.length > 0 && s.employees.length > 0
        ? h(
            'section',
            { class: 'card wide' },
            h('h4', null, '異動（今の店の従業員をほかの店へ）'),
            h('p', { class: 'note' }, '閉店後にできます。店長の営業では、従業員の担当と能力で出せる杯数が増えます。'),
            h(
              'div',
              { class: 'table' },
              s.employees.map((e) => {
                const sel = h('select', null, others.map((x) => h('option', { value: x.id }, storeDisplayName(s, x))));
                return h(
                  'div',
                  { class: 'trow' },
                  h('div', { class: 'tname' }, e.profile.name, h('small', null, `${ROLE_LABEL[e.profile.role]}・${e.profile.employment === 'full' ? '社員' : 'アルバイト'}`)),
                  sel,
                  h('button', { class: 'mini', disabled: !closed, onclick: () => void this.act({ type: 'transferEmployee', employeeId: e.id, toStoreId: (sel as HTMLSelectElement).value }, '異動しました') }, '異動する'),
                );
              }),
            ),
          )
        : null;
    return h('div', { class: 'grid2' }, finance, ...storeCards, openCard, moveCard);
  }

  // ───────────────── 営業時間（じろ1 5.1） ─────────────────
  private hoursCard(s: GameState, entry: StoreEntry): HTMLElement {
    const set = entry.hours ?? DEFAULT_HOURS;
    const today = todayHours(s);
    const changed = hoursSummary(today) !== hoursSummary(set);
    const row = (k: string, v: string, attr: Record<string, string> = {}) => h('div', { class: 'kv' }, h('span', null, k), h('b', attr, v));
    return h(
      'section',
      { class: 'card hours-card', 'data-hours-card': entry.id },
      h('h4', null, '🕒 営業時間'),
      row(changed ? '次の営業日から' : '設定', hoursSummary(set), { 'data-hours-set': '1' }),
      changed ? row('今日', hoursSummary(today)) : null,
      this.host.isHost ? h('button', { class: 'btn ghost', 'data-edit-hours': entry.id, onclick: () => void this.editHours(entry) }, '🕒 営業時間・定休日を変える') : null,
      h('p', { class: 'note' }, '昼・夜など営業の枠を3つまでと、定休日を決められます。長く開けると客は増えますが、光熱費と給料も増えます。'),
    );
  }

  private async editHours(entry: StoreEntry): Promise<void> {
    const s = this.host.state;
    const next = await hoursDialog(this.root, `営業時間 — ${storeDisplayName(s, entry)}`, entry.hours ?? DEFAULT_HOURS);
    if (next) await this.act({ type: 'setStoreHours', storeId: entry.id, hours: next }, '営業時間を決めました（次の営業日から）');
  }

  // ───────────────── 経営ダッシュボード（じろ1 P6: 数字のカード・お金の流れ・2週間の利益・気をつけること） ─────────────────
  private dash(s: GameState): HTMLElement {
    const d = s.today;
    const op = operatingProfit(d);
    const net = d.sales - d.refunds;
    const fc = fixedCosts(s);
    const avgSat = d.satisfactionCount > 0 ? d.satisfactionSum / d.satisfactionCount : 0;
    const avgWait = d.served > 0 ? d.totalSeatWait / d.served : 0;
    const arrears = s.arrears.reduce((a, b) => a + b.amount, 0);
    const loan = s.loans.reduce((a, b) => a + b.remaining, 0);
    const lowStock = ['yasai', 'buta', 'garlic', 'abura', 'tare', 'noodle'].filter((id) => stockOf(s, id) < (id === 'noodle' ? 1500 : id === 'buta' ? 6 : 100));
    const row = (k: string, v: string, cls = '') => h('div', { class: `kv compact ${cls}` }, h('span', null, k), h('b', null, v));
    const hist = s.history.slice(-14);
    const prev = s.history.filter((r) => r.day < s.day).slice(-1)[0] ?? null;
    const repDelta = delta(s.reputation, prev ? prev.reputation : null, (v) => v.toFixed(2));
    const cashDelta = s.phase === 'closed' && s.history[s.history.length - 1]?.day === s.day ? s.history[s.history.length - 1]! : null;
    // ── 数字のカード ──
    const kpis = kpiRow([
      kpi('現在資金', yenStr(s.money), cashDelta ? `今日 ${yenSigned(cashDelta.cashEnd - cashDelta.cashStart, true)}` : `翌営業日の支出 ${yenStr(fc.total)}`, s.money < fc.total ? 'bad' : '', cashDelta ? (cashDelta.cashEnd >= cashDelta.cashStart ? 'good' : 'bad') : '', { 'data-kpi': 'cash' }),
      kpi('今日の営業利益', yenSigned(op, true), `純売上 ${yenStr(net)}`, op > 0 ? 'good' : op < 0 ? 'bad' : '', '', { 'data-kpi': 'op' }),
      kpi('評判', `★ ${s.reputation.toFixed(2)}`, `${repDelta ? `${repDelta.text}・` : ''}常連 ${s.regulars.length}人`, 'accent', repDelta?.tone ?? '', { 'data-kpi': 'rep' }),
      kpi('提供 / 来客', `${d.served}杯 / ${d.customers}人`, d.lost + d.balked > 0 ? `帰った客 ${d.lost}人・諦めた ${d.balked}人` : '帰った客なし', '', d.lost > 0 ? 'warn' : '', { 'data-kpi': 'served' }),
    ]);
    // ── 気をつけること（色付きの短い文。ボタンで対応できるものはボタンを付ける） ──
    const alerts: HTMLElement[] = [];
    const goTab = (tab: ManageTab, label: string) => h('button', { class: 'mini', onclick: () => { this.tab = tab; this.render(); this.body.scrollTop = 0; } }, label);
    if (arrears > 0) alerts.push(alertBox('bad', `未払金 ${yenStr(arrears)}（期限までに払わないと破産します）`, h('button', { class: 'mini', onclick: () => this.act({ type: 'payArrears' }, '未払金を支払いました') }, '未払金を支払う')));
    if (s.money < fc.total) alerts.push(alertBox('bad', `資金が翌営業日の支出（${yenStr(fc.total)}）より少ない`));
    if (lowStock.length > 0) alerts.push(alertBox('bad', `在庫不足: ${lowStock.map((id) => INGREDIENTS[id]?.name ?? id).join('・')}`, goTab('stock', '発注を見る')));
    if (d.lost > 0) alerts.push(alertBox('warn', `途中で帰った客 ${d.lost}人（待ちすぎ・品切れ）。人手か席を増やすと減ります`));
    if (d.stockouts > 0) alerts.push(alertBox('warn', `品切れ ${d.stockouts}回`, goTab('stock', '在庫を見る')));
    if (d.breakdowns > 0) alerts.push(alertBox('warn', `設備故障 ${d.breakdowns}回（定期メンテで減らせます）`, goTab('equip', '設備を見る')));
    if (loan > 0) alerts.push(alertBox('info', `融資の残り ${yenStr(loan)}`));
    // 店長のあすの予測（閉店後。オーナーの指示 2026-11-11）
    const fcst = s.phase === 'closed' ? s.history.at(-1)?.managerOrder?.forecast : undefined;
    if (fcst) alerts.push(alertBox('info', `店長のあすの予測 — ${forecastText(fcst)}`));
    if (d.managerExpress) alerts.push(alertBox('warn', `店長が当日便で仕入れた: ${d.managerExpress.packs}パック ${yenStr(d.managerExpress.spent)}（前の晩の発注が足りなかった分）`));
    if (buzzBoostFactor(s) > 1) alerts.push(alertBox('good', `🎥 SNSの話題になりやすさ ×${buzzBoostFactor(s).toFixed(1)}（${Math.max(...(s.events?.buzzBoosts ?? []).map((b) => b.untilDay))}日目まで）`));
    for (const e of (s.events?.effects ?? []).filter((x) => x.source === 'tv' && (x.fromDay ?? 0) >= s.day)) alerts.push(alertBox('good', `📺 テレビ放送の反響（${e.fromDay}日目） 来客 ×${e.mult.toFixed(1)}`));
    if (loanAvailable(s)) alerts.push(alertBox('info', '資金が足りないときは銀行の融資を受けられます（額を選べる）', loanControl(this.root, s, (amount) => this.act({ type: 'takeLoan', amount }, '融資を受けました'))));
    if (alerts.length === 0) alerts.push(alertBox('good', '特に気をつけることはありません'));
    // ── お金の流れ（純売上を100%として、費用と利益） ──
    const flow = flowBar(
      [
        { label: '原価', value: d.cogs + d.waste, color: '#e0a457' },
        { label: '人件費', value: d.wages, color: '#6fb3e0' },
        { label: '家賃', value: d.rent, color: '#b48ad6' },
        { label: 'その他', value: d.upkeep + d.utilities + d.repairs + d.hiring + (d.ads ?? 0), color: '#9aa3ad' },
      ],
      op,
    );
    return h(
      'div',
      null,
      h('p', { class: 'dash-title' }, `${storeDisplayName(s, activeStore(s))} — ${s.day}日目・${STAGES[s.career.stage]?.name ?? ''}`),
      kpis,
      h(
        'div',
        { class: 'grid2' },
        h(
          'section',
          { class: 'card' },
          cardHead('本日の損益（お金の流れ）', '家賃・給与・維持費・基本光熱費は閉店後の精算で計上されます。食材の仕入れは在庫（資産）になり、使ったときに原価になります。仕入れと設備投資は現金の支出で、損益には入りません。'),
          flow,
          row('売上', yenStr(d.sales)),
          d.refunds > 0 ? row('返金', `−${yenStr(d.refunds)}`) : null,
          row('食材原価＋廃棄', `−${yenStr(d.cogs + d.waste)}`, d.waste > 0 ? 'warn' : ''),
          row('人件費', `−${yenStr(d.wages)}`),
          row('家賃', `−${yenStr(d.rent)}`),
          row('光熱費・維持費・修理', `−${yenStr(d.utilities + d.upkeep + d.repairs)}`),
          d.hiring > 0 ? row('採用・解雇', `−${yenStr(d.hiring)}`) : null,
          (d.ads ?? 0) > 0 ? row('広告', `−${yenStr(d.ads ?? 0)}`) : null,
          row('営業利益', yenSigned(op, true), op < 0 ? 'bad' : 'good'),
          d.interest > 0 ? row('利息（融資）', `−${yenStr(d.interest)}`) : null,
          d.interest > 0 ? row('最終利益', yenSigned(op - d.interest, true), op - d.interest < 0 ? 'bad' : 'good') : null,
          row('仕入れ・設備投資（現金の支出）', `${yenStr(d.purchases)}・${yenStr(d.capex)}`),
        ),
        h('section', { class: 'card' }, cardHead('この2週間の営業利益'), profitBars(hist.map((r) => ({ day: r.day, value: r.operatingProfit })))),
        h('section', { class: 'card', 'data-alerts': '' }, cardHead('気をつけること'), h('div', { class: 'alerts' }, alerts)),
        h(
          'section',
          { class: 'card' },
          cardHead('本日の営業', '平均待ち時間は、席に着いてから提供されるまで。帰った客は、待ちすぎ・品切れで食べずに帰った人。諦めた客は、行列を見て並ばなかった人です。'),
          row('来客数', `${d.customers}人`),
          row('提供数', `${d.served}杯`),
          row('途中で帰った客', `${d.lost}人`, d.lost > 0 ? 'warn' : ''),
          row('行列を見て諦めた客', `${d.balked}人`),
          row('平均待ち時間（着席→提供）', `${avgWait.toFixed(0)}秒`),
          row('平均満足度', `${Math.round(avgSat * 100)}%`),
          row('注文ミス / クレーム', `${d.mistakes} / ${d.complaints}`),
          row('品切れ / 設備故障', `${d.stockouts}回 / ${d.breakdowns}回`, d.stockouts > 0 ? 'warn' : ''),
        ),
        h(
          'section',
          { class: 'card' },
          cardHead('翌営業日の予測支出'),
          row('家賃', yenStr(fc.rent)),
          row('給与', yenStr(fc.wages)),
          row('設備維持費', yenStr(fc.upkeep)),
          row('光熱費（基本）', yenStr(fc.utilities)),
          fc.loans > 0 ? row('融資返済＋利息', yenStr(fc.loans)) : null,
          row('合計', yenStr(fc.total), s.money < fc.total ? 'bad' : ''),
        ),
        this.hoursCard(s, activeStore(s)),
      h(
        'section',
        { class: 'card wide rename-card' },
        h('h4', null, '店名（屋号）'),
        this.renameRow('屋号', s.shopName, 'data-rename-shop', '', (v) => void this.act({ type: 'rename', name: v }, `店名を「${v}」にしました`)),
        (() => {
          const home = s.company.stores.find((x) => x.propertyId === 'home');
          if (!home) return null;
          return h(
            'div',
            { class: 'kv' },
            h('span', null, '本店の場所'),
            home.location
              ? h('b', { 'data-home-location': home.location }, locationLabel(home.location))
              : this.host.isHost
                ? h('button', { class: 'btn ghost', 'data-set-location': home.id, onclick: () => this.openLocationMap(home.id) }, '🗾 地図で決める（1回だけ）')
                : h('b', null, '未設定'),
          );
        })(),
        h(
          'p',
          { class: 'note' },
          `看板・日報・市場の順位に出る名前です（${STORE_NAME_MAX}文字まで）。2店目以降で自動で付けた名前（「〇〇 駅前店」など）も新しい屋号に合わせます。2店目以降の名前は「会社」で1店ずつ変えられます。`,
        ),
      ),
      s.notices.length > 0
        ? h(
            'section',
            { class: 'card wide' },
            h('h4', null, 'お知らせ'),
            s.notices.slice(-8).reverse().map((n) => h('div', { class: `notice ${n.level}` }, n.text)),
          )
        : null,
      ),
    );
  }

  // ───────────────── 在庫・発注 ─────────────────
  private stock(s: GameState): HTMLElement {
    const purch = Object.values(INGREDIENTS).filter((d) => d.purchasable && isUnlocked(s, d.unlock));
    const prepared = Object.values(INGREDIENTS).filter((d) => !d.purchasable && isUnlocked(s, d.unlock));
    const cap = fridgeCapacity(s);
    const used = fridgeUsage(s, true);
    const fill = used / Math.max(1, cap);
    // 在庫が少ない: 自動発注の目安の3割より少ない（届く予定を入れる）
    const low = purch.filter((d) => (s.autoOrder[d.id] ?? 0) > 0 && stockOf(s, d.id) + pendingOf(s, d.id) < (s.autoOrder[d.id] ?? 0) * 0.3);
    const last = s.history.at(-1);
    const express = s.deliveries.filter((d) => d.arriveAt !== null).length;
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('冷蔵庫', `${Math.round(used)} / ${cap}kg`, `${Math.round(fill * 100)}%（届く予定を含む）`, fill >= 0.9 ? 'warn' : '', fill >= 0.9 ? 'warn' : '', { 'data-kpi': 'fridge' }),
          kpi('在庫が少ない', `${low.length}品`, low.length > 0 ? low.slice(0, 2).map((d) => d.name.replace(/（.*）/, '')).join('・') : '足りています', low.length > 0 ? 'bad' : '', low.length > 0 ? 'bad' : 'good'),
          kpi('届く予定', `${s.deliveries.length}件`, express > 0 ? `当日便 ${express}件` : s.deliveries.length > 0 ? 'あすの朝' : null),
          kpi('きのうの原価', last ? yenSigned(last.cogs) : '—', last ? `廃棄 ${yenSigned(last.waste)}` : null, '', last && last.waste > last.cogs * 0.15 ? 'warn' : ''),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead(
          '仕入れ',
          '翌朝便は通常価格で翌日の開店前に届きます。当日便は3割高で約60秒後に届きます。自動発注は閉店後に目標在庫まで翌朝便で発注します。「売れ行きに合わせる」は、最近3日の使用量に余裕をみた量まで発注します（品切れした食材は多めに。冷蔵庫に入りきらないときは比例して減らします。目安の量の半分は必ず持ちます）。値段は店の場所の物価で変わります。',
        ),
        h(
          'div',
          { class: 'row wrap auto-mode' },
          h('span', null, '自動発注のしかた:'),
          h('button', { class: `mini ${s.autoOrderMode !== 'sales' ? 'on' : 'ghost'}`, 'data-mode': 'manual', onclick: () => this.act({ type: 'setAutoOrderMode', mode: 'manual' }, '自動発注を「目安の量まで」にしました') }, '目安の量まで'),
          h('button', { class: `mini ${s.autoOrderMode === 'sales' ? 'on' : 'ghost'}`, 'data-mode': 'sales', onclick: () => this.act({ type: 'setAutoOrderMode', mode: 'sales' }, '自動発注を「売れ行きに合わせる」にしました') }, '売れ行きに合わせる'),
        ),
        this.managerOrderRow(s),
        h(
          'div',
          { class: 'table' },
          purch.map((d) => {
            // 店の場所の物価を入れた1パックの値段（じろ1 5.5）
            const pack = packPriceOf(s, d.id);
            const target = s.autoOrder[d.id] ?? 0;
            return h(
              'div',
              { class: 'trow' },
              h('div', { class: 'tname' }, d.name, h('small', null, `在庫 ${Math.floor(stockOf(s, d.id)).toLocaleString('ja-JP')}${d.unit}${pendingOf(s, d.id) > 0 ? `（入荷予定 +${pendingOf(s, d.id).toLocaleString('ja-JP')}）` : ''}`)),
              h('div', { class: 'tsub' }, `${d.packQty.toLocaleString('ja-JP')}${d.unit} / ${yenStr(pack)}`),
              h(
                'div',
                { class: 'tbtns' },
                h('button', { class: 'mini', onclick: () => this.act({ type: 'orderStock', itemId: d.id, packs: 1, express: false }, `${d.name}を発注（翌朝便）`) }, '翌朝便'),
                h('button', { class: 'mini warn', onclick: () => this.act({ type: 'orderStock', itemId: d.id, packs: 1, express: true }, `${d.name}を発注（当日便）`) }, '当日便'),
              ),
              h(
                'div',
                { class: 'tauto' },
                h('span', null, '自動:'),
                h('button', { class: 'mini ghost', onclick: () => this.act({ type: 'setAutoOrder', itemId: d.id, qty: Math.max(0, target - d.packQty) }) }, '−'),
                h('b', null, target > 0 ? `${target.toLocaleString('ja-JP')}${d.unit}` : 'なし'),
                h('button', { class: 'mini ghost', onclick: () => this.act({ type: 'setAutoOrder', itemId: d.id, qty: target + d.packQty }) }, '＋'),
                s.autoOrderMode === 'sales' && target > 0 ? h('small', { class: 'auto-now' }, `今夜の目安 ${autoOrderTarget(s, d.id).toLocaleString('ja-JP')}${d.unit}`) : null,
              ),
            );
          }),
        ),
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead('仕込み品（店内で作る）', '仕込み: 豚を煮込む→（煮豚・タレ）→ 仕込み台で豚を切る / 野菜ゆで釜でヤサイ / 仕込み台でニンニクを刻む / 煮込み鍋で背脂を炊く / 寸胴でスープを炊く。'),
        this.prepTargetRows(s),
        h('div', { class: 'table' }, prepared.map((d) => h('div', { class: 'trow' }, h('div', { class: 'tname' }, d.name), h('div', { class: 'tsub' }, `${Math.floor(stockOf(s, d.id)).toLocaleString('ja-JP')}${d.unit}`), h('div', { class: 'tsub' }, d.shelfLifeDays === 0 ? '当日限り' : `${d.shelfLifeDays}日もつ`)))),
      ),
    );
  }

  /** 翌朝便の発注をだれがするか（店長がいる店だけ。じろ1 5.8）と、店長の発注の実績 */
  private managerOrderRow(s: GameState): HTMLElement | null {
    if (!s.company) return null;
    const st = activeStore(s);
    const mgr = st.managerId ? s.employees.find((e) => e.id === st.managerId) : null;
    if (!mgr) return null;
    const byMgr = st.policy.orderBy !== 'self';
    const last = s.history.at(-1)?.managerOrder;
    const set = (orderBy: 'manager' | 'self', msg: string) => this.act({ type: 'setStorePolicy', storeId: st.id, policy: { orderBy } }, msg);
    return h(
      'div',
      { class: 'manager-order', 'data-manager-order': byMgr ? 'manager' : 'self' },
      h(
        'div',
        { class: 'row wrap' },
        h('span', null, '翌朝便の発注:'),
        h('button', { class: `mini ${byMgr ? 'on' : 'ghost'}`, onclick: () => set('manager', `店長（${mgr.profile.name}さん）に発注を任せました`) }, `🧑‍🍳 店長に任せる`),
        h('button', { class: `mini ${!byMgr ? 'on' : 'ghost'}`, onclick: () => set('self', '発注を自分の設定にしました') }, '自分の設定で'),
      ),
      h(
        'p',
        { class: 'note' },
        byMgr
          ? `店長の${mgr.profile.name}さんが、営業中は閉店までに足りなくなりそうな材料を当日便で先に仕入れ、閉店後はその日の売れ行き・あすの曜日と営業時間・定休日から来客を予測して翌朝便を発注します。仕込み品が切れそうなときは先に仕込みます（下の「自動」の目安が0の食材は発注しません。手元に翌日の固定費の2日分を残します）。${last ? `前回: ${yenStr(last.spent)}・${last.packs}パック${last.skipped > 0 ? `（資金が少なく${last.skipped}パック減らした）` : ''}` : ''}`
          : '下の自動発注の設定のとおりに発注します（当日便も自分で頼みます）。',
      ),
      byMgr && last?.forecast ? h('p', { class: 'note', 'data-manager-forecast': '1' }, `店長のあすの予測: ${forecastText(last.forecast)}`) : null,
      byMgr && s.today.managerExpress ? h('p', { class: 'note warn' }, `今日の当日便: ${s.today.managerExpress.packs}パック ${yenStr(s.today.managerExpress.spent)}`) : null,
    );
  }

  /** 仕込みの目安（品ごとに「自動」か量。じろ1 5.8） */
  private prepTargetRows(s: GameState): HTMLElement {
    const items = prepTargetItems().filter((x) => isUnlocked(s, INGREDIENTS[x.itemId]?.unlock));
    return h(
      'div',
      { class: 'prep-targets' },
      h('p', { class: 'note' }, '仕込みの目安: 在庫がこの量より少なくなったら、店員が仕込みます。「自動」は売れ行きから決めます（ピークの時間に足りる量）。'),
      h(
        'div',
        { class: 'table' },
        items.map(({ itemId, minQty }) => {
          const d = INGREDIENTS[itemId]!;
          const cur = s.prepTargets?.[itemId];
          const opts: [string, string][] = [['', '自動']];
          for (const k of [1, 2, 3, 5, 8]) opts.push([String(minQty * k), `${(minQty * k).toLocaleString('ja-JP')}${d.unit}`]);
          if (cur !== undefined && !opts.some(([v]) => v === String(cur))) opts.push([String(cur), `${cur.toLocaleString('ja-JP')}${d.unit}`]);
          return h(
            'div',
            { class: 'trow' },
            h('div', { class: 'tname' }, d.name, h('small', null, `在庫 ${Math.floor(stockOf(s, itemId)).toLocaleString('ja-JP')}${d.unit}`)),
            h(
              'select',
              {
                class: 'select',
                'data-prep-target': itemId,
                onchange: (ev: Event) => {
                  const v = (ev.target as HTMLSelectElement).value;
                  void this.act({ type: 'setPrepTarget', itemId, qty: v === '' ? null : Number(v) }, `${d.name}の仕込みの目安を${v === '' ? '自動' : `${Number(v).toLocaleString('ja-JP')}${d.unit}`}にしました`);
                },
              },
              opts.map(([v, label]) => h('option', { value: v, selected: v === (cur === undefined ? '' : String(cur)) }, label)),
            ),
          );
        }),
      ),
    );
  }

  // ───────────────── メニュー ─────────────────
  private menu(s: GameState): HTMLElement {
    const editable = s.phase !== 'open' && s.phase !== 'closing';
    const live = Object.values(MENU).filter((m) => isUnlocked(s, m.unlock) && !s.pausedMenu.includes(m.id));
    const ratio = live.length > 0 ? live.reduce((a, m) => a + (s.prices[m.id] ?? m.defaultPrice) / m.defaultPrice, 0) / live.length : 1;
    const last = s.history.filter((r) => r.served > 0).at(-1);
    const ticket = last ? (last.sales - last.refunds) / last.served : null;
    const ad = adBudgetOf(activeStore(s));
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('販売中のメニュー', `${live.length}品`, `全${Object.keys(MENU).length}品`),
          kpi('定価に対する値段', `${Math.round(ratio * 100)}%`, ratio > 1.05 ? '高め（客が減りやすい）' : ratio < 0.95 ? '安め（客が増えやすい）' : '定価くらい', '', ratio > 1.05 ? 'warn' : ''),
          kpi('客単価（最後の営業日）', ticket !== null ? yenSigned(ticket) : '—', last ? `${last.day}日目・${last.served}杯` : null),
          kpi('広告', ad > 0 ? `${yenSigned(ad)}/日` : 'なし', ad > 0 ? `来客 +${Math.round((adFactor(ad) - 1) * 100)}%` : null),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead('メニューと価格', '定価より高いと来客が減り、安いと増えます。高すぎる値段は「値段に見合わない」と感じられ、満足度・口コミ・常連にも効きます。'),
        h(
          'p',
          { class: 'note', 'data-price-note': '' },
          (() => {
            // 地域の値段の感じ方（じろ1 5.5）: 都会・所得の高い地域は高めでも来て、田舎・所得の低い地域は高いと離れやすい
            const l = locationInfo(activeStore(s).location);
            const feel = !l ? '' : l.tolerance > 1.005 ? `この地域は定価の${Math.round((l.tolerance - 1) * 100)}%増しまでなら客が減りにくい。` : l.priceSensitivity > 1.005 ? 'この地域は定価より高いと客が離れやすく、量の多い品が好まれます。' : '';
            return `営業時間外に ¥${BALANCE.priceMin.toLocaleString('ja-JP')}〜¥${BALANCE.priceMax.toLocaleString('ja-JP')} で変えられます。${feel}`;
          })(),
        ),
        Object.values(MENU).map((m) => {
          const unlocked = isUnlocked(s, m.unlock);
          const price = s.prices[m.id] ?? m.defaultPrice;
          const paused = s.pausedMenu.includes(m.id);
          if (!unlocked) return h('div', { class: 'trow locked' }, h('div', { class: 'tname' }, `🔒 ${m.name}`), h('div', { class: 'tsub' }, UNLOCK_NAMES[m.unlock ?? ''] ? 'キャリア目標で解放' : ''));
          return h(
            'div',
            { class: 'trow' },
            h('div', { class: 'tname' }, m.name, h('small', null, `麺${m.noodleG}g・豚${m.buta}枚${soldOut(s, m.id) ? '・売切' : ''}`)),
            h(
              'div',
              { class: 'tbtns' },
              h('button', { class: 'mini ghost', disabled: !editable, onclick: () => this.act({ type: 'setPrice', menuId: m.id, price: price - 50 }) }, '−50'),
              h('b', { class: 'price' }, yenStr(price)),
              h('button', { class: 'mini ghost', disabled: !editable, onclick: () => this.act({ type: 'setPrice', menuId: m.id, price: price + 50 }) }, '+50'),
            ),
            h('button', { class: `mini ${paused ? 'warn' : 'ghost'}`, onclick: () => this.act({ type: 'pauseMenu', menuId: m.id, paused: !paused }) }, paused ? '販売停止中' : '販売中'),
          );
        }),
      ),
      this.adsCard(s),
      h(
        'section',
        { class: 'card wide' },
        cardHead('無料トッピング（コール）', '客は食券を出したあと、麺がゆで上がる頃に「ニンニク入れますか？」と聞かれてコールします。コールを聞いてから盛り付けましょう。'),
        Object.values(CALLS).map((c) => h('div', { class: 'kv' }, h('span', null, c.name), h('b', null, c.levels.map((l) => l.label).join(' / ')))),
      ),
    );
  }

  /** 広告（店ごとの1日の広告費。開店のときに払う。オーナーの判断 14「控えめ」） */
  private adsCard(s: GameState): HTMLElement {
    const entry = activeStore(s);
    const cur = adBudgetOf(entry);
    return h(
      'section',
      { class: 'card wide ads-card' },
      cardHead('広告', `1日の広告費を決めると、開店のときに払い、その日の来客が増えます（1日¥3,000で約+8%、どれだけ出しても+${Math.round(BALANCE.ads.max * 100)}%まで。効きは段々弱まります）。お金が足りない日は出しません。`),
      h(
        'div',
        { class: 'kv' },
        h('span', null, '1日の広告費'),
        h(
          'select',
          { 'data-ad-budget': entry.id, disabled: !this.host.isHost, onchange: (ev: Event) => void this.act({ type: 'setStorePolicy', storeId: entry.id, policy: { adBudget: Number((ev.target as HTMLSelectElement).value) } }) },
          BALANCE.ads.choices.map((v) => h('option', { value: String(v), selected: v === cur }, v === 0 ? '出さない' : `${yenStr(v)}（来客 +${Math.round((adFactor(v) - 1) * 100)}%）`)),
        ),
      ),
      (s.today.ads ?? 0) > 0 ? h('p', { class: 'note good' }, `今日は ${yenStr(s.today.ads ?? 0)} の広告を出しています`) : null,
    );
  }

  // ───────────────── 設備 ─────────────────
  private equip(s: GameState): HTMLElement {
    const owned = s.equipment;
    const shop = Object.values(EQUIPMENT);
    const ownedCount = (id: string) => owned.filter((e) => e.type === id).length;
    const broken = owned.filter((e) => e.status === 'broken').length;
    const worn = owned.filter((e) => e.status !== 'broken' && (e.status === 'faulty' || e.condition < 40)).length;
    const upkeep = owned.reduce((a, e) => a + (EQUIPMENT[e.type]?.upkeep ?? 0), 0);
    const booked = owned.filter((e) => e.maintenanceBooked).length;
    const repairable = owned.filter((e) => (EQUIPMENT[e.type]?.repairCost ?? 0) > 0).length;
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('設備', `${owned.length}台`, `丼 ${s.bowls.length}個`),
          kpi('故障・不調', `${broken + worn}台`, broken > 0 ? `故障 ${broken}台` : worn > 0 ? '状態が悪い' : 'なし', broken > 0 ? 'bad' : worn > 0 ? 'warn' : '', broken > 0 ? 'bad' : worn > 0 ? 'warn' : 'good'),
          kpi('維持費', `${yenSigned(upkeep)}/日`, null),
          kpi('自動メンテ', `${booked} / ${repairable}台`, booked < repairable ? 'OFFの設備は故障しやすい' : 'すべてON', '', booked < repairable ? 'warn' : 'good'),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead('所有している設備', `状態が下がると故障しやすくなります。自動メンテをONにすると、状態が${MAINTENANCE_THRESHOLD}%を下回った日の閉店後にメンテ（状態+40%）を行います。売ると買値の一部が戻ります。`),
        owned.map((e) => {
          const def = EQUIPMENT[e.type]!;
          const cond = Math.round(e.condition);
          return h(
            'div',
            { class: `trow ${e.status === 'broken' ? 'bad' : e.status === 'faulty' ? 'warn' : ''}` },
            h('div', { class: 'tname' }, def.name, h('small', null, `${STATUS_LABEL[e.status]}・状態${cond}%${def.w > 0 && !e.placed ? '・倉庫（未配置）' : ''}・維持費${yenStr(def.upkeep)}/日`)),
            h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${cond}%`, background: cond < 30 ? '#e74c3c' : cond < 60 ? '#f39c12' : '#2ecc71' } })),
            h(
              'div',
              { class: 'tbtns' },
              e.status !== 'normal' || cond < 95
                ? h('button', { class: `mini ${e.status === 'broken' ? 'danger' : ''}`, disabled: e.status === 'repairing', onclick: () => this.act({ type: 'repair', equipmentId: e.id }, '修理を依頼しました') }, e.status === 'repairing' ? '修理中' : `修理 ${yenStr(e.status === 'broken' ? def.repairCost : Math.round(def.repairCost * 0.5))}`)
                : null,
              def.repairCost > 0
                ? h('button', { class: `mini ${e.maintenanceBooked ? 'on' : 'ghost'}`, title: `ONにすると、状態が${MAINTENANCE_THRESHOLD}%を下回った日の閉店後にメンテ（状態+40%）を行います`, onclick: () => this.act({ type: 'maintenance', equipmentId: e.id, on: !e.maintenanceBooked }) }, `自動メンテ${e.maintenanceBooked ? 'ON' : 'OFF'}（1回${yenStr(maintenanceCost(e))}）`)
                : null,
              this.host.isHost
                ? h(
                    'button',
                    {
                      class: 'mini ghost',
                      onclick: async () => {
                        if (await confirmDialog(this.root, '設備の売却', `${def.name}を${yenStr(resaleValue(e))}で売却します。`, '売却する', true)) await this.act({ type: 'sellEquipment', equipmentId: e.id }, '売却しました');
                      },
                    },
                    `売却 ${yenStr(resaleValue(e))}`,
                  )
                : null,
            ),
          );
        }),
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead('設備を買う', '配置が必要な設備は空いている場所に置きます（置けなければ倉庫）。閉店後か仕込み時間に「店舗 → レイアウト編集」で動かせます。'),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', onclick: () => this.act({ type: 'buyBowls' }, `丼を${BOWL_PACK.qty}個買いました`) }, `丼を${BOWL_PACK.qty}個買う ${yenStr(BOWL_PACK.price)}（所有 ${s.bowls.length}個）`),
        ),
        shop.map((d) => {
          const unlocked = isUnlocked(s, d.unlock);
          const n = ownedCount(d.id);
          return h(
            'div',
            { class: `trow ${unlocked ? '' : 'locked'}` },
            h('div', { class: 'tname' }, `${unlocked ? '' : '🔒 '}${d.name}`, h('small', null, `${d.description}${d.upkeep ? ` 維持費${yenStr(d.upkeep)}/日` : ''}`)),
            h('div', { class: 'tsub' }, `所有 ${n}/${d.maxCount}`),
            h(
              'button',
              { class: 'mini', disabled: !unlocked || n >= d.maxCount, onclick: () => this.act({ type: 'buyEquipment', equipType: d.id, autoPlace: true }, `${d.name}を購入しました`) },
              unlocked ? yenStr(d.price) : UNLOCK_NAMES[d.unlock ?? ''] ? '未解放' : '未解放',
            ),
          );
        }),
      ),
    );
  }

  // ───────────────── 従業員 ─────────────────
  private staff(s: GameState): HTMLElement {
    const hiring = s.career.unlocked.includes('hiring');
    const wd = weekdayOf(s.day);
    const counts = new Map<string, number>();
    for (const e of s.employees) {
      const st = e.att && e.att.day === s.day ? ATTENDANCE_LABEL[e.att.status] : e.presentToday ? '勤務中' : '休み';
      counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    const today = [...counts].map(([k, n]) => `${k} ${n}`).join('・');
    const full = s.employees.filter((e) => !isPartTime(e)).length;
    const present = s.employees.filter((e) => e.presentToday).length;
    const tomorrowPay = s.employees.reduce((a, e) => a + expectedPay(e, s.day + 1, storeHours(s)), 0);
    const short = s.employees.length > 0 ? shiftTable(s).reduce((a, r) => a + r.cells.filter((c) => c.staff < c.need).length, 0) : 0;
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('従業員', `${s.employees.length}人`, `社員 ${full}・アルバイト ${s.employees.length - full}`),
          kpi('いま店にいる', `${present}人`, s.employees.length > 0 ? `${WEEKDAY_LABEL[wd]}曜` : null),
          kpi('あすの人件費の見込み', yenSigned(tomorrowPay), null),
          kpi('人が足りない時間', s.employees.length > 0 ? `週${short}時間` : '—', s.employees.length > 0 ? (short > 0 ? 'シフト表の赤い時間' : '足りています') : 'まだ雇っていません', '', short > 0 ? 'warn' : s.employees.length > 0 ? 'good' : ''),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `従業員（${s.employees.length}人）`),
        s.employees.length > 0 ? h('p', { class: 'note staff-today' }, `今日（${s.day}日目・${WEEKDAY_LABEL[wd]}曜）の出勤: ${today}`) : null,
        s.employees.length === 0 ? h('p', { class: 'note' }, hiring ? 'まだ誰も雇っていません。下の採用候補から雇えます（通常の採用は2日後から出勤。今日すぐ人手が要るときは短期バイト）。' : '採用はまだできません。') : null,
        s.employees.length > 0 ? this.teamCalendar(s) : null,
        s.employees.map((e) => this.staffCard(s, e)),
      ),
      s.employees.length > 0 ? this.shiftTableCard(s) : null,
      hiring
        ? h(
            'section',
            { class: 'card wide' },
            cardHead(
              '採用候補（毎朝入れ替わります）',
              `採用はアルバイトから（時給・シフト制）。採用は閉店後か仕込み時間にできます。手続きと研修があるので、出勤できるのは採用の${BALANCE.staff.hireDelayDays}日後からです。採用費はその場で、給与は働いた時間ぶんを閉店後の精算で支払います。アルバイトには出られる曜日（希望シフト）があります。真面目さや我慢強さは数字では分かりません。働きぶりは勤務の記録で確かめましょう。`,
            ),
            h('p', { class: 'note' }, `出勤できるのは採用の${BALANCE.staff.hireDelayDays}日後から。`),
            s.candidates.length === 0 ? h('p', { class: 'note' }, '今日の候補者はいません。') : null,
            s.candidates.map((c) =>
              h(
                'div',
                { class: 'emp' },
                h(
                  'div',
                  { class: 'trow' },
                  h('div', { class: 'tname' }, c.profile.name, h('small', null, `${ROLE_LABEL[c.profile.role]}・アルバイト・時給${yenStr(c.profile.hourly ?? Math.round(c.profile.wage / BALANCE.staff.employment.fullShiftHours / 10) * 10)}・採用費${yenStr(c.profile.hireFee)}${c.profile.wishDays ? `・出られる曜日 ${WEEKDAY_LABEL.filter((_, i) => c.profile.wishDays![i]).join('')}` : ''}`)),
                  h('button', { class: 'mini', onclick: () => this.act({ type: 'hire', candidateId: c.id }) }, '採用する'),
                ),
                lookLine(lookSeedOf(c)),
                this.skillBars(c.profile.skills),
              ),
            ),
          )
        : null,
      hiring ? this.tempCard(s) : null,
    );
  }

  /**
   * シフト表（オーナーの指示 2026-11-11）: 曜日 × 1時間ごとの、いる人数（店主を入れる）と必要な人数の目安。
   * 「シフトを自動で組む」と、店長がいる店は「店長に任せる / 自分で組む」
   */
  private shiftTableCard(s: GameState): HTMLElement {
    const hrs = storeHours(s);
    const rows = shiftTable(s, hrs);
    const st = s.company ? activeStore(s) : null;
    const mgr = st?.managerId ? s.employees.find((e) => e.id === st.managerId) : null;
    const byMgr = !!mgr && st!.policy.shiftBy !== 'self';
    const parts = s.employees.filter(isPartTime);
    const head = rows.find((r) => !r.closed)?.cells ?? [];
    const nameOf = (id: string) => s.employees.find((e) => e.id === id)?.profile.name ?? '';
    const shortCells = rows.reduce((a, r) => a + r.cells.filter((c) => c.staff < c.need).length, 0);
    return h(
      'section',
      { class: 'card wide shift-table-card', 'data-shift-table': '1' },
      cardHead(
        'シフト表（曜日ごとのくりかえし）',
        '数字は「いる人数 / 必要な人数の目安」（店主のあなたを1人と数えます）。必要な人数は、最近の来客と曜日・時間帯の客の多さから見積もります（1人で1時間に約12人）。赤は足りない時間、灰色は多すぎる時間です。日にちごとに入れた予定はここには出ません。営業時間を変えると、アルバイトのシフトは同じ時刻に働くように自動で直します。',
      ),
      mgr
        ? h(
            'div',
            { class: 'row wrap', 'data-shift-by': byMgr ? 'manager' : 'self' },
            h('span', null, 'シフトを組む人:'),
            h('button', { class: `mini ${byMgr ? 'on' : 'ghost'}`, disabled: !this.host.isHost, onclick: () => this.act({ type: 'setStorePolicy', storeId: st!.id, policy: { shiftBy: 'manager' } }, `店長（${mgr.profile.name}さん）にシフトを任せました`) }, '🧑‍🍳 店長に任せる'),
            h('button', { class: `mini ${!byMgr ? 'on' : 'ghost'}`, disabled: !this.host.isHost, onclick: () => this.act({ type: 'setStorePolicy', storeId: st!.id, policy: { shiftBy: 'self' } }, 'シフトを自分で組むことにしました') }, '自分で組む'),
          )
        : null,
      mgr ? h('p', { class: 'note' }, byMgr ? `店長の${mgr.profile.name}さんが、毎週日曜の閉店後に翌週のアルバイトのシフトを組み直します。` : 'アルバイトのシフトは自分で組みます（店長は組み直しません）。') : null,
      h(
        'div',
        { class: 'shift-table-wrap' },
        h(
          'table',
          { class: 'shift-table' },
          h('thead', null, h('tr', null, h('th', null, ''), head.map((c) => h('th', null, `${clockLabel(c.clock).replace(':00', '')}時`)))),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                { 'data-shift-row': String(r.weekday) },
                h('th', { title: r.partTimers.map((p) => `${nameOf(p.id)} ${this.shiftText(p.shift)}`).join('、') || 'アルバイトなし' }, WEEKDAY_LABEL[r.weekday]!),
                r.closed
                  ? h('td', { class: 'closed', colspan: String(Math.max(1, head.length)) }, '定休日')
                  : r.cells.map((c) =>
                      h('td', { class: c.staff < c.need ? 'short' : c.staff > c.need + 1 ? 'over' : 'ok', title: `来客の見込み 1時間に約${Math.round(c.customers)}人` }, `${c.staff}/${c.need}`),
                    ),
              ),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row wrap' },
        this.host.isHost && parts.length > 0
          ? h('button', { class: 'mini', 'data-auto-shifts': '1', onclick: () => this.act({ type: 'autoShifts' }) }, '🗓 シフトを自動で組む')
          : null,
        h('span', { class: `note${shortCells > 0 ? ' warn' : ''}` }, parts.length === 0 ? 'アルバイトを雇うと、シフトを自動で組めます' : shortCells > 0 ? `人が足りない時間が週に${shortCells}時間あります` : '人数は足りています'),
      ),
    );
  }

  /** 短期バイト（今日だけ。オーナーの判断 14） */
  private tempCard(s: GameState): HTMLElement {
    const max = BALANCE.staff.temp.maxPerDay;
    const used = s.employees.filter((e) => e.profile.temp).length;
    const can = s.phase === 'prep' && used < max && this.host.isHost;
    return h(
      'section',
      { class: 'card wide temp-card' },
      cardHead(`短期バイト（今日だけ・1日${max}人まで）`, `開店前（仕込みの間）に呼ぶと、すぐ来て今日だけ働きます。採用費はかからず、時給は通常の${BALANCE.staff.temp.wageMult}倍（${yenStr(tempHourly())}）、能力は新人並みです。人が足りない日に使います。`),
      h('p', { class: 'note' }, `時給 ${yenStr(tempHourly())}・採用費なし`),
      h(
        'div',
        { class: 'tbtns' },
        (['cook', 'server', 'cleaner'] as EmployeeRole[]).map((r) => h('button', { class: 'mini', 'data-temp': r, disabled: !can, onclick: () => this.act({ type: 'hireTemp', role: r }) }, `${ROLE_LABEL[r]}を呼ぶ`)),
      ),
      s.phase !== 'prep' ? h('p', { class: 'note' }, '開店前（仕込みの間）に呼べます') : used >= max ? h('p', { class: 'note' }, `今日はもう${max}人呼んでいます`) : null,
    );
  }

  /** 見える能力（勤怠・辛抱は隠しパラメータなので出さない） */
  /**
   * 能力のバー。採用したときの能力（灰色）と、働いて伸びた分（緑）を分けて見せる（じろ1 5.7）。
   * 採用したときの記録がない人（前のセーブ）は今の能力だけ
   */
  private skillBars(sk: Employee['profile']['skills'], init?: Employee['profile']['skills']): HTMLElement {
    const bar = (label: string, v: number, v0: number | undefined) => {
      const base = Math.round(Math.min(v, v0 ?? v) * 100);
      const grown = Math.max(0, Math.round(v * 100) - base);
      return h(
        'div',
        { class: 'skill' },
        h('span', null, label),
        h(
          'div',
          { class: 'meter small skill-meter', title: grown > 0 ? `採用時 ${base} → 今 ${base + grown}（+${grown}）` : `${base}` },
          h('div', { class: 'meter-fill base' + (init ? ' initial' : ''), style: { width: `${base}%` } }),
          grown > 0 ? h('div', { class: 'meter-fill grown', style: { width: `${grown}%` } }) : null,
        ),
        grown > 0 ? h('small', { class: 'grown-num' }, `+${grown}`) : null,
      );
    };
    return h(
      'div',
      { class: 'skills' },
      bar('速さ', sk.speed, init?.speed),
      bar('調理', sk.cooking, init?.cooking),
      bar('接客', sk.service, init?.service),
      bar('衛生', sk.hygiene, init?.hygiene),
      bar('移動', sk.movement, init?.movement),
    );
  }

  private togglePanel(e: Employee, kind: 'shift' | 'record' | 'prio'): void {
    const open = this.empPanel?.id === e.id && this.empPanel.kind === kind;
    this.empPanel = open ? null : { id: e.id, kind };
    if (kind === 'shift' && !open) this.shiftEdit = null;
    this.render();
  }

  private staffCard(s: GameState, e: Employee): HTMLElement {
    const part = isPartTime(e);
    const panel = this.empPanel?.id === e.id ? this.empPanel.kind : null;
    // 社員の日給は営業時間に合わせる（4時間の店は今までの日給。長い店は時間・残業・深夜の分が増える。じろ1 5.1）
    const fullPay = fullTimePayFor(e, storeHours(s));
    const pay = part ? `時給${yenStr(hourlyOf(e))}` : `日給${yenStr(fullPay)}${fullPay !== e.profile.wage ? `（基本 ${yenStr(e.profile.wage)}）` : ''}`;
    const summary = staffSummary(e, s);
    const host = this.host.isHost;
    return h(
      'div',
      { class: 'emp', 'data-emp': e.id },
      h(
        'div',
        { class: 'trow' },
        h(
          'div',
          { class: 'tname' },
          h('span', null, e.profile.name, h('span', { class: `emp-type ${employmentOf(e)}` }, EMPLOYMENT_LABEL[employmentOf(e)])),
          h('small', null, `${ROLE_LABEL[e.profile.role]}・${pay}・${attendanceText(e, s)}${e.presentToday && e.ai.note ? `（${e.ai.note}）` : ''}`),
        ),
        h(
          'select',
          {
            class: 'select',
            onchange: (ev: Event) => this.act({ type: 'setRole', employeeId: e.id, role: (ev.target as HTMLSelectElement).value as EmployeeRole }),
          },
          // シフトリーダーは昇格でなる（担当の変更では選べない）
          (Object.keys(ROLE_LABEL) as EmployeeRole[])
            .filter((r) => r !== 'leader' || e.profile.role === 'leader')
            .map((r) => h('option', { value: r, selected: r === e.profile.role, disabled: r === 'leader' }, ROLE_LABEL[r])),
        ),
      ),
      lookLine(lookSeedOf(e)),
      h(
        'div',
        { class: 'tbtns emp-btns' },
        h('button', { class: `mini ghost ${panel === 'shift' ? 'on' : ''}`, 'data-guest-ok': '1', onclick: () => this.togglePanel(e, 'shift') }, '📅 シフト'),
        h('button', { class: `mini ghost ${panel === 'record' ? 'on' : ''}`, 'data-guest-ok': '1', onclick: () => this.togglePanel(e, 'record') }, '📝 記録'),
        h('button', { class: `mini ghost ${panel === 'prio' ? 'on' : ''}`, 'data-guest-ok': '1', onclick: () => this.togglePanel(e, 'prio') }, '担当設定'),
        part && host ? h('button', { class: 'mini', onclick: () => void this.promoteDialog(e) }, '社員にする') : null,
        !part && host && e.profile.role !== 'leader' ? h('button', { class: 'mini', 'data-promote-leader': e.id, onclick: () => void this.leaderDialog(e) }, '⭐ シフトリーダーにする') : null,
        host
          ? h(
              'button',
              {
                class: 'mini danger',
                onclick: async () => {
                  if (await confirmDialog(this.root, '解雇', `${e.profile.name}さんを解雇します。解雇手当 ${yenStr(dailyWageOf(e) * BALANCE.severanceDays)} がかかります。`, '解雇する', true)) await this.act({ type: 'fire', employeeId: e.id });
                },
              },
              '解雇',
            )
          : null,
      ),
      this.skillBars(e.profile.skills, e.profile.initialSkills),
      h(
        'p',
        { class: 'note emp-wellbeing', 'data-wellbeing': e.id },
        `疲れ: ${fatigueText(e)}・満足度: ${moraleText(e)}`,
        part && e.profile.wishDays ? `・希望の曜日: ${WEEKDAY_LABEL.filter((_, i) => isWishDay(e, i)).join('')}` : '',
        !part && restDaysOf(e).length > 0 ? `・休み: ${restDaysOf(e).map((i) => WEEKDAY_LABEL[i]).join('')}` : '',
      ),
      h('p', { class: 'note emp-summary' }, summary.slice(0, 3).join('・')),
      panel === 'shift' ? this.shiftPanel(s, e) : null,
      panel === 'record' ? this.recordPanel(s, e) : null,
      panel === 'prio' ? this.prioPanel(e) : null,
    );
  }

  private prioPanel(e: Employee): HTMLElement {
    return h(
      'div',
      { class: 'prio' },
      h('p', { class: 'note' }, '仕事ごとの優先度を調整できます。「担当外」にするとその仕事をしません。担当以外の仕事も＋にすると任せられます。'),
      Object.entries(TASK_KINDS).map(([kind, info]) => {
        const v = e.priorities[kind] ?? 0;
        const roleDefault = info.roles.includes(e.profile.role);
        return h(
          'div',
          { class: 'kv' },
          h('span', null, `${info.label}${roleDefault ? '' : '（担当外）'}`),
          h(
            'div',
            { class: 'tbtns' },
            h('button', { class: 'mini ghost', onclick: () => this.act({ type: 'setPriority', employeeId: e.id, kind, value: -100 }) }, 'しない'),
            h('button', { class: 'mini ghost', onclick: () => this.act({ type: 'setPriority', employeeId: e.id, kind, value: v - 10 }) }, '−'),
            h('b', null, v <= -100 ? 'しない' : v > 0 ? `+${v}` : String(v)),
            h('button', { class: 'mini ghost', onclick: () => this.act({ type: 'setPriority', employeeId: e.id, kind, value: Math.max(-90, v) + 10 }) }, '＋'),
          ),
        );
      }),
    );
  }

  /** 勤務の記録（実際に起きた出来事だけ。勤怠・辛抱の数値は出さない） */
  private recordPanel(s: GameState, e: Employee): HTMLElement {
    const log = staffLog(e, 10);
    return h(
      'div',
      { class: 'prio emp-record' },
      h('ul', { class: 'emp-lines' }, staffSummary(e, s).map((l) => h('li', null, l))),
      log.length > 0 ? h('h5', null, '最近の出来事') : null,
      log.length > 0 ? h('ul', { class: 'emp-log' }, log.map((l) => h('li', { class: `log-${l.kind}` }, h('b', null, `${l.day}日目`), ` ${l.text}`))) : null,
    );
  }

  /**
   * みんなの勤務のカレンダー（じろ1 5.8。オーナーの指示）: 今日から2週間の日ごとに、出る人の数と名前。日を押すと、
   * その日の全員のシフトを見て、アルバイトはその日だけのシフトを変えられる（社員は毎日・休みの曜日は「休み」）
   */
  private teamCalendar(s: GameState): HTMLElement {
    const days = Array.from({ length: 14 }, (_, i) => s.day + i);
    const sel = this.teamDay !== null && this.teamDay >= s.day && this.teamDay < s.day + 14 ? this.teamDay : null;
    const short = (name: string) => name.split(' ')[0] ?? name;
    const grid = h(
      'div',
      { class: 'team-cal' },
      days.map((d) => {
        const on = s.employees.filter((e) => shiftFor(e, d) !== null && (e.availableFrom === undefined || e.availableFrom <= d));
        const wd = weekdayOf(d);
        return h(
          'button',
          { class: `team-day${d === sel ? ' on' : ''}${wd >= 5 ? ' weekend' : ''}`, 'data-team-day': String(d), 'data-guest-ok': '1', onclick: () => { this.teamDay = d === sel ? null : d; this.render(); } },
          h('span', { class: 'td-date' }, `${d}日目（${WEEKDAY_LABEL[wd]}）`),
          h('b', { class: 'td-count' }, `${on.length}人`),
          h('small', { class: 'td-names' }, on.map((e) => short(e.profile.name)).join('・') || '—'),
        );
      }),
    );
    let editor: HTMLElement | null = null;
    if (sel !== null) {
      const host = this.host.isHost;
      const presets = this.shiftPresets(s);
      editor = h(
        'div',
        { class: 'team-edit', 'data-team-edit': String(sel) },
        h('h5', null, `${sel}日目（${WEEKDAY_LABEL[weekdayOf(sel)]}曜）の勤務`),
        s.employees.map((e) => {
          const sh = shiftFor(e, sel);
          const part = isPartTime(e);
          const notYet = e.availableFrom !== undefined && e.availableFrom > sel;
          return h(
            'div',
            { class: 'kv' },
            h('span', null, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`),
            notYet
              ? h('b', null, `${e.availableFrom}日目から出勤`)
              : part && host
                ? h(
                    'select',
                    {
                      class: 'select',
                      'data-team-shift': e.id,
                      onchange: (ev: Event) => {
                        const i = Number((ev.target as HTMLSelectElement).value);
                        if (i < 0) return;
                        void this.saveDateShift(e, [sel], presets[i]![1], 'once');
                      },
                    },
                    h('option', { value: '-1', selected: true }, this.shiftText(sh)),
                    presets.map(([label], i) => h('option', { value: String(i) }, `→ ${label}`)),
                  )
                : h('b', null, `${this.shiftText(sh)}${part ? '' : '（社員）'}`),
          );
        }),
        h('p', { class: 'note' }, 'アルバイトは、この日だけのシフトに変わります（毎週くりかえす・細かい時間は各人の「📅 シフト」から）。社員の休みの曜日は各人の「📅 シフト」で決めます。'),
      );
    }
    return h('div', { class: 'team-calendar' }, h('h5', null, '📅 みんなの勤務（2週間）'), grid, editor);
  }

  /**
   * みんなの勤務のカレンダーで選べるシフトの形。店の営業時間（じろ1 5.1）に合わせる:
   * 枠が2つ以上なら枠ごと（昼だけ・夜だけ）、1つなら前半・後半
   */
  private shiftPresets(s: GameState): [string, ShiftDay | null][] {
    const hrs = storeHours(s);
    const openMin = openMinutesOf(hrs);
    const step = BALANCE.staff.shiftStepMin;
    const at = (start: number, end: number, fromPrep = false): ShiftDay => ({ start, end, breakAt: 0, breakLen: 0, fromPrep });
    const list: [string, ShiftDay | null][] = [
      ['休み', null],
      ['仕込み〜閉店', at(0, openMin, true)],
      ['開店〜閉店', at(0, openMin)],
    ];
    const spans = sessionSpans(hrs);
    if (spans.length > 1) {
      for (const sp of spans) list.push([`${clockLabel(sp.open)}〜${clockLabel(sp.close)}の営業`, at(Math.round(sp.startT / SEC_PER_MIN), Math.round(sp.endT / SEC_PER_MIN))]);
    } else {
      const half = Math.max(step, Math.floor(openMin / 2 / step) * step);
      list.push(['前半', at(0, half)], ['後半', at(half, openMin)]);
    }
    return list;
  }

  private shiftText(sh: ShiftDay | null): string {
    if (!sh) return '休み';
    const hrs = storeHours(this.host.state);
    const b = sh.breakLen > 0 ? `（休憩${sh.breakLen}分）` : '';
    return `${sh.fromPrep ? '仕込み' : shiftTimeText(sh.start, hrs)}〜${shiftTimeText(Math.min(sh.end, openMinutesOf(hrs)), hrs, true)}${b}`;
  }

  /**
   * シフトの欄: 4週間のカレンダー（アルバイト。オーナー回答「日にちごと＋くりかえしも使える」）。
   * 日にちを押して選び（いくつでも）、時間を決めて「この日だけ」か「毎週くりかえす」で保存する。社員は毎日・全時間
   */
  private shiftPanel(s: GameState, e: Employee): HTMLElement {
    if (!isPartTime(e)) {
      // 社員: 休みの曜日を決める（疲れは休みの日に回復する。オーナーの判断 12）
      const rest = new Set(restDaysOf(e));
      const toggleRest = (i: number) => {
        const next = new Set(rest);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        void this.act({ type: 'setRestDays', employeeId: e.id, days: [...next].sort((a, b) => a - b) });
      };
      return h(
        'div',
        { class: 'prio' },
        h('p', { class: 'note' }, `社員は出勤の日は仕込みから閉店まで勤務します（日給 ${yenStr(fullTimePayFor(e, storeHours(s)))}。営業時間に合わせて変わります）。休みの曜日は来ず、日給もかかりません。疲れは休みの日に回復します（週に1〜2日休ませると、ほぼ回復します）。`),
        h(
          'div',
          { class: 'tbtns rest-days', 'data-rest-days': e.id },
          WEEKDAY_LABEL.map((w, i) =>
            h('button', { class: `mini ${rest.has(i) ? 'ghost' : 'on'}`, 'data-rest-day': String(i), disabled: !this.host.isHost, onclick: () => toggleRest(i) }, `${w} ${rest.has(i) ? '休み' : '出勤'}`),
          ),
        ),
        h('p', { class: 'note' }, `今: ${fatigueText(e)}（作業の速さ ${Math.round(fatigueSpeed(e) * 100)}%）`),
      );
    }
    const N = BALANCE.staff.calendarDays;
    const first = s.day - weekdayOf(s.day);
    const lastDay = s.day + N - 1;
    const ed = this.shiftEdit?.id === e.id ? this.shiftEdit : null;
    const sel = new Set((ed?.days ?? []).filter((d) => d >= s.day && d <= lastDay));
    // 選ぶ日を変えても、編集中の時間はそのまま（選ぶのをやめたら消す）
    const setSel = (days: number[]) => {
      const list = [...new Set(days)].sort((x, y) => x - y);
      this.shiftEdit = { id: e.id, days: list, draft: list.length > 0 ? ed?.draft : undefined };
      this.render();
    };
    const toggle = (d: number) => setSel(sel.has(d) ? [...sel].filter((x) => x !== d) : [...sel, d]);
    // 曜日の見出しを押すと、その曜日（今日から4週間）をまとめて選ぶ・外す
    const pickWeekday = (wd: number) => {
      const days: number[] = [];
      for (let d = s.day; d <= lastDay; d++) if (weekdayOf(d) === wd) days.push(d);
      const all = days.every((d) => sel.has(d));
      setSel(all ? [...sel].filter((d) => !days.includes(d)) : [...sel, ...days]);
    };
    const cells: HTMLElement[] = [];
    const weeks = Math.ceil((lastDay - first + 1) / 7);
    for (let i = 0; i < weeks * 7; i++) {
      const d = first + i;
      const past = d < s.day;
      const beyond = d > lastDay;
      if (past || beyond) {
        cells.push(h('div', { class: 'cal-day past' }, h('b', null, `${d}日目`)));
        continue;
      }
      if (e.availableFrom !== undefined && d < e.availableFrom) {
        cells.push(h('button', { class: `cal-day pending ${d === s.day ? 'today' : ''}`, 'data-day': String(d), disabled: true }, h('b', null, `${d}日目${d === s.day ? '・今日' : ''}`), h('small', null, '手続き中')));
        continue;
      }
      const sh = shiftFor(e, d);
      const own = hasDateShift(e, d);
      cells.push(
        h(
          'button',
          {
            class: `cal-day ${sel.has(d) ? 'on' : ''} ${d === s.day ? 'today' : ''} ${sh ? 'work' : 'off'} ${own ? 'own' : ''}`,
            'data-day': String(d),
            onclick: () => toggle(d),
          },
          h('b', null, `${d}日目${d === s.day ? '・今日' : ''}`),
          h('small', null, this.shiftText(sh)),
          !isWishDay(e, weekdayOf(d)) ? h('i', { class: 'cal-unwish', title: '希望していない曜日（入れると満足度が下がる）' }, '希望外') : null,
          own ? h('i', { class: 'cal-own', title: 'この日だけの予定' }, 'この日だけ') : null,
        ),
      );
    }
    const cal = h(
      'div',
      { class: 'cal', 'data-guest-ok': '1' },
      WEEKDAY_LABEL.map((w, i) => h('button', { class: 'cal-head', onclick: () => pickWeekday(i), title: `${w}曜をまとめて選ぶ` }, w)),
      cells,
    );
    const week = shiftsOf(e);
    const wishNote = e.profile.wishDays
      ? h('p', { class: 'note cal-wish' }, `希望の曜日: ${WEEKDAY_LABEL.filter((_, i) => isWishDay(e, i)).join('・')}。希望していない曜日に入れることもできますが、満足度が下がり、遅刻・欠勤が増え、続くと辞めることがあります。`)
      : null;
    const repeat = h(
      'p',
      { class: 'note cal-repeat' },
      '毎週のくりかえし: ',
      WEEKDAY_LABEL.map((w, i) => h('span', { class: week[i] ? '' : 'off' }, `${w} ${this.shiftText(week[i] ?? null)}`)),
    );
    const picked = [...sel];
    let editor: HTMLElement;
    if (picked.length === 0) {
      editor = h('p', { class: 'note' }, '日にちを押して選びます（いくつでも選べます。曜日の見出しを押すとその曜日をまとめて選べます）。');
    } else {
      const step = BALANCE.staff.shiftStepMin;
      // シフトの時刻は店の営業時間（じろ1 5.1）の中で決める（0 = その日の最初の開店。枠の間の中休みは飛ばして数える）
      const hrs = storeHours(s);
      const close = openMinutesOf(hrs);
      const base = shiftFor(e, picked[0]!);
      const draft: ShiftDay | null = ed && ed.draft !== undefined ? ed.draft : base;
      const setDraft = (d: ShiftDay | null) => {
        this.shiftEdit = { id: e.id, days: picked, draft: d };
        this.render();
      };
      const wds = [...new Set(picked.map(weekdayOf))].sort((x, y) => x - y);
      const label = picked.length <= 4 ? picked.map((d) => `${d}日目（${WEEKDAY_LABEL[weekdayOf(d)]}）`).join('・') : `${picked.length}日（${picked[0]}日目〜${picked[picked.length - 1]}日目）`;
      const anyOwn = picked.some((d) => hasDateShift(e, d));
      const opt = (v: number, text: string, cur: number) => h('option', { value: String(v), selected: v === cur }, text);
      const controls: (HTMLElement | null)[] = [];
      let problem: string | null = null;
      let summary = '休み';
      if (draft) {
        const starts: HTMLElement[] = [h('option', { value: 'prep', selected: draft.fromPrep }, '仕込みから')];
        for (let m = 0; m < close; m += step) starts.push(opt(m, shiftTimeText(m, hrs), draft.fromPrep ? -1 : draft.start));
        const ends: HTMLElement[] = [];
        for (let m = draft.start + step; m <= close; m += step) ends.push(opt(m, shiftTimeText(m, hrs, true), draft.end));
        const breaks: HTMLElement[] = [opt(0, 'なし', draft.breakLen), opt(30, '30分', draft.breakLen), opt(60, '60分', draft.breakLen)];
        const breakAts: HTMLElement[] = [];
        for (let m = draft.start + step; m + draft.breakLen < draft.end; m += step) breakAts.push(opt(m, `${shiftTimeText(m, hrs)}から`, draft.breakAt));
        const fixBreak = (d: ShiftDay): ShiftDay => {
          if (d.breakLen <= 0) return { ...d, breakAt: 0, breakLen: 0 };
          let at = d.breakAt;
          if (at <= d.start || at + d.breakLen >= d.end) at = d.start + Math.max(step, Math.floor((d.end - d.start - d.breakLen) / 2 / step) * step);
          return { ...d, breakAt: at };
        };
        controls.push(
          h(
            'div',
            { class: 'shift-row' },
            h('label', null, '出勤', h('select', {
              class: 'select',
              onchange: (ev: Event) => {
                const v = (ev.target as HTMLSelectElement).value;
                const start = v === 'prep' ? 0 : Number(v);
                setDraft(fixBreak({ ...draft, start, fromPrep: v === 'prep', end: Math.max(draft.end, start + step) }));
              },
            }, starts)),
            h('label', null, '退勤', h('select', { class: 'select', onchange: (ev: Event) => setDraft(fixBreak({ ...draft, end: Number((ev.target as HTMLSelectElement).value) })) }, ends)),
            h('label', null, '休憩', h('select', { class: 'select', onchange: (ev: Event) => setDraft(fixBreak({ ...draft, breakLen: Number((ev.target as HTMLSelectElement).value) })) }, breaks)),
            draft.breakLen > 0 && breakAts.length > 0 ? h('label', null, '休憩の開始', h('select', { class: 'select', onchange: (ev: Event) => setDraft(fixBreak({ ...draft, breakAt: Number((ev.target as HTMLSelectElement).value) })) }, breakAts)) : null,
          ),
        );
        problem = shiftProblem(draft, close);
        const hours = shiftPaidHours(draft, close);
        summary = `${this.shiftText(draft)}・1日の給与の目安 ${yenStr(Math.round((hourlyOf(e) * hours) / 10) * 10)}（${hours}時間）`;
      }
      editor = h(
        'div',
        { class: 'shift-edit' },
        h('p', { class: 'cal-picked' }, `選んだ日: ${label}`),
        draft
          ? h('button', { class: 'mini ghost', onclick: () => setDraft(null) }, '休みにする')
          : h('button', { class: 'mini', onclick: () => setDraft(base ?? { start: 0, end: close, breakAt: 0, breakLen: 0, fromPrep: true }) }, '勤務を入れる'),
        ...controls,
        h('p', { class: `note ${problem ? 'bad' : ''}` }, problem ?? summary),
        h(
          'div',
          { class: 'tbtns' },
          h('button', { class: 'mini', 'data-save': 'once', disabled: !!problem, onclick: () => void this.saveDateShift(e, picked, draft, 'once') }, draft ? 'この日だけ保存' : 'この日だけ休みにする'),
          h('button', { class: 'mini ghost', 'data-save': 'weekly', disabled: !!problem, onclick: () => void this.saveDateShift(e, picked, draft, 'weekly') }, `毎週くりかえす（${wds.map((w) => WEEKDAY_LABEL[w]).join('・')}）`),
          anyOwn ? h('button', { class: 'mini ghost', 'data-save': 'reset', onclick: () => void this.saveDateShift(e, picked, null, 'reset') }, 'くりかえしに戻す') : null,
          h('button', { class: 'mini ghost', 'data-guest-ok': '1', onclick: () => setSel([]) }, '選ぶのをやめる'),
        ),
      );
    }
    let total = 0;
    for (let d = s.day; d <= lastDay; d++) total += expectedPay(e, d, d === s.day ? todayHours(s) : storeHours(s));
    return h(
      'div',
      { class: 'prio shift' },
      wishNote,
      cal,
      repeat,
      editor,
      h('p', { class: 'note' }, `${N}日間の給与の目安 ${yenStr(total)}・今日の見込み ${yenStr(expectedPay(e, s.day, todayHours(s)))}。今日の予定を変えるとすぐに反映します（休みの人に勤務を入れると呼び出し、着くまで少しかかります）。`),
    );
  }

  private async saveDateShift(e: Employee, days: number[], sh: ShiftDay | null, mode: 'once' | 'weekly' | 'reset'): Promise<void> {
    const ok = await this.act({ type: 'setDateShift', employeeId: e.id, days, shift: sh, mode });
    if (!ok) return;
    // 「1日」は日付と紛れるので、1日なら「N日目」、いくつもなら「N日分」と書く
    const which = days.length === 1 ? `${days[0]}日目` : `${days.length}日分`;
    const wds = [...new Set(days.map(weekdayOf))].sort((x, y) => x - y).map((w) => WEEKDAY_LABEL[w]).join('・');
    const text =
      mode === 'reset' ? `${e.profile.name}さんの${which}を、くりかえしの予定に戻しました`
      : mode === 'weekly' ? `${e.profile.name}さんの毎週の${wds}曜を${sh ? this.shiftText(sh) : '休み'}にしました`
      : sh ? `${e.profile.name}さんの${which}のシフトを保存しました`
      : `${e.profile.name}さんの${which}を休みにしました`;
    toast(this.root, text, 'good', 1800);
    // 保存したら選ぶのをやめる（カレンダーで結果を見る）
    this.shiftEdit = { id: e.id, days: [] };
    this.render();
  }

  /** シフトリーダーへの昇格（社員だけ。全部の仕事をする上位の役職。じろ1 5.8） */
  private async leaderDialog(e: Employee): Promise<void> {
    const problem = promoteLeaderProblem(e);
    const body = h(
      'div',
      { class: 'promote' },
      h('p', null, `${e.profile.name}さん（${ROLE_LABEL[e.profile.role]}・社員 日給${yenStr(e.profile.wage)}）をシフトリーダーにします。`),
      h('p', null, `シフトリーダーは仕入れ・仕込み・調理・接客・清掃を全部する上位の役職です。日給は ${yenStr(leaderWageFor(e))} になります。`),
      problem ? h('p', { class: 'note bad' }, problem) : null,
    );
    if (!(await confirmNode(this.root, 'シフトリーダーにする', body, 'シフトリーダーにする'))) return;
    await this.act({ type: 'promoteLeader', employeeId: e.id });
  }

  /** 社員への昇格（参考情報を見て、プレイヤーが決める） */
  private async promoteDialog(e: Employee): Promise<void> {
    const s = this.host.state;
    const info = promotionInfo(e, s);
    const body = h(
      'div',
      { class: 'promote' },
      h('p', null, `${e.profile.name}さん（${ROLE_LABEL[e.profile.role]}・アルバイト 時給${yenStr(hourlyOf(e))}）を社員にします。`),
      h('p', null, `社員は日給 ${yenStr(info.newWage)} で、毎日 仕込みから閉店まで勤務します（シフトはなくなります）。遅刻・欠勤が少なく安定し、接客担当がいないときは担当に関係なくクレームに対応します。`),
      h('h5', null, '昇格の目安（参考）'),
      h('ul', { class: 'promote-checks' }, info.checks.map((c) => h('li', { class: c.ok ? 'ok' : 'ng' }, `${c.ok ? '✓' : '・'} ${c.label}`))),
      h('h5', null, '勤務の様子'),
      h('ul', { class: 'emp-lines' }, staffSummary(e, s).map((l) => h('li', null, l))),
      info.canPromote ? h('p', { class: 'note bad' }, info.canPromote) : null,
    );
    if (!(await confirmNode(this.root, '社員にする', body, '社員にする'))) return;
    await this.act({ type: 'promote', employeeId: e.id });
  }

  // ───────────────── 店舗（レイアウト・席・拡張） ─────────────────
  private layout(s: GameState): HTMLElement {
    const info = expansionInfo(s);
    const adv = expansionAdvice(s);
    const st = STAGES[s.career.stage]!;
    const editable = s.phase === 'closed' || s.phase === 'prep';
    const seatsNow = s.seats.filter((x) => x.installed && x.index < st.seats.length).length;
    const fc = fixedCosts(s);
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('店の大きさ', st.name.replace(/（.*）/, ''), `${st.seats.length}席の店`),
          kpi('席', `${seatsNow} / ${st.seats.length}席`, seatsNow < st.seats.length ? `あと${st.seats.length - seatsNow}席置ける` : 'すべて設置', '', seatsNow < st.seats.length ? 'warn' : 'good'),
          kpi('家賃', `${yenSigned(fc.rent)}/日`, null),
          kpi('次の拡張', info.next ? yenSigned(adv?.total ?? info.cost) : '—', info.next ? (info.canExpand ? 'いま拡張できます' : (info.reason ?? '')) : '最大の店舗', info.next && info.canExpand ? 'good' : '', info.next && info.canExpand ? 'good' : ''),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead(`レイアウト — ${st.name}`, '設備の配置で動線（移動距離）が変わり、処理能力が変わります。盛り付け台の近くにスープ寸胴・トッピング台・麺釜を置くと作業が速くなります。'),
        h('button', { class: 'btn primary', disabled: !editable, onclick: () => this.cb.onLayoutEditor() }, editable ? 'レイアウト編集を開く' : '営業中は編集できません'),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `席（${s.seats.filter((x) => x.installed && x.index < st.seats.length).length}/${st.seats.length}）`),
        h(
          'div',
          { class: 'row wrap' },
          s.seats.filter((x) => x.index < st.seats.length).map((seat) =>
            seat.installed
              ? h('span', { class: 'chip on' }, `${seat.index + 1}番`)
              : h('button', { class: 'mini', onclick: () => this.act({ type: 'buySeat', seatIndex: seat.index }, `${seat.index + 1}番席を設置しました`) }, `${seat.index + 1}番を設置 ${yenStr(SEAT_PRICE)}`),
          ),
        ),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '店舗拡張'),
        info.next
          ? h(
              'div',
              null,
              h('div', { class: 'kv' }, h('span', null, '次の段階'), h('b', null, info.next.name)),
              h('p', { class: 'note' }, info.next.description),
              h('div', { class: 'kv' }, h('span', null, '工事費'), h('b', null, yenStr(info.next.constructionCost))),
              h('div', { class: 'kv' }, h('span', null, '設備移設費'), h('b', null, yenStr(info.relocation))),
              h('div', { class: 'kv' }, h('span', null, '家賃'), h('b', null, `${yenStr(st.rent)} → ${yenStr(info.next.rent)}/日`)),
              h('div', { class: 'kv' }, h('span', null, '工事による休業'), h('b', null, `${info.next.closureDays}日`)),
              h('div', { class: 'kv' }, h('span', null, '工事後に必要な手元資金'), h('b', null, yenStr(info.next.minFundsAfter))),
              adv
                ? h(
                    'div',
                    { class: 'exp-advice' },
                    h('p', { class: 'note' }, '拡張したあとに必要になる物の目安（工事の条件ではありません）'),
                    adv.seats > 0 ? h('div', { class: 'kv' }, h('span', null, `増える席の椅子（${adv.seats}脚）`), h('b', null, yenStr(adv.seatCost))) : null,
                    h(
                      'div',
                      { class: 'kv' },
                      h('span', null, `冷蔵庫の容量 ${adv.fridgeKg}kg → 目安 ${adv.fridgeKgNeeded}kg`),
                      h('b', null, adv.fridges > 0 ? `冷蔵庫 ${adv.fridges}台 ${yenStr(adv.fridgeCost)}` : '足りています'),
                    ),
                    h('div', { class: 'kv' }, h('span', null, '合計の目安（工事費・移設・席・冷蔵庫・手元資金）'), h('b', { 'data-exp-total': '' }, yenStr(adv.total))),
                    adv.fridges > 0 ? h('p', { class: 'note' }, '店が大きくなって杯数が増えると、麺・豚肉・もやしが冷蔵庫に入りきらず品切れが増えます') : null,
                  )
                : null,
              info.reason ? h('p', { class: 'note bad' }, info.reason) : null,
              this.host.isHost
                ? h(
                    'button',
                    {
                      class: 'btn primary',
                      disabled: !info.canExpand,
                      onclick: async () => {
                        if (await confirmDialog(this.root, '店舗拡張', `${info.next!.name}に拡張します。工事費${yenStr(info.cost)}。拡張すれば自動で利益が増えるわけではありません。需要と人手が伴わないと赤字になります。`, '工事を発注する')) await this.act({ type: 'expand' }, '工事を発注しました');
                      },
                    },
                    '拡張工事を発注する',
                  )
                : h('p', { class: 'note' }, '拡張はホストだけが実行できます'),
            )
          : h('p', { class: 'note' }, '最大の店舗です'),
      ),
    );
  }

  // ───────────────── キャリア ─────────────────
  private career(s: GameState): HTMLElement {
    const signs = signsOf(s);
    const done = GOALS.filter((g) => s.career.goalsDone.includes(g.id)).length;
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('評判', `★ ${s.reputation.toFixed(2)}`, `口コミ ${s.reviews.length}件`, 'accent'),
          kpi('キャリア目標', `${done} / ${GOALS.length}`, done < GOALS.length ? '達成すると新しい物が解放されます' : 'すべて達成', '', done === GOALS.length ? 'good' : ''),
          kpi('常連客', `${s.regulars.length}人`, null),
          kpi('累計提供', `${s.career.totalServed.toLocaleString('ja-JP')}杯`, `営業 ${s.career.daysPlayed}日・最高 ${s.career.bestDayServed}杯/日`),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `芸能人のサイン（${signs.length}枚）`),
        signs.length === 0
          ? h('p', { class: 'note' }, 'テレビ取材を受けて、出演者に食べ終えてもらうとサインがもらえます。サインは店の壁に飾られます（売上には影響しません）。')
          : h(
              'div',
              null,
              h('p', { class: 'note' }, 'もらった順に店の壁（正面のガラスの上・右の壁）に飾っています。'),
              signs.map((x) => h('div', { class: 'kv' }, h('span', null, `🖊️ ${x.name}`), h('b', null, `「${x.show}」${x.day}日目${x.visits > 1 ? `・${x.visits}回来店` : ''}`))),
            ),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, 'キャリア目標'),
        GOALS.map((g) => {
          const done = s.career.goalsDone.includes(g.id);
          const p = done ? 1 : g.progress(s);
          return h(
            'div',
            { class: `goal ${done ? 'done' : ''}` },
            h('div', { class: 'tname' }, `${done ? '✅' : '⬜'} ${g.name}`, h('small', null, `${g.description}${g.unlocks.length ? ` → ${g.unlocks.map((u) => UNLOCK_NAMES[u] ?? u).join('・')}` : ''}`)),
            h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${Math.round(p * 100)}%` } })),
          );
        }),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `口コミ（最近${Math.min(10, s.reviews.length)}件）`),
        s.reviews.length === 0 ? h('p', { class: 'note' }, 'まだ口コミはありません') : null,
        s.reviews.slice(-10).reverse().map((r) => h('div', { class: 'review' }, h('b', null, `${'★'.repeat(Math.round(r.stars))}${r.regular ? '（常連）' : ''}`), h('span', null, ` ${r.text}`), h('small', null, ` ${r.day}日目`))),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `常連客（${s.regulars.length}人）`),
        s.regulars.slice().sort((a, b) => b.loyalty - a.loyalty).slice(0, 10).map((r) => h('div', { class: 'kv' }, h('span', null, `${r.name}（${MENU[r.favoriteMenu]?.short ?? ''}）`), h('b', null, `来店${r.visits}回・常連度${Math.round(r.loyalty * 100)}%`))),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '通算'),
        h('div', { class: 'kv' }, h('span', null, '累計提供'), h('b', null, `${s.career.totalServed}杯`)),
        h('div', { class: 'kv' }, h('span', null, '1日の最高提供数'), h('b', null, `${s.career.bestDayServed}杯`)),
        h('div', { class: 'kv' }, h('span', null, '営業日数'), h('b', null, `${s.career.daysPlayed}日`)),
      ),
    );
  }

  // ───────────────── セーブ・設定 ─────────────────
  private system(s: GameState): HTMLElement {
    return h(
      'div',
      null,
      this.host.mode === 'local' && debugEventsEnabled() ? debugEventsCard(s, this.host, this.root, () => this.cb.onClose()) : null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, 'セーブ'),
        this.host.mode === 'local'
          ? h('p', { class: 'note' }, '閉店後に自動で保存されます。いつでも手動で保存できます。')
          : h('p', { class: 'note' }, '共同経営の保存はホストが行い、ホストのセーブスロットに記録されます。参加者のセーブは変更されません。'),
        h('button', { class: 'btn primary', disabled: !this.host.isHost, onclick: () => this.cb.onSave() }, '今すぐ保存'),
        this.host.mode === 'local'
          ? h(
              'div',
              null,
              h('p', { class: 'note' }, 'クラウドセーブ（任意）: サーバーを設定していれば、別の端末と同じ進行を共有できます。競合したときは確認してから上書きします。'),
              h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => this.cb.onCloudSave() }, '☁ クラウドに保存'), h('button', { class: 'btn ghost', onclick: () => this.cb.onCloudLoad() }, '☁ クラウドから読み込む')),
            )
          : null,
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '設定・その他'),
        h('div', { class: 'row wrap', 'data-guest-ok': '1' }, h('button', { class: 'btn', onclick: () => this.cb.onSettings() }, '設定（音・操作・画質）'), h('button', { class: 'btn', onclick: () => this.cb.onHelp() }, '遊び方'), h('button', { class: 'btn ghost', 'data-title': '1', onclick: () => this.cb.onTitle() }, 'タイトルに戻る')),
      ),
    );
  }
}

/** 従業員の見た目（制服の色の丸と説明）。3D の人物と同じ番号から決まる */
function lookLine(seed: number): HTMLElement {
  const l = staffLook(seed);
  const dot = (color: string, title: string) => h('span', { class: 'look-dot', title, style: { background: color } });
  return h(
    'div',
    { class: 'emp-look' },
    dot(l.shirt, 'シャツ'),
    dot(l.apron, '前掛け'),
    l.headwear !== 'none' ? dot(l.headColor, '頭') : null,
    h('span', null, staffLookText(l)),
  );
}
