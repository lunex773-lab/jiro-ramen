// クラウドセーブ（設計書 16.2 / 18.4）。本体は R2、メタデータと世代番号は D1。
//
// 競合の扱い: クラウドに既にデータがあり、その revision がクライアントの baseRevision と違う場合は
// 上書きせず 409 を返す（新しい方を無条件に採用しない。どちらを残すかはクライアントがユーザーに選ばせる）。
// 同時に2台から保存された場合も、D1 の条件付き UPDATE（revision が一致したときだけ更新）で一方だけが成功する。
// R2 には revision ごとに別のキーで書き、直近 3 世代を残す。

import { metaOf, parseSave, SLOT_COUNT, stateChecksum, type SaveFile } from '@jiro/core';
import { audit } from '../audit';
import type { AuthedPlayer } from '../auth';
import type { Env } from '../env';
import { HttpError, json, rawJson, readJson } from '../http';
import { isInt, isObj, log } from '../util';

/** セーブ本文の上限 */
export const SAVE_BODY_LIMIT = 2 * 1024 * 1024;
/** R2 に残す世代数 */
export const KEEP_GENERATIONS = 3;

interface SlotRow {
  save_id: string;
  revision: number;
  checksum: string;
  r2_key: string;
  meta_json: string;
  updated_at: number;
}

export function parseSlot(v: unknown): number {
  const n = typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : v;
  if (!isInt(n) || n < 1 || n > SLOT_COUNT) throw new HttpError(400, 'invalid_slot', `スロット番号は1〜${SLOT_COUNT}です`);
  return n;
}

const slotPrefix = (playerId: string, slot: number) => `saves/${playerId}/${slot}/`;
const slotKey = (playerId: string, slot: number, revision: number) => `${slotPrefix(playerId, slot)}${revision}.json`;

async function getRow(env: Env, playerId: string, slot: number): Promise<SlotRow | null> {
  return env.DB.prepare('SELECT save_id, revision, checksum, r2_key, meta_json, updated_at FROM save_slots WHERE player_id = ? AND slot = ?')
    .bind(playerId, slot)
    .first<SlotRow>();
}

function cloudInfo(row: SlotRow) {
  let meta: unknown = null;
  try {
    meta = JSON.parse(row.meta_json);
  } catch {
    meta = null;
  }
  return { saveId: row.save_id, revision: row.revision, checksum: row.checksum, updatedAt: row.updated_at, meta };
}

function conflict(row: SlotRow): HttpError {
  return new HttpError(409, 'conflict', 'クラウドのセーブが別の端末で更新されています。どちらを残すか選んでください', { cloud: cloudInfo(row) });
}

