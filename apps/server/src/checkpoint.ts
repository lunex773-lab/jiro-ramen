// ルーム状態のチェックポイント（設計書 17.7 / 18.4）と、操作要求の重複検出（設計書 17.6）。
//
// チェックポイントは Durable Object の SQLite ストレージに、JSON を固定長の断片に分けて保存する。
// KV 型の put は 1 値あたり 128 KiB の上限があるため、状態が大きくなっても保存できるように断片化している。
// 重複検出用の requestId 一覧も同じチェックポイントに含める。こうすると
//   - 復元した状態に反映済みの操作 → requestId も復元されるので、再送されても二重適用しない
//   - 復元した状態に反映されていない操作 → requestId も無いので、再送されたら正しく適用される
// となり、状態と重複検出が常に一致する。

import { checksum, migrate, SCHEMA_VERSION, validateState, type ActionResult, type GameState } from '@jiro/core';
import { isObj, safeJsonParse } from './util';

// ───────────────────────── 重複検出（requestId → 結果） ─────────────────────────

/** プレイヤーごとに覚えておく requestId の数 */
export const RID_CACHE_SIZE = 200;
/** キャッシュする結果の data の上限（大きな data は捨てて ok/reason だけ残す） */
const MAX_CACHED_DATA = 512;

/** 挿入順で古いものから捨てる、上限つきの requestId キャッシュ */
export class RidCache {
  private map = new Map<string, ActionResult>();

  constructor(readonly limit = RID_CACHE_SIZE) {}

  get size(): number {
    return this.map.size;
  }

  get(rid: string): ActionResult | undefined {
    return this.map.get(rid);
  }

  set(rid: string, r: ActionResult): void {
    this.map.delete(rid);
    this.map.set(rid, compactResult(r));
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  entries(): [string, ActionResult][] {
    return [...this.map.entries()];
  }

  static from(entries: unknown, limit = RID_CACHE_SIZE): RidCache {
    const c = new RidCache(limit);
    if (Array.isArray(entries)) {
      for (const e of entries) {
        if (Array.isArray(e) && typeof e[0] === 'string' && isObj(e[1]) && typeof e[1].ok === 'boolean') c.set(e[0], e[1] as unknown as ActionResult);
      }
    }
    return c;
  }
}

function compactResult(r: ActionResult): ActionResult {
  if (r.data === undefined) return r;
  let size = 0;
  try {
    size = JSON.stringify(r.data)?.length ?? 0;
  } catch {
    size = Infinity;
  }
  if (size <= MAX_CACHED_DATA) return r;
  const { data: _drop, ...rest } = r;
  return rest;
}

// ───────────────────────── チェックポイント ─────────────────────────

export interface CheckpointData {
  v: 1;
  /** 配信済みの状態バージョン（パッチの seq） */
  seq: number;
  savedAt: number;
  state: GameState;
  /** プレイヤーID → [requestId, 結果][] */
  rids: Record<string, [string, ActionResult][]>;
}

/** 1断片の文字数。日本語は UTF-8 で 3 バイトになるので、最大でも約 192 KiB に収まる */
export const CHUNK_CHARS = 64 * 1024;

export interface EncodedCheckpoint {
  chunks: string[];
  /** 全体の JSON のチェックサム（破損検出用） */
  sum: string;
  length: number;
}

export function encodeCheckpoint(data: CheckpointData, chunkChars = CHUNK_CHARS): EncodedCheckpoint {
  const text = JSON.stringify(data);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));
  if (chunks.length === 0) chunks.push('');
  return { chunks, sum: checksum(text), length: text.length };
}

export type DecodeResult = { ok: true; data: CheckpointData } | { ok: false; error: string };

/** 断片を結合して検証する。壊れていたら推測で続行せずエラーを返す（設計書 17.7） */
export function decodeCheckpoint(chunks: string[], sum: string, length: number): DecodeResult {
  const text = chunks.join('');
  if (text.length !== length) return { ok: false, error: `長さが一致しません（${text.length} / ${length}）` };
  if (checksum(text) !== sum) return { ok: false, error: 'チェックサムが一致しません' };
  let raw: unknown;
  try {
    raw = safeJsonParse(text);
  } catch {
    return { ok: false, error: 'JSON として読めません' };
  }
  if (!isObj(raw) || raw.v !== 1 || typeof raw.seq !== 'number' || !isObj(raw.state)) return { ok: false, error: '形式が不正です' };
  let state = raw.state as Record<string, unknown>;
  try {
    if (state.schema !== SCHEMA_VERSION) state = migrate(state);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const errs = validateState(state);
  if (errs.length > 0) return { ok: false, error: `状態の検証に失敗: ${errs.slice(0, 3).join(', ')}` };
  const rids: Record<string, [string, ActionResult][]> = {};
  if (isObj(raw.rids)) {
    for (const [pid, list] of Object.entries(raw.rids)) rids[pid] = RidCache.from(list).entries();
  }
  return {
    ok: true,
    data: { v: 1, seq: raw.seq, savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0, state: state as unknown as GameState, rids },
  };
}
