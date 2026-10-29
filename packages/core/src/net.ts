// 共同経営の通信プロトコル（設計書 17.5, 17.6）。
// サーバー（Durable Object）が確定した状態を、差分（パッチ）として各クライアントへ配信する。
// 差分は状態バージョン（seq）付きで、抜けがあればクライアントは全体を要求し直す。

import type { Action, ActionResult } from './sim/actions';
import type { GameEvent, GameState, Vec2 } from './types';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS = 4;

// ───────────────────────── メッセージ ─────────────────────────

export type ClientMsg =
  | { t: 'hello'; name: string; protocol: number; clientVersion: string }
  /** 操作要求。rid は再送しても同じ（重複適用を防ぐ）、v はクライアントが観測した状態バージョン */
  | { t: 'act'; rid: string; a: Action; v: number }
  | { t: 'ping'; ts: number }
  /** ホストが自分のキャリアを持ち込む */
  | { t: 'hostInit'; state: GameState }
  /** 全体の再送を要求（パッチの抜け・不一致を検出したとき） */
  | { t: 'resync' }
  /** ホストが保存を要求 */
  | { t: 'save'; rid: string }
  /** レイアウト編集の排他（同時に一人だけ） */
  | { t: 'layoutLock'; on: boolean };

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
  isHost: boolean;
}

export type ServerMsg =
  | { t: 'welcome'; playerId: string; roomId: string; isHost: boolean; protocol: number; needInit: boolean }
  | { t: 'full'; seq: number; state: GameState }
  | { t: 'patch'; from: number; to: number; ops: PatchOp[]; ev: GameEvent[]; h?: string }
  | { t: 'res'; rid: string; r: ActionResult }
  | { t: 'pong'; ts: number; serverTime: number }
  | { t: 'peers'; list: PeerInfo[] }
  | { t: 'paused'; reason: string }
  | { t: 'resumed' }
  | { t: 'saved'; rid: string; ok: boolean; error?: string; state?: GameState; checksum?: string }
  | { t: 'layoutLock'; holder: string | null }
  | { t: 'error'; code: string; message: string };

// ───────────────────────── 差分 ─────────────────────────

/** パスの要素: オブジェクトのキー、配列の添字、または '#<id>'（id を持つ要素の配列内参照） */
export type PathSeg = string | number;

export type PatchOp =
  /** 値を設定 */
  | { o: 's'; p: PathSeg[]; v: unknown }
  /** キーを削除 */
  | { o: 'd'; p: PathSeg[] }
  /** id付き配列の並び替え・追加・削除。ins は新しく入る要素 */
  | { o: 'a'; p: PathSeg[]; ids: string[]; ins: Record<string, unknown> }
  /** 配列の一部を置き換える（ログ型の配列の「先頭を削って末尾に追加」用） */
  | { o: 'sp'; p: PathSeg[]; i: number; del: number; ins: unknown[] };

type J = unknown;

const isObj = (v: J): v is Record<string, J> => typeof v === 'object' && v !== null && !Array.isArray(v);

function keyedArray(a: J[]): boolean {
  return a.length > 0 && a.every((x) => isObj(x) && typeof x.id === 'string');
}

