// 店内 HUD（設計書 19.1 店舗内HUD・注文状況・調理状況、19.3 通知）。
// 同じ画面に大量のボタンを常時出さず、注視対象と手の状態に応じて操作候補を変える（設計書 5.1）。

import {
  BALANCE,
  bowlsOnAssembly,
  currentTutorialStep,
  bowlStageLabel,
  callToShort,
  EQUIPMENT,
  listVerbs,
  MENU,
  noodleDonenessLabel,
  orderById,
  stockOf,
  type GameState,
  type Notice,
  type Order,
  type Target,
  type VerbInfo,
  waitingOrders,
  bowlForOrder,
  noodlesStartedFor,
  isBowlComplete,
  INGREDIENTS,
} from '@jiro/core';
import type { GameHost } from '../game/host';
import { targetName, type FocusResult } from '../game/targeting';
import { h, replace, stars, toast, yenStr } from './dom';
import { showRoomCode } from './room-code';
import { verbFace } from './verb-face';

export interface HudCallbacks {
  onMenu(): void;
  onOpenShop(): void;
  onHelp(): void;
}

export function clockText(s: GameState): string {
  if (s.phase === 'prep') return '仕込み中';
  if (s.phase === 'closing') return '閉店作業中';
  if (s.phase === 'closed') return '閉店';
  if (s.phase === 'bankrupt') return '破産';
  const r = Math.min(1, s.openT / BALANCE.openDuration);
  const mins = BALANCE.openHour * 60 + r * (BALANCE.closeHour - BALANCE.openHour) * 60;
  const hh = Math.floor(mins / 60);
  const mm = Math.floor(mins % 60);
  return `${hh}:${String(mm).padStart(2, '0')}`;
}

