import { describe, expect, it } from 'vitest';
import {
  activeStore,
  applyAction,
  BALANCE,
  enterStoreProblem,
  nextDay,
  openStoreProblem,
  parseSave,
  makeSaveFile,
  PROPERTIES,
  STAT_MONEY,
  storeReport,
  validateState,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, addSoloBot, newGame, runDay } from './helpers';

/** 1日営業して閉店後にする */
function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 出店できる会社（12席・評判★4.2・資金300万円・社員の調理担当が1人） */
function readyCompany(seed: number) {
  const { s, ctx } = newGame(seed);
  addSoloBot(s);
  const cook = addBot(s, 'cook', 0.7, 6000);
  playDay(s, ctx);
  s.money = 3_000_000;
  s.career.unlocked.push('stage2', 'hiring');
  expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
  s.reputation = 4.2;
  return { s, ctx, cook };
}

describe('出店（Phase 2-3）', () => {
  it('12席・評判★4.0以上の店と、店長にする社員と、初期費用＋運転資金があると出店できる', () => {
    const { s, ctx } = newGame(201);
    const cook = addBot(s, 'cook', 0.7, 6000);
    // 営業中は出せない
    expect(openStoreProblem(s, 'residential', cook.id)).toContain('閉店後');
    playDay(s, ctx);
    expect(openStoreProblem(s, 'residential', cook.id)).toContain('席以上');
    const r = readyCompany(202);
    expect(openStoreProblem(r.s, 'residential', r.cook.id)).toBeNull();
    expect(openStoreProblem(r.s, 'nope', r.cook.id)).toContain('物件');
    r.cook.profile.employment = 'part';
    expect(openStoreProblem(r.s, 'residential', r.cook.id)).toContain('社員');
    r.cook.profile.employment = 'full';
    r.s.money = 100;
    expect(openStoreProblem(r.s, 'residential', r.cook.id)).toContain('資金');
  });

  it('出店すると初期費用を払い、社員が店長として新しい店へ移り、新しい店は準備の日数だけ休む', () => {
    const { s, ctx, cook } = readyCompany(203);
    const money = s.money;
    const prop = PROPERTIES.residential!;
    const r = applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx);
    expect(r.ok).toBe(true);
    expect(s.money).toBe(money - prop.initialCost);
    expect(s.company.stores).toHaveLength(2);
    const st = s.company.stores[1]!;
    expect(st.managerId).toBe(cook.id);
    expect(st.snapshot).not.toBeNull();
    expect(st.snapshot!.employees.map((e) => e.id)).toEqual([cook.id]);
    expect(s.employees.some((e) => e.id === cook.id)).toBe(false);
    expect(st.snapshot!.stage).toBe(prop.stage);
    expect(st.snapshot!.closedForConstruction).toBe(prop.openingDays);
    // のれん: 評判の半分を引き継ぐ
    const R = BALANCE.reputation.initial;
    expect(st.snapshot!.reputation).toBeCloseTo(R + (4.2 - R) * BALANCE.company.brandCarry, 5);
    // ID は店をまたいでも重ならない
    const ids = new Set(s.equipment.map((e) => e.id));
    for (const e of st.snapshot!.equipment) expect(ids.has(e.id)).toBe(false);
    expect(validateState(s)).toEqual([]);
    // セーブして読み込める
    const p = parseSave(JSON.stringify(makeSaveFile(s, 1, null, 1)));
    expect(p.ok).toBe(true);
  });
});