function eqPrim(a: J, b: J): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** a → b の差分を作る */
export function diff(a: J, b: J, path: PathSeg[] = [], out: PatchOp[] = []): PatchOp[] {
  if (eqPrim(a, b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const keyed = (keyedArray(a) || a.length === 0) && (keyedArray(b) || b.length === 0) && (a.length > 0 || b.length > 0);
    if (keyed) {
      const aIds = a.map((x) => (x as { id: string }).id);
      const bIds = b.map((x) => (x as { id: string }).id);
      const aMap = new Map(a.map((x) => [(x as { id: string }).id, x]));
      const sameOrder = aIds.length === bIds.length && aIds.every((id, i) => id === bIds[i]);
      // 先頭から k 個を削り、末尾に追加しただけか（取引履歴・通知などログ型の配列）
      let k = bIds.length > 0 ? aIds.indexOf(bIds[0]!) : aIds.length;
      if (k < 0) k = -1;
      const kept = k >= 0 ? aIds.length - k : 0;
      const isLog = !sameOrder && k >= 0 && kept <= bIds.length && aIds.slice(k).every((id, i) => id === bIds[i]);
      if (isLog) {
        if (k > 0) out.push({ o: 'sp', p: path, i: 0, del: k, ins: [] });
        if (bIds.length > kept) out.push({ o: 'sp', p: path, i: kept, del: 0, ins: clone(b.slice(kept)) });
      } else if (!sameOrder) {
        const ins: Record<string, unknown> = {};
        for (const x of b) {
          const id = (x as { id: string }).id;
          if (!aMap.has(id)) ins[id] = clone(x);
        }
        out.push({ o: 'a', p: path, ids: bIds, ins });
      }
      for (const x of b) {
        const id = (x as { id: string }).id;
        const old = aMap.get(id);
        if (old !== undefined) diff(old, x, [...path, `#${id}`], out);
      }
      return out;
    }
    if (a.length !== b.length) {
      out.push({ o: 's', p: path, v: clone(b) });
      return out;
    }
    for (let i = 0; i < b.length; i++) diff(a[i], b[i], [...path, i], out);
    return out;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of Object.keys(a)) {
      if (!(k in b) || b[k] === undefined) {
        if (a[k] !== undefined) out.push({ o: 'd', p: [...path, k] });
      }
    }
    for (const k of Object.keys(b)) {
      if (b[k] === undefined) continue;
      if (!(k in a)) out.push({ o: 's', p: [...path, k], v: clone(b[k]) });
      else diff(a[k], b[k], [...path, k], out);
    }
    return out;
  }
  out.push({ o: 's', p: path, v: clone(b) });
  return out;
}

function resolveSeg(container: J, seg: PathSeg): PathSeg {
  if (Array.isArray(container) && typeof seg === 'string' && seg.startsWith('#')) {
    const id = seg.slice(1);
    const i = container.findIndex((x) => isObj(x) && x.id === id);
    if (i < 0) throw new Error(`patch: id ${id} not found`);
    return i;
  }
  return seg;
}

/** 差分を適用する（root は書き換えられる）。新しい root を返す */
export function applyPatch<T>(root: T, ops: PatchOp[]): T {
  let r: J = root;
  for (const op of ops) {
    if (op.p.length === 0) {
      if (op.o === 's') r = clone(op.v);
      else if (op.o === 'a' && Array.isArray(r)) r = reorder(r, op.ids, op.ins);
      else if (op.o === 'sp' && Array.isArray(r)) r.splice(op.i, op.del, ...clone(op.ins));
      continue;
    }
    let cur: J = r;
    for (let i = 0; i < op.p.length - 1; i++) {
      const seg = resolveSeg(cur, op.p[i]!);
      cur = (cur as Record<string | number, J>)[seg as string];
      if (cur === undefined || cur === null) throw new Error(`patch: bad path ${op.p.join('.')}`);
    }
    const last = resolveSeg(cur, op.p[op.p.length - 1]!);
    const holder = cur as Record<string | number, J>;
    if (op.o === 's') holder[last as string] = clone(op.v);
    else if (op.o === 'd') delete holder[last as string];
    else if (op.o === 'a') {
      const arr = holder[last as string];
      if (!Array.isArray(arr)) throw new Error('patch: not an array');
      holder[last as string] = reorder(arr, op.ids, op.ins);
    } else if (op.o === 'sp') {
      const arr = holder[last as string];
      if (!Array.isArray(arr)) throw new Error('patch: not an array');
      arr.splice(op.i, op.del, ...clone(op.ins));
    }
  }
  return r as T;
}

function reorder(arr: J[], ids: string[], ins: Record<string, unknown>): J[] {
  const map = new Map(arr.filter(isObj).map((x) => [x.id as string, x]));
  return ids.map((id) => {
    if (id in ins) return clone(ins[id]);
    const v = map.get(id);
    if (v === undefined) throw new Error(`patch: missing element ${id}`);
    return v;
  });
}

// ───────────────────────── 配信する状態 ─────────────────────────

/**
 * 共同経営で配信する状態。仕込み開始時点の控え（prepSnapshot）は含めない
 * （クライアントは使わず、復元はサーバーの中だけで行う。控えを配ると毎日1回、状態の全体に近い量を全員に送ることになる）
 */
export function syncView(s: GameState): GameState {
  if (s.prepSnapshot === undefined) return s;
  const { prepSnapshot: _snapshot, ...rest } = s;
  return rest as GameState;
}

// ───────────────────────── 補間（表示用） ─────────────────────────

/** 他プレイヤーの表示位置を補間する */
export function lerpPos(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

export function isClientMsg(v: unknown): v is ClientMsg {
  return isObj(v) && typeof v.t === 'string';
}
