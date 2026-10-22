// クライアントからのメッセージ（@jiro/core の net.ts の ClientMsg）の形式検証。
// core の applyAction も値を検証するが、サーバーではその手前で型・長さ・範囲を確認し、
// 想定外の形（巨大な文字列、オブジェクトの埋め込みなど）をシミュレーションに渡さない。

import { INGREDIENTS, type Action, type ActionType, type ClientMsg } from '@jiro/core';
import { isFiniteNum, isObj } from './util';

/** WebSocket メッセージの上限（hostInit 以外） */
export const MAX_MSG_BYTES = 8 * 1024;
/** hostInit（キャリアの状態全体）の上限 */
export const MAX_HOST_INIT_BYTES = 1024 * 1024;

export const ACTION_TYPES = [
  'move', 'interact', 'cancelWork', 'openShop', 'nextDay', 'orderStock', 'setAutoOrder', 'buyEquipment',
  'sellEquipment', 'repair', 'maintenance', 'place', 'store', 'buySeat', 'seatOffset', 'buyBowls', 'hire',
  'fire', 'setRole', 'setPriority', 'expand', 'setPrice', 'pauseMenu', 'takeLoan', 'payArrears', 'rename', 'giveUp',
] as const satisfies readonly ActionType[];

// core に操作が追加されたらここでコンパイルエラーになる（検証の追加漏れを防ぐ）
type MissingActionTypes = Exclude<ActionType, (typeof ACTION_TYPES)[number]>;
const actionTypesComplete: [MissingActionTypes] extends [never] ? true : MissingActionTypes = true;
void actionTypesComplete;

const ACTION_SET: ReadonlySet<string> = new Set(ACTION_TYPES);

/** レイアウト編集のロックが必要な操作（設計書 17.8） */
export const LAYOUT_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>(['place', 'store', 'seatOffset']);

const ID_RE = /^[A-Za-z0-9_.:#-]{1,64}$/;
const RID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** ID・キーとして使う文字列。Object.prototype の名前（__proto__, constructor, toString など）は拒否する */
const isId = (v: unknown): boolean => typeof v === 'string' && ID_RE.test(v) && !Object.prototype.hasOwnProperty.call(Object.prototype, v);
const isIngredient = (v: unknown): boolean => isId(v) && Object.prototype.hasOwnProperty.call(INGREDIENTS, v as string);
const isStr = (max: number) => (v: unknown): boolean => typeof v === 'string' && v.length <= max;
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const optBool = (v: unknown): boolean => v === undefined || typeof v === 'boolean';
const isNum = (v: unknown): boolean => isFiniteNum(v) && Math.abs(v) <= 1e9;
const isIntIn = (lo: number, hi: number) => (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const isRot = (v: unknown): boolean => v === 0 || v === 1 || v === 2 || v === 3;
const isSmall = (v: unknown): boolean => isFiniteNum(v) && Math.abs(v) <= 2;
const isVec = (v: unknown): boolean => isObj(v) && isSmall(v.x) && isSmall(v.z) && Object.keys(v).length === 2;
const optVec = (v: unknown): boolean => v === undefined || isVec(v);
const isRole = (v: unknown): boolean => v === 'cook' || v === 'server' || v === 'cleaner';
function isArgs(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (!isObj(v)) return false;
  const entries = Object.entries(v);
  if (entries.length > 8) return false;
  return entries.every(([k, x]) => isId(k) && k.length <= 32 && (isNum(x) || typeof x === 'boolean' || (typeof x === 'string' && x.length <= 64)));
}

type FieldRules = Record<string, (v: unknown) => boolean>;

const RULES: Record<ActionType, FieldRules> = {
  move: { x: isNum, z: isNum, yaw: isNum },
  interact: { targetId: isId, verb: isStr(32), args: isArgs },
  cancelWork: {},
  openShop: {},
  nextDay: {},
  orderStock: { itemId: isId, packs: isIntIn(1, 50), express: isBool },
  // core は itemId の存在を確かめずに autoOrder に書き込むため、ここで食材IDに限定する（状態の肥大化を防ぐ）
  setAutoOrder: { itemId: isIngredient, qty: isNum },
  buyEquipment: { equipType: isId, autoPlace: optBool },
  sellEquipment: { equipmentId: isId },
  repair: { equipmentId: isId },
  maintenance: { equipmentId: isId, on: isBool },
  place: { equipmentId: isId, gx: isIntIn(-1000, 1000), gz: isIntIn(-1000, 1000), rot: isRot, offset: optVec },
  store: { equipmentId: isId },
  buySeat: { seatIndex: isIntIn(0, 1000) },
  seatOffset: { seatIndex: isIntIn(0, 1000), x: isSmall, z: isSmall },
  buyBowls: {},
  hire: { candidateId: isId },
  fire: { employeeId: isId },
  setRole: { employeeId: isId, role: isRole },
  setPriority: { employeeId: isId, kind: isId, value: isNum },
  expand: {},
  setPrice: { menuId: isId, price: isNum },
  pauseMenu: { menuId: isId, paused: isBool },
  takeLoan: {},
  payArrears: {},
  rename: { name: isStr(40) },
  giveUp: {},
};

/** 操作要求の形を検証する。正しければ余計なキーを除いた Action を返す */
export function parseAction(v: unknown): Action | null {
  if (!isObj(v) || typeof v.type !== 'string' || !ACTION_SET.has(v.type)) return null;
  const rules = RULES[v.type as ActionType];
  const out: Record<string, unknown> = { type: v.type };
  for (const [k, ok] of Object.entries(rules)) {
    if (!ok(v[k])) return null;
    if (v[k] !== undefined) out[k] = v[k];
  }
  return out as unknown as Action;
}

export type ParsedMsg = ClientMsg;

/**
 * 受信メッセージを解釈・検証する。不正なら理由の文字列を返す。
 * @param raw 受信した文字列（安全な reviver で JSON.parse 済みの値）
 */
export function parseClientMsg(v: unknown): ParsedMsg | string {
  if (!isObj(v) || typeof v.t !== 'string') return 'メッセージの形式が不正です';
  switch (v.t) {
    case 'hello':
      if (typeof v.name !== 'string' || v.name.length > 64) return 'name が不正です';
      if (!isFiniteNum(v.protocol)) return 'protocol が不正です';
      if (typeof v.clientVersion !== 'string' || v.clientVersion.length > 32) return 'clientVersion が不正です';
      return { t: 'hello', name: v.name, protocol: v.protocol, clientVersion: v.clientVersion };
    case 'act': {
      if (typeof v.rid !== 'string' || !RID_RE.test(v.rid)) return 'rid が不正です';
      const a = parseAction(v.a);
      if (!a) return '操作の形式が不正です';
      const ver = isFiniteNum(v.v) ? v.v : 0;
      return { t: 'act', rid: v.rid, a, v: ver };
    }
    case 'ping':
      return { t: 'ping', ts: isFiniteNum(v.ts) ? v.ts : 0 };
    case 'hostInit':
      if (!isObj(v.state)) return 'state が不正です';
      return { t: 'hostInit', state: v.state as never };
    case 'resync':
      return { t: 'resync' };
    case 'save':
      if (typeof v.rid !== 'string' || !RID_RE.test(v.rid)) return 'rid が不正です';
      return { t: 'save', rid: v.rid };
    case 'layoutLock':
      if (typeof v.on !== 'boolean') return 'on が不正です';
      return { t: 'layoutLock', on: v.on };
    default:
      return '不明なメッセージです';
  }
}
