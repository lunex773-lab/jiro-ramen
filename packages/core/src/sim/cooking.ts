// 調理と品質（設計書 6）。
// 完全な物理・化学シミュレーションではなく、ゲームとして納得できる因果関係で品質を決める。

import { BALANCE } from '../data/balance';
import { CALL_KEYS, CALLS, MENU, type MenuDef } from '../data/menu';
import type { Bowl, BowlContents, CallLevels, Order, ToppingKey } from '../types';
import { clamp01 } from '../util';

export function emptyContents(t: number): BowlContents {
  return {
    tare: 0,
    tareQuality: 1,
    soupL: 0,
    soupQuality: 0,
    soupTemp: 0,
    noodleG: 0,
    noodleQuality: 0,
    noodleBoilDelta: 0,
    toppings: { yasai: 0, ninniku: 0, abura: 0, ichimi: 0 },
    buta: 0,
    butaQuality: 0,
    freshness: 1,
    steps: [],
    startedAt: t,
    heat: 20,
    cost: 0,
    extras: {},
  };
}

/** ゆで加減の品質。理想から perfectWindow 以内なら 1、badWindow で 0.25、さらに離れると 0.1 */
export function noodleQualityFor(elapsed: number, ideal: number): number {
  const c = BALANCE.cooking;
  const delta = elapsed - ideal;
  const a = Math.abs(delta);
  if (a <= c.noodlePerfectWindow) return 1;
  // 硬めは柔らかすぎよりは許容される
  const window = delta < 0 ? c.noodleBadWindow * 0.8 : c.noodleBadWindow;
  const t = (a - c.noodlePerfectWindow) / (window - c.noodlePerfectWindow);
  if (t >= 1) return Math.max(0.1, 0.25 - (a - window) * 0.01);
  return 1 - 0.75 * t;
}

export function noodleDonenessLabel(elapsed: number, ideal: number): string {
  const d = elapsed - ideal;
  if (d < -BALANCE.cooking.noodleBadWindow * 0.8) return '生煮え';
  if (d < -BALANCE.cooking.noodlePerfectWindow) return '硬め';
  if (d <= BALANCE.cooking.noodlePerfectWindow) return 'ちょうど';
  if (d <= BALANCE.cooking.noodleBadWindow) return '柔らかめ';
  return 'ゆですぎ';
}

export function menuOf(id: string): MenuDef {
  const m = MENU[id];
  if (!m) throw new Error(`unknown menu ${id}`);
  return m;
}

export function soupPerBowl(menuId: string | null): number {
  const m = menuId ? MENU[menuId] : undefined;
  return m?.size === 'large' ? BALANCE.cooking.soupPerBowlLarge : BALANCE.cooking.soupPerBowlSmall;
}

/** トッピングの必要量（コールのレベル→食材量） */
export function toppingAmount(key: ToppingKey, level: number): { itemId: string; qty: number } {
  const c = BALANCE.cooking;
  switch (key) {
    case 'yasai':
      return { itemId: 'yasai', qty: level * c.yasaiPerLevel };
    case 'ninniku':
      return { itemId: 'garlic', qty: level * c.ninnikuPerLevel };
    case 'abura':
      return { itemId: 'abura', qty: level * c.aburaPerLevel };
    case 'ichimi':
      return { itemId: 'ichimi', qty: level * c.ichimiPerLevel };
  }
}

export interface QualityResult {
  quality: number;
  mistakes: string[];
  parts: { noodle: number; soup: number; buta: number; toppings: number; temp: number; freshness: number; process: number };
}

/** 提供時の温度補正 */
export function tempFactor(heat: number): number {
  if (heat >= 85) return 1;
  if (heat <= 55) return 0.45;
  return 0.45 + 0.55 * ((heat - 55) / 30);
}

/**
 * 丼の中身を注文と照合して品質とミスを判定する。
 * 品質 = 味（麺・スープ・豚・トッピング）× 温度 × 鮮度 − 工程の乱れ
 */
