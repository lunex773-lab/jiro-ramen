// じろ1 P2（docs/JIRO1_PLAN.md 5.7・5.8）: 最低賃金を参考にした給料・シフトリーダー・仕入れ担当→接客担当・仕込みの目安・店長の発注
import { describe, expect, it } from 'vitest';
import { applyAction, BALANCE, PREFECTURE_ECONOMY, refreshCandidates, type GameState } from '../src';
import { activeStore } from '../src/sim/company';
import { ensureStartingUnlocks, restockTarget, setPrepTarget } from '../src/sim/employees';
import { addLot, managerOrderBudget, managerOrders, runAutoOrder } from '../src/sim/inventory';
import { applyWageFloor, marketHourly, minWageOf } from '../src/sim/wages';
import { PREP_RECIPES } from '../src/data/prep';
import { addBot, newGame } from './helpers';

describe('給料（最低賃金を参考に）', () => {
  it('都道府県の最低賃金（令和8年度）。場所がなければ全国加重平均', () => {
    expect(minWageOf('13104')).toBe(1280);
    expect(minWageOf('47201')).toBe(1086);
    expect(minWageOf(null)).toBe(1177);
    expect(Object.keys(PREFECTURE_ECONOMY)).toHaveLength(47);
  });

  it('時給は最低賃金を下回らず、能力・担当で上がる。シフトリーダーは2割高', () => {
    expect(marketHourly(1100, 'server', 0, 0, 0)).toBeGreaterThanOrEqual(1100);
    expect(marketHourly(1100, 'server', 0.8, 0, 0.5)).toBeGreaterThan(marketHourly(1100, 'server', 0.2, 0, 0.5));
    expect(marketHourly(1100, 'cook', 0.5, 0, 0.5)).toBeGreaterThan(marketHourly(1100, 'server', 0.5, 0, 0.5));
    expect(marketHourly(1100, 'leader', 0.5, 0, 0.5) / marketHourly(1100, 'server', 0.5, 0, 0.5)).toBeCloseTo(1.2, 1);
  });

  it('採用の候補の時給は、店の都道府県の最低賃金以上（東京の店は沖縄の店より高め）', () => {
    const avg = (code: string) => {
      let sum = 0;
      let n = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const { s } = newGame(seed);
        activeStore(s).location = code;
        refreshCandidates(s);
        for (const c of s.candidates) {
          expect(c.profile.hourly!).toBeGreaterThanOrEqual(minWageOf(code));
          expect(c.profile.wage).toBe(Math.round((c.profile.hourly! * BALANCE.staff.employment.fullShiftHours) / 10) * 10);
          sum += c.profile.hourly!;
          n += 1;
        }
      }
      return sum / n;
    };
    expect(avg('13104')).toBeGreaterThan(avg('47201'));
  });

  it('今いる人の給料が最低賃金より低ければ朝に上げる（下げない）。給与0（店主の代わりのボット）は払わない', () => {
    const { s } = newGame(3);
    activeStore(s).location = '13104';
    const low = addBot(s, 'server', 0.5, 4000);
    low.profile.employment = 'part';
    low.profile.hourly = 900;
    const high = addBot(s, 'cook', 0.5, 9000);
    high.profile.hourly = 2000;
    const bot = addBot(s, 'cook', 0.5, 0);
    applyWageFloor(s);
    expect(low.profile.hourly).toBe(1280);
    expect(high.profile.hourly).toBe(2000);
    expect(high.profile.wage).toBe(9000);
    expect(bot.profile.wage).toBe(0);
  });
});

describe('担当（仕込み担当 → 接客担当、シフトリーダー）', () => {
  it('前のセーブの仕込み担当は接客担当になる', () => {
    const { s } = newGame(5);
    const e = addBot(s, 'server');
    (e.profile as { role: string }).role = 'prep';
    ensureStartingUnlocks(s);
    expect(e.profile.role).toBe('server');
  });

  it('シフトリーダーは社員から昇格し、日給が上がる。担当の変更ではなれない', () => {
    const { s, ctx } = newGame(6);
    const e = addBot(s, 'cook', 0.7, 7000);
    e.profile.employment = 'part';
    expect(applyAction(s, 'p1', { type: 'promoteLeader', employeeId: e.id }, ctx).ok).toBe(false);
    e.profile.employment = 'full';
    expect(applyAction(s, 'p1', { type: 'setRole', employeeId: e.id, role: 'leader' }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'promoteLeader', employeeId: e.id }, ctx).ok).toBe(true);
    expect(e.profile.role).toBe('leader');
    expect(e.profile.wage).toBeGreaterThan(7000);
  });
});

describe('仕込みの目安', () => {
  it('品ごとに決めた量を目安にし、null で自動に戻す。範囲の外は断る', () => {
    const { s } = newGame(7);
    const yasai = Object.values(PREP_RECIPES).find((r) => r.restockBelow?.itemId === 'yasai')!;
    const auto = restockTarget(s, yasai);
    expect(setPrepTarget(s, 'yasai', 3000).ok).toBe(true);
    expect(restockTarget(s, yasai)).toBe(3000);
    expect(setPrepTarget(s, 'yasai', -1).ok).toBe(false);
    expect(setPrepTarget(s, 'noodle', 100).ok).toBe(false);
    expect(setPrepTarget(s, 'yasai', null).ok).toBe(true);
    expect(restockTarget(s, yasai)).toBe(auto);
  });
});

describe('店長の発注', () => {
  function withManager(): GameState {
    const { s, ctx } = newGame(8);
    s.career.unlocked.push('hiring');
    const m = addBot(s, 'cook', 0.7, 7000);
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: activeStore(s).id, employeeId: m.id }, ctx).ok).toBe(true);
    return s;
  }
  it('店長がいれば店長が発注する（方針で「自分で」にすると自分の設定）', () => {
    const s = withManager();
    expect(managerOrders(s)).toBe(true);
    activeStore(s).policy.orderBy = 'self';
    expect(managerOrders(s)).toBe(false);
  });
  it('資金が少ないときは、翌日の固定費の2日分を残した額までしか発注しない', () => {
    const s = withManager();
    s.inventory = [];
    addLot(s, 'ichimi', 1, 1);
    s.money = managerOrderBudget(s) === 0 ? s.money : 30_000;
    const budget = managerOrderBudget(s);
    const before = s.money;
    runAutoOrder(s, { events: [], notices: [] } as never);
    expect(before - s.money).toBeLessThanOrEqual(budget);
    expect(s.today.managerOrder!.skipped).toBeGreaterThan(0);
  });
});
