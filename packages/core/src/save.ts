// セーブデータ（設計書 16）: 3スロット、バージョン管理、スキーマ検証、チェックサム、世代バックアップ。
// 保存先はインターフェース（SaveStore）で抽象化し、ブラウザでは localStorage、テストではメモリを使う。

import { EQUIPMENT } from './data/equipment';
import { INGREDIENTS } from './data/ingredients';
import { MENU } from './data/menu';
import { STAGES } from './data/stages';
import { SCHEMA_VERSION } from './state';
import { removePlayer } from './sim/actions';
import { makeCtx } from './sim/notices';
import type { GameState } from './types';

export const SLOT_COUNT = 3;
export const SAVE_FORMAT = 'jiro-ramen-save';

export interface SaveMeta {
  shopName: string;
  day: number;
  money: number;
  reputation: number;
  stage: number;
  phase: GameState['phase'];
  bankrupt: boolean;
  totalServed: number;
}

export interface SaveFile {
  format: typeof SAVE_FORMAT;
  schema: number;
  saveId: string;
  slot: number;
  /** 保存の世代番号（上書きのたびに +1。クラウドセーブの競合検出に使う） */
  revision: number;
  createdAt: number;
  updatedAt: number;
  meta: SaveMeta;
  checksum: string;
  state: GameState;
}

/** キー順に依存しない正規化JSON（チェックサム・同期の照合用） */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** FNV-1a 64bit 相当（32bit×2）の16進文字列。暗号用途ではなく破損検出用 */
export function checksum(text: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function stateChecksum(s: GameState): string {
  return checksum(canonicalJson(s));
}

export function metaOf(s: GameState): SaveMeta {
  return {
    shopName: s.shopName,
    day: s.day,
    money: s.money,
    reputation: Math.round(s.reputation * 100) / 100,
    stage: s.career.stage,
    phase: s.phase,
    bankrupt: s.bankruptcy !== null,
    totalServed: s.career.totalServed,
  };
}

// ───────────────────────── スキーマ検証 ─────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isArr = Array.isArray;

/** 読み込み時の検証。問題があれば理由を返す */
export function validateState(s: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(s)) return ['状態がオブジェクトではありません'];
  const need = (cond: boolean, msg: string) => {
    if (!cond) errs.push(msg);
  };
  need(isNum(s.schema), 'schema');
  need(isNum(s.day) && (s.day as number) >= 1, 'day');
  need(isNum(s.money), 'money');
  need(isNum(s.t) && isNum(s.openT), 't');
  need(isStr(s.phase) && ['prep', 'open', 'closing', 'closed', 'bankrupt'].includes(s.phase as string), 'phase');
  need(isNum(s.reputation) && (s.reputation as number) >= 1 && (s.reputation as number) <= 5, 'reputation');
  need(isNum(s.nextId) && isNum(s.rng), 'ids');
  for (const k of ['arrears', 'loans', 'transactions', 'history', 'inventory', 'deliveries', 'equipment', 'seats', 'bowls', 'dirt', 'lostItems', 'players', 'employees', 'candidates', 'customers', 'orders', 'queue', 'insideQueue', 'reviews', 'todayReviews', 'regulars', 'notices', 'pausedMenu']) {
    need(isArr(s[k]), `${k} が配列ではありません`);
  }
  if (errs.length > 0) return errs;
  const career = s.career;
  need(isObj(career) && isNum(career.stage) && STAGES[career.stage as number] !== undefined, 'career.stage');
  need(isObj(s.today) && isObj(s.prices) && isObj(s.autoOrder), 'today/prices');
  for (const e of s.equipment as unknown[]) {
    if (!isObj(e) || !isStr(e.type) || !EQUIPMENT[e.type] || !isNum(e.gx) || !isNum(e.gz) || !isNum(e.condition)) {
      errs.push('設備データが壊れています');
      break;
    }
  }
  for (const l of s.inventory as unknown[]) {
    if (!isObj(l) || !isStr(l.itemId) || !INGREDIENTS[l.itemId] || !isNum(l.qty) || (l.qty as number) < 0) {
      errs.push('在庫データが壊れています');
      break;
    }
  }
  for (const id of Object.keys(s.prices as object)) {
    if (!MENU[id]) {
      errs.push(`不明なメニュー ${id}`);
      break;
    }
  }
  for (const b of s.bowls as unknown[]) {
    if (!isObj(b) || !isStr(b.id) || !isObj(b.loc)) {
      errs.push('丼データが壊れています');
      break;
    }
  }
  return errs;
}

