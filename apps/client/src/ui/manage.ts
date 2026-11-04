// 経営メニュー（設計書 14.6 経営ダッシュボード、19.1 在庫/従業員/設備/拡張/キャリア）。

import {
  BALANCE,
  BOWL_PACK,
  CALLS,
  EQUIPMENT,
  expansionInfo,
  fixedCosts,
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
  purchaseUnitCost,
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
  shiftFor,
  hasDateShift,
  shiftTimeText,
  staffLog,
  staffSummary,
  weekdayOf,
  type Action,
  type Employee,
  type EmployeeRole,
  type GameState,
  type ShiftDay,
} from '@jiro/core';
import type { GameHost } from '../game/host';
import { confirmDialog, confirmNode, h, replace, stars, toast, yenStr } from './dom';
import { debugEventsCard, debugEventsEnabled } from './debug-events';
import { lookSeedOf, staffLook, staffLookText } from '../render/staff-look';

export type ManageTab = 'dash' | 'stock' | 'menu' | 'equip' | 'staff' | 'layout' | 'career' | 'system';

const TABS: [ManageTab, string][] = [
  ['dash', '経営'],
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
    for (const [id, b] of this.tabButtons) b.classList.toggle('on', id === this.tab);
    if (this.badge.hidden !== !ro) this.badge.hidden = !ro;
    this.el.classList.toggle('readonly', ro);
    let content: HTMLElement;
    try {
      content =
        this.tab === 'dash' ? this.dash(s)
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

  // ───────────────── 経営ダッシュボード ─────────────────
  private dash(s: GameState): HTMLElement {
    const d = s.today;
    const op = operatingProfit(d);
    const fc = fixedCosts(s);
    const avgSat = d.satisfactionCount > 0 ? d.satisfactionSum / d.satisfactionCount : 0;
    const avgWait = d.served > 0 ? d.totalSeatWait / d.served : 0;
    const arrears = s.arrears.reduce((a, b) => a + b.amount, 0);
    const loan = s.loans.reduce((a, b) => a + b.remaining, 0);
    const lowStock = ['yasai', 'buta', 'garlic', 'abura', 'tare', 'noodle'].filter((id) => stockOf(s, id) < (id === 'noodle' ? 1500 : id === 'buta' ? 6 : 100));
    const row = (k: string, v: string, cls = '') => h('div', { class: `kv ${cls}` }, h('span', null, k), h('b', null, v));
    const hist = s.history.slice(-14);
    const maxAbs = Math.max(1, ...hist.map((r) => Math.abs(r.operatingProfit)));
    return h(
      'div',
      { class: 'grid2' },
      h(
        'section',
        { class: 'card' },
        h('h4', null, `${s.shopName} — ${s.day}日目`),
        row('現在資金', yenStr(s.money), s.money < fc.total ? 'bad' : ''),
        row('評判', `${stars(s.reputation)} ${s.reputation.toFixed(2)}`),
        row('常連客', `${s.regulars.length}人`),
        // YouTube の動画・テレビ放送の反響（第2版 11・12）
        buzzBoostFactor(s) > 1 ? row('🎥 SNSの話題になりやすさ', `×${buzzBoostFactor(s).toFixed(1)}（${Math.max(...(s.events?.buzzBoosts ?? []).map((b) => b.untilDay))}日目まで）`, 'good') : null,
        ...(s.events?.effects ?? []).filter((e) => e.source === 'tv' && (e.fromDay ?? 0) >= s.day).map((e) => row(`📺 テレビ放送の反響（${e.fromDay}日目）`, `来客 ×${e.mult.toFixed(1)}`, 'good')),
        row('店舗', STAGES[s.career.stage]?.name ?? ''),
        arrears > 0 ? row('未払金', yenStr(arrears), 'bad') : null,
        loan > 0 ? row('融資残高', yenStr(loan), 'warn') : null,
        h(
          'div',
          { class: 'row' },
          arrears > 0 ? h('button', { class: 'btn', onclick: () => this.act({ type: 'payArrears' }, '未払金を支払いました') }, '未払金を支払う') : null,
          loanAvailable(s)
            ? h(
                'button',
                {
                  class: 'btn ghost',
                  onclick: async () => {
                    const L = BALANCE.loan;
                    const ok = await confirmDialog(this.root, '緊急融資', `¥${L.amount.toLocaleString('ja-JP')}を借ります。日利${(L.dailyRate * 100).toFixed(1)}%、${L.days}日で毎日返済します。融資は1件までです。`, '借りる');
                    if (ok) await this.act({ type: 'takeLoan' }, '融資を受けました');
                  },
                },
                '融資を受ける',
              )
            : null,
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h4', null, '本日の損益'),
        row('売上', yenStr(d.sales)),
        d.refunds > 0 ? row('返金', `−${yenStr(d.refunds)}`) : null,
        row('食材原価', `−${yenStr(d.cogs)}`),
        row('廃棄', `−${yenStr(d.waste)}`, d.waste > 0 ? 'warn' : ''),
        row('人件費', `−${yenStr(d.wages)}`),
        row('家賃', `−${yenStr(d.rent)}`),
        row('維持費', `−${yenStr(d.upkeep)}`),
        row('光熱費', `−${yenStr(d.utilities)}`),
        row('修理費', `−${yenStr(d.repairs)}`),
        d.hiring > 0 ? row('採用・解雇', `−${yenStr(d.hiring)}`) : null,
        d.interest > 0 ? row('利息', `−${yenStr(d.interest)}`) : null,
        row('営業利益', yenStr(op), op < 0 ? 'bad' : 'good'),
        h('p', { class: 'note' }, '※ 家賃・給与・維持費・基本光熱費は閉店後の精算で計上されます。食材の仕入れは在庫（資産）になり、使ったときに原価になります。'),
        row('仕入れ（現金支出）', yenStr(d.purchases)),
        row('設備投資（現金支出）', yenStr(d.capex)),
      ),
      h(
        'section',
        { class: 'card' },
        h('h4', null, '本日の営業'),
        row('来客数', `${d.customers}人`),
        row('提供数', `${d.served}杯`),
        row('途中で帰った客', `${d.lost}人`, d.lost > 0 ? 'warn' : ''),
        row('行列を見て諦めた客', `${d.balked}人`),
        row('平均待ち時間（着席→提供）', `${avgWait.toFixed(0)}秒`),
        row('平均満足度', `${Math.round(avgSat * 100)}%`),
        row('注文ミス / クレーム', `${d.mistakes} / ${d.complaints}`),
        row('品切れ', `${d.stockouts}回`, d.stockouts > 0 ? 'warn' : ''),
        row('設備故障', `${d.breakdowns}回`),
        lowStock.length > 0 ? row('在庫不足', lowStock.map((id) => INGREDIENTS[id]?.name ?? id).join('・'), 'bad') : null,
      ),
      h(
        'section',
        { class: 'card' },
        h('h4', null, '翌営業日の予測支出'),
        row('家賃', yenStr(fc.rent)),
        row('給与', yenStr(fc.wages)),
        row('設備維持費', yenStr(fc.upkeep)),
        row('光熱費（基本）', yenStr(fc.utilities)),
        fc.loans > 0 ? row('融資返済＋利息', yenStr(fc.loans)) : null,
        row('合計', yenStr(fc.total), s.money < fc.total ? 'bad' : ''),
        hist.length > 0
          ? h(
              'div',
              { class: 'bars' },
              hist.map((r) =>
                h(
                  'div',
                  { class: 'bar-col', title: `${r.day}日目 ${yenStr(r.operatingProfit)}` },
                  h('div', { class: `bar ${r.operatingProfit < 0 ? 'neg' : ''}`, style: { height: `${(Math.abs(r.operatingProfit) / maxAbs) * 60}px` } }),
                  h('div', { class: 'bar-label' }, String(r.day)),
                ),
              ),
            )
          : h('p', { class: 'note' }, '営業日の利益の推移がここに表示されます'),
      ),
      s.notices.length > 0
        ? h(
            'section',
            { class: 'card wide' },
            h('h4', null, 'お知らせ'),
            s.notices.slice(-8).reverse().map((n) => h('div', { class: `notice ${n.level}` }, n.text)),
          )
        : null,
    );
  }

  // ───────────────── 在庫・発注 ─────────────────
  private stock(s: GameState): HTMLElement {
    const purch = Object.values(INGREDIENTS).filter((d) => d.purchasable && isUnlocked(s, d.unlock));
    const prepared = Object.values(INGREDIENTS).filter((d) => !d.purchasable && isUnlocked(s, d.unlock));
    const cap = fridgeCapacity(s);
    const used = fridgeUsage(s, true);
    return h(
      'div',
      null,
      h('section', { class: 'card wide' }, h('h4', null, '冷蔵庫'), h('div', { class: 'meter' }, h('div', { class: 'meter-fill', style: { width: `${Math.min(100, (used / Math.max(1, cap)) * 100)}%` } })), h('p', { class: 'note' }, `使用 ${used.toFixed(1)}kg / ${cap}kg（配送待ち含む）`)),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '仕入れ'),
        h('p', { class: 'note' }, '翌朝便は通常価格で翌日の開店前に届きます。当日便は3割高で約60秒後に届きます。自動発注は閉店後に目標在庫まで翌朝便で発注します。'),
        h(
          'div',
          { class: 'table' },
          purch.map((d) => {
            const unit = purchaseUnitCost(d.id, false);
            const pack = Math.round(unit * d.packQty);
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
              ),
            );
          }),
        ),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '仕込み品（店内で作る）'),
        h('div', { class: 'table' }, prepared.map((d) => h('div', { class: 'trow' }, h('div', { class: 'tname' }, d.name), h('div', { class: 'tsub' }, `${Math.floor(stockOf(s, d.id)).toLocaleString('ja-JP')}${d.unit}`), h('div', { class: 'tsub' }, d.shelfLifeDays === 0 ? '当日限り' : `${d.shelfLifeDays}日もつ`)))),
        h('p', { class: 'note' }, '仕込み: 豚を煮込む→（煮豚・タレ）→ 仕込み台で豚を切る / 野菜ゆで釜でヤサイ / 仕込み台でニンニクを刻む / 煮込み鍋で背脂を炊く / 寸胴でスープを炊く。'),
      ),
    );
  }

  // ───────────────── メニュー ─────────────────
  private menu(s: GameState): HTMLElement {
    const editable = s.phase !== 'open' && s.phase !== 'closing';
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, 'メニューと価格'),
        h('p', { class: 'note' }, `価格は営業時間外に変更できます。平均価格が¥${BALANCE.customers.referencePrice.toLocaleString('ja-JP')}より高いと来客が減り、安いと増えます。`),
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
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '無料トッピング（コール）'),
        h('p', { class: 'note' }, '客は食券を出したあと、麺がゆで上がる頃に「ニンニク入れますか？」と聞かれてコールします。コールを聞いてから盛り付けましょう。'),
        Object.values(CALLS).map((c) => h('div', { class: 'kv' }, h('span', null, c.name), h('b', null, c.levels.map((l) => l.label).join(' / ')))),
      ),
    );
  }

  // ───────────────── 設備 ─────────────────
  private equip(s: GameState): HTMLElement {
    const owned = s.equipment;
    const shop = Object.values(EQUIPMENT);
    const ownedCount = (id: string) => owned.filter((e) => e.type === id).length;
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '所有している設備'),
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
        h('h4', null, '設備を買う'),
        h('p', { class: 'note' }, '配置が必要な設備は倉庫に入ります。閉店後か仕込み時間に「店舗 → レイアウト編集」で置いてください。'),
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
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `従業員（${s.employees.length}人）`),
        s.employees.length > 0 ? h('p', { class: 'note staff-today' }, `今日（${s.day}日目・${WEEKDAY_LABEL[wd]}曜）の出勤: ${today}`) : null,
        s.employees.length === 0 ? h('p', { class: 'note' }, hiring ? 'まだ誰も雇っていません。' : '「初めての黒字」を達成すると採用できるようになります。') : null,
        s.employees.map((e) => this.staffCard(s, e)),
      ),
      hiring
        ? h(
            'section',
            { class: 'card wide' },
            h('h4', null, '採用候補（毎朝入れ替わります）'),
            h('p', { class: 'note' }, '採用はアルバイトから（時給・シフト制）。採用は閉店後か仕込み時間にできます。採用費はその場で、給与は働いた時間ぶんを閉店後の精算で支払います。真面目さや我慢強さは数字では分かりません。働きぶりは勤務の記録で確かめましょう。'),
            s.candidates.length === 0 ? h('p', { class: 'note' }, '今日の候補者はいません。') : null,
            s.candidates.map((c) =>
              h(
                'div',
                { class: 'emp' },
                h(
                  'div',
                  { class: 'trow' },
                  h('div', { class: 'tname' }, c.profile.name, h('small', null, `${ROLE_LABEL[c.profile.role]}・アルバイト・時給${yenStr(c.profile.hourly ?? Math.round(c.profile.wage / BALANCE.staff.employment.fullShiftHours / 10) * 10)}・採用費${yenStr(c.profile.hireFee)}`)),
                  h('button', { class: 'mini', onclick: () => this.act({ type: 'hire', candidateId: c.id }) }, '採用する'),
                ),
                lookLine(lookSeedOf(c)),
                this.skillBars(c.profile.skills),
              ),
            ),
          )
        : null,
    );
  }

  /** 見える能力（勤怠・辛抱は隠しパラメータなので出さない） */
  private skillBars(sk: Employee['profile']['skills']): HTMLElement {
    const bar = (label: string, v: number) => h('div', { class: 'skill' }, h('span', null, label), h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${Math.round(v * 100)}%` } })));
    return h('div', { class: 'skills' }, bar('速さ', sk.speed), bar('調理', sk.cooking), bar('接客', sk.service), bar('衛生', sk.hygiene), bar('移動', sk.movement));
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
    const pay = part ? `時給${yenStr(hourlyOf(e))}` : `日給${yenStr(e.profile.wage)}`;
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
          (Object.keys(ROLE_LABEL) as EmployeeRole[]).map((r) => h('option', { value: r, selected: r === e.profile.role }, ROLE_LABEL[r])),
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
      this.skillBars(e.profile.skills),
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

  private shiftText(sh: ShiftDay | null): string {
    if (!sh) return '休み';
    const b = sh.breakLen > 0 ? `（休憩${sh.breakLen}分）` : '';
    return `${sh.fromPrep ? '仕込み' : shiftTimeText(sh.start)}〜${shiftTimeText(sh.end)}${b}`;
  }

  /**
   * シフトの欄: 4週間のカレンダー（アルバイト。オーナー回答「日にちごと＋くりかえしも使える」）。
   * 日にちを押して選び（いくつでも）、時間を決めて「この日だけ」か「毎週くりかえす」で保存する。社員は毎日・全時間
   */
  private shiftPanel(s: GameState, e: Employee): HTMLElement {
    if (!isPartTime(e)) {
      return h('div', { class: 'prio' }, h('p', { class: 'note' }, `社員は毎日、仕込みから閉店まで勤務します（日給 ${yenStr(e.profile.wage)}）。遅刻・欠勤が少なく安定します。`));
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
      const close = (BALANCE.closeHour - BALANCE.openHour) * 60;
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
        for (let m = 0; m < close; m += step) starts.push(opt(m, shiftTimeText(m), draft.fromPrep ? -1 : draft.start));
        const ends: HTMLElement[] = [];
        for (let m = draft.start + step; m <= close; m += step) ends.push(opt(m, shiftTimeText(m), draft.end));
        const breaks: HTMLElement[] = [opt(0, 'なし', draft.breakLen), opt(30, '30分', draft.breakLen), opt(60, '60分', draft.breakLen)];
        const breakAts: HTMLElement[] = [];
        for (let m = draft.start + step; m + draft.breakLen < draft.end; m += step) breakAts.push(opt(m, `${shiftTimeText(m)}から`, draft.breakAt));
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
        problem = shiftProblem(draft);
        const hours = shiftPaidHours(draft);
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
    for (let d = s.day; d <= lastDay; d++) total += expectedPay(e, d);
    return h(
      'div',
      { class: 'prio shift' },
      cal,
      repeat,
      editor,
      h('p', { class: 'note' }, `${N}日間の給与の目安 ${yenStr(total)}・今日の見込み ${yenStr(expectedPay(e, s.day))}。今日の予定を変えるとすぐに反映します（休みの人に勤務を入れると呼び出し、着くまで少しかかります）。`),
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
    const st = STAGES[s.career.stage]!;
    const editable = s.phase === 'closed' || s.phase === 'prep';
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `レイアウト — ${st.name}`),
        h('p', { class: 'note' }, '設備の配置で動線（移動距離）が変わり、処理能力が変わります。盛り付け台の近くにスープ寸胴・トッピング台・麺釜を置くと作業が速くなります。'),
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
    return h(
      'div',
      null,
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