describe('店長の営業（Phase 2-4）と会社の日報', () => {
  it('プレイヤーがいない店は1日単位で計算され、会社の日報は店舗の合計になる', { timeout: 60_000 }, () => {
    const { s, ctx, cook } = readyCompany(204);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    const opened = s.day;
    // 1日目: 準備（休業）→ 2日目から営業
    for (let i = 0; i < 4; i++) playDay(s, ctx);
    nextDay(s, ctx);
    const closed = storeReport(s, branch, opened + 1)!;
    expect(closed.managed).toBe('closed');
    expect(closed.served).toBe(0);
    expect(closed.rent).toBeGreaterThan(0);
    const open = storeReport(s, branch, opened + 2)!;
    expect(open.managed).toBe('manager');
    expect(open.served).toBeGreaterThan(20);
    expect(open.netSales).toBeGreaterThan(0);
    // 会社の日報 = 店舗の合計
    for (const c of s.company.history.filter((x) => x.day > opened)) {
      expect(c.stores).toHaveLength(2);
      const sum = c.stores.reduce((a, x) => a + x.netSales, 0);
      expect(c.netSales).toBe(sum);
      expect(c.operatingProfit).toBe(c.stores.reduce((a, x) => a + x.operatingProfit, 0));
      const r1 = storeReport(s, s.company.stores[0]!, c.day)!;
      expect(c.stores[0]!.netSales).toBe(r1.netSales);
    }
    // 会社のお金: 最後の会社の日報の期末 = 次の日の期首
    const last = s.company.history[s.company.history.length - 1]!;
    expect(last.cashEnd).toBe(s.cashAtDayStart);
    expect(validateState(s)).toEqual([]);
  });

  it('店長がいない店は休業し、家賃と維持費だけかかる', { timeout: 60_000 }, () => {
    const { s, ctx, cook } = readyCompany(205);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: branch.id, employeeId: null }, ctx).ok).toBe(true);
    for (let i = 0; i < 3; i++) playDay(s, ctx);
    nextDay(s, ctx);
    const r = storeReport(s, branch, s.day - 1)!;
    expect(r.managed).toBe('closed');
    expect(r.sales).toBe(0);
    expect(r.rent).toBe(Math.round(8_000 * PROPERTIES.residential!.rentMult));
  });

  it('方針の価格を上げると、客単価が上がり客は減る', { timeout: 60_000 }, () => {
    const run = (mult: number) => {
      const { s, ctx, cook } = readyCompany(206);
      applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id }, ctx);
      const b = s.company.stores[1]!;
      expect(applyAction(s, 'p1', { type: 'setStorePolicy', storeId: b.id, policy: { priceMult: mult } }, ctx).ok).toBe(true);
      for (let i = 0; i < 4; i++) playDay(s, ctx);
      nextDay(s, ctx);
      return storeReport(s, b, s.day - 1)!;
    };
    const lo = run(1);
    const hi = run(1.3);
    expect(hi.netSales! / hi.served).toBeGreaterThan(lo.netSales! / lo.served);
    expect(hi.customers).toBeLessThan(lo.customers);
  });

  it('方針の値の範囲外は受け付けない', () => {
    const { s, ctx } = newGame(207);
    const id = activeStore(s).id;
    expect(applyAction(s, 'p1', { type: 'setStorePolicy', storeId: id, policy: { priceMult: 5 } }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setStorePolicy', storeId: id, policy: { orderMode: 'x' as 'sales' } }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'setStorePolicy', storeId: id, policy: { repairCap: 10_000 } }, ctx).ok).toBe(true);
  });
});

describe('店に入る（切り替え）', () => {
  it('閉店後にほかの店へ入ると、次の日からその店で細かいシミュレーションで営業し、元の店は店長の営業になる', { timeout: 60_000 }, () => {
    const { s, ctx, cook } = readyCompany(208);
    const home = activeStore(s);
    const homeEquip = s.equipment.map((e) => e.id);
    // 本店にも店長（社員）を置く
    const mgr2 = addBot(s, 'cook', 0.7, 6000);
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: home.id, employeeId: mgr2.id }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    playDay(s, ctx);
    playDay(s, ctx);
    expect(enterStoreProblem(s, branch.id)).toBeNull();
    const lv = s.layoutVersion;
    expect(applyAction(s, 'p1', { type: 'enterStore', storeId: branch.id }, ctx).ok).toBe(true);
    expect(s.company.activeStoreId).toBe(branch.id);
    expect(branch.snapshot).toBeNull();
    expect(home.snapshot).not.toBeNull();
    expect(home.snapshot!.equipment.map((e) => e.id)).toEqual(homeEquip);
    expect(s.equipment.some((e) => homeEquip.includes(e.id))).toBe(false);
    expect(s.career.stage).toBe(PROPERTIES.residential!.stage);
    expect(s.layoutVersion).toBeGreaterThan(lv);
    expect(validateState(s)).toEqual([]);
    // 次の日は支店で営業する（店長の社員とプレイヤー）
    const day = s.day + 1;
    playDay(s, ctx);
    const played = storeReport(s, branch, day)!;
    expect(played.managed).toBeUndefined();
    expect(played.served).toBeGreaterThan(0);
    nextDay(s, ctx);
    // 本店はその日を店長の営業で計算
    expect(storeReport(s, home, day)!.managed).toBe('manager');
    // 営業中は移れない
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    expect(enterStoreProblem(s, home.id)).toContain('閉店後');
  });

  it('同じ種と同じ操作なら、同じ結果になる（店長の営業は乱数を使わない）', { timeout: 60_000 }, () => {
    const run = () => {
      const { s, ctx, cook } = readyCompany(209);
      applyAction(s, 'p1', { type: 'openStore', propertyId: 'station', managerId: cook.id }, ctx);
      for (let i = 0; i < 3; i++) playDay(s, ctx);
      nextDay(s, ctx);
      return JSON.stringify(s.company.history);
    };
    expect(run()).toBe(run());
  });
});

