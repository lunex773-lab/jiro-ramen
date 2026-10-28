// 共同経営の参加コードの表示（ルームを作った後の待機画面と、店の中で画面上部の「コード」から開く表示で使う）。

import type { GameHost } from '../game/host';
import { h, toast } from './dom';

export const JOIN_HOWTO = '仲間は、タイトルの「オンライン共同経営」→「ルームに参加」で、このコードを入力します。';

/** 参加コードの大きな表示とコピーボタン */
export function codeBlock(root: HTMLElement, code: string): HTMLElement {
  return h(
    'div',
    { class: 'room-code-row' },
    h('div', { class: 'room-code', 'aria-label': `参加コード ${code.split('').join(' ')}` }, code),
    h('button', { class: 'btn', onclick: () => void copyCode(root, code) }, 'コピー'),
  );
}

async function copyCode(root: HTMLElement, code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast(root, 'コピーしました', 'good', 1500);
  } catch {
    toast(root, 'コピーできませんでした。コードを書き写してください', 'warn', 2500);
  }
}

export function memberText(host: GameHost): string {
  const on = host.peers.filter((p) => p.connected);
  return on.length > 0 ? `参加中 ${on.length}人: ${on.map((p) => p.name).join('、')}` : '接続しています…';
}

/** 参加コードを大きく表示する（共同経営中に画面上部の「コード」から開く） */
export function showRoomCode(root: HTMLElement, host: GameHost): void {
  const code = host.roomCode;
  if (!code) return;
  const members = h('div', { class: 'note' });
  const tick = () => (members.textContent = memberText(host));
  const timer = window.setInterval(tick, 500);
  tick();
  const close = () => {
    window.clearInterval(timer);
    overlay.remove();
  };
  const overlay = h(
    'div',
    { class: 'modal-overlay' },
    h(
      'div',
      { class: 'modal' },
      h('h3', null, '参加コード'),
      codeBlock(root, code),
      h('p', { class: 'modal-body' }, JOIN_HOWTO),
      members,
      h('div', { class: 'row end' }, h('button', { class: 'btn primary', onclick: close }, '閉じる')),
    ),
  );
  overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
  root.appendChild(overlay);
}
