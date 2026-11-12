// じろ1 §8「経済バランス検証（必須）」。JIRO1_SIM=1 のときだけ 10 パターン × 90 日を回し、1・7・30・90 日の収支を JIRO1_OUT（JSON）に書く。
//   JIRO1_SIM=1 JIRO1_DAYS=90 JIRO1_SEEDS=777,778 JIRO1_OUT=/path/out.json npx vitest run test/econ/jiro1-balance.test.ts
// 結果と合格条件の確認は docs/JIRO1_BALANCE_REPORT.md。
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstProfitableWeek, PATTERNS, runPattern, totalsUpTo } from './jiro1-balance';

import { BALANCE, CHAOS, CHAOS_KINDS, FAME } from '../../src';

/** 調整案を試す: JIRO1_TUNE='{"customers.valueWeight":0.6}'（BALANCE の項目。測定だけに使う） */
function applyTune(json: string | undefined): void {
  if (!json) return;
  for (const [path, v] of Object.entries(JSON.parse(json) as Record<string, unknown>)) {
    const keys = path.split('.');
    let o = BALANCE as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
    o[keys[keys.length - 1]!] = v;
  }
}
applyTune(process.env.JIRO1_TUNE);

// じろ7 Phase 8: JIRO7_OFF=1 のとき、珍客イベントと知名度・話題性の効果を止めて測る（じろ7 の影響だけを比べるため）
if (process.env.JIRO7_OFF === '1') {
  for (const k of CHAOS_KINDS) (CHAOS[k] as { dayChance: number }).dayChance = 0;
  (FAME as { awarenessMaxBonus: number }).awarenessMaxBonus = 0;
  (FAME as { topicMaxBonus: number }).topicMaxBonus = 0;
  (FAME as { buzzByTopic: number }).buzzByTopic = 0;
  (FAME as { flameMaxRep: number }).flameMaxRep = 0;
}

const ON = process.env.JIRO1_SIM === '1';
const DAYS = Number(process.env.JIRO1_DAYS ?? 90);
const ONLY = process.env.JIRO1_CASES?.split(',');

describe.skipIf(!ON)('じろ1 §8 経済バランスの検証（10パターン × 1・7・30・90日）', () => {
  it('回して書き出す', { timeout: 7_200_000 }, () => {
    const seeds = (process.env.JIRO1_SEEDS ?? '777').split(',').map(Number);
    const out: unknown[] = [];
    for (const p of PATTERNS) {
      if (ONLY && !ONLY.includes(p.id)) continue;
      for (const seed of seeds) {
        const t0 = Date.now();
        const { rows } = runPattern(p, DAYS, seed);
        out.push({
          id: p.id,
          name: p.name,
          seed,
          checkpoints: Object.fromEntries([1, 7, 30, 90].filter((d) => d <= DAYS).map((d) => [d, totalsUpTo(rows, d)])),
          firstProfitableWeek: firstProfitableWeek(rows),
          bankrupt: rows.some((r) => r.bankrupt),
          rows: rows.map((r) => ({ day: r.day, op: r.gameOp, net: r.netSales, served: r.served, customers: r.customers, cash: r.cashEnd, staff: r.staff, rep: r.reputation })),
          ms: Date.now() - t0,
        });
        if (process.env.JIRO1_OUT) writeFileSync(process.env.JIRO1_OUT, JSON.stringify({ days: DAYS, cases: out }, null, 1));
      }
    }
    expect(out.length).toBeGreaterThan(0);
  });
});
