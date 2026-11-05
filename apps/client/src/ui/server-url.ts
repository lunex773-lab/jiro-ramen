// サーバーの URL（共同経営・オンライン市場・クラウドセーブで使う）。
// 誤って書き換えないよう、入口の画面には出さず（今の URL を表示するだけ）、設定の画面で「変更する」を押したときだけ入力できる。

import { Api, ApiError, defaultServerUrl, rememberServerUrl } from '../net/api';
import { confirmDialog, h, replace } from './dom';

/** URL として使える形か（http: か https: のどちらか） */
export function validServerUrl(raw: string): string | null {
  const url = Api.normalize(raw);
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

/** 設定の画面の「サーバー」の欄 */
export function serverUrlCard(root: () => HTMLElement): HTMLElement {
  const body = h('div', null);
  const card = h('section', { class: 'card wide server-url-card' }, h('h4', null, 'サーバー（共同経営・オンライン市場・クラウドセーブ）'), body);
  const show = () => {
    const cur = defaultServerUrl();
    replace(
      body,
      h('div', { class: 'kv' }, h('span', null, 'URL'), h('b', { class: 'server-url', 'data-server-url': cur }, cur || '未設定')),
      h('p', { class: 'note' }, '誤って書き換えないよう、変えるときは「変更する」を押してください。'),
      h('button', { class: 'btn ghost', 'data-server-url-edit': '', onclick: edit }, '変更する'),
    );
  };
  const edit = () => {
    const cur = defaultServerUrl();
    const input = h('input', { class: 'input', 'data-server-url-input': '', value: cur, placeholder: 'https://jiro-ramen.<アカウント>.workers.dev', inputMode: 'url', autocapitalize: 'off', spellcheck: false }) as HTMLInputElement;
    const status = h('p', { class: 'note' });
    const save = async () => {
      const url = validServerUrl(input.value);
      if (!url) {
        status.textContent = 'https:// で始まる URL を入力してください';
        return;
      }
      status.textContent = '接続を確かめています…';
      let ok = false;
      try {
        const v = await Promise.race([new Api(url).version(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('時間内に応答がありません')), 8000))]);
        ok = v.protocol === 1;
        if (!ok) status.textContent = 'サーバーとゲームのバージョンが合いません';
      } catch (e) {
        status.textContent = `接続できませんでした（${e instanceof ApiError ? e.message : (e as Error).message}）`;
      }
      if (!ok && !(await confirmDialog(root(), 'サーバーの URL', `${url}\n\nこのサーバーに接続できませんでした。それでも保存しますか？`, '保存する'))) return;
      rememberServerUrl(url);
      show();
      const note = body.querySelector('.note');
      if (note) note.textContent = ok ? '保存しました（接続できました）。次に接続するときから使います。' : '保存しました（まだ接続できていません）。';
    };
    replace(
      body,
      input,
      status,
      h('div', { class: 'row wrap' }, h('button', { class: 'btn primary', 'data-server-url-save': '', onclick: () => void save() }, '保存する'), h('button', { class: 'btn ghost', onclick: show }, 'キャンセル')),
    );
    input.focus();
  };
  show();
  return card;
}

/** 入口の画面に出す、今のサーバー（変えるのは設定の画面） */
export function serverUrlNote(onOpenSettings: () => void): HTMLElement {
  const cur = defaultServerUrl();
  return h(
    'section',
    { class: 'card wide' },
    h('h4', null, 'サーバー'),
    cur
      ? h('div', { class: 'kv' }, h('span', null, 'URL'), h('b', { class: 'server-url', 'data-server-url': cur }, cur))
      : h('p', { class: 'note bad', 'data-server-url-missing': '' }, 'サーバーが設定されていません。設定の画面で URL を入れてください。'),
    h('button', { class: 'btn ghost', 'data-open-settings': '', onclick: onOpenSettings }, '⚙ 設定で変える'),
  );
}