export class Hud {
  readonly el: HTMLElement;
  private top: HTMLElement;
  private rail: HTMLElement;
  private notices: HTMLElement;
  private focusLabel: HTMLElement;
  /** 照準の下: 押せない理由・「近づいてください」 */
  private focusReason: HTMLElement;
  private detail: HTMLElement;
  private actions: HTMLElement;
  private workBar: HTMLElement;
  private workFill: HTMLElement;
  private workLabel: HTMLElement;
  private hand: HTMLElement;
  private cta: HTMLElement;
  private crosshair: HTMLElement;
  /** 上部中央（初心者向けの案内） */
  private center: HTMLElement;
  private lastTopKey = '';
  private lastRailKey = '';
  private lastActionsKey = '';
  private lastDetailKey = '';
  /** 詳細パネルを押している最中は中身を差し替えない（タップが外れるため） */
  private detailPressed = false;
  private lastNoticeId = '';
  private lastCtaKey = '';
  private seenNotices = new Set<string>();
  private verbs: VerbInfo[] = [];
  private focus: Target | null = null;
  /** 注視対象に手が届くか */
  private reachable = true;
  /** 長押しの進み具合の輪を出しているボタン */
  private ringBtn: HTMLElement | null = null;
  /** 長押し中の動詞 */
  private holding: string | null = null;
  private acc = 0;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: HudCallbacks,
  ) {
    this.top = h('div', { class: 'hud-top' });
    this.rail = h('div', { class: 'hud-rail' });
    this.notices = h('div', { class: 'hud-notices' });
    this.crosshair = h('div', { class: 'crosshair' });
    this.focusLabel = h('div', { class: 'focus-label' });
    this.focusReason = h('div', { class: 'focus-reason' });
    this.detail = h('div', { class: 'hud-detail' });
    this.actions = h('div', { class: 'hud-actions' });
    this.workFill = h('div', { class: 'work-fill' });
    this.workLabel = h('div', { class: 'work-label' });
    this.workBar = h('div', { class: 'work-bar' }, this.workLabel, h('div', { class: 'work-track' }, this.workFill));
    this.hand = h('div', { class: 'hud-hand' });
    this.cta = h('div', { class: 'hud-cta' });
    // 横向きの画面: 上に状態の行、左の列に伝票と通知、上部中央に手に持っている物、右の列に詳細と丸い操作ボタン（右手の親指で押す）、
    // 下に案内の帯（小さく横長。チュートリアルの案内も同じ場所）と開店ボタン。左半分は移動スティック用に空けておく
    const left = h('div', { class: 'hud-left' }, this.rail, this.notices);
    this.center = h('div', { class: 'hud-center' }, this.hand);
    const right = h('div', { class: 'hud-right' }, this.detail, this.actions);
    this.el = h('div', { class: 'hud' }, this.top, left, this.center, right, this.crosshair, this.focusLabel, this.focusReason, this.workBar, this.cta);
    // HUD 上のタッチを 3D 操作に渡さない
    for (const el of [this.top, this.rail, this.detail, this.actions, this.cta, this.notices]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    }
    this.detail.addEventListener('pointerdown', () => (this.detailPressed = true));
    const release = () => (this.detailPressed = false);
    this.detail.addEventListener('pointerup', release);
    this.detail.addEventListener('pointercancel', release);
    this.detail.addEventListener('pointerleave', release);
    root.appendChild(this.el);
  }

  /** 初心者向けの案内（下の帯）を置く */
  attachHint(el: HTMLElement): void {
    this.el.appendChild(el);
  }

  get currentVerbs(): VerbInfo[] {
    return this.verbs;
  }

  setFocus(f: FocusResult | null): void {
    this.focus = f?.target ?? null;
    this.reachable = f?.reachable ?? true;
  }

  /** 毎フレーム呼ぶ（DOM 更新は間引く） */
  update(dt: number): void {
    this.acc += dt;
    const s = this.host.state;
    this.updateWork(s);
    if (this.acc < 0.1) return;
    this.acc = 0;
    this.updateTop(s);
    this.updateRail(s);
    this.updateNotices(s);
    this.updateFocus(s);
    this.updateHand(s);
    this.updateCta(s);
  }

  private me() {
    return this.host.state.players.find((p) => p.id === this.host.playerId);
  }

  /** 上部の表示は一度だけ作り、文字だけ更新する（押している最中のボタンを差し替えない） */
  private topParts: {
    day: HTMLElement;
    clock: HTMLElement;
    money: HTMLElement;
    rep: HTMLElement;
    queue: HTMLElement;
    speed: HTMLElement;
  } | null = null;

  private menuBtn: HTMLElement | null = null;
  private tutorialUi: 'menu' | 'open' | null = null;

  /** チュートリアルで押してほしいボタンを目立たせる */
  setTutorialHighlight(ui: 'menu' | 'open' | null): void {
    this.tutorialUi = ui;
    this.menuBtn?.classList.toggle('tut-pulse', ui === 'menu');
    this.cta.querySelector('.btn.primary')?.classList.toggle('tut-pulse', ui === 'open');
  }

  private buildTop(): NonNullable<Hud['topParts']> {
    const parts = {
      day: h('div', { class: 'day' }),
      clock: h('div', { class: 'clock' }),
      money: h('div', { class: 'money' }),
      rep: h('div', { class: 'rep' }),
      queue: h('div', { class: 'queue', title: '行列（店外 / 店内）' }),
      speed:
        this.host.mode === 'local'
          ? h(
              'button',
              {
                class: 'chip',
                title: 'ゲーム速度',
                onclick: () => {
                  this.host.speed = this.host.speed >= 3 ? 1 : this.host.speed + 1;
                  this.lastTopKey = '';
                },
              },
            )
          : h('button', { class: 'chip conn', title: '参加コードを表示', onclick: () => showRoomCode(this.root, this.host) }),
    };
    replace(
      this.top,
      h('div', { class: 'top-left' }, parts.day, parts.clock),
      h(
        'div',
        { class: 'top-right' },
        parts.money,
        parts.rep,
        parts.queue,
        parts.speed,
        h('button', { class: 'chip', onclick: () => this.cb.onHelp(), title: '操作説明' }, '?'),
        (this.menuBtn = h('button', { class: 'chip menu', onclick: () => this.cb.onMenu(), title: '経営メニュー (Tab)' }, '☰ 経営')),
      ),
    );
    this.setTutorialHighlight(this.tutorialUi);
    return parts;
  }

  private updateTop(s: GameState): void {
    const key = `${s.day}|${s.phase}|${clockText(s)}|${s.money}|${s.reputation.toFixed(2)}|${s.queue.length}|${s.insideQueue.length}|${this.host.speed}|${this.host.conn}|${this.host.peers.length}`;
    if (key === this.lastTopKey) return;
    this.lastTopKey = key;
    const t = (this.topParts ??= this.buildTop());
    t.day.textContent = `${s.day}日目`;
    t.clock.className = `clock ${s.phase}`;
    t.clock.textContent = clockText(s);
    t.money.className = `money ${s.money < 0 ? 'neg' : ''}`;
    t.money.textContent = yenStr(s.money);
    t.rep.title = `評判 ${s.reputation.toFixed(2)}`;
    t.rep.textContent = stars(s.reputation);
    t.queue.textContent = `🚶${s.queue.length}/${s.insideQueue.length}`;
    if (this.host.mode === 'local') t.speed.textContent = `×${this.host.speed}`;
    else {
      t.speed.className = `chip conn ${this.host.conn}`;
      // 参加コードは常に出す（押すと大きく表示してコピーできる）
      const code = this.host.roomCode ? `コード ${this.host.roomCode}` : '';
      t.speed.textContent = this.host.conn === 'online' ? `${code} ・ ${this.host.peers.filter((p) => p.connected).length}人` : `${connLabel(this.host.conn)} ${code}`;
    }
  }

  private updateRail(s: GameState): void {
    const orders = waitingOrders(s);
    const key = orders
      .map((o) => `${o.id}:${o.callRevealed ? 1 : 0}:${Math.floor((s.t - o.createdAt) / 5)}:${orderProgress(s, o)}`)
      .join(',');
    if (key === this.lastRailKey) return;
    this.lastRailKey = key;
    replace(
      this.rail,
      orders.slice(0, 12).map((o) => {
        const seat = s.seats.find((x) => x.id === o.seatId);
        const wait = Math.floor(s.t - o.createdAt);
        const prog = orderProgress(s, o);
        const level = wait > 90 ? 'late' : wait > 55 ? 'warn' : '';
        return h(
          'div',
          { class: `ticket ${level}` },
          h('div', { class: 'ticket-seat' }, `${(seat?.index ?? 0) + 1}番`),
          h('div', { class: 'ticket-menu' }, MENU[o.menuId]?.short ?? '?'),
          h('div', { class: 'ticket-call' }, o.callRevealed ? callToShort(o.call) : 'コール？'),
          h('div', { class: 'ticket-prog' }, prog),
          h('div', { class: 'ticket-wait' }, `${wait}秒`),
        );
      }),
    );
  }

  private updateNotices(s: GameState): void {
    const list = s.notices.slice(-4);
    const key = list.map((n) => n.id).join(',');
    for (const n of s.notices) {
      if (this.seenNotices.has(n.id)) continue;
      this.seenNotices.add(n.id);
      if (n.level === 'danger' || n.level === 'good') toast(this.root, n.text, n.level, 3500);
    }
    if (key === this.lastNoticeId) return;
    this.lastNoticeId = key;
    replace(
      this.notices,
      list.map((n: Notice) => h('div', { class: `notice ${n.level}` }, n.text)),
    );
  }

  private updateFocus(s: GameState): void {
    const me = this.me();
    if (!me) return;
    const t = this.focus;
    // 手が届かない物は名前だけ出し、近づくよう案内する
    const far = !!t && !this.reachable;
    this.verbs = t && !far ? listVerbs(s, me.id, t.id) : [];
    this.focusLabel.textContent = t ? targetName(s, t) : '';
    this.crosshair.classList.toggle('active', !!t && !far);
    this.crosshair.classList.toggle('far', far);
    // 操作ボタン（押せるものがなければ、押せない1つを薄く出し、理由を照準の下に出す）
    const enabled = this.verbs.filter((v) => v.enabled);
    const shown = enabled.length > 0 ? enabled.slice(0, 5) : this.verbs.slice(0, 1);
    const first = this.verbs[0];
    const reason = far ? '近づいてください' : enabled.length === 0 && first?.reason ? `${first.label}: ${first.reason}` : '';
    if (this.focusReason.textContent !== reason) this.focusReason.textContent = reason;
    const key = `${t?.id ?? ''}|${shown.map((v) => `${v.verb}:${v.label}:${v.enabled}:${v.reason}`).join('|')}|${me.work?.verb ?? ''}`;
    if (key !== this.lastActionsKey) {
      this.lastActionsKey = key;
      replace(
        this.actions,
        shown.map((v, i) => this.actionButton(v, i)),
      );
    }
    this.updateDetail(s, t);
  }

  /** 小さな丸い操作ボタン（絵文字＋短い名前）。正式な名前は読み上げ名にする */
  private actionButton(v: VerbInfo, i: number): HTMLElement {
    const f = verbFace(v.verb, v.label);
    const title = v.enabled ? (v.hold ? `${v.label}（長押し ${v.duration.toFixed(1)}秒）` : v.label) : `${v.label}: ${v.reason ?? ''}`;
    const btn = h(
      'button',
      { class: `act ${v.enabled ? '' : 'disabled'} ${v.hold ? 'hold' : ''} ${i === 0 ? 'primary' : ''}`, 'aria-label': v.label, title, 'data-verb': v.verb },
      h('span', { class: 'act-icon', 'aria-hidden': 'true' }, f.icon),
      h('span', { class: 'act-label', 'aria-hidden': 'true' }, f.short),
      f.badge ? h('span', { class: 'act-badge', 'aria-hidden': 'true' }, f.badge) : null,
      !this.root.closest('.touch') && i < 6 ? h('span', { class: 'act-key', 'aria-hidden': 'true' }, i === 0 ? 'E' : String(i + 1)) : null,
    );
    if (!v.enabled) return btn;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.setPointerCapture?.(e.pointerId);
      this.press(v, true);
    });
    const up = (e: PointerEvent) => {
      e.stopPropagation();
      this.press(v, false);
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    return btn;
  }

  /** 操作ボタン・キーの押下/解放 */
  press(v: VerbInfo, down: boolean): void {
    if (!this.focus) return;
    if (down) {
      if (this.holding) return;
      this.holding = v.verb;
      void this.host.act({ type: 'interact', targetId: this.focus.id, verb: v.verb, args: argsFor(this.host.state, v.verb, this.focus) }).then((r) => {
        if (!r.ok && r.reason) toast(this.root, r.reason, 'warn', 1800);
        if (!v.hold) this.holding = null;
      });
    } else {
      if (this.holding === null) return;
      const me = this.me();
      if (v.hold && me?.work && me.work.verb === this.holding) {
        // 長押しを途中で離したら中断（設計書 5.1 長押し）
        void this.host.act({ type: 'cancelWork' });
      }
      this.holding = null;
    }
  }

  pressIndex(i: number, down: boolean): void {
    const enabled = this.verbs.filter((v) => v.enabled);
    const v = enabled[i];
    if (v) this.press(v, down);
    else if (!down) this.holding = null;
  }

  private updateWork(s: GameState): void {
    const me = s.players.find((p) => p.id === this.host.playerId);
    const w = me?.work;
    if (!w) {
      this.workBar.style.display = 'none';
      this.setRing(null, 0);
      return;
    }
    this.workBar.style.display = 'block';
    const p = Math.min(1, w.progress / Math.max(0.01, w.duration));
    this.workFill.style.width = `${(p * 100).toFixed(1)}%`;
    // 押している丸ボタンの周りにも進み具合の輪を出す
    this.setRing(this.actions.querySelector<HTMLElement>(`.act[data-verb="${CSS.escape(w.verb)}"]`), p);
    const label = this.verbs.find((v) => v.verb === w.verb)?.label ?? '作業中';
    if (this.workLabel.textContent !== label) this.workLabel.textContent = label;
  }

  private setRing(btn: HTMLElement | null, p: number): void {
    if (this.ringBtn && this.ringBtn !== btn) {
      this.ringBtn.classList.remove('working');
      this.ringBtn.style.removeProperty('--p');
    }
    this.ringBtn = btn;
    if (!btn) return;
    btn.classList.add('working');
    btn.style.setProperty('--p', p.toFixed(3));
  }

  private updateHand(s: GameState): void {
    const me = this.me();
    if (!me) return;
    let text = '';
    const hd = me.hand;
    if (hd.kind === 'bowl') {
      const b = s.bowls.find((x) => x.id === hd.bowlId);
      const o = orderById(s, b?.orderId);
      const seat = o ? s.seats.find((x) => x.id === o.seatId) : undefined;
      text = `丼: ${seat ? `${seat.index + 1}番席 ` : ''}${o ? MENU[o.menuId]?.short ?? '' : ''} ${bowlStageLabel(b?.contents ?? null)}${b?.contents ? ` ${Math.round(b.contents.heat)}℃` : ''}`;
    } else if (hd.kind === 'clean') text = `きれいな丼 ×${hd.bowlIds.length}`;
    else if (hd.kind === 'dirty') text = `下げた丼 ×${hd.bowlIds.length}`;
    else if (hd.kind === 'mop') text = 'モップ';
    else if (hd.kind === 'lostItem') {
      const item = s.lostItems.find((l) => l.id === (hd as { lostItemId: string }).lostItemId);
      text = `忘れ物（${item?.kind ?? ''}）`;
    } else if (hd.kind === 'trash') text = 'ゴミ';
    this.hand.textContent = text ? `✋ ${text}` : '';
    this.hand.style.display = text ? 'block' : 'none';
  }

  private updateCta(s: GameState): void {
    // チュートリアル中は「開店」の手順になるまで開店ボタンを出さない
    const tutStep = s.tutorial && !s.tutorial.finished ? currentTutorialStep(s)?.id ?? '' : '';
    const key = `${s.phase}|${this.host.isHost}|${s.paused}|${tutStep}`;
    if (key === this.lastCtaKey) return;
    this.lastCtaKey = key;
    if (s.paused) {
      replace(this.cta, h('div', { class: 'cta-info' }, 'ホストの再接続を待っています（一時停止中）'));
    } else if (s.phase === 'prep' && tutStep && tutStep !== 'open') {
      replace(this.cta);
    } else if (s.phase === 'prep') {
      replace(
        this.cta,
        // 高さの低い画面（スマホの横向き）では案内と重複するので説明を省く
        h('div', { class: 'cta-info redundant' }, '開店前の仕込み時間です。準備ができたら開店しましょう'),
        h('button', { class: 'btn big primary', onclick: () => this.cb.onOpenShop() }, '🏮 開店する'),
      );
    } else if (s.phase === 'closing') {
      replace(this.cta, h('div', { class: 'cta-info' }, '営業時間終了。店内のお客さんに提供を済ませましょう'));
    } else {
      replace(this.cta);
    }
    this.setTutorialHighlight(this.tutorialUi);
  }

  private updateDetail(s: GameState, t: Target | null): void {
    let key = t ? t.id : '';
    let content: HTMLElement | null = null;
    if (t?.kind === 'equipment') {
      const e = t.e;
      const def = EQUIPMENT[e.type];
      const statusTxt = e.status !== 'normal' ? ` [${({ worn: '劣化', faulty: '不調', broken: '故障', repairing: '修理中' } as Record<string, string>)[e.status] ?? ''}]` : '';
      if (def?.role === 'assembly') {
        const list = bowlsOnAssembly(s, e);
        key += list.map((x) => `${x.bowl.id}:${x.bowl.orderId}:${x.bowl.contents?.steps.join('')}:${Math.round(x.bowl.contents?.heat ?? 0) >> 2}`).join(',');
        content = h(
          'div',
          null,
          h('div', { class: 'detail-title' }, `盛り付け台${statusTxt}`),
          e.bowlSlots.map((id, i) => {
            const b = s.bowls.find((x) => x.id === id);
            if (!b) return h('div', { class: 'slot empty' }, `${i + 1}: 空き`);
            const o = orderById(s, b.orderId);
            const seat = o ? s.seats.find((x) => x.id === o.seatId) : undefined;
            const done = isBowlComplete(b.contents);
            return h(
              'div',
              { class: `slot ${done ? 'done' : ''}` },
              h('span', { class: 'slot-main' }, `${i + 1}: ${seat ? `${seat.index + 1}番 ` : '未割当 '}${o ? MENU[o.menuId]?.short ?? '' : ''}`),
              h('span', { class: 'slot-sub' }, `${bowlStageLabel(b.contents)}${b.contents ? ` ${Math.round(b.contents.heat)}℃` : ''}${o && !o.callRevealed ? ' コール？' : o ? ` ${callToShort(o.call)}` : ''}`),
              h(
                'button',
                {
                  class: 'mini',
                  onclick: () => this.actWith('bowl_take', { slot: i }),
                },
                '持つ',
              ),
              b.contents && b.contents.steps.length > 0
                ? h('button', { class: 'mini danger', onclick: () => this.actWith('bowl_discard', { slot: i }) }, '捨てる')
                : null,
            );
          }),
        );
      } else if (def?.role === 'boiler') {
        key += e.slots.map((x) => (x ? `${Math.floor(x.elapsed)}:${x.grams}` : '-')).join(',');
        content = h(
          'div',
          null,
          h('div', { class: 'detail-title' }, `麺釜${statusTxt}（理想 ${BALANCE.cooking.noodleIdeal}秒）`),
          e.slots.map((x, i) => {
            if (!x) return h('div', { class: 'slot empty' }, `テボ${i + 1}: 空き`);
            const label = noodleDonenessLabel(x.elapsed, x.ideal);
            const o = orderById(s, x.orderId);
            const seat = o ? s.seats.find((y) => y.id === o.seatId) : undefined;
            const cls = label === 'ちょうど' ? 'good' : label === 'ゆですぎ' ? 'bad' : label === '柔らかめ' ? 'warn' : '';
            return h(
              'div',
              { class: `slot ${cls}` },
              h('span', { class: 'slot-main' }, `テボ${i + 1}: ${x.grams}g ${seat ? `(${seat.index + 1}番)` : ''}`),
              h('span', { class: 'slot-sub' }, `${Math.floor(x.elapsed)}/${x.ideal}秒 ${label}`),
            );
          }),
        );
      } else if (def?.role === 'soup') {
        key += `${e.soupL.toFixed(1)}:${e.process?.elapsed.toFixed(0)}`;
        content = h(
          'div',
          null,
          h('div', { class: 'detail-title' }, `${def.name}${statusTxt}`),
          h('div', { class: 'slot' }, `スープ ${e.soupL.toFixed(1)} / ${def.capacity}L ・品質 ${Math.round(e.soupQuality * 100)}`),
          e.process ? h('div', { class: 'slot' }, `炊いています… 残り${Math.ceil(e.process.duration - e.process.elapsed)}秒`) : null,
        );
      } else if (def?.role === 'topping') {
        const items: [string, string, string][] = [
          ['yasai', 'ヤサイ', 'g'], ['buta', '豚', '枚'], ['garlic', 'ニンニク', 'g'], ['abura', 'アブラ', 'g'], ['ichimi', '唐辛子', 'g'], ['tare', 'タレ', 'ml'],
        ];
        key += items.map(([id]) => Math.floor(stockOf(s, id))).join(',');
        content = h(
          'div',
          null,
          h('div', { class: 'detail-title' }, `トッピング台${statusTxt}`),
          items.map(([id, name, unit]) => h('div', { class: 'slot' }, `${name}: ${Math.floor(stockOf(s, id))}${unit}`)),
        );
      } else if (e.process) {
        key += `${Math.floor(e.process.elapsed)}`;
        content = h('div', null, h('div', { class: 'detail-title' }, `${def?.name ?? ''}${statusTxt}`), h('div', { class: 'slot' }, `工程中… 残り${Math.ceil(e.process.duration - e.process.elapsed)}秒`));
      } else if (def?.role === 'fridge' || def?.role === 'freezer') {
        const raw = ['noodle', 'pork_raw', 'pork_block', 'bones', 'backfat_raw', 'moyashi', 'cabbage', 'garlic_raw', 'homemade_noodle'];
        key += raw.map((id) => Math.floor(stockOf(s, id))).join(',');
        content = h(
          'div',
          null,
          h('div', { class: 'detail-title' }, `${def.name}${statusTxt}`),
          raw.filter((id) => stockOf(s, id) > 0).map((id) => h('div', { class: 'slot' }, `${INGREDIENTS[id]?.name}: ${Math.floor(stockOf(s, id)).toLocaleString('ja-JP')}${INGREDIENTS[id]?.unit}`)),
        );
      } else if (statusTxt) {
        content = h('div', null, h('div', { class: 'detail-title' }, `${def?.name ?? ''}${statusTxt}`), h('div', { class: 'slot' }, '経営メニュー → 設備 から修理を依頼できます'));
      }
    } else if (t?.kind === 'seat') {
      const c = s.customers.find((x) => x.id === t.seat.customerId);
      const o = s.orders.find((x) => x.seatId === t.seat.id && x.customerId === t.seat.customerId);
      key += `${c?.state}:${o?.status}:${o?.callRevealed}:${Math.floor(t.seat.dirt * 10)}:${c ? Math.floor(c.patience / 10) : ''}`;
      content = h(
        'div',
        null,
        h('div', { class: 'detail-title' }, `${t.seat.index + 1}番席`),
        c ? h('div', { class: 'slot' }, `${o ? MENU[o.menuId]?.name : '注文待ち'}${o?.status === 'served' ? '（食事中）' : ''}`) : h('div', { class: 'slot empty' }, '空席'),
        o ? h('div', { class: 'slot' }, o.callRevealed ? `コール: ${callToShort(o.call)}` : 'コール: まだ聞いていません') : null,
        c && c.state === 'complaint' ? h('div', { class: 'slot bad' }, `クレーム: ${c.complaintReason}`) : null,
        t.seat.dirt > 0.05 ? h('div', { class: 'slot warn' }, `カウンターの汚れ ${Math.round(t.seat.dirt * 100)}%`) : null,
      );
    }
    if (key === this.lastDetailKey || this.detailPressed) return;
    this.lastDetailKey = key;
    if (content) {
      replace(this.detail, content);
      this.detail.style.display = 'block';
    } else {
      replace(this.detail);
      this.detail.style.display = 'none';
    }
  }

  private actWith(verb: string, args: Record<string, number>): void {
    if (!this.focus) return;
    void this.host.act({ type: 'interact', targetId: this.focus.id, verb, args }).then((r) => {
      if (!r.ok && r.reason) toast(this.root, r.reason, 'warn', 1800);
    });
  }

  dispose(): void {
    this.el.remove();
  }
}

function connLabel(c: string): string {
  return ({ connecting: '接続中…', reconnecting: '再接続中…', paused: '一時停止', closed: '切断', online: 'オンライン', local: '' } as Record<string, string>)[c] ?? c;
}

/** 注文の進み具合（丼・麺・完成） */
function orderProgress(s: GameState, o: Order): string {
  const b = bowlForOrder(s, o.id);
  if (b && isBowlComplete(b.contents)) return '完成';
  const parts: string[] = [];
  if (b) parts.push('丼');
  if (noodlesStartedFor(s, o.id)) parts.push('麺');
  return parts.join('・') || '—';
}

/** 動詞の追加引数 */
function argsFor(s: GameState, verb: string, _t: Target): Record<string, number> | undefined {
  if (verb === 'bowls_take') {
    const need = waitingOrders(s).filter((o) => !bowlForOrder(s, o.id)).length;
    return { count: Math.max(1, Math.min(6, need || 4)) };
  }
  return undefined;
}
