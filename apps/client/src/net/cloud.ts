// クラウドセーブ（設計書 16.2）。
// ローカルが基本。クラウドと競合したら新しい方を自動で選ばず、内容を見せてユーザーに選ばせる。

import { compareSaves, loadFromSlot, saveToSlot, type SaveFile, type SaveStore } from '@jiro/core';
import { confirmDialog, toast, yenStr } from '../ui/dom';
import { Api, ApiError, defaultServerUrl } from './api';

const baseKey = (slot: number) => `jiro.cloudrev.slot${slot}`;

function getBase(slot: number): number | null {
  try {
    const v = localStorage.getItem(baseKey(slot));
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function setBase(slot: number, rev: number): void {
  try {
    localStorage.setItem(baseKey(slot), String(rev));
  } catch {
    // 無視
  }
}

function describe(f: Pick<SaveFile, 'meta' | 'updatedAt'>): string {
  return `${f.meta.shopName}・${f.meta.day}日目・${yenStr(f.meta.money)}（${new Date(f.updatedAt).toLocaleString('ja-JP')}）`;
}

export async function cloudUpload(root: HTMLElement, store: SaveStore, slot: number, playerName: string): Promise<void> {
  const url = defaultServerUrl();
  if (!url) {
    toast(root, 'サーバーが設定されていません（オンライン画面でURLを設定してください）', 'warn', 4000);
    return;
  }
  const local = loadFromSlot(store, slot);
  if (!local.ok) {
    toast(root, 'このスロットにはデータがありません', 'warn');
    return;
  }
  const api = new Api(Api.normalize(url));
  try {
    const auth = await api.auth(playerName);
    try {
      const r = await api.uploadSave(auth.token, slot, local.file, getBase(slot));
      setBase(slot, r.revision);
      toast(root, `クラウドに保存しました（世代 ${r.revision}）`, 'good');
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      const cloud = (e.body as { cloud?: { meta: SaveFile['meta']; updatedAt: number; revision: number } } | null)?.cloud;
      const ok = await confirmDialog(
        root,
        'クラウドに別のデータがあります',
        `クラウド: ${cloud ? describe(cloud) : '不明'}\nこの端末: ${describe(local.file)}\n\nこの端末のデータでクラウドを上書きしますか？（クラウド側の進行は失われます）`,
        '上書きする',
        true,
      );
      if (!ok) return;
      const r = await api.uploadSave(auth.token, slot, local.file, cloud?.revision ?? null);
      setBase(slot, r.revision);
      toast(root, `クラウドを上書きしました（世代 ${r.revision}）`, 'good');
    }
  } catch (e) {
    toast(root, `クラウド保存に失敗: ${(e as Error).message}`, 'danger', 5000);
  }
}

/** クラウドから読み込む。置き換えたら true */
export async function cloudDownload(root: HTMLElement, store: SaveStore, slot: number, playerName: string): Promise<boolean> {
  const url = defaultServerUrl();
  if (!url) {
    toast(root, 'サーバーが設定されていません', 'warn');
    return false;
  }
  const api = new Api(Api.normalize(url));
  try {
    const auth = await api.auth(playerName);
    const r = await api.downloadSave(auth.token, slot);
    const local = loadFromSlot(store, slot);
    if (local.ok) {
      const kind = compareSaves(local.file, r.save, getBase(slot));
      if (kind === 'same') {
        toast(root, 'この端末とクラウドは同じデータです', 'info');
        setBase(slot, r.revision);
        return false;
      }
      const msg =
        kind === 'cloudNewer'
          ? 'クラウドの方が新しい進行です。'
          : kind === 'localNewer'
            ? 'この端末の方が新しい進行です。読み込むとこの端末の進行が失われます。'
            : kind === 'differentCareer'
              ? 'クラウドには別のキャリアが保存されています。'
              : 'この端末とクラウドで別々に進行しています。';
      const ok = await confirmDialog(root, 'クラウドから読み込む', `${msg}\n\nクラウド: ${describe(r.save)}\nこの端末: ${describe(local.file)}\n\nクラウドのデータで置き換えますか？`, '置き換える', kind !== 'cloudNewer');
      if (!ok) return false;
    }
    const res = saveToSlot(store, slot, r.save.state);
    if (!res.ok) {
      toast(root, res.error, 'danger');
      return false;
    }
    setBase(slot, r.revision);
    toast(root, 'クラウドのデータを読み込みました', 'good');
    return true;
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    toast(root, status === 404 ? 'クラウドにこのスロットのデータはありません' : `読み込みに失敗: ${(e as Error).message}`, status === 404 ? 'info' : 'danger', 4000);
    return false;
  }
}