export function evaluateBowl(c: BowlContents, order: Pick<Order, 'menuId' | 'call'>): QualityResult {
  const menu = menuOf(order.menuId);
  const mistakes: string[] = [];

  // 麺
  let noodle = c.noodleQuality;
  if (c.noodleG <= 0) {
    mistakes.push('麺が入っていない');
    noodle = 0;
  } else if (Math.abs(c.noodleG - menu.noodleG) > 50) {
    mistakes.push(c.noodleG > menu.noodleG ? '麺の量が多い（大と小の取り違え）' : '麺の量が少ない（大と小の取り違え）');
    noodle *= 0.8;
  }

  // スープとタレ
  let soup = c.soupL > 0 ? c.soupQuality : 0;
  if (c.soupL <= 0) mistakes.push('スープが入っていない');
  if (c.tare <= 0) {
    mistakes.push('タレが入っていない');
    soup *= 0.3;
  } else {
    soup *= c.tareQuality;
    const wantTare = 1 + order.call.karame;
    if (c.tare !== wantTare) {
      mistakes.push(c.tare > wantTare ? 'しょっぱすぎる（カラメ違い）' : 'カラメが足りない');
      soup *= 0.85;
    }
  }

  // 豚
  let buta = c.buta > 0 ? c.butaQuality : 0;
  if (c.buta < menu.buta) {
    mistakes.push(`豚が足りない（${c.buta}/${menu.buta}枚）`);
    buta *= c.buta / Math.max(1, menu.buta);
  }

  // トッピング（コールとの一致）
  let toppings = 1;
  for (const k of CALL_KEYS) {
    if (k === 'karame') continue;
    const want = order.call[k];
    const got = c.toppings[k as ToppingKey];
    const diff = Math.abs(want - got);
    if (diff < 0.01) continue;
    if (k === 'ninniku' && want === 0 && got > 0) {
      mistakes.push('ニンニクを入れてしまった');
      toppings -= 0.4;
    } else if (want > 0 && got === 0) {
      mistakes.push(`${CALLS[k].name}が入っていない`);
      toppings -= 0.2;
    } else {
      mistakes.push(`${CALLS[k].name}の量が違う`);
      toppings -= 0.08 * diff;
    }
  }
  if (menu.extras?.egg && (c.extras.egg ?? 0) < menu.extras.egg) {
    mistakes.push('生卵が付いていない');
    toppings -= 0.15;
  }
  toppings = clamp01(toppings);

  // 工程の順序: タレ→スープ→麺→トッピング が基本
  let process = 0;
  const idx = (step: string) => c.steps.indexOf(step);
  if (idx('noodles') >= 0 && idx('soup') > idx('noodles')) process += 0.06; // 麺の後からスープ
  if (idx('noodles') >= 0 && idx('tare') > idx('noodles')) process += 0.06;
  if (idx('toppings') >= 0 && idx('noodles') > idx('toppings')) process += 0.1;

  const temp = tempFactor(c.heat);
  const fresh = 0.6 + 0.4 * c.freshness;
  const base = noodle * 0.36 + soup * 0.3 + buta * 0.14 + toppings * 0.2;
  const quality = clamp01(base * (0.4 + 0.6 * temp) * fresh - process);
  return { quality, mistakes, parts: { noodle, soup, buta, toppings, temp, freshness: fresh, process } };
}

/** 丼の温度を下げる */
export function coolBowl(b: Bowl, dt: number): void {
  if (!b.contents) return;
  const c = b.contents;
  const ambient = 22;
  if (c.heat > ambient) c.heat = Math.max(ambient, c.heat - BALANCE.cooking.heatLossPerSec * dt * (c.soupL > 0 ? 1 : 2));
}

export function callEquals(a: CallLevels, b: CallLevels): boolean {
  return CALL_KEYS.every((k) => Math.abs(a[k] - b[k]) < 0.01);
}

export function isBowlComplete(c: BowlContents | null): boolean {
  return !!c && c.tare > 0 && c.soupL > 0 && c.noodleG > 0 && c.steps.includes('toppings');
}

export function bowlStageLabel(c: BowlContents | null): string {
  if (!c || c.steps.length === 0) return '空';
  if (isBowlComplete(c)) return '完成';
  const has = (s: string) => c.steps.includes(s);
  const parts: string[] = [];
  if (has('tare')) parts.push('タレ');
  if (has('soup')) parts.push('スープ');
  if (has('noodles')) parts.push('麺');
  if (has('toppings')) parts.push('トッピング');
  return parts.join('・');
}
