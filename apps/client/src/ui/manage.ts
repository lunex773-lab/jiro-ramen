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
  actingManager,
  managerTitle,
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
  autoOrderEnabled,
  siteStats,
  isClosedDay,
  inProcessOutput,
  type StoreHours,
  shelfLifeCap,
  prepPerBowl,
  shiftIssues,
  attendanceOn,
  shiftFor,
  injuredOn,
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
  forecastNextDay,
  promoteLeaderProblem,
  storeHours,
  shiftTable,
  openMinutesOf,
  sessionSpans,
  shiftSpansBreak,
  SEC_PER_MIN,
  fullTimePayFor,
  clockText as clockLabel,
  todayHours,
  DEFAULT_HOURS,
  type StoreEntry,
  prefRangeProblem,
  rangeTitle,
  type MarketView,
  forecastDay,
  prepPlanItems,
  prepPlanProgress,
  prepHave,
  prepScheduleMult,
  suggestPrepPlan,
  PREP_SCHEDULE_CHOICES,
} from '@jiro/core';
import type { GameHost } from '../game/host';
import { MarketHost } from '../game/market-play';
import { creditCard } from './market-credit';

/** 「会社」のタブを出すか: 店を2つ以上持っている、または出店の条件（12席以上・評判★4.0以上の店）を満たしている */
function companyTabVisible(s: GameState): boolean {
  if (!s.company || s.tutorial) return false;
  if (s.company.stores.length > 1) return true;
  const B = BALANCE.company;
  return s.career.stage >= B.unlockStage && s.reputation >= B.unlockReputation;
}
import { confirmDialog, confirmNode, h, replace, stars, toast, toastUndo, yenStr } from './dom';
import { openStoreMap } from './store-map';
import { hoursDialog, hoursSummary } from './hours-dialog';
import { loanControl, loanSummary } from './loan';
import { forecastLines } from './site-lines';
import { storeDaysCard } from './store-days';
import { alertBox, cardHead, delta, flowBar, kpi, kpiRow, meterBar, profitBars, yenSigned } from './kit';
import { debugEventsCard, debugEventsEnabled } from './debug-events';
import { lookSeedOf, staffLook, staffLookText } from '../render/staff-look';

export type ManageTab = 'dash' | 'company' | 'stock' | 'prep' | 'menu' | 'equip' | 'staff' | 'layout' | 'career' | 'system';

/** タブ: id・正式な名前（読み上げ・見出し）・左のナビの短い名前・アイコン（じろ6: 左の縦のナビ） */
const TABS: [ManageTab, string, string, string][] = [
  ['dash', '経営', '経営', '📊'],
  ['company', '会社', '会社', '🏢'],
  ['stock', '在庫・発注', '在庫', '📦'],
  ['prep', '仕込み', '仕込み', '🔪'],
  ['menu', 'メニュー', 'メニュー', '🍜'],
  ['equip', '設備', '設備', '🔧'],
  ['staff', '従業員', '従業員', '👥'],
  ['layout', '店舗', '店舗', '🏪'],
  ['career', 'キャリア', '記録', '🏆'],
  ['system', 'セーブ・設定', '設定', '⚙️'],
];

/** 直近7営業日（売れた日）に使った量の1日の平均（在庫があと何日もつかの目安。営業した日がなければ 0） */
function avgDailyUse(s: GameState, id: string): number {
  let sum = 0;
  let n = 0;
  for (let i = s.history.length - 1; i >= 0 && n < 7; i--) {
    const r = s.history[i]!;
    if (r.served <= 0) continue;
    n += 1;
    sum += r.usedItems?.[id] ?? 0;
  }
  return n > 0 ? sum / n : 0;
}

/** あと何日の短い文 */
function daysText(days: number | null): string {
  if (days === null) return '—';
  if (days >= 30) return '30日以上';
  return `${days < 10 ? days.toFixed(1) : Math.round(days)}日`;
}

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

/** 職種ごとの人数（「調理2・接客1」） */
function roleCounts(list: Employee[]): string {
  const m = new Map<string, number>();
  for (const e of list) m.set(ROLE_LABEL[e.profile.role], (m.get(ROLE_LABEL[e.profile.role]) ?? 0) + 1);
  return [...m].map(([k, n]) => `${k}${n}`).join('・');
}

/** 実際の勤務の短い説明 */
function attText(a: { absent: boolean; workedMin: number; lateMin: number; overtimeMin: number; calledIn: boolean; injured?: boolean }): string {
  if (a.absent) return '欠勤';
  const hm = `${Math.floor(a.workedMin / 60)}時間${a.workedMin % 60 > 0 ? `${a.workedMin % 60}分` : ''}`;
  return `${hm}${a.lateMin > 0 ? `・遅刻${a.lateMin}分` : ''}${a.overtimeMin >= 10 ? `・残業${a.overtimeMin}分` : ''}${a.calledIn ? '・呼び出し' : ''}${a.injured ? '・けがをして帰った' : ''}`;
}

/** 表のマスに入る短いシフト（「11-15」） */
function shiftShort(sh: ShiftDay, hrs: StoreHours): string {
  const a = shiftTimeText(sh.start, hrs).replace(/:00$/, '');
  const b = shiftTimeText(sh.end, hrs, true).replace(/:00$/, '');
  return `${a}-${b}`;
}

/** イベントの記録の種類の名前 */
const EVENT_LOG_LABEL: Record<string, string> = {
  sns_buzz: '📱 SNSのバズ',
  critic: '🕵️ 覆面調査員',
  rare_couple: '💑 珍しいカップル',
  rare_lover: '🍜 ラーメン好きの客',
  complaint_unreasonable: '😤 理不尽なクレーム',
  explosion: '🔥 爆発',
  youtuber: '🎥 YouTuber',
  tv: '📺 テレビ取材',
  incident: '🚨 客を襲った事件',
};