// ───────────────────────── 移行 ─────────────────────────

/** 古いスキーマから現在のスキーマへの移行関数（from → from+1） */
export const MIGRATIONS: Record<number, (s: Record<string, unknown>) => Record<string, unknown>> = {
  // 例: 0 → 1（初期の開発版で career.daysPlayed がなかったデータ）
  0: (s) => {
    const career = (s.career ?? {}) as Record<string, unknown>;
    if (career.daysPlayed === undefined) career.daysPlayed = 0;
    s.career = career;
    s.schema = 1;
    return s;
  },
};

export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let s = raw;
  let v = isNum(s.schema) ? (s.schema as number) : 0;
  while (v < SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`schema ${v} からの移行手順がありません`);
    s = m(s);
    v = s.schema as number;
  }
  if (v > SCHEMA_VERSION) throw new Error('新しいバージョンのゲームで保存されたデータです');
  return s;
}

// ───────────────────────── 直列化 ─────────────────────────

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** 保存前の整合性チェック（重要データの妥当性） */
export function preSaveCheck(s: GameState): string[] {
  const errs = validateState(s);
  if (s.inventory.some((l) => l.qty < 0)) errs.push('在庫が負になっています');
  if (!Number.isFinite(s.money)) errs.push('資金が不正です');
  const ids = new Set<string>();
  for (const b of s.bowls) {
    if (ids.has(b.id)) errs.push('丼IDが重複しています');
    ids.add(b.id);
  }
  return errs;
}

export function makeSaveFile(s: GameState, slot: number, prev: SaveFile | null, now: number): SaveFile {
  const state = JSON.parse(JSON.stringify(s)) as GameState;
  // 共同経営のゲストはホストのキャリアに残さない（ゲストが持っていた物は安全な場所へ戻す）
  const hostIds = state.players.filter((p) => p.isHost).map((p) => p.id);
  const keep = hostIds.length > 0 ? hostIds : state.players.slice(0, 1).map((p) => p.id);
  const ctx = makeCtx();
  for (const p of [...state.players]) if (!keep.includes(p.id)) removePlayer(state, p.id, ctx);
  // 接続状態などの一時的な情報はセーブに残さない
  for (const p of state.players) {
    p.connected = false;
    p.lastMoveAt = 0;
  }
  return {
    format: SAVE_FORMAT,
    schema: SCHEMA_VERSION,
    saveId: prev?.saveId ?? randomId(),
    slot,
    revision: (prev?.revision ?? 0) + 1,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    meta: metaOf(state),
    checksum: stateChecksum(state),
    state,
  };
}

export type ParseResult = { ok: true; save: SaveFile; migrated: boolean } | { ok: false; error: string };

export function parseSave(text: string | null | undefined): ParseResult {
  if (!text) return { ok: false, error: 'データがありません' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'JSONとして読み込めません（破損）' };
  }
  if (!isObj(raw) || raw.format !== SAVE_FORMAT || !isObj(raw.state)) return { ok: false, error: 'セーブデータの形式ではありません' };
  const file = raw as unknown as SaveFile;
  if (stateChecksum(file.state) !== file.checksum) return { ok: false, error: 'チェックサムが一致しません（破損）' };
  let migrated = false;
  let state = file.state as unknown as Record<string, unknown>;
  try {
    if (file.schema !== SCHEMA_VERSION || state.schema !== SCHEMA_VERSION) {
      state = migrate(state);
      migrated = true;
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const errs = validateState(state);
  if (errs.length > 0) return { ok: false, error: `検証エラー: ${errs.slice(0, 3).join(', ')}` };
  return { ok: true, save: { ...file, schema: SCHEMA_VERSION, state: state as unknown as GameState }, migrated };
}

// ───────────────────────── スロット管理 ─────────────────────────

export interface SaveStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export class MemoryStore implements SaveStore {
  data = new Map<string, string>();
  get(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.data.set(key, value);
  }
  remove(key: string): void {
    this.data.delete(key);
  }
}

const PREFIX = 'jiro.save.';
export const slotKey = (slot: number) => `${PREFIX}slot${slot}`;
const bakKey = (slot: number) => `${PREFIX}slot${slot}.bak`;
const tmpKey = (slot: number) => `${PREFIX}slot${slot}.tmp`;

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) throw new Error(`スロット番号が不正です: ${slot}`);
}