describe('営業の終わりで確定したあとに店を移る（2店舗で売上がマイナスになった不具合）', () => {
  it('確定のあとに別の店へ入っても、次の日の売上などはマイナスにならず、確定した日報は書き換わらない', { timeout: 60_000 }, () => {
    const { s, ctx, cook } = readyCompany(210);
    const home = activeStore(s);
    const mgr2 = addBot(s, 'cook', 0.7, 6000);
    expect(applyAction(s, 'p1', { type: 'assignManager', storeId: home.id, employeeId: mgr2.id }, ctx).ok).toBe(true);
    expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true);
    const branch = s.company.stores[1]!;
    playDay(s, ctx);
    playDay(s, ctx);
    const noNegative = () => {
      for (const k of STAT_MONEY) expect((s.today[k] as number) ?? 0, `${k} が負`).toBeGreaterThanOrEqual(0);
    };
    for (let round = 0; round < 2; round++) {
      // 共通市場と同じく、営業の終わりで結果を確定する
      expect(s.today.sales).toBeGreaterThan(0);
      expect(applyAction(s, 'p1', { type: 'finalizeDay' }, ctx).ok).toBe(true);
      const day = s.day;
      const from = activeStore(s);
      const to = from.id === home.id ? branch : home;
      const fromReport = JSON.stringify(storeReport(s, from, day));
      const toReport = JSON.stringify(storeReport(s, to, day));
      // 閉店後の事務作業（仕入れ）→ 店を移る
      const ord = applyAction(s, 'p1', { type: 'orderStock', itemId: 'soy', packs: 1, express: false }, ctx);
      expect(ord.ok, ord.reason).toBe(true);
      expect(applyAction(s, 'p1', { type: 'enterStore', storeId: to.id }, ctx).ok).toBe(true);
      expect(nextDay(s, ctx).ok).toBe(true);
      // 確定した日の店の日報はどちらも書き換わらない
      expect(JSON.stringify(storeReport(s, from, day))).toBe(fromReport);
      expect(JSON.stringify(storeReport(s, to, day))).toBe(toReport);
      // 次の日の始まり: 売上は0、閉店後の仕入れ・店長の仕込みはこの日の仕入れに入る
      expect(s.today.sales).toBe(0);
      expect(s.today.purchases).toBeGreaterThan(0);
      noNegative();
      // その日を営業すると、日報の売上 = 実際の売上（マイナスにならない）
      applyAction(s, 'p1', { type: 'openShop' }, ctx);
      runDay(s, ctx);
      noNegative();
      expect(s.today.sales).toBeGreaterThan(0);
      expect(validateState(s)).toEqual([]);
    }
    nextDay(s, ctx);
    for (const r of s.history) expect(r.sales, `${r.day}日目`).toBeGreaterThanOrEqual(0);
    for (const r of s.company.history) expect(r.netSales, `会社 ${r.day}日目`).toBeGreaterThanOrEqual(0);
  });
});
