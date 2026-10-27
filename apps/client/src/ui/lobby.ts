// 共同経営のルーム作成・参加（設計書 19.1 マルチプレイのルーム作成/参加/接続中表示）。

import { createGame, listSlots, loadFromSlot, saveToSlot, type GameState } from '@jiro/core';
import type { App } from '../game/app';
import { VERSION } from '../game/app';
import { Api, ApiError, defaultServerUrl, rememberServerUrl } from '../net/api';
import { RemoteHost } from '../net/remote';
import { h, replace, toast } from './dom';

export function openLobby(app: App, onBack: () => void): HTMLElement {
  const body = h('div', { class: 'lobby-body' });
  const el = h('div', { class: 'screen lobby' }, h('div', { class: 'screen-inner' }, h('h2', null, 'オンライン共同経営（最大4人）'), body, h('button', { class: 'btn ghost', onclick: onBack }, '← 戻る')));
  el.addEventListener('pointerdown', (e) => e.stopPropagation());

  const urlInput = h('input', { class: 'input', value: defaultServerUrl(), placeholder: 'https://jiro-ramen.<アカウント>.workers.dev' }) as HTMLInputElement;
  const codeInput = h('input', { class: 'input code', placeholder: '参加コード（6文字）', maxLength: 6 }) as HTMLInputElement;
  const status = h('div', { class: 'note' });
  const slots = listSlots(app.store);
  const slotSelect = h(
    'select',
    { class: 'select' },
    slots.map((s) => h('option', { value: String(s.slot) }, `スロット${s.slot}: ${s.meta ? `${s.meta.shopName}（${s.meta.day}日目）` : '空き（新しい店）'}`)),
  ) as HTMLSelectElement;

  const busy = (on: boolean, text = '') => {
    for (const b of Array.from(body.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = on;
    status.textContent = text;
  };

  const connect = async (mode: 'create' | 'join') => {
    const url = Api.normalize(urlInput.value);
    if (!url) {
      status.textContent = 'サーバーのURLを入力してください';
      return;
    }
    rememberServerUrl(url);
    const api = new Api(url);
    busy(true, 'サーバーに接続しています…');
    try {
      const ver = await api.version();
      if (ver.protocol !== 1) throw new Error('サーバーとゲームのバージョンが合いません。ページを再読み込みしてください');
      const auth = await api.auth(app.settings.playerName);
      let roomId: string;
      let code: string;
      let joinToken: string;
      let initState: GameState | null = null;
      const slot = Number(slotSelect.value);
      if (mode === 'create') {
        const r = loadFromSlot(app.store, slot);
        initState = r.ok ? r.file.state : createGame({ shopName: 'ラーメン まし屋', playerName: app.settings.playerName });
        if (!r.ok) saveToSlot(app.store, slot, initState);
        if (initState.bankruptcy) throw new Error('破産したキャリアでは共同経営を始められません');
        const room = await api.createRoom(auth.token);
        roomId = room.roomId;
        code = room.code;
        joinToken = room.joinToken;
      } else {
        code = codeInput.value.trim().toUpperCase();
        if (code.length < 4) throw new Error('参加コードを入力してください');
        const room = await api.joinRoom(auth.token, code);
        roomId = room.roomId;
        joinToken = room.joinToken;
      }
      busy(true, 'ルームに接続しています…');
      const placeholder = initState ?? createGame({ seed: 1 });
      const host = new RemoteHost({ api, authToken: auth.token, roomId, code, joinToken, name: app.settings.playerName, initState, clientVersion: VERSION }, placeholder);
      const ok = await host.connect();
      if (!ok) {
        host.dispose();
        throw new Error(host.lastError || '接続できませんでした');
      }
      if (mode === 'create') app.slot = slot;
      toast(app.uiLayer, `ルーム ${code} に参加しました。仲間に参加コード「${code}」を伝えてください`, 'good', 8000);
      app.startGame(host);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : (e as Error).message;
      busy(false, `エラー: ${msg}`);
    }
  };

  replace(
    body,
    h(
      'section',
      { class: 'card wide' },
      h('h4', null, 'サーバー'),
      h('p', { class: 'note' }, '共同経営には Cloudflare 上のゲームサーバーが必要です。設定方法はリポジトリの docs/CLOUDFLARE_SETUP.md を参照してください。'),
      urlInput,
    ),
    h(
      'div',
      { class: 'grid2' },
      h(
        'section',
        { class: 'card' },
        h('h4', null, 'ルームを作る（ホスト）'),
        h('p', { class: 'note' }, 'ホストのキャリアで全員が同じ店を経営します。資金・在庫・評判は共有です。ホストが切断すると一時停止します。'),
        slotSelect,
        h('button', { class: 'btn primary', onclick: () => void connect('create') }, 'ルームを作成'),
      ),
      h(
        'section',
        { class: 'card' },
        h('h4', null, 'ルームに参加'),
        h('p', { class: 'note' }, 'ホストから教えてもらった参加コードを入力します。あなたのセーブデータは変更されません。'),
        codeInput,
        h('button', { class: 'btn primary', onclick: () => void connect('join') }, '参加する'),
      ),
    ),
    status,
  );
  return el;
}
