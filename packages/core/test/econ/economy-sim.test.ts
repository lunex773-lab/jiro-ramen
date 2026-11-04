// 経済バランスの測定（ECON_SIM=1 のときだけ実行。結果は ECON_OUT の JSON に書く）。
//   ECON_SIM=1 ECON_DAYS=90 ECON_OUT=/path/out.json npx vitest run test/econ/economy-sim.test.ts
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASES, EQUIPMENT_PRICES, EXPANSION_COSTS, runCase, summarize } from './harness';

const ON = process.env.ECON_SIM === '1';
const DAYS = Number(process.env.ECON_DAYS ?? 90);
const ONLY = process.env.ECON_CASES?.split(',');

describe.skipIf(!ON)('経済バランスの測定（設計書 v2.1 §4.3）', () => {
  it('10ケースを同じ種で回す', { timeout: 3_600_000 }, () => {
    const out: unknown[] = [];
    for (const c of CASES) {
      if (ONLY && !ONLY.includes(c.id)) continue;
      const t0 = Date.now();
      const { rows } = runCase(c, DAYS);
      const sum = summarize(c, rows);
      out.push({ ...sum, rows, ms: Date.now() - t0 });
      console.log(`[econ] ${c.id} days=${rows.length} ${Math.round((Date.now() - t0) / 1000)}s d8_30.op=${sum.avg.d8_30?.op} cash90=${sum.at.day90?.cash}`);
    }
    if (process.env.ECON_OUT) writeFileSync(process.env.ECON_OUT, JSON.stringify({ days: DAYS, expansion: EXPANSION_COSTS, equipment: EQUIPMENT_PRICES, cases: out }, null, 1));
    expect(out.length).toBeGreaterThan(0);
  });
});
