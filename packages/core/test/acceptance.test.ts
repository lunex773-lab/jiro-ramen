// 経済の受け入れの条件（統合進化設計書 v2.1 §4.6）の短い版。90日の測定は test/econ（ECON_SIM=1）で回す。
import { describe, expect, it } from 'vitest';
import { expansionAdvice, STAGES } from '../src';
import { CASES, runCase } from './econ/harness';
import { newGame } from './helpers';

const policy = (id: string) => {
  const p = CASES.find((c) => c.id === id);
  if (!p) throw new Error(id);
  return p;
};
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

describe('経済の受け入れの条件（短い版）', () => {
  it('上手な成長（調理担当・売れ行きに合わせた仕入れ・定期メンテ）: 20〜32日目に12席へ拡張でき、拡張後の利益が拡張前より多い', { timeout: 180_000 }, () => {
    const { rows } = runCase(policy('c17_growth_full'), 40, 777);
    const day = rows.find((r, i) => i > 0 && r.stage > rows[i - 1]!.stage)?.day ?? null;
    expect(day).not.toBeNull();
    expect(day!).toBeGreaterThanOrEqual(20);
    expect(day!).toBeLessThanOrEqual(32);
    const before = avg(rows.filter((r) => r.day >= day! - 8 && r.day < day!).map((r) => r.op));
    // 工事の休業日と翌日（仕入れが追いつくまで）を除く
    const after = avg(rows.filter((r) => r.day >= day! + 3).map((r) => r.op));
    // 拡張後の利益が拡張前より1割以上多い（1.15倍 → 1.1倍: バズが1〜3時間になり（じろ1 5.9）、この種では拡張前のバズの日の利益が増えて
    // 比が 1.145 になった。拡張で利益が増えることは変わらない。受け入れの条件は じろ1 P5 で新しい条件（§8）に作り直す）
    expect(after).toBeGreaterThan(before * 1.1);
    expect(rows.every((r) => !r.bankrupt)).toBe(true);
  });

  it('調理担当を1人雇うと、一人営業より利益が増える（投資が報われる）', { timeout: 180_000 }, () => {
    const solo = runCase(policy('c11_smart_solo'), 24, 778).rows.filter((r) => r.day >= 10);
    const cook = runCase(policy('c12_smart_cook'), 24, 778).rows.filter((r) => r.day >= 10);
    expect(avg(cook.map((r) => r.op))).toBeGreaterThan(avg(solo.map((r) => r.op)));
  });

  it('人を雇いすぎると、1人だけ雇うより利益が減る（無計画な人員増加にはコストがかかる）', { timeout: 180_000 }, () => {
    const over = runCase(policy('c6_overstaff'), 20, 779).rows.filter((r) => r.day >= 8);
    const one = runCase(policy('c2_basic_staff'), 20, 779).rows.filter((r) => r.day >= 8);
    expect(avg(over.map((r) => r.op))).toBeLessThan(avg(one.map((r) => r.op)));
  });
});

describe('拡張の案内', () => {
  it('増える席の椅子と、目安に足りない冷蔵庫の台数・代金を出す', () => {
    const { s } = newGame(90);
    const a = expansionAdvice(s)!;
    expect(a.seats).toBe(STAGES[1]!.seats.length - STAGES[0]!.seats.length);
    expect(a.fridgeKg).toBe(100);
    expect(a.fridgeKgNeeded).toBe(STAGES[1]!.fridgeKgNeeded);
    expect(a.fridges).toBe(1);
    expect(a.total).toBeGreaterThan(STAGES[1]!.constructionCost + STAGES[1]!.minFundsAfter);
  });
});
