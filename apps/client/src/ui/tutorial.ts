// チュートリアルの案内。画面の下に小さく横長の帯で出し、視界をふさがない（文は2行まで。「…」で全文）。
// 今の手順（何をするか）と進み具合を出し、「次へ」などのボタンと、経営メニューのタブを開いたかの判定（画面側の条件）を受け持つ。
// 帯の文字の部分はタッチを素通りさせ、下にある移動スティックの操作を邪魔しない（ボタンだけ押せる）。
// 手順の中身と、操作で状態が変わったら次へ進む判定は core（sim/tutorial.ts）にある。

import { currentTutorialStep, tutorialProgress, type GameState, type TutorialUi } from '@jiro/core';
import type { GameHost } from '../game/host';
import { nextHint } from '../game/guide';
import { h, replace, toast } from './dom';

/** 画面の状態（経営メニュー・レイアウト編集・結果画面が開いているか） */
export interface TutorialScreenState {
  manageOpen: boolean;
  manageTab: string | null;
  editorOpen: boolean;
  /** 画面全体を覆うもの（経営メニュー・レイアウト編集・結果画面など）が出ているか */
  covered: boolean;
}

export interface TutorialPanelCallbacks {
  /** 「やめる」が押された */
  onQuit(): void;
  /** 最後の手順まで終えた（営業0日目なら1日目を始める） */
  onFinished(): void;
}

function uiMet(ui: TutorialUi, st: TutorialScreenState): boolean {
  switch (ui) {
    case 'manage:stock':
      return st.manageOpen && st.manageTab === 'stock';
    case 'manage:staff':
      return st.manageOpen && st.manageTab === 'staff';
    case 'closedAll':
      return !st.manageOpen && !st.editorOpen;
  }
}

export class TutorialPanel {
  readonly el: HTMLElement;
  private lastKey = '';
  /** 画面側の条件で「次へ」を送った手順（二重送信を防ぐ） */
  private sentFor = '';
  private finishedHandled = false;
  private acc = 0;
  /** 下の案内の行（手順の途中でも書き換える） */
  private guideEl: HTMLElement | null = null;
  /** 全文を出しているか（手順が変わると2行に戻す） */
  private expanded = false;
  private expandedStep = '';

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: TutorialPanelCallbacks,
  ) {
    this.el = h('div', { class: 'tutorial-panel', role: 'status' });
    root.appendChild(this.el);
  }

  /** 今の手順で目立たせる経営メニューのタブ */
  get highlightTab(): string | null {
    return currentTutorialStep(this.host.state)?.tab ?? null;
  }

  update(dt: number, screen: TutorialScreenState): void {
    this.acc += dt;
    if (this.acc < 0.15) return;
    this.acc = 0;
    const s = this.host.state;
    const t = s.tutorial;
    const app = this.root.closest('.app');
    if (!t || t.finished) {
      this.hide(app);
      if (t?.finished && !this.finishedHandled) {
        this.finishedHandled = true;
        this.cb.onFinished();
      }
      return;
    }
    const step = currentTutorialStep(s);
    if (!step) {
      this.hide(app);
      return;
    }
    app?.classList.add('tutorial-on');
    this.el.style.display = 'flex';
    this.el.classList.toggle('docked', screen.covered);
    // 画面側の条件（経営メニューのタブを開いた等）を満たしたら「次へ」を送る
    if (step.ui && this.sentFor !== step.id && uiMet(step.ui, screen)) {
      this.sentFor = step.id;
      void this.host.act({ type: 'tutorial', op: 'next', stepId: step.id });
    }
    if (this.expanded && this.expandedStep !== step.id) this.expanded = false;
    this.el.classList.toggle('expanded', this.expanded);
    // 帯は手順が変わったときだけ作り直す（ボタンを押している途中で作り直すと押せないため）。下の案内の行だけは中身を書き換える
    const key = `${step.id}|${s.phase}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.render(s);
    }
    const guide = step.showGuide ? nextHint(s, this.host.playerId) : null;
    const g = guide ? `💡 ${guide}` : '';
    if (this.guideEl && this.guideEl.textContent !== g) {
      this.guideEl.textContent = g;
      this.guideEl.hidden = !guide;
    }
  }

  /** 表示中か（下の帯の高さを測るため） */
  get visible(): boolean {
    return this.el.style.display !== 'none';
  }

  private hide(app: Element | null): void {
    this.el.style.display = 'none';
    app?.classList.remove('tutorial-on');
    this.lastKey = '';
  }

  private render(s: GameState): void {
    const step = currentTutorialStep(s);
    if (!step) return;
    const prog = tutorialProgress(s);
    const kind = s.tutorial?.kind === 'staff' ? '従業員' : '練習の日';
    const act = (op: 'next' | 'alt' | 'close') => async () => {
      const r = await this.host.act({ type: 'tutorial', op, stepId: step.id });
      if (!r.ok && r.reason) toast(this.root, r.reason, 'warn');
    };
    const buttons: HTMLElement[] = [];
    if (step.closeButton && s.phase === 'open') buttons.push(h('button', { class: 'btn primary tut-btn', onclick: act('close') }, '閉店する'));
    if (step.button) buttons.push(h('button', { class: 'btn primary tut-btn', onclick: act('next') }, step.button));
    if (step.alt) buttons.push(h('button', { class: 'btn tut-btn', onclick: act('alt') }, step.alt.label));
    const line = h('div', { class: 'tut-line' }, h('b', { class: 'tut-title' }, step.title), ' ', step.text);
    // 2行に収まらないときだけ「…」（全文を出す）を出す
    const more = h(
      'button',
      {
        class: 'tut-more',
        'aria-label': '全文を見る',
        onclick: () => {
          this.expanded = !this.expanded;
          this.expandedStep = step.id;
          this.el.classList.toggle('expanded', this.expanded);
          more.textContent = this.expanded ? '▾' : '…';
        },
      },
      this.expanded ? '▾' : '…',
    );
    more.hidden = true;
    const stop = (e: Event) => e.stopPropagation();
    const btnRow = h('div', { class: 'tut-buttons' }, more, ...buttons, h('button', { class: 'tut-quit', onclick: () => this.cb.onQuit() }, 'やめる'));
    // ボタンのタッチは 3D の操作に渡さない（帯のほかの部分は素通り）
    btnRow.addEventListener('pointerdown', stop);
    this.guideEl = h('div', { class: 'tut-guide', hidden: true });
    replace(this.el, h('span', { class: 'tut-badge' }, prog ? `${kind} ${prog.index}/${prog.total}` : kind), h('div', { class: 'tut-main' }, line, this.guideEl), btnRow);
    requestAnimationFrame(() => {
      more.hidden = !this.expanded && line.scrollHeight <= line.clientHeight + 1;
    });
  }

  dispose(): void {
    const app = this.root.closest('.app');
    app?.classList.remove('tutorial-on');
    this.el.remove();
  }
}
