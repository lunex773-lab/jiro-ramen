// 経済バランスの測定（ECON_SIM=1 のときだけ実行。結果は ECON_OUT の JSON に書く）。
//   ECON_SIM=1 ECON_DAYS=90 ECON_OUT=/path/out.json npx vitest run test/econ/economy-sim.test.ts
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BALANCE, STAGES } from '../../src';
import { CASES, EQUIPMENT_PRICES, EXPANSION_COSTS, runCase, summarize } from './harness';

/** 調整案を試す: ECON_TUNE='{"equipment.wearMult":0.6,"STAGES.1.constructionCost":450000}' */
function applyTune(json: string | undefined): void {
  if (!json) return;
  const t = JSON.parse(json) as Record<string, unknown>;
  for (const [path, v] of Object.entries(t)) {
    const keys = path.split('.');
    let o: Record<string, unknown> = keys[0] === 'STAGES' ? (STAGES as unknown as Record<string, unknown>) : (BALANCE as unknown as Record<string, unknown>);
    const rest = keys[0] === 'STAGES' ? keys.slice(1) : keys;
    for (const k of rest.slice(0, -1)) o = o[k] as Record<string, unknown>;
    o[rest[rest.length - 1]!] = v;
  }
}
applyTune(process.env.ECON_TUNE);

const ON = process.env.ECON_SIM === '1';
const DAYS = Number(process.env.ECON_DAYS ?? 90);
const ONLY = process.env.ECON_CASES?.split(',');

describe.skipIf(!ON)('経済バランスの測定（設計書 v2.1 §4.3）', () => {
  it('10ケースを同じ種で回す', { timeout: 3_600_000 }, () => {
    const out: unknown[] = [];
    const seeds = (process.env.ECON_SEEDS ?? '777').split(',').map(Number);
    for (const c of CASES) {
      if (ONLY && !ONLY.includes(c.id)) continue;
      for (const seed of seeds) {
        const t0 = Date.now();
        const { rows } = runCase(c, DAYS, seed);
        const sum = summarize(c, rows);
        out.push({ ...sum, seed, rows, ms: Date.now() - t0 });
      }
    }
    if (process.env.ECON_OUT) writeFileSync(process.env.ECON_OUT, JSON.stringify({ days: DAYS, tune: process.env.ECON_TUNE ?? null, expansion: EXPANSION_COSTS, equipment: EQUIPMENT_PRICES, cases: out }, null, 1));
    expect(out.length).toBeGreaterThan(0);
  });
});