/** POST /api/v1/save {slot, save, baseRevision} → {slot, revision, checksum, saveId, updatedAt} */
export async function uploadSave(req: Request, env: Env, ctx: ExecutionContext, player: AuthedPlayer): Promise<Response> {
  const body = await readJson(req, SAVE_BODY_LIMIT);
  if (!isObj(body)) throw new HttpError(400, 'bad_request', '本文の形式が不正です');
  const slot = parseSlot(body.slot);
  const base = body.baseRevision;
  if (base !== undefined && base !== null && (!isInt(base) || base < 0)) throw new HttpError(400, 'bad_request', 'baseRevision が不正です');
  const baseRevision = isInt(base) ? base : null;
  if (!isObj(body.save)) throw new HttpError(400, 'bad_request', 'save がありません');

  // core と同じ検証（形式・チェックサム・スキーマ）。破損データは保存しない
  const parsed = parseSave(JSON.stringify(body.save));
  if (!parsed.ok) throw new HttpError(422, 'invalid_save', `セーブデータが不正です: ${parsed.error}`);
  const save = parsed.save;
  // 移行した場合は内容が変わるのでチェックサムとメタデータを付け直す
  const sum = parsed.migrated ? stateChecksum(save.state) : save.checksum;

  const existing = await getRow(env, player.id, slot);
  if (existing) {
    // 同じ内容の再送（応答が届かずに再試行した場合など）は成功として扱う
    if (existing.checksum === sum && existing.save_id === save.saveId) {
      return json({ slot, revision: existing.revision, checksum: existing.checksum, saveId: existing.save_id, updatedAt: existing.updated_at, unchanged: true });
    }
    if (baseRevision === null || baseRevision !== existing.revision) {
      ctx.waitUntil(audit(env.DB, { kind: 'save_conflict', playerId: player.id, detail: { slot, base: baseRevision, cloud: existing.revision } }));
      throw conflict(existing);
    }
  }

  const revision = Math.max((existing?.revision ?? 0) + 1, isInt(save.revision) ? save.revision : 0);
  const now = Date.now();
  const file: SaveFile = { ...save, slot, revision, checksum: sum, meta: metaOf(save.state) };
  const key = slotKey(player.id, slot, revision);
  const metaJson = JSON.stringify(file.meta);

  // 1) D1 で世代番号を確保する（競合したらここで止まり、R2 には書かない）
  const claim = existing
    ? await env.DB.prepare(
        'UPDATE save_slots SET save_id = ?, revision = ?, checksum = ?, r2_key = ?, meta_json = ?, updated_at = ? WHERE player_id = ? AND slot = ? AND revision = ?',
      )
        .bind(file.saveId, revision, sum, key, metaJson, now, player.id, slot, existing.revision)
        .run()
    : await env.DB.prepare(
        'INSERT INTO save_slots (player_id, slot, save_id, revision, checksum, r2_key, meta_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id, slot) DO NOTHING',
      )
        .bind(player.id, slot, file.saveId, revision, sum, key, metaJson, now)
        .run();
  if (claim.meta.changes !== 1) {
    const latest = await getRow(env, player.id, slot);
    if (latest) throw conflict(latest);
    throw new HttpError(409, 'conflict', 'クラウドのセーブが同時に更新されました。もう一度お試しください');
  }

  // 2) R2 に本体を書く。失敗したら D1 を元に戻す
  try {
    await env.SAVES.put(key, JSON.stringify(file), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { checksum: sum, revision: String(revision) },
    });
  } catch (e) {
    log('error', 'save_r2_put_failed', { playerId: player.id, slot, error: String(e) });
    if (existing) {
      await env.DB.prepare(
        'UPDATE save_slots SET save_id = ?, revision = ?, checksum = ?, r2_key = ?, meta_json = ?, updated_at = ? WHERE player_id = ? AND slot = ? AND revision = ? AND r2_key = ?',
      )
        .bind(existing.save_id, existing.revision, existing.checksum, existing.r2_key, existing.meta_json, existing.updated_at, player.id, slot, revision, key)
        .run();
    } else {
      await env.DB.prepare('DELETE FROM save_slots WHERE player_id = ? AND slot = ? AND revision = ? AND r2_key = ?').bind(player.id, slot, revision, key).run();
    }
    throw new HttpError(503, 'storage_unavailable', 'セーブの保存に失敗しました。時間をおいて再度お試しください');
  }

  // 3) 古い世代を消す（直近 KEEP_GENERATIONS 世代を残す）
  await pruneGenerations(env, player.id, slot);
  ctx.waitUntil(audit(env.DB, { kind: 'save_upload', playerId: player.id, detail: { slot, revision, day: file.meta.day } }));
  return json({ slot, revision, checksum: sum, saveId: file.saveId, updatedAt: now });
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SAVES.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) keys.push(o.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

export async function pruneGenerations(env: Env, playerId: string, slot: number): Promise<void> {
  const prefix = slotPrefix(playerId, slot);
  const keys = await listKeys(env, prefix);
  const gens = keys
    .map((k) => ({ k, rev: Number(/^(\d+)\.json$/.exec(k.slice(prefix.length))?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.rev))
    .sort((a, b) => b.rev - a.rev);
  const drop = gens.slice(KEEP_GENERATIONS).map((x) => x.k);
  if (drop.length > 0) await env.SAVES.delete(drop);
}

/** GET /api/v1/save/:slot → {slot, revision, updatedAt, save} */
export async function downloadSave(env: Env, player: AuthedPlayer, slotRaw: string): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const row = await getRow(env, player.id, slot);
  if (!row) throw new HttpError(404, 'not_found', 'このスロットにクラウドセーブはありません');
  const obj = await env.SAVES.get(row.r2_key);
  if (!obj) {
    log('error', 'save_r2_missing', { playerId: player.id, slot, revision: row.revision });
    throw new HttpError(503, 'storage_unavailable', 'セーブ本体を読み込めませんでした。時間をおいて再度お試しください');
  }
  const text = await obj.text();
  // 保存時に検証済みの JSON をそのまま埋め込む（大きなセーブを解析し直さない）
  return rawJson(`{"slot":${slot},"revision":${row.revision},"updatedAt":${row.updated_at},"save":${text}}`);
}

/** DELETE /api/v1/save/:slot */
export async function deleteSave(env: Env, ctx: ExecutionContext, player: AuthedPlayer, slotRaw: string): Promise<Response> {
  const slot = parseSlot(slotRaw);
  const res = await env.DB.prepare('DELETE FROM save_slots WHERE player_id = ? AND slot = ?').bind(player.id, slot).run();
  const keys = await listKeys(env, slotPrefix(player.id, slot));
  if (keys.length > 0) await env.SAVES.delete(keys);
  if (res.meta.changes === 0 && keys.length === 0) throw new HttpError(404, 'not_found', 'このスロットにクラウドセーブはありません');
  ctx.waitUntil(audit(env.DB, { kind: 'save_delete', playerId: player.id, detail: { slot } }));
  return json({ ok: true, slot });
}
