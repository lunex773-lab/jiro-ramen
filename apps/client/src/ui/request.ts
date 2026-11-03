// ホストへの確認（第2版 11-2・12）: YouTuber の撮影の許可、テレビ取材を受けるか。
// ホスト（ひとりプレイなら自分）にだけ確認の画面を出す。ゲストには「ホストが判断しています」と出すだけ。
// 答えは操作 answerRequest でサーバー（ひとりプレイなら自分の sim）へ送る。時間切れは sim が「断る」にする。
// ひとりプレイでは確認の画面を開いている間は時間を止める（app.ts の blocking）。

import { pendingRequests, type GameState, type HostRequest } from '@jiro/core';
import type { GameHost } from '../game/host';
import { h } from './dom';

export class RequestPrompt {
  private overlay: HTMLElement | null = null;
  private shownId: string | null = null;
  private left: HTMLElement | null = null;
  private sending = false;

  constructor(
    private root: HTMLElement,
    private host: GameHost,
  ) {}

  /** 確認の画面を開いている（ひとりプレイでは時間を止める） */
  get isOpen(): boolean {
    return this.overlay !== null;
  }

  update(s: GameState): void {
    const list = pendingRequests(s);
    const cur = this.shownId ? list.find((r) => r.id === this.shownId) : undefined;
    if (this.shownId && !cur) this.close();
    if (!this.host.isHost) return;
    if (!this.overlay && list.length > 0) this.open(list[0]!);
    if (cur && this.left) {
      const sec = Math.max(0, Math.ceil(cur.timeoutAt - s.t));
      const txt = `あと${sec}秒で「断る」になります`;
      if (this.left.textContent !== txt) this.left.textContent = txt;
    }
  }

  private open(r: HostRequest): void {
    this.shownId = r.id;
    const yes = r.kind === 'filming' ? '撮影を許可する' : '取材を受ける';
    const no = r.kind === 'filming' ? '許可しない' : '断る';
    const title = r.kind === 'filming' ? '🎥 撮影の許可' : '📺 テレビ取材';
    const note =
      r.kind === 'filming'
        ? '許可して撮影が終わると、3日間SNSで話題になりやすくなります。許可しなくても撮ろうとする人がいます。'
        : '受けると出演者2人がラーメンを食べ、カメラマン2人が撮影します（スタッフ4人は店の外で待ちます）。食べ終えてもらえれば、明日と明後日はお客さんが大幅に増えます。';
    this.left = h('p', { class: 'note' }, '');
    this.overlay = h(
      'div',
      { class: 'modal-overlay request-prompt', 'data-request': r.id },
      h(
        'div',
        { class: 'modal' },
        h('h3', null, title),
        h('p', { class: 'modal-body' }, r.text),
        h('p', { class: 'note' }, note),
        this.left,
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn ghost', onclick: () => void this.answer(r.id, false) }, no),
          h('button', { class: 'btn primary', onclick: () => void this.answer(r.id, true) }, yes),
        ),
      ),
    );
    this.root.appendChild(this.overlay);
  }

  private async answer(id: string, accept: boolean): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      await this.host.act({ type: 'answerRequest', requestId: id, accept });
    } finally {
      this.sending = false;
      this.close();
    }
  }

  close(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.shownId = null;
    this.left = null;
  }

  dispose(): void {
    this.close();
  }
}
