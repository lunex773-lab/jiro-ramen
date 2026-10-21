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
  type Action,
  type EmployeeRole,
  type GameState,
} from '@jiro/core';
import type { GameHost } from '../game/host';
import { confirmDialog, h, replace, stars, toast, yenStr } from './dom';

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
  onSettings(): void;
  onTitle(): void;
  onHelp(): void;
}

export class ManageMenu {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabsEl: HTMLElement;
  private tab: ManageTab = 'dash';
  private timer: number | null = null;
  private expandedEmp: string | null = null;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: ManageCallbacks,
  ) {
    this.tabsEl = h('div', { class: 'tabs' });
    this.body = h('div', { class: 'manage-body' });
    this.el = h(
      'div',
      { class: 'manage' },
      h(
        'div',
        { class: 'manage-head' },
        h('div', { class: 'manage-title' }, '経営メニュー'),
        h('button', { class: 'btn ghost close', onclick: () => cb.onClose() }, '✕ 閉じる'),
      ),
      this.tabsEl,
      this.body,
    );
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  open(tab: ManageTab = this.tab): void {
    this.tab = tab;
    this.root.appendChild(this.el);
    this.render();
    if (this.timer === null) this.timer = window.setInterval(() => this.render(true), 1000);
  }

  close(): void {
    this.el.remove();
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  get isOpen(): boolean {
    return this.el.isConnected;
  }

  private async act(a: Action, okMsg?: string): Promise<boolean> {
    const r = await this.host.act(a);
    if (!r.ok) toast(this.root, r.reason ?? 'できませんでした', 'warn');
    else if (okMsg) toast(this.root, okMsg, 'good', 1600);
    this.render();
    return r.ok;
  }

  render(live = false): void {
    // 入力中は再描画しない
    if (live && (this.tab !== 'dash' && this.tab !== 'staff')) return;
    if (live && this.el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return;
    const scroll = this.body.scrollTop;
    replace(
      this.tabsEl,
      TABS.map(([id, label]) =>
        h('button', { class: `tab ${id === this.tab ? 'on' : ''}`, onclick: () => { this.tab = id; this.render(); this.body.scrollTop = 0; } }, label),
      ),
    );
    const s = this.host.state;
    const content =
      this.tab === 'dash' ? this.dash(s)
      : this.tab === 'stock' ? this.stock(s)
      : this.tab === 'menu' ? this.menu(s)
      : this.tab === 'equip' ? this.equip(s)
      : this.tab === 'staff' ? this.staff(s)
      : this.tab === 'layout' ? this.layout(s)
      : this.tab === 'career' ? this.career(s)
      : this.system(s);
    replace(this.body, content);
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
                ? h('button', { class: `mini ${e.maintenanceBooked ? 'on' : 'ghost'}`, title: '閉店後に状態を回復', onclick: () => this.act({ type: 'maintenance', equipmentId: e.id, on: !e.maintenanceBooked }) }, `定期メンテ${e.maintenanceBooked ? 'ON' : 'OFF'}（${yenStr(maintenanceCost(e))}/日）`)
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
    const skillBar = (label: string, v: number) => h('div', { class: 'skill' }, h('span', null, label), h('div', { class: 'meter small' }, h('div', { class: 'meter-fill', style: { width: `${Math.round(v * 100)}%` } })));
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, `従業員（${s.employees.length}人）`),
        s.employees.length === 0 ? h('p', { class: 'note' }, hiring ? 'まだ誰も雇っていません。' : '「初めての黒字」を達成すると採用できるようになります。') : null,
        s.employees.map((e) => {
          const open = this.expandedEmp === e.id;
          return h(
            'div',
            { class: 'emp' },
            h(
              'div',
              { class: 'trow' },
              h('div', { class: 'tname' }, e.profile.name, h('small', null, `${ROLE_LABEL[e.profile.role]}・日給${yenStr(e.profile.wage)}・${e.presentToday ? (e.ai.note || '待機中') : '欠勤'}・こなした仕事${e.tasksDone}`)),
              h(
                'select',
                {
                  class: 'select',
                  onchange: (ev: Event) => this.act({ type: 'setRole', employeeId: e.id, role: (ev.target as HTMLSelectElement).value as EmployeeRole }),
                },
                (Object.keys(ROLE_LABEL) as EmployeeRole[]).map((r) => h('option', { value: r, selected: r === e.profile.role }, ROLE_LABEL[r])),
              ),
              h('button', { class: 'mini ghost', onclick: () => { this.expandedEmp = open ? null : e.id; this.render(); } }, open ? '閉じる' : '担当設定'),
              this.host.isHost
                ? h(
                    'button',
                    {
                      class: 'mini danger',
                      onclick: async () => {
                        if (await confirmDialog(this.root, '解雇', `${e.profile.name}さんを解雇します。解雇手当 ${yenStr(e.profile.wage * BALANCE.severanceDays)} がかかります。`, '解雇する', true)) await this.act({ type: 'fire', employeeId: e.id });
                      },
                    },
                    '解雇',
                  )
                : null,
            ),
            h('div', { class: 'skills' }, skillBar('速さ', e.profile.skills.speed), skillBar('調理', e.profile.skills.cooking), skillBar('接客', e.profile.skills.service), skillBar('衛生', e.profile.skills.hygiene), skillBar('移動', e.profile.skills.movement), skillBar('安定', e.profile.skills.reliability)),
            open
              ? h(
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
                )
              : null,
          );
        }),
      ),
      hiring
        ? h(
            'section',
            { class: 'card wide' },
            h('h4', null, '採用候補（毎朝入れ替わります）'),
            h('p', { class: 'note' }, '採用は閉店後か仕込み時間にできます。採用費はその場で、給与は勤務した営業日ごとに閉店後の精算で支払います。'),
            s.candidates.length === 0 ? h('p', { class: 'note' }, '今日の候補者はいません。') : null,
            s.candidates.map((c) =>
              h(
                'div',
                { class: 'emp' },
                h(
                  'div',
                  { class: 'trow' },
                  h('div', { class: 'tname' }, c.profile.name, h('small', null, `${ROLE_LABEL[c.profile.role]}・日給${yenStr(c.profile.wage)}・採用費${yenStr(c.profile.hireFee)}`)),
                  h('button', { class: 'mini', onclick: () => this.act({ type: 'hire', candidateId: c.id }, `${c.profile.name}さんを採用しました`) }, '採用する'),
                ),
                h('div', { class: 'skills' }, skillBar('速さ', c.profile.skills.speed), skillBar('調理', c.profile.skills.cooking), skillBar('接客', c.profile.skills.service), skillBar('衛生', c.profile.skills.hygiene), skillBar('移動', c.profile.skills.movement), skillBar('安定', c.profile.skills.reliability)),
              ),
            ),
          )
        : null,
    );
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
    return h(
      'div',
      null,
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
  private system(_s: GameState): HTMLElement {
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, 'セーブ'),
        this.host.mode === 'local'
          ? h('p', { class: 'note' }, '閉店後に自動で保存されます。いつでも手動で保存できます。')
          : h('p', { class: 'note' }, '共同経営の保存はホストが行い、ホストのセーブスロットに記録されます。参加者のセーブは変更されません。'),
        h('button', { class: 'btn primary', disabled: !this.host.isHost, onclick: () => this.cb.onSave() }, '今すぐ保存'),
      ),
      h(
        'section',
        { class: 'card wide' },
        h('h4', null, '設定・その他'),
        h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => this.cb.onSettings() }, '設定（音・操作・画質）'), h('button', { class: 'btn', onclick: () => this.cb.onHelp() }, '遊び方'), h('button', { class: 'btn ghost', onclick: () => this.cb.onTitle() }, 'タイトルに戻る')),
      ),
    );
  }
}
