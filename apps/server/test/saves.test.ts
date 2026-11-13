// ひとりプレイ・共同経営のクラウドセーブは廃止した（オーナーの判断 2026-11-13）。サーバーのデータも消した。
// クラウドセーブはオンライン市場だけ（市場の会社の状態と途中のセーブ）
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, newPlayer } from './helpers';

describe('クラウドセーブの廃止', () => {
  it('前の版の端末からの保存・読み込み・削除の要求には 410 を返す', async () => {
    const p = await newPlayer('廃止の確認');
    for (const [path, method] of [['/api/v1/save', 'POST'], ['/api/v1/save/1', 'GET'], ['/api/v1/save/1', 'DELETE']] as const) {
      const r = await call(path, { token: p.token, method, ...(method === 'POST' ? { body: { slot: 1, save: {}, baseRevision: null } } : {}) });
      expect(r.status, `${method} ${path}`).toBe(410);
      expect(((await r.json()) as { code?: string }).code).toBe('cloud_save_removed');
    }
  });

  it('保存してあったデータの表は消えている', async () => {
    const r = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('save_slots', 'save_bodies', 'room_snapshots')").all<{ name: string }>();
    expect(r.results).toEqual([]);
  });
});
