// メニューとコールの定義（設計書 6.2）。メニュー追加はこの表の追加だけで済むようにする。

import type { CallKey, CallLevels } from '../types';

export interface MenuDef {
  id: string;
  name: string;
  /** 食券に印字する略称 */
  short: string;
  size: 'small' | 'large';
  noodleG: number;
  buta: number;
  defaultPrice: number;
  /** 追加トッピング（生卵など） */
  extras?: { egg?: number };
  unlock?: string;
  /** 食べ終えるまでの時間倍率 */
  eatFactor: number;
}

export const MENU: Record<string, MenuDef> = {
  small: { id: 'small', name: 'ラーメン（小）', short: '小', size: 'small', noodleG: 300, buta: 2, defaultPrice: 950, eatFactor: 1.0 },
  small_buta: { id: 'small_buta', name: '小豚ラーメン', short: '小豚', size: 'small', noodleG: 300, buta: 5, defaultPrice: 1_150, eatFactor: 1.15 },
  small_buta_w: { id: 'small_buta_w', name: '小豚ダブル', short: '小W', size: 'small', noodleG: 300, buta: 8, defaultPrice: 1_350, eatFactor: 1.3, unlock: 'menu_double' },
  large: { id: 'large', name: 'ラーメン（大）', short: '大', size: 'large', noodleG: 450, buta: 2, defaultPrice: 1_050, eatFactor: 1.35, unlock: 'menu_large' },
  large_buta: { id: 'large_buta', name: '大豚ラーメン', short: '大豚', size: 'large', noodleG: 450, buta: 5, defaultPrice: 1_250, eatFactor: 1.5, unlock: 'menu_large' },
  large_buta_w: { id: 'large_buta_w', name: '大豚ダブル', short: '大W', size: 'large', noodleG: 450, buta: 8, defaultPrice: 1_450, eatFactor: 1.65, unlock: 'menu_double' },
  small_egg: { id: 'small_egg', name: '小ラーメン＋生卵', short: '小卵', size: 'small', noodleG: 300, buta: 2, defaultPrice: 1_050, eatFactor: 1.05, extras: { egg: 1 }, unlock: 'menu_egg' },
};

export const MENU_IDS = Object.keys(MENU);

export interface CallDef {
  key: CallKey;
  name: string;
  /** レベルごとの呼び名 */
  levels: { value: number; label: string }[];
  /** 客が言う時の呼び方（例: ヤサイマシ） */
  spoken: (v: number) => string;
}

export const CALLS: Record<CallKey, CallDef> = {
  yasai: {
    key: 'yasai',
    name: 'ヤサイ',
    levels: [
      { value: 0, label: '抜き' },
      { value: 0.5, label: '少なめ' },
      { value: 1, label: '普通' },
      { value: 2, label: 'マシ' },
      { value: 3, label: 'マシマシ' },
    ],
    spoken: (v) => (v === 0 ? 'ヤサイ抜き' : v === 0.5 ? 'ヤサイ少なめ' : v === 1 ? '' : v === 2 ? 'ヤサイマシ' : 'ヤサイマシマシ'),
  },
  ninniku: {
    key: 'ninniku',
    name: 'ニンニク',
    levels: [
      { value: 0, label: 'なし' },
      { value: 0.5, label: '少し' },
      { value: 1, label: '普通' },
      { value: 2, label: 'マシ' },
      { value: 3, label: 'マシマシ' },
    ],
    spoken: (v) => (v === 0 ? '' : v === 0.5 ? 'ニンニク少し' : v === 1 ? 'ニンニク' : v === 2 ? 'ニンニクマシ' : 'ニンニクマシマシ'),
  },
  abura: {
    key: 'abura',
    name: 'アブラ',
    levels: [
      { value: 0, label: 'なし' },
      { value: 1, label: '普通' },
      { value: 2, label: 'マシ' },
      { value: 3, label: 'マシマシ' },
    ],
    spoken: (v) => (v === 0 ? '' : v === 1 ? 'アブラ' : v === 2 ? 'アブラマシ' : 'アブラマシマシ'),
  },
  karame: {
    key: 'karame',
    name: 'カラメ',
    levels: [
      { value: 0, label: '普通' },
      { value: 1, label: 'カラメ' },
      { value: 2, label: 'カラカラ' },
    ],
    spoken: (v) => (v === 0 ? '' : v === 1 ? 'カラメ' : 'カラカラ'),
  },
  ichimi: {
    key: 'ichimi',
    name: '唐辛子',
    levels: [
      { value: 0, label: 'なし' },
      { value: 1, label: '普通' },
      { value: 2, label: 'マシ' },
      { value: 3, label: 'マシマシ' },
    ],
    spoken: (v) => (v === 0 ? '' : v === 1 ? '唐辛子' : v === 2 ? '唐辛子マシ' : '唐辛子マシマシ'),
  },
};

export const CALL_KEYS: CallKey[] = ['yasai', 'ninniku', 'abura', 'karame', 'ichimi'];

/** 「そのままで」= 何も足さない標準 */
export const DEFAULT_CALL: CallLevels = { yasai: 1, ninniku: 0, abura: 0, karame: 0, ichimi: 0 };

export function callToSpoken(call: CallLevels): string {
  const parts = CALL_KEYS.map((k) => CALLS[k].spoken(call[k])).filter((s) => s.length > 0);
  return parts.length === 0 ? 'そのままで' : parts.join('、');
}

export function callToShort(call: CallLevels): string {
  const parts: string[] = [];
  for (const k of CALL_KEYS) {
    const v = call[k];
    const def = CALLS[k];
    const base = k === 'yasai' ? 1 : 0;
    if (v === base) continue;
    const lv = def.levels.find((l) => l.value === v);
    parts.push(k === 'karame' ? (lv?.label ?? '') : `${def.name}${lv?.label ?? ''}`);
  }
  return parts.length === 0 ? '標準' : parts.join(' ');
}
