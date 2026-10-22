// クラウドセーブ: アップロード・ダウンロード・競合（409）・破損の拒否・3世代保持・削除。

import { createGame, makeSaveFile, stateChecksum, type SaveFile } from '@jiro/core';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, callJson, newPlayer } from './helpers';

function saveFile(seed: number, prev: SaveFile | null = null, slot = 1): SaveFile {
  const s = createGame({ seed, shopName: `テスト屋${seed}` });
  s.money += seed;
  return makeSaveFile(s, slot, prev, Date.now());
}

async function upload(token: string, slot: number, save: unknown, baseRevision: number | null) {
  return callJson<{ revision: number; checksum: string; error?: string; code?: string; cloud?: { revision: number; checksum: string } }>('/api/v1/save', {
    token,
    body: { slot, save, baseRevision },
  });
}

async function r2Keys(playerId: string, slot: number): Promise<string[]> {
  const l = await env.SAVES.list({ prefix: `saves/${playerId}/${slot}/` });
  return l.objects.map((o) => o.key).sort();
}

describe('クラウドセーブ', () => {
  it('アップロードしてダウンロードすると同じデータが返る', async () => {
    const p = await newPlayer();
    const f = saveFile(1);
    const up = await upload(p.token, 1, f, null);
    expect(up.status).toBe(200);
    expect(up.body.revision).toBe(1);
    expect(up.body.checksum).toBe(f.checksum);

    const down = await callJson<{ slot: number; revision: number; save: SaveFile }>('/api/v1/save/1', { token: p.token });
    expect(down.status).toBe(200);
    expect(down.body.revision).toBe(1);
    expect(down.body.save.checksum).toBe(f.checksum);
    expect(stateChecksum(down.body.save.state)).toBe(f.checksum);
    expect(down.body.save.state.shopName).toBe('テスト屋1');

    const prof = await callJson<{ slots: { slot: number; revision: number; meta: { shopName: string } }[] }>('/api/v1/profile', { token: p.token });
    expect(prof.body.slots).toHaveLength(1);
    expect(prof.body.slots[0]).toMatchObject({ slot: 1, revision: 1, meta: { shopName: 'テスト屋1' } });

    // 他人のセーブは見えない
    const other = await newPlayer();
    expect((await call('/api/v1/save/1', { token: other.token })).status).toBe(404);
  });

  it('baseRevision がクラウドと違えば 409 で、クラウドの情報を返す（上書きしない）', async () => {
    const p = await newPlayer();
    const a = saveFile(2);
    expect((await upload(p.token, 2, a, null)).body.revision).toBe(1);
    // 別の端末がクラウドを更新した
    const b = saveFile(3, a, 2);
    expect((await upload(p.token, 2, b, 1)).body.revision).toBe(2);
    // 古い世代（rev 1）を元にした保存は競合
    const c = saveFile(4, a, 2);
    const r = await upload(p.token, 2, c, 1);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('conflict');
    expect(typeof r.body.error).toBe('string');
    expect(r.body.cloud).toMatchObject({ revision: 2, checksum: b.checksum });
    // baseRevision なしで既存スロットを上書きしようとしても競合
    expect((await upload(p.token, 2, c, null)).status).toBe(409);
    // クラウドは b のまま
    const down = await callJson<{ save: SaveFile }>('/api/v1/save/2', { token: p.token });
    expect(down.body.save.checksum).toBe(b.checksum);
    // ユーザーが上書きを選んだ場合は最新の revision を指定すれば保存できる
    expect((await upload(p.token, 2, c, 2)).status).toBe(200);

    const conflicts = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE player_id = ? AND kind = 'save_conflict'").bind(p.playerId).first<{ n: number }>();
    expect(conflicts?.n).toBe(2);
  });

  it('同じ内容の再送は成功扱い（応答が届かなかった場合の再試行）', async () => {
    const p = await newPlayer();
    const f = saveFile(5);
    expect((await upload(p.token, 3, f, null)).body.revision).toBe(1);
    const again = await upload(p.token, 3, f, null);
    expect(again.status).toBe(200);
    expect(again.body.revision).toBe(1);
    expect(await r2Keys(p.playerId, 3)).toHaveLength(1);
  });

  it('チェックサムが合わない・形式が違うデータは拒否する', async () => {
    const p = await newPlayer();
    const f = saveFile(6);
    const broken = { ...f, state: { ...f.state, money: f.state.money + 1 } };
    const r = await upload(p.token, 1, broken, null);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid_save');
    expect(r.body.error).toMatch(/チェックサム/);
    expect((await upload(p.token, 1, { hello: 'world' }, null)).status).toBe(422);
    expect((await upload(p.token, 4, f, null)).status).toBe(400);
    expect((await upload(p.token, 0, f, null)).status).toBe(400);
    expect((await upload(p.token, 1, f, -1)).status).toBe(400);
    expect((await call('/api/v1/save/1', { token: p.token })).status).toBe(404);
  });

  it('大きすぎる本文は 413', async () => {
    const p = await newPlayer();
    const f = saveFile(7);
    const big = { slot: 1, baseRevision: null, save: f, pad: 'x'.repeat(2 * 1024 * 1024) };
    const r = await call('/api/v1/save', { token: p.token, body: big });
    expect(r.status).toBe(413);
  });

  it('R2 には直近3世代だけを残す', async () => {
    const p = await newPlayer();
    let prev: SaveFile | null = null;
    let rev: number | null = null;
    for (let i = 0; i < 5; i++) {
      const f = saveFile(100 + i, prev, 1);
      const r = await upload(p.token, 1, f, rev);
      expect(r.status).toBe(200);
      rev = r.body.revision;
      prev = { ...f, revision: rev };
    }
    expect(rev).toBe(5);
    expect(await r2Keys(p.playerId, 1)).toEqual([3, 4, 5].map((n) => `saves/${p.playerId}/1/${n}.json`));
    const row = await env.DB.prepare('SELECT revision, r2_key FROM save_slots WHERE player_id = ? AND slot = 1').bind(p.playerId).first<{ revision: number; r2_key: string }>();
    expect(row).toEqual({ revision: 5, r2_key: `saves/${p.playerId}/1/5.json` });
  });

  it('スロットを削除できる（他のスロットは残る）', async () => {
    const p = await newPlayer();
    await upload(p.token, 1, saveFile(8), null);
    await upload(p.token, 2, saveFile(9), null);
    const del = await call('/api/v1/save/1', { token: p.token, method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await r2Keys(p.playerId, 1)).toEqual([]);
    expect((await call('/api/v1/save/1', { token: p.token })).status).toBe(404);
    expect((await call('/api/v1/save/2', { token: p.token })).status).toBe(200);
    expect((await call('/api/v1/save/1', { token: p.token, method: 'DELETE' })).status).toBe(404);
  });
});
