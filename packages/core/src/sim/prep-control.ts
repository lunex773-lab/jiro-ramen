// 仕込みの調整（オーナーの指示 2026-11-12「仕込みの調整機能」）:
//   ① 仕込むときに量を選べる（レシピの scales の倍率。材料・出来上がり・時間が変わる）
//   ② 仕込み専用の画面（client。ここは数字を出す関数）
//   ③ 開店前の仕込みの計画（その日の開店までに、品ごとにこの量まで仕込む。店員が計画の量まで仕込み、進み具合が見える）
//   ④ 時間帯・曜日で仕込みの量を変える（仕込みの目安に掛ける倍率）
import { INGREDIENTS } from '../data/ingredients';
import { PREP_RECIPES, type PrepRecipe } from '../data/prep';
import type { Equipment, GameState } from '../types';
import { SEC_PER_MIN } from './hours';
import { weekdayOf } from './staff';
import { forecastDay, stockOf } from './inventory';
import { prepHave, prepPerBowl, prepTargetItems } from './employees';
import { isUnlocked } from './equipment';

/** 選べる倍率（レシピにないときは 1 だけ） */
export function prepScales(r: PrepRecipe): number[] {
  return r.scales && r.scales.length > 0 ? r.scales : [1];
}

/** 倍率を確かめる（レシピにない倍率は 1） */
export function prepMult(r: PrepRecipe, mult: unknown): number {
  const m = typeof mult === 'number' && Number.isFinite(mult) ? mult : 1;
  return prepScales(r).some((x) => Math.abs(x - m) < 1e-9) ? m : 1;
}

/** 倍率を掛けた材料 */
export function prepInputs(r: PrepRecipe, mult = 1): { itemId: string; qty: number }[] {
  return r.inputs.map((i) => ({ itemId: i.itemId, qty: Math.round(i.qty * mult * 1000) / 1000 }));
}

/** 倍率を掛けた時間（人が付きっきりの作業は量に比例、鍋などの工程は量が倍でも 1.5 倍の時間） */
export function prepTime(r: PrepRecipe, mult = 1): number {
  return r.kind === 'hold' ? r.time * mult : r.time * (0.5 + 0.5 * mult);
}

/** その倍率で作る量の短い文（「豚 4本」「スープ 9L」「ヤサイ 2,500g」） */
export function prepAmountText(r: PrepRecipe, mult = 1): string {
  if (r.soupL) return `スープ ${r.soupL * mult}L`;
  const o = r.outputs[0];
  if (!o) return '';
  const d = INGREDIENTS[o.itemId];
  return `${(d?.name ?? o.itemId).replace(/（.*）/, '')} ${Math.round(o.qty * mult).toLocaleString('ja-JP')}${d?.unit ?? ''}`;
}

/** 材料が足りて、寸胴に入る、いちばん大きい倍率（なければ null） */
export function maxPossibleMult(s: GameState, r: PrepRecipe, e: Equipment | null, capacity = Infinity): number | null {
  const ok = prepScales(r).filter((m) => prepInputs(r, m).every((i) => stockOf(s, i.itemId) >= i.qty - 1e-9) && (!r.soupL || !e || e.soupL + r.soupL * m <= capacity + 1e-6));
  return ok.length > 0 ? Math.max(...ok) : null;
}

/**
 * 店員が仕込むときの倍率: 足りない分（できた品の量）をまかなえるいちばん小さい倍率。材料・寸胴の空きで足りなければ、できるいちばん大きい倍率
 */
export function staffPrepMult(s: GameState, r: PrepRecipe, deficit: number, e: Equipment | null, capacity = Infinity): number {
  const max = maxPossibleMult(s, r, e, capacity);
  if (max === null) return 1;
  const out = r.soupL ?? r.outputs[0]?.qty ?? 0;
  const perUnit = r.id === 'braise_pork' ? out * (PREP_RECIPES.slice_pork?.outputs[0]?.qty ?? 18) : out;
  // ふだんはレシピの量（1）以上で、足りない分をまかなえるいちばん小さい倍率（今までの量より少なくは作らない）。
  // 材料が足りないときだけ、できる量（1より小さい倍率）で作る
  const fit = prepScales(r).filter((m) => m <= max + 1e-9).sort((a, b) => a - b);
  const big = fit.filter((m) => m >= 1);
  for (const m of big) if (perUnit * m >= deficit) return m;
  return big.length > 0 ? big[big.length - 1]! : (fit[fit.length - 1] ?? 1);
}

// ───────────────── ④ 時間帯・曜日 ─────────────────

export const PREP_SCHEDULE_CHOICES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** 今の時間帯・曜日の倍率（仕込みの時間は開店から1時間目の倍率） */
export function prepScheduleMult(s: GameState): number {
  const sc = s.prepSchedule;
  if (!sc) return 1;
  const wd = sc.weekday?.[weekdayOf(s.day)] ?? 1;
  const hour = s.phase === 'open' || s.phase === 'closing' ? Math.floor(s.openT / SEC_PER_MIN / 60) : 0;
  const hr = sc.hours?.[hour] ?? 1;
  return wd * hr;
}