export type SaveResult = { ok: true; file: SaveFile } | { ok: false; error: string };

/**
 * スロットに保存する。
 * 1) 一時キーに書く 2) 読み戻して検証 3) 現在のデータをバックアップへ 4) 本体を置き換え 5) 一時キーを消す
 * 途中で中断しても、本体かバックアップのどちらかは有効なデータが残る。
 */
export function saveToSlot(store: SaveStore, slot: number, s: GameState, now = Date.now()): SaveResult {
  checkSlot(slot);
  const errs = preSaveCheck(s);
  if (errs.length > 0) return { ok: false, error: `保存前チェックに失敗: ${errs[0]}` };
  const prevParsed = parseSave(store.get(slotKey(slot)));
  const prev = prevParsed.ok ? prevParsed.save : null;
  const file = makeSaveFile(s, slot, prev, now);
  const text = JSON.stringify(file);
  try {
    store.set(tmpKey(slot), text);
    const verify = parseSave(store.get(tmpKey(slot)));
    if (!verify.ok) return { ok: false, error: `書き込み検証に失敗: ${verify.error}` };
    const cur = store.get(slotKey(slot));
    if (cur && prev) store.set(bakKey(slot), cur);
    store.set(slotKey(slot), text);
    store.remove(tmpKey(slot));
  } catch (e) {
    return { ok: false, error: `保存できませんでした（容量不足の可能性）: ${(e as Error).message}` };
  }
  return { ok: true, file };
}

export type LoadResult =
  | { ok: true; file: SaveFile; fromBackup: boolean; migrated: boolean }
  | { ok: false; error: string; empty: boolean };

/** 読み込む。本体が壊れていればバックアップから復旧する */
export function loadFromSlot(store: SaveStore, slot: number): LoadResult {
  checkSlot(slot);
  const main = store.get(slotKey(slot));
  const tmp = store.get(tmpKey(slot));
  const bak = store.get(bakKey(slot));
  if (!main && !bak && !tmp) return { ok: false, error: '空きスロットです', empty: true };
  const m = parseSave(main);
  if (m.ok) return { ok: true, file: m.save, fromBackup: false, migrated: m.migrated };
  // 本体の置き換え中に中断した場合は一時データが有効なことがある
  const t = parseSave(tmp);
  if (t.ok) return { ok: true, file: t.save, fromBackup: true, migrated: t.migrated };
  const b = parseSave(bak);
  if (b.ok) return { ok: true, file: b.save, fromBackup: true, migrated: b.migrated };
  return { ok: false, error: `データが破損しています（${m.ok ? '' : m.error}）。バックアップもありません`, empty: false };
}

export interface SlotInfo {
  slot: number;
  empty: boolean;
  corrupted: boolean;
  meta: SaveMeta | null;
  updatedAt: number | null;
  error?: string;
}

export function listSlots(store: SaveStore): SlotInfo[] {
  const out: SlotInfo[] = [];
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    const r = loadFromSlot(store, slot);
    if (r.ok) out.push({ slot, empty: false, corrupted: false, meta: r.file.meta, updatedAt: r.file.updatedAt });
    else out.push({ slot, empty: r.empty, corrupted: !r.empty, meta: null, updatedAt: null, error: r.empty ? undefined : r.error });
  }
  return out;
}

export function deleteSlot(store: SaveStore, slot: number): void {
  checkSlot(slot);
  store.remove(slotKey(slot));
  store.remove(bakKey(slot));
  store.remove(tmpKey(slot));
}

/**
 * クラウドとローカルの競合判定（設計書 16.2）。
 * 新しい方を無条件に採用せず、同じ saveId で revision が一致しないときはユーザーに選ばせる。
 */
export type ConflictKind = 'same' | 'localNewer' | 'cloudNewer' | 'diverged' | 'differentCareer';

export function compareSaves(local: SaveFile, cloud: SaveFile, cloudBaseRevision: number | null): ConflictKind {
  if (local.saveId !== cloud.saveId) return 'differentCareer';
  if (local.checksum === cloud.checksum) return 'same';
  // ローカルがクラウドの最新を元に進んでいる
  if (cloudBaseRevision !== null && cloudBaseRevision === cloud.revision && local.revision > cloud.revision) return 'localNewer';
  if (cloudBaseRevision !== null && cloudBaseRevision === local.revision && cloud.revision > local.revision) return 'cloudNewer';
  return 'diverged';
}
