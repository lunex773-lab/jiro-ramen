// チュートリアルの案内パネル。今の手順（何をするか）と進み具合を出し、
// 「次へ」などのボタンと、経営メニューのタブを開いたかの判定（画面側の条件）を受け持つ。
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
  /** 見出しだけにたたんでいるか（手順が変わると開き直す） */
  private collapsed = false;
  private collapsedStep = '';

  constructor(
    private root: HTMLElement,
    private host: GameHost,
    private cb: TutorialPanelCallbacks,
  ) {
    this.el = h('div', { class: 'tutorial-panel', role: 'status' });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
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
    this.el.style.display = 'block';
    this.el.classList.toggle('docked', screen.covered);
    // 画面側の条件（経営メニューのタブを開いた等）を満たしたら「次へ」を送る
    if (step.ui && this.sentFor !== step.id && uiMet(step.ui, screen)) {
      this.sentFor = step.id;
      void this.host.act({ type: 'tutorial', op: 'next', stepId: step.id });
    }
    if (this.collapsed && this.collapsedStep !== step.id) this.collapsed = false;
    this.el.classList.toggle('collapsed', this.collapsed);
    const guide = step.showGuide ? nextHint(s, this.host.playerId) : null;
    const key = `${step.id}|${guide ?? ''}|${s.phase}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.render(s, guide);
    }
    // 案内パネルの高さぶん、右の列（詳細と操作ボタン）を下げる
    if (app instanceof HTMLElement) app.style.setProperty('--tut-h', screen.covered ? '0px' : `${this.el.offsetHeight}px`);
  }

  private hide(app: Element | null): void {
    this.el.style.display = 'none';
    app?.classList.remove('tutorial-on');
    this.lastKey = '';
  }

  private render(s: GameState, guide: string | null): void {
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
    // 見出しを押すとたたむ（画面が狭いときに、下の画面を見るため）
    const toggle = () => {
      this.collapsed = !this.collapsed;
      this.collapsedStep = step.id;
      this.el.classList.toggle('collapsed', this.collapsed);
    };
    replace(
      this.el,
      h(
        'div',
        { class: 'tut-head', onclick: toggle, title: 'たたむ / 開く' },
        h('span', { class: 'tut-badge' }, kind),
        h('span', { class: 'tut-title' }, step.title),
        prog ? h('span', { class: 'tut-prog' }, `${prog.index} / ${prog.total}`) : null,
        h('span', { class: 'tut-fold', 'aria-hidden': 'true' }, '▾'),
      ),
      h('div', { class: 'tut-text' }, step.text),
      guide ? h('div', { class: 'tut-guide' }, `💡 ${guide}`) : null,
      h(
        'div',
        { class: 'tut-buttons' },
        ...buttons,
        h('button', { class: 'tut-quit', onclick: () => this.cb.onQuit() }, 'やめる'),
      ),
    );
  }

  dispose(): void {
    const app = this.root.closest('.app');
    app?.classList.remove('tutorial-on');
    this.el.remove();
  }
}