/** 時間帯・曜日の倍率を決める（weekday は7つ、hours は開店からの1時間ごと。0.5〜2 の決まった値） */
export function setPrepSchedule(s: GameState, p: { weekday?: unknown; hours?: unknown }): { ok: boolean; reason?: string } {
  const ok = (v: unknown) => typeof v === 'number' && (PREP_SCHEDULE_CHOICES as readonly number[]).includes(v);
  const next = { ...(s.prepSchedule ?? {}) };
  if (p.weekday !== undefined) {
    if (!Array.isArray(p.weekday) || p.weekday.length !== 7 || !p.weekday.every(ok)) return { ok: false, reason: '曜日の倍率が不正です' };
    next.weekday = [...(p.weekday as number[])];
  }
  if (p.hours !== undefined) {
    if (!Array.isArray(p.hours) || p.hours.length > 24 || !p.hours.every(ok)) return { ok: false, reason: '時間帯の倍率が不正です' };
    next.hours = [...(p.hours as number[])];
  }
  const allOne = (a?: number[]) => !a || a.every((x) => x === 1);
  if (allOne(next.weekday) && allOne(next.hours)) delete s.prepSchedule;
  else s.prepSchedule = next;
  return { ok: true };
}

// ───────────────── ③ 開店前の仕込みの計画 ─────────────────

/** 今日の仕込みの計画のその品の量（仕込みの時間だけ。計画がなければ null） */
export function prepPlanQty(s: GameState, itemId: string): number | null {
  const p = s.prepPlan;
  if (!p || p.day !== s.day || s.phase !== 'prep') return null;
  const q = p.items[itemId];
  return q !== undefined && q > 0 ? q : null;
}

/** 仕込みの計画を決める（items: 品 → 量。0・null の品は計画から外す）。その日の仕込みの時間だけ */
export function setPrepPlan(s: GameState, items: unknown, maxOf: (itemId: string) => number | null): { ok: boolean; reason?: string } {
  if (s.phase !== 'prep') return { ok: false, reason: '仕込みの計画は開店前（仕込みの時間）に決めます' };
  if (!items || typeof items !== 'object' || Array.isArray(items)) return { ok: false, reason: '計画の中身が不正です' };
  const cur = s.prepPlan && s.prepPlan.day === s.day ? { ...s.prepPlan.items } : {};
  for (const [itemId, v] of Object.entries(items as Record<string, unknown>)) {
    const max = maxOf(itemId);
    if (max === null) return { ok: false, reason: '仕込みで作る品ではありません' };
    if (v === null || v === 0) {
      delete cur[itemId];
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return { ok: false, reason: `量は0〜${max.toLocaleString('ja-JP')}の範囲で決めてください` };
    cur[itemId] = Math.round(v);
  }
  if (Object.keys(cur).length === 0) delete s.prepPlan;
  else s.prepPlan = { day: s.day, items: cur };
  return { ok: true };
}

/** 計画できる品（仕込みで作る品のうち解放されたもの）と、量の上限 */
export function prepPlanItems(s: GameState): { itemId: string; max: number }[] {
  return prepTargetItems()
    .filter((x) => isUnlocked(s, INGREDIENTS[x.itemId]?.unlock))
    .map((x) => ({ itemId: x.itemId, max: x.minQty * 20 }));
}

/** 計画の量の上限（計画できない品は null） */
export function prepPlanMax(s: GameState, itemId: string): number | null {
  return prepPlanItems(s).find((x) => x.itemId === itemId)?.max ?? null;
}

/**
 * 計画の案: 今日の予想の杯数 × 1人前 × 開店前に用意する割合（残りは営業中に仕込む）。
 * 予想ができない（営業した日がない）ときは、自動の仕込みの目安
 */
export function suggestPrepPlan(s: GameState, share = 0.5): Record<string, number> {
  const fc = forecastDay(s, s.day);
  const out: Record<string, number> = {};
  for (const { itemId, max } of prepPlanItems(s)) {
    const per = prepPerBowl(s, itemId);
    const q = fc && !fc.closed && fc.bowls > 0 ? fc.bowls * per * share : null;
    const fallback = prepTargetItems().find((x) => x.itemId === itemId)?.minQty ?? 0;
    out[itemId] = Math.min(max, Math.round(q ?? fallback));
  }
  return out;
}

/** 今日の計画の進み具合（品ごとに 計画の量・手元の量・割合）。計画がなければ空 */
export function prepPlanProgress(s: GameState): { itemId: string; plan: number; have: number; ratio: number }[] {
  const p = s.prepPlan;
  if (!p || p.day !== s.day) return [];
  return Object.entries(p.items).map(([itemId, plan]) => {
    const have = prepHave(s, itemId);
    return { itemId, plan, have, ratio: plan > 0 ? Math.min(1, have / plan) : 1 };
  });
}