export class ManageMenu {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private tab: ManageTab = 'dash';
  private timer: number | null = null;
  /** 開いている従業員の欄（シフト・記録・担当設定） */
  private empPanel: { id: string; kind: 'shift' | 'record' | 'prio' } | null = null;
  /** 送っている最中の操作（二重に送らない） */
  private inFlight = new Set<string>();
  /** 従業員の表で選んでいる人（下にくわしい欄を出す） */
  private empSel: string | null = null;
  /** シフトのカレンダーで選んでいる日と編集中の内容（保存するまで状態は変えない。自動更新で消えないようここに持つ） */
  private shiftEdit: { id: string; days: number[]; draft?: ShiftDay | null } | null = null;
  /** みんなの勤務のカレンダーで選んだ日 */
  private teamDay: number | null = null;
  /** 勤務のカレンダーの見方（じろ2: 日・2週間・月）と並べ方（従業員別・職種別） */
  private calView: 'day' | 'twoWeeks' | 'month' = 'twoWeeks';
  private calGroup: 'staff' | 'role' = 'staff';
  private tabButtons = new Map<ManageTab, HTMLElement>();
  /** 押している最中は自動更新しない（押した要素が差し替わるとタップが外れる） */
  private pressing = false;
  /** 閲覧専用の印（共同経営のゲスト） */
  private badge: HTMLElement;
  /** 見出し（今のタブの名前）と、店・日の小さな文字 */
  private titleEl: HTMLElement;
  private crumbEl: HTMLElement;
  /** 最後に描いたときの状態の版（ゲストはホストの更新を受けたら描き直す） */
  private renderedVersion = -1;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: ManageCallbacks,
  ) {
    // タブは一度だけ作り、選択中の表示だけ切り替える
    // じろ6（改修設計書06）: 左の縦のナビ（アイコン＋短い名前。読み上げは正式な名前）と、細い見出し
    this.tabsEl = h(
      'nav',
      { class: 'tabs', 'aria-label': '経営メニュー' },
      TABS.map(([id, label, short, icon]) => {
        const b = h(
          'button',
          { class: 'tab', 'data-tab': id, 'aria-label': label, title: label, onclick: () => { this.tab = id; this.render(); this.body.scrollTop = 0; } },
          h('span', { class: 'tab-icon', 'aria-hidden': 'true' }, icon),
          h('span', { class: 'tab-label' }, short),
        );
        this.tabButtons.set(id, b);
        return b;
      }),
    );
    this.body = h('div', { class: 'manage-body' });
    this.titleEl = h('div', { class: 'manage-title' }, '経営');
    this.crumbEl = h('div', { class: 'manage-crumb' });
    this.el = h(
      'div',
      { class: 'manage' },
      h(
        'div',
        { class: 'manage-head' },
        this.titleEl,
        this.crumbEl,
        (this.badge = h('div', { class: 'readonly-badge', hidden: true }, '👀 閲覧専用（経営はホストが行います）')),
        h('button', { class: 'btn ghost close', onclick: () => cb.onClose() }, '✕ 閉じる'),
      ),
      h('div', { class: 'manage-main' }, this.tabsEl, this.body),
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
          lines: [`初期費用 ${yenStr(p.initialCost)}・家賃 ${yenStr(rent)}/日・来客 ×${(p.demand * (l?.demand ?? 1) * siteStats(code, propertyId).demandMult).toFixed(2)}・準備 ${p.openingDays}日`, ...forecastLines(s, code, propertyId)],
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
    // 同じ操作を続けて押しても二重に送らない（送っている間は同じ操作を受け付けない。じろ6）
    const key = JSON.stringify(a);
    if (this.inFlight.has(key)) return false;
    this.inFlight.add(key);
    this.body.classList.add('busy');
    let r: { ok: boolean; reason?: string };
    try {
      r = await this.host.act(a);
    } finally {
      this.inFlight.delete(key);
      if (this.inFlight.size === 0) this.body.classList.remove('busy');
    }
    if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn');
    else if (okMsg) toast(this.root, okMsg, 'good', 1600);
    this.render();
    return r.ok;
  }

  /** 取り消せる操作: 結果の知らせに「元に戻す」を付ける（押すと inverse を送る。じろ6） */
  private async actUndo(a: Action, msg: string, inverse: Action): Promise<boolean> {
    const ok = await this.act(a);
    if (ok) toastUndo(this.root, msg, () => void this.act(inverse, '元に戻しました'));
    return ok;
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
    // 共通市場の営業中は、企業間の貸し借りのために「会社」をいつも出す（オーナーの指示 2026-11-11）
    const showCompany = companyTabVisible(s) || this.host instanceof MarketHost;
    const ct = this.tabButtons.get('company');
    if (ct && ct.hidden === showCompany) ct.hidden = !showCompany;
    if (this.tab === 'company' && !showCompany) this.tab = 'dash';
    for (const [id, b] of this.tabButtons) {
      b.classList.toggle('on', id === this.tab);
      if (id === this.tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    const label = TABS.find(([id]) => id === this.tab)?.[1] ?? '経営';
    if (this.titleEl.textContent !== label) this.titleEl.textContent = label;
    const crumb = `${s.company ? storeDisplayName(s, activeStore(s)) : s.shopName}・${s.day}日目・${STAGES[s.career.stage]?.name ?? ''}`;
    if (this.crumbEl.textContent !== crumb) this.crumbEl.textContent = crumb;
    if (this.badge.hidden !== !ro) this.badge.hidden = !ro;
    this.el.classList.toggle('readonly', ro);
    let content: HTMLElement;
    try {
      content =
        this.tab === 'dash' ? this.dash(s)
        : this.tab === 'company' ? this.company(s)
        : this.tab === 'stock' ? this.stock(s)
        : this.tab === 'prep' ? this.prep(s)
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

  /** 営業中の会社の企業間の貸し借り（共通市場の営業中だけ。市場の今をサーバーから読む） */
  private creditView: MarketView | null = null;
  private creditLoadedAt = 0;
  private creditLoading = false;

  private marketCredit(): HTMLElement | null {
    if (!(this.host instanceof MarketHost)) return null;
    const session = this.host.session;
    const load = async () => {
      if (this.creditLoading) return;
      this.creditLoading = true;
      try {
        this.creditView = await session.api.viewMarket<MarketView>(session.auth.token, session.marketId);
        this.creditLoadedAt = Date.now();
      } catch (e) {
        toast(this.root, `市場を読み込めませんでした（${(e as Error)?.message ?? e}）`, 'warn');
        this.creditLoadedAt = Date.now();
      } finally {
        this.creditLoading = false;
        if (this.tab === 'company') this.render();
      }
    };
    if (!this.creditLoading && Date.now() - this.creditLoadedAt > 20_000) void load();
    if (!this.creditView) return h('section', { class: 'card wide', 'data-market-credit': 'loading' }, h('h4', null, '企業間の貸し借り'), h('p', { class: 'note' }, '市場を読み込んでいます…'));
    const card = creditCard(this.root, this.creditView, {
      op: async (op, okMsg) => {
        try {
          const r = await session.api.creditMarket(session.auth.token, session.marketId, `cr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, op);
          if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn');
          else toast(this.root, okMsg, 'good', 1800);
        } catch (e) {
          toast(this.root, (e as Error)?.message ?? String(e), 'warn');
        }
        this.creditLoadedAt = 0;
        await load();
      },
    });
    return card
      ? h('div', null, card, h('p', { class: 'note' }, '営業中でも申し込み・承認ができます。お金は、この日の営業を送ったあと（日の確定のあと）に動きます。前倒しの返済も、日の確定のあとに返します。'))
      : null;
  }

  // ───────────────── 会社（Phase 2: 店舗一覧・店舗別損益・会社の財務・出店・店長・方針） ─────────────────
  /** その店の運営のしかた（あなた・店長・店長代理・準備中・休業）の短い文 */
  private storeRunLabel(s: GameState, entry: StoreEntry): string {
    if (entry.id === s.company.activeStoreId) return 'あなた';
    if (entry.snapshot && entry.snapshot.closedForConstruction > 0) return '準備中';
    const st = storeStatus(s, entry);
    if (entry.managerId && st.employees.some((e) => e.id === entry.managerId)) return '店長';
    if (st.employees.some((e) => e.profile.role === 'leader')) return '店長代理';
    return '休業';
  }

  /**
   * 店舗ごとの売上（オーナーの指示 2026-11-12「どの店舗がどれだけ売り上げたかが見づらい」）。
   * 最後にそろった日の売上・営業利益・杯数と、直近7日の売上・営業利益・全店の売上に占める割合を、1店1行の表で
   */
  private storeSalesTable(s: GameState, compact = false): HTMLElement | null {
    const c = s.company;
    if (c.stores.length < 2) return null;
    const last = c.history.at(-1);
    if (!last) return h('p', { class: 'note' }, '次の日へ進むと、店ごとの売上がここに出ます');
    const week = c.history.slice(-7);
    const rows = c.stores.map((entry) => {
      const line = last.stores.find((x) => x.storeId === entry.id) ?? null;
      const wk = { sales: 0, op: 0, served: 0 };
      for (const r of week) {
        const l = r.stores.find((x) => x.storeId === entry.id);
        if (!l) continue;
        wk.sales += l.netSales;
        wk.op += l.operatingProfit;
        wk.served += l.served;
      }
      const rep = storeReport(s, entry, last.day);
      const how = line?.played ? 'あなた' : rep?.managed === 'closed' ? '休業' : rep?.managed === 'manager' ? '店長' : this.storeRunLabel(s, entry);
      return { entry, line, wk, how };
    });
    const totalWk = Math.max(1, rows.reduce((a, r) => a + Math.max(0, r.wk.sales), 0));
    const sum = rows.reduce((a, r) => ({ sales: a.sales + (r.line?.netSales ?? 0), op: a.op + (r.line?.operatingProfit ?? 0), served: a.served + (r.line?.served ?? 0), wkSales: a.wkSales + r.wk.sales, wkOp: a.wkOp + r.wk.op }), { sales: 0, op: 0, served: 0, wkSales: 0, wkOp: 0 });
    const tone = (v: number) => (v < 0 ? 'tone-bad' : v > 0 ? 'tone-good' : '');
    const head = h(
      'div',
      { class: 'ss-row ss-head' },
      ['店', '運営', `${last.day}日目の売上`, '営業利益', '杯', `直近${week.length}日の売上`, '営業利益', '割合'].map((t, i) => h('span', { class: `ss-c ss-c${i}` }, t)),
    );
    const body = rows.map((r) =>
      h(
        'div',
        { class: `ss-row${r.entry.id === c.activeStoreId ? ' here' : ''}`, 'data-store-sales': r.entry.id },
        h('span', { class: 'ss-c ss-c0' }, storeDisplayName(s, r.entry)),
        h('span', { class: 'ss-c ss-c1' }, h('span', { class: `chip-st ${r.how === '休業' ? 'bad' : r.how === 'あなた' ? 'info' : r.how === '準備中' ? 'warn' : 'good'}` }, r.how)),
        h('b', { class: 'ss-c ss-c2' }, yenStr(r.line?.netSales ?? 0)),
        h('b', { class: `ss-c ss-c3 ${tone(r.line?.operatingProfit ?? 0)}` }, yenSigned(r.line?.operatingProfit ?? 0, true)),
        h('span', { class: 'ss-c ss-c4' }, `${r.line?.served ?? 0}杯`),
        h('b', { class: 'ss-c ss-c5' }, yenStr(r.wk.sales)),
        h('b', { class: `ss-c ss-c6 ${tone(r.wk.op)}` }, yenSigned(r.wk.op, true)),
        h('span', { class: 'ss-c ss-c7' }, meterBar(Math.max(0, r.wk.sales) / totalWk, r.entry.id === c.activeStoreId ? 'info' : 'good', `売上の割合 ${Math.round((Math.max(0, r.wk.sales) / totalWk) * 100)}%`), h('small', null, `${Math.round((Math.max(0, r.wk.sales) / totalWk) * 100)}%`)),
      ),
    );
    const total = h(
      'div',
      { class: 'ss-row ss-total' },
      h('span', { class: 'ss-c ss-c0' }, '全店'),
      h('span', { class: 'ss-c ss-c1' }, `${c.stores.length}店`),
      h('b', { class: 'ss-c ss-c2' }, yenStr(sum.sales)),
      h('b', { class: `ss-c ss-c3 ${tone(sum.op)}` }, yenSigned(sum.op, true)),
      h('span', { class: 'ss-c ss-c4' }, `${sum.served}杯`),
      h('b', { class: 'ss-c ss-c5' }, yenStr(sum.wkSales)),
      h('b', { class: `ss-c ss-c6 ${tone(sum.wkOp)}` }, yenSigned(sum.wkOp, true)),
      h('span', { class: 'ss-c ss-c7' }),
    );
    return h('div', { class: `store-sales${compact ? ' compact' : ''}`, 'data-store-sales-table': '' }, h('div', { class: 'store-sales-grid' }, head, body, total));
  }

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
        kpi('返済の残り（借入・未払金）', yenSigned(totalDebt(s)), `借入の総額 ${yenStr(s.loans.reduce((a, l) => a + l.principal, 0))}`, totalDebt(s) > 0 ? 'warn' : ''),
        kpi('店の数', `${c.stores.length}店`, null),
        last ? kpi(`${last.day}日目の営業利益（全店）`, yenSigned(last.operatingProfit, true), `純売上 ${yenSigned(last.netSales)}${last.interest > 0 ? `・利息 −${yenStr(last.interest)}` : ''}`, last.operatingProfit < 0 ? 'bad' : 'good') : null,
      ]),
      week.length > 0 ? row(`直近${week.length}日の営業利益（全店）`, yenSigned(weekOp, true), weekOp < 0 ? 'bad' : 'good') : null,
      c.history.length > 1 ? profitBars(c.history.slice(-14).map((r) => ({ day: r.day, value: r.operatingProfit }))) : null,
      h('h5', null, '🏦 銀行の借入'),
      loanSummary(s),
    );
    const storeCards = c.stores.map((entry) => {
      const st = storeStatus(s, entry);
      const active = entry.id === c.activeStoreId;
      const r = last ? storeReport(s, entry, last.day) : null;
      const mgr = st.employees.find((e) => e.id === entry.managerId) ?? null;
      const prop = storeProperty(entry);
      const name = storeDisplayName(s, entry);
      const run = this.storeRunLabel(s, entry);
      const status = active ? '🧑‍🍳 いまここ（あなたが営業）' : run === '準備中' ? '🛠 準備中' : run === '店長' ? '👔 店長が営業' : run === '店長代理' ? '👔 店長代理（シフトリーダー）が営業' : '⛔ 店長（店長代理のシフトリーダー）がいないため休業';
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
    const sales = c.stores.length > 1 ? h('section', { class: 'card wide', 'data-company-store-sales': '' }, cardHead('店舗ごとの売上', '店ごとの売上（純売上）・営業利益・杯数です。左は最後にそろった日、右は直近7日の合計と、全店の売上に占める割合。運営は、その日に誰が店を回したか（あなた・店長・店長代理・休業）です。'), this.storeSalesTable(s)) : null;
    return h('div', { class: 'grid2' }, sales, storeDaysCard(s), finance, this.marketCredit(), ...storeCards, openCard, moveCard);
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
    const fc = fixedCosts(s);
    const arrears = s.arrears.reduce((a, b) => a + b.amount, 0);
    const loan = s.loans.reduce((a, b) => a + b.remaining, 0);
    const lowStock = ['yasai', 'buta', 'garlic', 'abura', 'tare', 'noodle'].filter((id) => stockOf(s, id) < (id === 'noodle' ? 1500 : id === 'buta' ? 6 : 100));
    const row = (k: string, v: string, cls = '') => h('div', { class: `kv compact ${cls}` }, h('span', null, k), h('b', null, v));
    const hist = s.history.slice(-14);
    const prev = s.history.filter((r) => r.day < s.day).slice(-1)[0] ?? null;
    const repDelta = delta(s.reputation, prev ? prev.reputation : null, (v) => v.toFixed(2));
    const cashDelta = s.phase === 'closed' && s.history[s.history.length - 1]?.day === s.day ? s.history[s.history.length - 1]! : null;
    // ── 先頭の8つの数字（じろ6: 現金・売上・営業利益・最終利益・負債・在庫・来客・勤務）。実績（昨日・今日）と営業中の今日を札で区別する ──
    const lastRep = s.history.at(-1) ?? null;
    const live = s.phase === 'open' || s.phase === 'closing';
    const rep = !live && lastRep && (s.phase === 'closed' ? lastRep.day === s.day : lastRep.day < s.day) ? lastRep : null;
    const src = rep ?? d;
    const srcOp = rep ? rep.operatingProfit : op;
    const srcFinal = rep ? (rep.finalProfit ?? rep.operatingProfit - rep.interest) : op - d.interest;
    const tag = live ? h('span', { class: 'kpi-tag live' }, '今日・営業中') : rep ? h('span', { class: 'kpi-tag actual' }, rep.day === s.day ? '今日の実績' : '昨日の実績') : h('span', { class: 'kpi-tag' }, 'まだ営業していません');
    const debt = loan + arrears;
    const borrowed = s.loans.reduce((a, b) => a + b.principal, 0);
    const scheduled = s.employees.filter((e) => e.att?.day === s.day ? e.att.shift !== null || e.att.calledIn : shiftFor(e, s.day) !== null);
    const working = s.employees.filter((e) => e.presentToday).length;
    const absent = s.employees.filter((e) => e.att?.day === s.day && e.att.status === 'absent').length;
    const late = s.employees.filter((e) => e.att?.day === s.day && e.att.status === 'late').length;
    const injured = s.employees.filter((e) => injuredOn(e, s.day)).length;
    const kpis = h(
      'div',
      { class: 'dash-kpis' },
      h('div', { class: 'dash-kpis-head' }, h('span', null, '大事な数字'), tag),
      kpiRow(
        [
          kpi('💴 現金残高', yenStr(s.money), cashDelta ? `今日 ${yenSigned(cashDelta.cashEnd - cashDelta.cashStart, true)}` : rep ? `前日比 ${yenSigned(rep.cashEnd - rep.cashStart, true)}` : `翌営業日の支出 ${yenStr(fc.total)}`, s.money < fc.total ? 'bad' : 'hero', '', { 'data-kpi': 'cash' }),
          kpi('売上', yenStr(src.sales), `${src.served}杯${src.refunds > 0 ? `・返金 ${yenStr(src.refunds)}` : ''}`, '', '', { 'data-kpi': 'sales' }),
          kpi('営業利益', yenSigned(srcOp, true), src.sales > 0 ? `利益率 ${Math.round((srcOp / Math.max(1, src.sales - src.refunds)) * 100)}%` : '売上から費用を引いた額', srcOp > 0 ? 'good' : srcOp < 0 ? 'bad' : '', '', { 'data-kpi': 'op' }),
          kpi('最終利益', yenSigned(srcFinal, true), src.interest > 0 ? `利息など −${yenStr(src.interest)}` : '利息なし', srcFinal > 0 ? 'good' : srcFinal < 0 ? 'bad' : '', '', { 'data-kpi': 'final' }),
          kpi('負債（返済の残り）', yenStr(debt), borrowed > 0 ? `借入の総額 ${yenStr(borrowed)}${arrears > 0 ? `・未払金 ${yenStr(arrears)}` : ''}` : arrears > 0 ? `未払金 ${yenStr(arrears)}` : '借入なし', arrears > 0 ? 'bad' : '', '', { 'data-kpi': 'debt' }),
          kpi('在庫', lowStock.length > 0 ? `${lowStock.length}品 少ない` : '足りている', lowStock.length > 0 ? lowStock.slice(0, 3).map((id) => (INGREDIENTS[id]?.name ?? id).replace(/（.*）/, '')).join('・') : '主な食材と仕込み品', lowStock.length > 0 ? 'warn' : '', '', { 'data-kpi': 'stock' }),
          kpi('来客', `${src.customers}人`, src.lost + src.balked > 0 ? `帰った客 ${src.lost}人・諦めた ${src.balked}人` : '帰った客なし', '', src.lost > 0 ? 'warn' : '', { 'data-kpi': 'customers' }),
          kpi('今日の勤務', `${working} / ${scheduled.length}人`, `${absent > 0 ? `欠勤 ${absent}・` : ''}${late > 0 ? `遅刻 ${late}・` : ''}${injured > 0 ? `療養 ${injured}・` : ''}店にいる / 予定`, absent + injured > 0 ? 'warn' : '', '', { 'data-kpi': 'staff' }),
        ],
        'dash-kpi-row',
      ),
    );
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
        { label: '原価', value: src.cogs + src.waste, color: '#e0a457' },
        { label: '人件費', value: src.wages, color: '#6fb3e0' },
        { label: '家賃', value: src.rent, color: '#b48ad6' },
        { label: 'その他', value: src.upkeep + src.utilities + src.repairs + src.hiring + (src.ads ?? 0), color: '#9aa3ad' },
      ],
      srcOp,
    );
    // ── 今日の勤務（1人1行・状態の札） ──
    const stTone: Record<string, string> = { working: 'good', break: 'info', scheduled: '', late: 'warn', absent: 'bad', left: '', off: '', closed: '' };
    const staffRows = s.employees.map((e) => {
      const a = e.att && e.att.day === s.day ? e.att : null;
      const inj = injuredOn(e, s.day) || e.injury?.day === s.day;
      const label = inj ? '療養' : a ? ATTENDANCE_LABEL[a.status] : e.presentToday ? '勤務中' : '休み';
      const tone = inj ? 'bad' : a ? (stTone[a.status] ?? '') : e.presentToday ? 'good' : '';
      return h(
        'div',
        { class: 'dash-staff-row', 'data-dash-staff': e.id },
        h('span', { class: 'dash-staff-name' }, e.profile.name, h('small', null, `${isPartTime(e) ? 'アルバイト' : '社員'}・${ROLE_LABEL[e.profile.role]}`)),
        h('span', { class: `chip-st ${tone}` }, label),
        h('small', { class: 'dash-staff-when' }, attendanceText(e, s).replace(/^勤務中（|の予定$|）$/g, '')),
      );
    });
    // ── 在庫があと何日もつか（直近7営業日に使った量の平均から。届く予定を入れる） ──
    const used = (id: string) => avgDailyUse(s, id);
    const stockDays = Object.values(INGREDIENTS)
      .filter((x) => x.purchasable && isUnlocked(s, x.unlock))
      .map((x) => ({ x, per: used(x.id), have: stockOf(s, x.id), coming: pendingOf(s, x.id) }))
      .filter((r) => r.per > 0)
      .map((r) => ({ ...r, days: (r.have + r.coming) / r.per }))
      .sort((a, b) => a.days - b.days)
      .slice(0, 6);
    const srcLabel = live ? '今日（営業中）' : rep ? (rep.day === s.day ? '今日' : '昨日') : '今日';
    return h(
      'div',
      null,
      kpis,
      // 2店以上: 店舗ごとの売上（8つの数字は今いる店のもの。オーナーの指示 2026-11-12）
      s.company.stores.length > 1
        ? h(
            'section',
            { class: 'card dash-stores', 'data-dash-stores': '' },
            cardHead('店舗ごとの売上', '上の8つの数字は今いる店のものです。ほかの店も入れた店ごとの売上・営業利益はこの表と「会社」で見られます。'),
            this.storeSalesTable(s, true),
            h('div', { class: 'row' }, goTab('company', '会社の画面へ')),
          )
        : null,
      h(
        'div',
        { class: 'grid2' },
        h(
          'section',
          { class: 'card', 'data-dash-flow': '' },
          cardHead(`${srcLabel}のお金の流れ`, '売上から、原価・人件費・家賃・その他の費用を引いた残りが営業利益、そこから利息などを引いたものが最終利益です。家賃・給与・維持費・基本光熱費は閉店後の精算で計上されます。食材の仕入れは在庫（資産）になり、使ったときに原価になります。仕入れと設備投資は現金の支出で、損益には入りません。'),
          flow,
          row('売上', yenStr(src.sales)),
          src.refunds > 0 ? row('返金', `−${yenStr(src.refunds)}`) : null,
          row('食材原価＋廃棄', `−${yenStr(src.cogs + src.waste)}`, src.waste > 0 ? 'warn' : ''),
          row('人件費', `−${yenStr(src.wages)}`),
          row('家賃', `−${yenStr(src.rent)}`),
          row('光熱費・維持費・修理', `−${yenStr(src.utilities + src.upkeep + src.repairs)}`),
          src.hiring > 0 ? row('採用・解雇', `−${yenStr(src.hiring)}`) : null,
          (src.ads ?? 0) > 0 ? row('広告', `−${yenStr(src.ads ?? 0)}`) : null,
          row('営業利益', yenSigned(srcOp, true), srcOp < 0 ? 'bad' : 'good'),
          src.interest > 0 ? row('利息など', `−${yenStr(src.interest)}`) : null,
          row('最終利益', yenSigned(srcFinal, true), srcFinal < 0 ? 'bad' : 'good'),
          row('仕入れ・設備投資（現金の支出）', `${yenStr(src.purchases)}・${yenStr(src.capex)}`),
        ),
        h(
          'div',
          { class: 'dash-stack' },
          h('section', { class: 'card' }, cardHead('この2週間の営業利益', '1本が1日。0の線から上が黒字、下が赤字です。棒を押すと（PCではマウスを乗せると）その日の額が出ます。'), profitBars(hist.map((r) => ({ day: r.day, value: r.operatingProfit })))),
          h('section', { class: 'card', 'data-alerts': '' }, cardHead('気をつけること'), h('div', { class: 'alerts' }, alerts)),
        ),
        h(
          'section',
          { class: 'card', 'data-dash-staff-card': '' },
          cardHead(`今日の勤務（${working}人が店に）`, '今日の予定と状態です。シフトの変更・社員にする・担当の変更は「従業員」でできます。'),
          staffRows.length > 0 ? h('div', { class: 'dash-staff' }, staffRows) : h('p', { class: 'note' }, 'まだ誰も雇っていません'),
          h('div', { class: 'row' }, goTab('staff', 'シフト・勤務を見る')),
        ),
        h(
          'section',
          { class: 'card', 'data-dash-stockdays': '' },
          cardHead('在庫があと何日もつか', '直近7営業日に使った量の平均で、今の在庫と届く予定の分が何日もつかの目安です。3日を切ると黄色、1日を切ると赤になります。'),
          stockDays.length > 0
            ? stockDays.map((r) =>
                h(
                  'div',
                  { class: 'dash-days-row' },
                  h('span', null, (r.x.name ?? r.x.id).replace(/（.*）/, '')),
                  meterBar(Math.min(1, r.days / 7), r.days < 1 ? 'bad' : r.days < 3 ? 'warn' : 'good', `${r.x.name} あと${r.days.toFixed(1)}日`),
                  h('b', { class: r.days < 1 ? 'tone-bad' : r.days < 3 ? 'tone-warn' : '' }, r.days >= 30 ? '30日以上' : `あと${r.days < 10 ? r.days.toFixed(1) : Math.round(r.days)}日`),
                ),
              )
            : h('p', { class: 'note' }, '営業すると、使った量からここに出ます'),
          h('div', { class: 'row' }, goTab('stock', '発注の画面へ')),
        ),
        h(
          'section',
          { class: 'card' },
          cardHead(`${srcLabel}の営業`, '平均待ち時間は、席に着いてから提供されるまで。帰った客は、待ちすぎ・品切れで食べずに帰った人。諦めた客は、行列を見て並ばなかった人です。'),
          row('来客数', `${src.customers}人`),
          row('提供数', `${src.served}杯`),
          row('途中で帰った客', `${src.lost}人`, src.lost > 0 ? 'warn' : ''),
          row('行列を見て諦めた客', `${src.balked}人`),
          row('平均待ち時間（着席→提供）', `${(src.served > 0 ? src.totalSeatWait / src.served : 0).toFixed(0)}秒`),
          row('平均満足度', `${Math.round((src.satisfactionCount > 0 ? src.satisfactionSum / src.satisfactionCount : 0) * 100)}%`),
          row('評判', `${s.reputation.toFixed(2)}${repDelta ? `（${repDelta.text}）` : ''}`, repDelta?.tone === 'bad' ? 'bad' : ''),
          row('注文ミス / クレーム', `${src.mistakes} / ${src.complaints}`),
          row('品切れ / 設備故障', `${src.stockouts}回 / ${src.breakdowns}回`, src.stockouts > 0 ? 'warn' : ''),
        ),
        h(
          'section',
          { class: 'card' },
          cardHead('翌営業日の支出の予想', '次の営業日の閉店後の精算で払う見込みの額です（給与はシフトの予定から）。現金がこれより少ないと赤くなります。'),
          row('家賃', yenStr(fc.rent)),
          row('給与', yenStr(fc.wages)),
          row('設備維持費', yenStr(fc.upkeep)),
          row('光熱費（基本）', yenStr(fc.utilities)),
          fc.loans > 0 ? row('融資返済＋利息', yenStr(fc.loans)) : null,
          row('合計', yenStr(fc.total), s.money < fc.total ? 'bad' : ''),
        ),
        s.loans.length > 0 || arrears > 0
          ? h('section', { class: 'card', 'data-dash-loans': '' }, cardHead('借入（銀行）', '借入の総額は借りた額の合計、返済の残りはまだ返していない額です。毎日の閉店後の精算で、元金の分と利息を返します。'), loanSummary(s))
          : null,
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
          { class: 'table stock-table' },
          purch.map((d) => {
            // 店の場所の物価を入れた1パックの値段（じろ1 5.5）
            const pack = packPriceOf(s, d.id);
            const target = s.autoOrder[d.id] ?? 0;
            const have = stockOf(s, d.id);
            const coming = pendingOf(s, d.id);
            const per = avgDailyUse(s, d.id);
            const days = per > 0 ? (have + coming) / per : null;
            const n = (v: number) => `${Math.floor(v).toLocaleString('ja-JP')}${d.unit}`;
            // 発注の結果: 何を・いくらで・いつ届くかと、入荷予定の前と後（じろ6）
            const order = async (express: boolean) => {
              const before = pendingOf(this.host.state, d.id);
              if (!(await this.act({ type: 'orderStock', itemId: d.id, packs: 1, express }))) return;
              toast(
                this.root,
                `${d.name} 1パック（${d.packQty.toLocaleString('ja-JP')}${d.unit}・${yenStr(express ? Math.round(pack * 1.3) : pack)}）を${express ? '当日便（約60秒で届く）' : '翌朝便（あすの開店前に届く）'}で頼みました。入荷予定 ${n(before)} → ${n(pendingOf(this.host.state, d.id))}`,
                'good',
                2600,
              );
            };
            return h(
              'div',
              { class: 'trow stock-row', 'data-stock-row': d.id },
              h('div', { class: 'tname' }, d.name, h('small', null, `1パック ${d.packQty.toLocaleString('ja-JP')}${d.unit} / ${yenStr(pack)}`)),
              h(
                'div',
                { class: 'stock-nums' },
                h('span', { class: 'sn' }, h('small', null, '在庫'), h('b', { 'data-stock-have': d.id }, n(have))),
                h('span', { class: `sn coming${coming > 0 ? ' on' : ''}` }, h('small', null, '入荷予定'), h('b', null, coming > 0 ? `+${n(coming)}` : '—')),
                h('span', { class: `sn days${days !== null && days < 1 ? ' bad' : days !== null && days < 3 ? ' warn' : ''}`, title: '在庫と入荷予定が、直近7営業日の1日の平均で何日もつか' }, h('small', null, 'もつ日数'), h('b', null, daysText(days))),
              ),
              h(
                'div',
                { class: 'tbtns' },
                h('button', { class: 'mini', onclick: () => void order(false) }, '翌朝便'),
                h('button', { class: 'mini warn', onclick: () => void order(true) }, '当日便'),
              ),
              h(
                'div',
                { class: 'tauto' },
                // 食材ごとに自動の仕入れを止める・戻す（目安の量は残る。じろ2）
                h(
                  'button',
                  {
                    class: `mini ${autoOrderEnabled(s, d.id) ? 'on' : 'ghost'}`,
                    'data-auto-item': d.id,
                    onclick: () => this.actUndo({ type: 'setAutoOrderItem', itemId: d.id, enabled: !autoOrderEnabled(s, d.id) }, `${d.name}の自動の仕入れを${autoOrderEnabled(s, d.id) ? '止めました' : '戻しました'}`, { type: 'setAutoOrderItem', itemId: d.id, enabled: autoOrderEnabled(s, d.id) }),
                  },
                  autoOrderEnabled(s, d.id) ? '自動 ON' : '自動 OFF',
                ),
                h('button', { class: 'mini ghost', onclick: () => this.actUndo({ type: 'setAutoOrder', itemId: d.id, qty: Math.max(0, target - d.packQty) }, `${d.name}の目安の量 ${target.toLocaleString('ja-JP')} → ${Math.max(0, target - d.packQty).toLocaleString('ja-JP')}${d.unit}`, { type: 'setAutoOrder', itemId: d.id, qty: target }) }, '−'),
                h('b', null, target > 0 ? `${target.toLocaleString('ja-JP')}${d.unit}` : 'なし'),
                h('button', { class: 'mini ghost', onclick: () => this.actUndo({ type: 'setAutoOrder', itemId: d.id, qty: target + d.packQty }, `${d.name}の目安の量 ${target.toLocaleString('ja-JP')} → ${(target + d.packQty).toLocaleString('ja-JP')}${d.unit}`, { type: 'setAutoOrder', itemId: d.id, qty: target }) }, '＋'),
                s.autoOrderMode === 'sales' && target > 0 ? h('small', { class: 'auto-now' }, `今夜の目安 ${autoOrderTarget(s, d.id).toLocaleString('ja-JP')}${d.unit}`) : null,
                Number.isFinite(shelfLifeCap(s, d.id)) ? h('small', { class: 'auto-now' }, `保存期間の上限 ${Math.round(shelfLifeCap(s, d.id)).toLocaleString('ja-JP')}${d.unit}`) : null,
              ),
            );
          }),
        ),
      ),
      this.purchaseLogCard(s),
      h(
        'section',
        { class: 'card wide' },
        cardHead('仕込み品（店内で作る）', '仕込み: 豚を煮込む→（煮豚・タレ）→ 仕込み台で豚を切る / 野菜ゆで釜でヤサイ / 仕込み台でニンニクを刻む / 煮込み鍋で背脂を炊く / 寸胴でスープを炊く。'),
        h('div', { class: 'row wrap' }, h('span', { class: 'note' }, '仕込みの目安・開店前の計画・時間帯と曜日の調整は「仕込み」のタブで決めます'), h('button', { class: 'mini', 'data-guest-ok': '1', onclick: () => { this.tab = 'prep'; this.render(); this.body.scrollTop = 0; } }, '仕込みのタブへ')),
        h(
          'div',
          { class: 'table stock-table' },
          prepared.map((d) => {
            const making = inProcessOutput(s, d.id);
            const plan = (s.prepPlan && s.prepPlan.day === s.day ? s.prepPlan.items[d.id] : undefined) ?? null;
            const fmtQ = (v: number) => `${Math.floor(v).toLocaleString('ja-JP')}${d.unit}`;
            return h(
              'div',
              { class: 'trow stock-row', 'data-prepared-row': d.id },
              h('div', { class: 'tname' }, d.name, h('small', null, d.shelfLifeDays === 0 ? '当日限り' : `${d.shelfLifeDays}日もつ`)),
              h(
                'div',
                { class: 'stock-nums' },
                h('span', { class: 'sn' }, h('small', null, '在庫'), h('b', null, fmtQ(stockOf(s, d.id)))),
                h('span', { class: `sn coming${making > 0 ? ' on' : ''}` }, h('small', null, '仕込み中'), h('b', null, making > 0 ? `+${fmtQ(making)}` : '—')),
                h('span', { class: `sn plan${plan ? ' on' : ''}` }, h('small', null, '今日の計画'), h('b', null, plan ? fmtQ(plan) : '—')),
              ),
            );
          }),
        ),
      ),
    );
  }

  /** 仕入れの記録（じろ2: いつ・何を・いくつ・いくら・誰が。新しい順に20件） */
  private purchaseLogCard(s: GameState): HTMLElement {
    const log = (s.purchaseLog ?? []).slice().reverse().slice(0, 20);
    const byText = { manual: '自分', auto: '自動発注', manager: '店長' } as const;
    return h(
      'section',
      { class: 'card wide', 'data-purchase-log': '' },
      cardHead('仕入れの記録（最近20件）', '頼んだ日・食材・パック数・代金・当日便か・誰が頼んだか（自分・自動発注・店長）です。自動発注は、保存期間のうちに使い切れない分は頼みません。'),
      log.length === 0
        ? h('p', { class: 'note' }, 'まだ仕入れていません')
        : log.map((p) =>
            h(
              'div',
              { class: 'kv' },
              h('span', null, `${p.day}日目 ${INGREDIENTS[p.itemId]?.name ?? p.itemId} ×${p.packs}${p.express ? '（当日便）' : ''}`),
              h('b', null, `${yenStr(p.cost)}・${byText[p.by]}`),
            ),
          ),
    );
  }

  /** 翌朝便の発注をだれがするか（店長がいる店だけ。じろ1 5.8）と、店長の発注の実績 */
  private managerOrderRow(s: GameState): HTMLElement | null {
    if (!s.company) return null;
    const st = activeStore(s);
    const mgr = st.managerId ? s.employees.find((e) => e.id === st.managerId) : null;
    // 店長がいなくても、シフトリーダーがいれば店長代理として発注する（オーナーの指示 2026-11-12）
    const leaders = s.employees.filter((e) => e.profile.role === 'leader' && e.id !== mgr?.id);
    if (!mgr && leaders.length === 0) return null;
    const byMgr = st.policy.orderBy !== 'self';
    const last = s.history.at(-1)?.managerOrder;
    const who = mgr ? `店長（${mgr.profile.name}さん）` : `店長代理（シフトリーダーの${leaders.map((e) => e.profile.name).join('・')}さん）`;
    const act = actingManager(s);
    const set = (orderBy: 'manager' | 'self', msg: string) => this.actUndo({ type: 'setStorePolicy', storeId: st.id, policy: { orderBy } }, msg, { type: 'setStorePolicy', storeId: st.id, policy: { orderBy: byMgr ? 'manager' : 'self' } });
    return h(
      'div',
      { class: 'manager-order', 'data-manager-order': byMgr ? 'manager' : 'self' },
      h(
        'div',
        { class: 'row wrap' },
        h('span', null, '仕入れ:'),
        h('button', { class: `mini ${byMgr ? 'on' : 'ghost'}`, 'data-order-by': 'manager', onclick: () => set('manager', `${who}に仕入れを任せました`) }, mgr ? '🧑‍🍳 店長に任せる' : '🧑‍🍳 店長代理に任せる'),
        h('button', { class: `mini ${!byMgr ? 'on' : 'ghost'}`, 'data-order-by': 'self', onclick: () => set('self', '仕入れを自分の設定にしました') }, '自分の設定で'),
      ),
      h(
        'p',
        { class: 'note' },
        byMgr
          ? `${who}が、営業中は閉店までに足りなくなりそうな材料を当日便で先に仕入れ、閉店後はその日の売れ行き・あすの曜日と営業時間・定休日から来客を予測して翌朝便を発注します。仕込み品が切れそうなときは先に仕込みます。${mgr && leaders.length > 0 ? '店長が休み・休憩のときは、店にいるシフトリーダーが店長代理としてします。' : ''}（下の「自動」の目安が0の食材は発注しません。手元に翌日の固定費の2日分を残します）。${last ? `前回: ${yenStr(last.spent)}・${last.packs}パック${last.skipped > 0 ? `（資金が少なく${last.skipped}パック減らした）` : ''}` : ''}`
          : '下の自動発注の設定のとおりに発注します（当日便も自分で頼みます）。',
      ),
      byMgr && act && (s.phase === 'open' || s.phase === 'prep') ? h('p', { class: 'note', 'data-acting-manager': act.deputy ? 'deputy' : 'manager' }, `今、店にいる${act.deputy ? '店長代理' : '店長'}: ${act.e.profile.name}さん`) : null,
      byMgr && last?.forecast ? h('p', { class: 'note', 'data-manager-forecast': '1' }, `${managerTitle(s)}のあすの予測: ${forecastText(last.forecast)}`) : null,
      byMgr && s.today.managerExpress ? h('p', { class: 'note warn' }, `今日の当日便: ${s.today.managerExpress.packs}パック ${yenStr(s.today.managerExpress.spent)}`) : null,
    );
  }

  /**
   * 仕込みの目安（品ごとに「自動」か量。じろ1 5.8）。じろ2（改修設計書02）: 「○人前」で選べ、在庫と予想の杯数と比べて見る。
   * 1人前は最近の日報の使用量 ÷ 杯数
   */
  private prepTargetRows(s: GameState): HTMLElement {
    const items = prepTargetItems().filter((x) => isUnlocked(s, INGREDIENTS[x.itemId]?.unlock));
    const fc = forecastNextDay(s);
    const expect = fc && !fc.closed ? fc.bowls : null;
    return h(
      'div',
      { class: 'prep-targets' },
      h(
        'p',
        { class: 'note' },
        `仕込みの目安: 在庫がこの量より少なくなったら、店員が仕込みます。「自動」は売れ行きから決めます（ピークの時間に足りる量）。${expect !== null ? `あすの予想は約${expect}杯です。` : ''}`,
      ),
      h(
        'div',
        { class: 'table' },
        items.map(({ itemId, minQty }) => {
          const d = INGREDIENTS[itemId]!;
          const per = prepPerBowl(s, itemId);
          const servings = (q: number) => Math.round(q / Math.max(1e-9, per));
          const cur = s.prepTargets?.[itemId];
          const opts: [string, string][] = [['', '自動']];
          const seen = new Set<string>();
          for (const n of [5, 10, 20, 30, 50, 80, 120]) {
            const q = Math.round(n * per);
            if (q <= 0 || q > minQty * 20 || seen.has(String(q))) continue;
            seen.add(String(q));
            opts.push([String(q), `${n}人前（${q.toLocaleString('ja-JP')}${d.unit}）`]);
          }
          if (cur !== undefined && !opts.some(([v]) => v === String(cur))) opts.push([String(cur), `${servings(cur)}人前（${cur.toLocaleString('ja-JP')}${d.unit}）`]);
          const stock = stockOf(s, itemId);
          return h(
            'div',
            { class: 'trow', 'data-prep-row': itemId },
            h(
              'div',
              { class: 'tname' },
              d.name,
              h('small', null, `在庫 ${Math.floor(stock).toLocaleString('ja-JP')}${d.unit}（約${servings(stock)}人前）・1人前 約${per < 10 ? per.toFixed(1) : Math.round(per)}${d.unit}${expect !== null ? `・あすの予想${expect}杯なら約${Math.round(expect * per).toLocaleString('ja-JP')}${d.unit}` : ''}`),
            ),
            h(
              'select',
              {
                class: 'select',
                'data-prep-target': itemId,
                onchange: (ev: Event) => {
                  const v = (ev.target as HTMLSelectElement).value;
                  void this.actUndo({ type: 'setPrepTarget', itemId, qty: v === '' ? null : Number(v) }, `${d.name}の仕込みの目安を${v === '' ? '自動' : `${servings(Number(v))}人前（${Number(v).toLocaleString('ja-JP')}${d.unit}）`}にしました`, { type: 'setPrepTarget', itemId, qty: cur ?? null });
                },
              },
              opts.map(([v, label]) => h('option', { value: v, selected: v === (cur === undefined ? '' : String(cur)) }, label)),
            ),
          );
        }),
      ),
    );
  }

  // ───────────────── 仕込み（オーナーの指示 2026-11-12: 仕込みの調整機能） ─────────────────
  private prep(s: GameState): HTMLElement {
    const items = prepPlanItems(s);
    const today = forecastDay(s, s.day);
    const bowls = today && !today.closed ? today.bowls : null;
    const progress = prepPlanProgress(s);
    const planOn = s.prepPlan?.day === s.day;
    const canPlan = s.phase === 'prep';
    const avg = progress.length > 0 ? progress.reduce((a, p) => a + p.ratio, 0) / progress.length : null;
    const host = this.host.isHost;
    const unitOf = (id: string) => INGREDIENTS[id]?.unit ?? '';
    const servingsOf = (id: string, q: number) => Math.round(q / Math.max(1e-9, prepPerBowl(s, id)));
    const planRows = items.map(({ itemId, max }) => {
      const d = INGREDIENTS[itemId]!;
      const per = prepPerBowl(s, itemId);
      const cur = s.prepPlan?.day === s.day ? (s.prepPlan.items[itemId] ?? 0) : 0;
      const have = prepHave(s, itemId);
      const opts: [number, string][] = [[0, '計画しない']];
      const seen = new Set<number>([0]);
      for (const n of [10, 20, 30, 40, 60, 80, 100, 150]) {
        const q = Math.round(n * per);
        if (q <= 0 || q > max || seen.has(q)) continue;
        seen.add(q);
        opts.push([q, `${n}人前（${q.toLocaleString('ja-JP')}${unitOf(itemId)}）`]);
      }
      if (cur > 0 && !seen.has(cur)) opts.push([cur, `${servingsOf(itemId, cur)}人前（${cur.toLocaleString('ja-JP')}${unitOf(itemId)}）`]);
      const ratio = cur > 0 ? Math.min(1, have / cur) : null;
      return h(
        'div',
        { class: 'trow', 'data-plan-row': itemId },
        h('div', { class: 'tname' }, d.name, h('small', null, `手元 ${Math.floor(have).toLocaleString('ja-JP')}${unitOf(itemId)}（約${servingsOf(itemId, have)}人前・鍋で作っている分を含む）`)),
        h(
          'select',
          {
            class: 'select',
            'data-plan-item': itemId,
            disabled: !canPlan,
            onchange: (ev: Event) => {
              const v = Number((ev.target as HTMLSelectElement).value);
              void this.act({ type: 'setPrepPlan', items: { [itemId]: v > 0 ? v : null } }, v > 0 ? `${d.name}を開店までに${servingsOf(itemId, v)}人前（${v.toLocaleString('ja-JP')}${unitOf(itemId)}）仕込む計画にしました` : `${d.name}を計画から外しました`);
            },
          },
          opts.map(([v, label]) => h('option', { value: String(v), selected: v === cur }, label)),
        ),
        h('div', { class: 'tsub plan-meter' }, ratio === null ? '—' : meterBar(ratio, ratio >= 1 ? 'good' : 'accent', `${d.name}の仕込みの進み具合 ${Math.round(ratio * 100)}%`), ratio === null ? null : h('small', null, `${Math.round(ratio * 100)}%`)),
      );
    });
    const choice = (v: number) => (v === 1 ? 'ふつう' : `×${v}`);
    const sched = s.prepSchedule ?? {};
    const wds = sched.weekday ?? [1, 1, 1, 1, 1, 1, 1];
    const openHours = Math.max(1, Math.ceil(openMinutesOf(storeHours(s)) / 60));
    const hrs = Array.from({ length: openHours }, (_, i) => sched.hours?.[i] ?? 1);
    const setWeekday = (i: number, v: number) => {
      const next = [...wds];
      next[i] = v;
      void this.act({ type: 'setPrepSchedule', weekday: next }, `${WEEKDAY_LABEL[i]}曜の仕込みの量を${choice(v)}にしました`);
    };
    const setHour = (i: number, v: number) => {
      const next = [...hrs];
      next[i] = v;
      void this.act({ type: 'setPrepSchedule', hours: next }, `開店から${i + 1}時間目の仕込みの量を${choice(v)}にしました`);
    };
    const hourLabel = (i: number) => `${shiftTimeText(i * 60, storeHours(s))}〜`;
    return h(
      'div',
      null,
      kpiRow(
        [
          kpi('今日の予想', bowls !== null ? `約${bowls}杯` : '—', bowls !== null ? '最近の営業・曜日・営業時間から' : '営業した日がまだありません', '', '', { 'data-kpi': 'prep-forecast' }),
          kpi('開店前の計画', planOn ? `${progress.length}品` : 'なし', avg !== null ? `進み具合 ${Math.round(avg * 100)}%` : canPlan ? '下で決められます' : '開店前（仕込みの時間）に決めます', avg !== null && avg >= 1 ? 'good' : '', avg !== null && avg >= 1 ? 'good' : '', { 'data-kpi': 'prep-plan' }),
          kpi('今の倍率', `×${prepScheduleMult(s)}`, `${WEEKDAY_LABEL[weekdayOf(s.day)]}曜・${s.phase === 'open' ? '営業中の時間帯' : '開店から1時間目'}`, prepScheduleMult(s) !== 1 ? 'accent' : ''),
        ],
        'tab-kpis',
      ),
      h(
        'section',
        { class: 'card wide', 'data-prep-plan': '1' },
        cardHead('開店前の仕込みの計画', '開店前（仕込みの時間）に、品ごとに「開店までに用意する量」を決めると、店員がその量まで仕込みます。手元の量には鍋・釜で作っている分を含みます。開店すると計画は終わり、ふだんの仕込みの目安に戻ります。'),
        canPlan
          ? h(
              'div',
              { class: 'row wrap' },
              host
                ? h('button', { class: 'mini', 'data-plan-suggest': '1', onclick: () => void this.act({ type: 'setPrepPlan', items: suggestPrepPlan(s) }, '今日の予想の半分（残りは営業中に仕込みます）を計画にしました') }, '📈 今日の予想から決める')
                : null,
              host && planOn
                ? h('button', { class: 'mini ghost', 'data-plan-clear': '1', onclick: () => void this.act({ type: 'setPrepPlan', items: Object.fromEntries(Object.keys(s.prepPlan!.items).map((k) => [k, null])) }, '計画を消しました') }, '計画を消す')
                : null,
            )
          : h('p', { class: 'note' }, '計画は開店前（仕込みの時間）に決めます。営業中は下の「仕込みの目安」と「時間帯・曜日」で店員が仕込みます。'),
        h('div', { class: 'table' }, planRows),
      ),
      h(
        'section',
        { class: 'card wide' },
        cardHead('仕込みの目安（営業中に店員が仕込む量）', '在庫がこの量より少なくなったら、店員が仕込みます。「自動」は売れ行きから決めます。下の「時間帯・曜日」の倍率が掛かります。'),
        this.prepTargetRows(s),
      ),
      h(
        'section',
        { class: 'card wide', 'data-prep-schedule': '1' },
        cardHead('時間帯・曜日で変える', '仕込みの目安に掛ける倍率です。忙しい曜日・時間帯は多め、閉店前は少なめ、などにできます（開店前の仕込みは開店から1時間目の倍率）。'),
        h('h5', null, '曜日'),
        h(
          'div',
          { class: 'sched-row' },
          WEEKDAY_LABEL.map((label, i) =>
            h(
              'label',
              { class: 'sched-cell' },
              h('span', null, label),
              h(
                'select',
                { class: 'select', 'data-sched-weekday': String(i), onchange: (ev: Event) => setWeekday(i, Number((ev.target as HTMLSelectElement).value)) },
                PREP_SCHEDULE_CHOICES.map((v) => h('option', { value: String(v), selected: v === wds[i] }, choice(v))),
              ),
            ),
          ),
        ),
        h('h5', null, '時間帯（開店からの1時間ごと）'),
        h(
          'div',
          { class: 'sched-row' },
          hrs.map((v0, i) =>
            h(
              'label',
              { class: 'sched-cell' },
              h('span', null, hourLabel(i)),
              h(
                'select',
                { class: 'select', 'data-sched-hour': String(i), onchange: (ev: Event) => setHour(i, Number((ev.target as HTMLSelectElement).value)) },
                PREP_SCHEDULE_CHOICES.map((v) => h('option', { value: String(v), selected: v === v0 }, choice(v))),
              ),
            ),
          ),
        ),
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
              h('button', { class: 'mini ghost', disabled: !editable, onclick: () => this.actUndo({ type: 'setPrice', menuId: m.id, price: price - 50 }, `${m.name}の値段 ${yenStr(price)} → ${yenStr(price - 50)}`, { type: 'setPrice', menuId: m.id, price }) }, '−50'),
              h('b', { class: 'price' }, yenStr(price)),
              h('button', { class: 'mini ghost', disabled: !editable, onclick: () => this.actUndo({ type: 'setPrice', menuId: m.id, price: price + 50 }, `${m.name}の値段 ${yenStr(price)} → ${yenStr(price + 50)}`, { type: 'setPrice', menuId: m.id, price }) }, '+50'),
            ),
            h('button', { class: `mini ${paused ? 'warn' : 'ghost'}`, onclick: () => this.actUndo({ type: 'pauseMenu', menuId: m.id, paused: !paused }, `${m.name}を${paused ? '販売中にしました' : '販売停止にしました'}`, { type: 'pauseMenu', menuId: m.id, paused }) }, paused ? '販売停止中' : '販売中'),
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
        h('div', { class: 'table equip-table' }, owned.map((e) => {
          const def = EQUIPMENT[e.type]!;
          const cond = Math.round(e.condition);
          // じろ6: 1台1行（名前と状態・状態の棒・操作）。自動メンテの1回の費用は名前の下の小さい文字に
          const stTone = e.status === 'broken' ? 'bad' : e.status === 'faulty' || cond < 40 ? 'warn' : 'good';
          return h(
            'div',
            { class: `trow equip-row ${e.status === 'broken' ? 'bad' : e.status === 'faulty' ? 'warn' : ''}`, 'data-equip-row': e.id },
            h(
              'div',
              { class: 'tname' },
              h('span', null, def.name, ' ', stTone !== 'good' || e.status !== 'normal' ? h('span', { class: `chip-st ${stTone === 'good' ? 'info' : stTone}` }, STATUS_LABEL[e.status]) : null),
              h('small', null, `${def.w > 0 && !e.placed ? '倉庫（未配置）・' : ''}維持費${yenStr(def.upkeep)}/日${def.repairCost > 0 ? `・メンテ1回${yenStr(maintenanceCost(e))}` : ''}`),
            ),
            h('div', { class: 'equip-cond' }, h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${cond}%`, background: cond < 30 ? '#e74c3c' : cond < 60 ? '#f39c12' : '#2ecc71' } })), h('small', null, `${cond}%`)),
            h(
              'div',
              { class: 'tbtns' },
              e.status !== 'normal' || cond < 95
                ? h('button', { class: `mini ${e.status === 'broken' ? 'danger' : ''}`, disabled: e.status === 'repairing', onclick: () => this.act({ type: 'repair', equipmentId: e.id }, '修理を依頼しました') }, e.status === 'repairing' ? '修理中' : `修理 ${yenStr(e.status === 'broken' ? def.repairCost : Math.round(def.repairCost * 0.5))}`)
                : null,
              def.repairCost > 0
                ? h('button', { class: `mini ${e.maintenanceBooked ? 'on' : 'ghost'}`, title: `ONにすると、状態が${MAINTENANCE_THRESHOLD}%を下回った日の閉店後にメンテ（状態+40%）を行います`, onclick: () => this.actUndo({ type: 'maintenance', equipmentId: e.id, on: !e.maintenanceBooked }, `${def.name}の自動メンテを${e.maintenanceBooked ? 'OFF' : 'ON'}にしました`, { type: 'maintenance', equipmentId: e.id, on: e.maintenanceBooked }) }, `自動メンテ ${e.maintenanceBooked ? 'ON' : 'OFF'}`)
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
        })),
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
    const sel = s.employees.find((e) => e.id === this.empSel) ?? s.employees[0] ?? null;
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
        { class: 'card wide', 'data-staff-list': '' },
        cardHead(`従業員（${s.employees.length}人）`, '1人1行の一覧です。名前を押すと、下にくわしい欄（担当・シフト・記録・能力・解雇）が出ます。「社員にする」はいつも行の右端にあります。'),
        s.employees.length > 0 ? h('p', { class: 'note staff-today' }, `今日（${s.day}日目・${WEEKDAY_LABEL[wd]}曜）の出勤: ${today}`) : null,
        s.employees.length === 0 ? h('p', { class: 'note' }, hiring ? 'まだ誰も雇っていません。下の採用候補から雇えます（通常の採用は2日後から出勤。今日すぐ人手が要るときは短期バイト）。' : '採用はまだできません。') : null,
        s.employees.length > 0 ? this.staffTable(s) : null,
      ),
      sel ? h('section', { class: 'card wide staff-detail', 'data-staff-detail': sel.id }, cardHead(`くわしく: ${sel.profile.name}`), this.staffCard(s, sel)) : null,
      s.employees.length > 0 ? h('section', { class: 'card wide' }, this.teamCalendar(s)) : null,
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

  /**
   * 従業員の一覧（じろ6: 1人1行の表）。名前・雇用・担当・今日の状態・能力・給与・この先7日のシフト・操作。
   * 「社員にする」（アルバイト）と「リーダーにする」（社員）は、どの画面の幅でも行の右端に出す（列が狭いときは能力・シフトの列を隠す）
   */
  private staffTable(s: GameState): HTMLElement {
    const host = this.host.isHost;
    const hrs = storeHours(s);
    const st = s.company ? activeStore(s) : null;
    const stTone: Record<string, string> = { working: 'good', break: 'info', scheduled: '', late: 'warn', absent: 'bad', left: '', off: '', closed: '' };
    const selId = (s.employees.find((e) => e.id === this.empSel) ?? s.employees[0])?.id;
    const head = h(
      'div',
      { class: 'st-row st-head', role: 'row' },
      ['名前', '担当', '今日', '能力', '給与', 'この先7日', ''].map((t, i) => h('span', { class: `st-c st-c${i}`, role: 'columnheader' }, t)),
    );
    const rows = s.employees.map((e) => {
      const part = isPartTime(e);
      const a = e.att && e.att.day === s.day ? e.att : null;
      const inj = injuredOn(e, s.day) || e.injury?.day === s.day;
      const label = inj ? '療養' : a ? ATTENDANCE_LABEL[a.status] : e.presentToday ? '勤務中' : '休み';
      const tone = inj ? 'bad' : a ? (stTone[a.status] ?? '') : e.presentToday ? 'good' : '';
      const sk = e.profile.skills;
      const avg = Math.round(((sk.speed + sk.cooking + sk.service + sk.hygiene + sk.movement) / 5) * 100);
      const pay = part ? `時給${yenStr(hourlyOf(e))}` : `日給${yenStr(fullTimePayFor(e, hrs))}`;
      const week = Array.from({ length: 7 }, (_, i) => {
        const d = s.day + i;
        const on = !isClosedDay(hrs, d) && shiftFor(e, d) !== null;
        return h('i', { class: `st-day${on ? ' on' : ''}${i === 0 ? ' today' : ''}`, title: `${d}日目（${WEEKDAY_LABEL[weekdayOf(d)]}）${on ? '出勤' : '休み'}` }, WEEKDAY_LABEL[weekdayOf(d)]);
      });
      const isMgr = st?.managerId === e.id;
      const op = part
        ? host
          ? h('button', { class: 'mini st-promote', 'data-row-promote': e.id, onclick: () => void this.promoteDialog(e) }, '社員にする')
          : h('span', { class: 'chip-st' }, 'アルバイト')
        : isMgr
          ? h('span', { class: 'chip-st info' }, '店長')
          : e.profile.role === 'leader'
            ? h('span', { class: 'chip-st info' }, 'リーダー')
            : host
              ? h('button', { class: 'mini ghost st-promote', 'data-row-leader': e.id, onclick: () => void this.leaderDialog(e) }, '⭐ リーダーに')
              : h('span', { class: 'chip-st' }, '社員');
      return h(
        'div',
        { class: `st-row${e.id === selId ? ' sel' : ''}`, role: 'row', 'data-emp-row': e.id },
        h(
          'button',
          { class: 'st-c st-c0 st-name', 'data-guest-ok': '1', 'aria-pressed': String(e.id === selId), onclick: () => { this.empSel = e.id; this.render(); } },
          h('b', null, e.profile.name),
          h('span', { class: `emp-type ${employmentOf(e)}` }, EMPLOYMENT_LABEL[employmentOf(e)]),
        ),
        h('span', { class: 'st-c st-c1' }, ROLE_LABEL[e.profile.role].replace('担当', '')),
        h('span', { class: 'st-c st-c2' }, h('span', { class: `chip-st ${tone}` }, label)),
        h('span', { class: 'st-c st-c3', title: '速さ・調理・接客・衛生・移動の平均（100が最高）' }, meterBar(avg / 100, avg >= 70 ? 'good' : avg >= 45 ? 'accent' : 'warn', `能力の平均 ${avg}`), h('small', null, String(avg))),
        h('span', { class: 'st-c st-c4' }, pay),
        h('span', { class: 'st-c st-c5 st-week' }, week),
        h('span', { class: 'st-c st-c6' }, op),
      );
    });
    return h('div', { class: 'staff-table-wrap' }, h('div', { class: 'staff-table', role: 'table', 'aria-label': '従業員の一覧' }, head, rows));
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
            onchange: (ev: Event) => {
              const role = (ev.target as HTMLSelectElement).value as EmployeeRole;
              void this.actUndo({ type: 'setRole', employeeId: e.id, role }, `${e.profile.name}さんの担当 ${ROLE_LABEL[e.profile.role]} → ${ROLE_LABEL[role]}`, { type: 'setRole', employeeId: e.id, role: e.profile.role });
            },
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
  /**
   * 勤務のカレンダー（じろ1 5.8・じろ2: 改修設計書02）。見方: 日（1日の全員の予定と実際）・2週間（日ごとの人数。日を押すと変えられる）・
   * 月（4週の表。過ぎた日は実際の勤務: ✓・遅刻・欠勤・残業）。並べ方: 従業員別・職種別。予定のおかしさ（休憩・7日続けて勤務など）も出す
   */
  private teamCalendar(s: GameState): HTMLElement {
    const views: [typeof this.calView, string][] = [['day', '日'], ['twoWeeks', '2週間'], ['month', '月']];
    const groups: [typeof this.calGroup, string][] = [['staff', '従業員別'], ['role', '職種別']];
    const issues = shiftIssues(s, s.day, 14);
    const nameOf = (id: string) => s.employees.find((e) => e.id === id)?.profile.name ?? '';
    return h(
      'div',
      { class: 'team-calendar', 'data-cal-view': this.calView },
      h(
        'div',
        { class: 'row wrap cal-head' },
        h('h5', null, '📅 勤務のカレンダー'),
        views.map(([v, label]) => h('button', { class: `mini ${this.calView === v ? 'on' : 'ghost'}`, 'data-cal-view-btn': v, 'data-guest-ok': '1', onclick: () => { this.calView = v; this.render(); } }, label)),
        groups.map(([g, label]) => h('button', { class: `mini ${this.calGroup === g ? 'on' : 'ghost'}`, 'data-cal-group': g, 'data-guest-ok': '1', onclick: () => { this.calGroup = g; this.render(); } }, label)),
      ),
      issues.length > 0
        ? h(
            'div',
            { class: 'cal-issues', 'data-shift-issues': String(issues.length) },
            issues.slice(0, 6).map((x) => h('p', { class: `note ${x.level === 'bad' ? 'bad' : 'warn'}` }, `⚠ ${x.day}日目 ${nameOf(x.employeeId)}: ${x.text}`)),
            issues.length > 6 ? h('p', { class: 'note' }, `ほか${issues.length - 6}件`) : null,
          )
        : null,
      this.calView === 'day' ? this.dayView(s) : this.calView === 'month' ? this.monthTable(s) : this.twoWeekGrid(s),
    );
  }

  /** 1日の見方: 全員の予定と、過ぎた日は実際の勤務（遅刻・欠勤・残業） */
  private dayView(s: GameState): HTMLElement {
    const d = this.teamDay ?? s.day;
    const hrs = storeHours(s);
    const past = d < s.day || (d === s.day && s.phase === 'closed');
    const rows = (list: Employee[]) =>
      list.map((e) => {
        const sh = shiftFor(e, d);
        const att = attendanceOn(e, d);
        return h(
          'div',
          { class: 'kv', 'data-cal-emp': e.id },
          h('span', null, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`),
          h('b', null, `${isClosedDay(hrs, d) ? '定休日' : injuredOn(e, d) && !past ? 'けがの療養中' : this.shiftText(sh)}${past && att ? `・実際 ${attText(att)}` : ''}`),
        );
      });
    const byRole = this.calGroup === 'role';
    return h(
      'div',
      { class: 'cal-day', 'data-cal-day': String(d) },
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'mini ghost', 'data-guest-ok': '1', onclick: () => { this.teamDay = d - 1; this.render(); } }, '← 前の日'),
        h('b', null, `${d}日目（${WEEKDAY_LABEL[weekdayOf(d)]}曜）${d === s.day ? '・今日' : ''}`),
        h('button', { class: 'mini ghost', 'data-guest-ok': '1', onclick: () => { this.teamDay = d + 1; this.render(); } }, '次の日 →'),
      ),
      byRole
        ? (Object.keys(ROLE_LABEL) as EmployeeRole[]).map((r) => {
            const list = s.employees.filter((e) => e.profile.role === r);
            return list.length > 0 ? h('div', null, h('h6', null, ROLE_LABEL[r]), rows(list)) : null;
          })
        : rows(s.employees),
      d >= s.day ? h('p', { class: 'note' }, '変えるときは「2週間」でその日を押すか、各人の「📅 シフト」から。') : null,
    );
  }

  /** 月の見方（4週の表）: 過ぎた7日は実際の勤務、今日から21日は予定。日の見出しを押すとその日の見方へ */
  private monthTable(s: GameState): HTMLElement {
    const days = Array.from({ length: 28 }, (_, i) => s.day - 7 + i).filter((d) => d >= 1);
    const hrs = storeHours(s);
    const cell = (e: Employee, d: number): [string, string] => {
      if (d < s.day || (d === s.day && s.phase === 'closed')) {
        const a = attendanceOn(e, d);
        if (!a) return ['', ''];
        if (a.injured) return ['傷', 'bad'];
        if (a.absent) return ['欠', 'bad'];
        if (a.lateMin > 0) return ['遅', 'warn'];
        if (a.overtimeMin >= 10) return ['残', 'info'];
        return ['✓', 'ok'];
      }
      if (isClosedDay(hrs, d)) return ['定', 'closed'];
      if (injuredOn(e, d)) return ['療', 'bad'];
      const sh = shiftFor(e, d);
      return sh ? [shiftShort(sh, hrs), 'plan'] : ['休', 'off'];
    };
    const head = h(
      'tr',
      null,
      h('th', null, ''),
      days.map((d) => h('th', { class: d === s.day ? 'today' : '', 'data-cal-head': String(d), onclick: () => { this.teamDay = d; this.calView = 'day'; this.render(); } }, `${d}`, h('small', null, WEEKDAY_LABEL[weekdayOf(d)]!))),
    );
    let rows: HTMLElement[];
    if (this.calGroup === 'role') {
      rows = (Object.keys(ROLE_LABEL) as EmployeeRole[])
        .filter((r) => s.employees.some((e) => e.profile.role === r))
        .map((r) => {
          const list = s.employees.filter((e) => e.profile.role === r);
          return h(
            'tr',
            { 'data-cal-role': r },
            h('th', null, ROLE_LABEL[r]),
            days.map((d) => {
              const n = list.filter((e) => ['✓', '遅', '残'].includes(cell(e, d)[0]) || cell(e, d)[1] === 'plan').length;
              return h('td', { class: n === 0 ? 'off' : 'plan' }, String(n));
            }),
          );
        });
    } else {
      rows = s.employees.map((e) =>
        h(
          'tr',
          { 'data-cal-row': e.id },
          h('th', null, e.profile.name.split(' ')[0] ?? e.profile.name),
          days.map((d) => {
            const [t, c] = cell(e, d);
            return h('td', { class: c, 'data-cal-cell': `${e.id}:${d}` }, t);
          }),
        ),
      );
    }
    return h(
      'div',
      { class: 'shift-table-wrap' },
      h('table', { class: 'team-table' }, h('thead', null, head), h('tbody', null, rows)),
      h('p', { class: 'note' }, '過ぎた日: ✓ 出勤・遅 遅刻・欠 欠勤・残 残業（10分以上）。今日から先: 予定の時間・休 休み・定 定休日。職種別は出る人数。'),
    );
  }

  private twoWeekGrid(s: GameState): HTMLElement {
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
          h('small', { class: 'td-names' }, (this.calGroup === 'role' ? roleCounts(on) : on.map((e) => short(e.profile.name)).join('・')) || '—'),
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
          const injured = injuredOn(e, sel);
          return h(
            'div',
            { class: 'kv' },
            h('span', null, `${e.profile.name}（${ROLE_LABEL[e.profile.role]}）`),
            notYet
              ? h('b', null, `${e.availableFrom}日目から出勤`)
              : injured
                ? h('b', null, `けがの療養中（${e.injury!.until + 1}日目から出勤）`)
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
    return h('div', null, grid, editor);
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
      // 枠ぜんぶ・中休みは休む（オーナーの指示 2026-11-11）
      list.push(['開店〜閉店（中休みは休み）', { ...at(0, openMin), midRest: true }]);
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
    const end = Math.min(sh.end, openMinutesOf(hrs));
    // 中休みは休む: 枠ごとの時間を並べる（「11:00〜14:00・17:00〜21:00（中休みは休み）」）
    if (sh.midRest && shiftSpansBreak(hrs, sh.start, end)) {
      const parts: string[] = [];
      for (const sp of sessionSpans(hrs)) {
        const a = Math.max(sh.start, sp.startT / SEC_PER_MIN);
        const z = Math.min(end, sp.endT / SEC_PER_MIN);
        if (z > a) parts.push(`${a === sh.start && sh.fromPrep ? '仕込み' : shiftTimeText(a, hrs)}〜${shiftTimeText(z, hrs, true)}`);
      }
      return `${parts.join('・')}（中休みは休み）${b}`;
    }
    return `${sh.fromPrep ? '仕込み' : shiftTimeText(sh.start, hrs)}〜${shiftTimeText(end, hrs, true)}${b}`;
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
      if (injuredOn(e, d)) {
        cells.push(h('button', { class: `cal-day pending ${d === s.day ? 'today' : ''}`, 'data-day': String(d), disabled: true }, h('b', null, `${d}日目${d === s.day ? '・今日' : ''}`), h('small', null, '療養')));
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
            // 営業の枠をまたぐ勤務: 枠の間の中休みに休ませるか（オーナーの指示 2026-11-11）
            shiftSpansBreak(hrs, draft.start, Math.min(draft.end, close))
              ? h(
                  'label',
                  null,
                  '中休み',
                  h(
                    'select',
                    { class: 'select', 'data-mid-rest': '', onchange: (ev: Event) => setDraft({ ...draft, midRest: (ev.target as HTMLSelectElement).value === '1' || undefined }) },
                    h('option', { value: '1', selected: !!draft.midRest }, '休む（店を出て、次の枠の開店で戻る）'),
                    h('option', { value: '0', selected: !draft.midRest }, '店にいる（仕込み・片付け）'),
                  ),
                )
              : null,
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
      h('p', null, `シフトリーダーは仕入れ・仕込み・調理・接客・清掃を全部する上位の役職です。店長がいない・休みのときは店長代理として、急ぎの仕込み・当日便・翌日の仕入れをします。日給は ${yenStr(leaderWageFor(e))} になります。`),
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
        h('div', { class: 'goals' }, GOALS.map((g) => {
          const done = s.career.goalsDone.includes(g.id);
          const p = done ? 1 : g.progress(s);
          return h(
            'div',
            { class: `goal ${done ? 'done' : ''}` },
            h('div', { class: 'tname' }, `${done ? '✅' : '⬜'} ${g.name}`, h('small', null, `${g.description}${g.unlocks.length ? ` → ${g.unlocks.map((u) => UNLOCK_NAMES[u] ?? u).join('・')}` : ''}`)),
            h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${Math.round(p * 100)}%` } })),
          );
        })),
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
      this.eventLogCard(s),
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

  /** イベントの記録（じろ2: 改修設計書05。いつ・どの店で・何が起き、どうなったか。確率がわかるものは確率も） */
  private eventLogCard(s: GameState): HTMLElement {
    const log = (s.events?.log ?? []).slice().reverse().slice(0, 20);
    const stateText = { happening: '起きている', done: '終わった', restored: '仕込み開始時点に戻した' } as const;
    return h(
      'section',
      { class: 'card wide', 'data-event-log': '' },
      cardHead('イベントの記録（最近20件）', 'SNSのバズ・覆面調査員・珍しい客・クレーム・YouTuber・テレビ取材・爆発・事件の記録です。確率は、抽選で起きたときのその日の確率です（強制発生・確率のないものは出しません）。'),
      log.length === 0
        ? h('p', { class: 'note' }, 'まだ記録はありません')
        : log.map((r) =>
            h(
              'div',
              { class: 'kv', 'data-event': r.kind },
              h('span', null, `${r.day}日目 ${EVENT_LOG_LABEL[r.kind] ?? r.kind}${r.chance !== null ? `（確率 ${(r.chance * 100).toFixed(r.chance < 0.01 ? 2 : 1)}%）` : ''}${r.forced ? '（テスト）' : ''}`),
              h('b', null, `${stateText[r.state]}${r.result ? `・${r.result}` : ''}${r.restores?.length ? `・戻した${r.restores.length}回` : ''}`),
            ),
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
