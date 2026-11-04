// 端末から届いた1日のデータの確かめ方（verify.ts。MARKET_RANKING_PLAN.md 4 章）。
// ふつうの営業（細かいシミュレーションをボットが回す）では一度も引っかからず、手を加えたデータは引っかかることを確かめる。
// 上限の幅の根拠（2026-11-04 の測定）: 経済の測定の12ケース × 40日（851日分）を回し、
// 来客 ÷ 見込みの最大 1.39（上位1%は 1.19）、1席あたりの杯数の最大 11、評判の1日の動きの最大 0.47、能力の1日の伸びの最大 = dailyCap。
// ふつうの日で引っかかったのは「次の日へ進めなかった日」（未払金を払えない。端末からは送れない）だけだった。
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  BALANCE,
  lastCompanyDay,
  nextDay,
  step,
  storeReport,
  verifyCommit,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, addSoloBot, autoRepair, clone, newGame } from './helpers';

/** 端末の1日（仕込み → 営業 → 閉店後の操作 → 次の日へ）。prev は日の始めの控え */
function deviceDay(s: GameState, ctx: SimCtx, opts: { prep?: () => void; evening?: () => void; demand?: Record<string, number> } = {}) {
  const prev = clone(s);
  const gameDate = lastCompanyDay(prev) + 1;
  s.marketDemand = opts.demand ?? null;
  if (s.phase === 'prep') {
    opts.prep?.();
    for (let i = 0; i < 300 && s.phase === 'prep'; i++) step(s, 0.1, ctx);
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let guard = 0;
    while ((s.phase as string) !== 'closed' && (s.phase as string) !== 'bankrupt' && guard++ < 30000) {
      step(s, 0.1, ctx);
      autoRepair(s, ctx);
    }
  }
  opts.evening?.();
  const r = nextDay(s, ctx);
  expect(r.ok, r.reason).toBe(true);
  return { prev, gameDate, v: verifyCommit(prev, s, { gameDate, demand: opts.demand ?? {} }) };
}

function setup(seed = 401) {
  const { s, ctx } = newGame(seed);
  s.tutorial = null;
  addSoloBot(s, 0.65);
  return { s, ctx };
}

describe('端末のデータの確かめ方: ふつうの営業は引っかからない', () => {
  it('一人営業・値段を変える・雇う・設備を買う・融資・設備を売る', { timeout: 120_000 }, () => {
    const { s, ctx } = setup();
    s.career.unlocked.push('hiring');
    const days = [
      deviceDay(s, ctx),
      deviceDay(s, ctx, { prep: () => void applyAction(s, 'p1', { type: 'setPrice', menuId: Object.keys(s.prices)[0]!, price: 1100 }, ctx) }),
      deviceDay(s, ctx, {
        evening: () => {
          const c = s.candidates[0];
          if (c) expect(applyAction(s, 'p1', { type: 'hire', candidateId: c.id }, ctx).ok).toBe(true);
        },
      }),
      deviceDay(s, ctx, { evening: () => void applyAction(s, 'p1', { type: 'buyEquipment', equipType: 'fridge', autoPlace: true }, ctx) }),
      deviceDay(s, ctx, { evening: () => void applyAction(s, 'p1', { type: 'takeLoan' }, ctx) }),
      deviceDay(s, ctx, {
        evening: () => {
          const f = s.equipment.filter((e) => e.type === 'fridge');
          if (f.length > 1) applyAction(s, 'p1', { type: 'sellEquipment', equipmentId: f[f.length - 1]!.id }, ctx);
        },
      }),
    ];
    for (const d of days) {
      expect(d.v.reject, `${d.gameDate}日目`).toEqual([]);
      expect(d.v.flags, `${d.gameDate}日目`).toEqual([]);
    }
    expect(s.loans.length).toBeGreaterThan(0);
  });

  it('拡張の工事の日・出店・ほかの店（店長の営業）・客の取り合いの倍率', { timeout: 120_000 }, () => {
    const { s, ctx } = setup(402);
    const cook = addBot(s, 'cook', 0.7, 6000);
    s.money = 3_000_000;
    s.career.unlocked.push('stage2', 'hiring');
    const out = [deviceDay(s, ctx, { evening: () => expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true) })];
    // 工事の日（閉店後の状態で届く）→ 次の日
    while (s.closedForConstruction > 0 || s.phase === 'closed') out.push(deviceDay(s, ctx));
    s.reputation = 4.2;
    out.push(deviceDay(s, ctx, { evening: () => expect(applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx).ok).toBe(true) }));
    const branch = s.company.stores[1]!;
    for (let i = 0; i < 4; i++) out.push(deviceDay(s, ctx, { demand: { [s.company.activeStoreId]: 0.6, [branch.id]: 0.8 } }));
    // 閉店後に従業員を異動し、支店へ移る（店の中身の入れ替え・仕込みの補充）→ 支店で1日
    const home = s.company.stores[0]!;
    out.push(
      deviceDay(s, ctx, {
        evening: () => {
          const e = s.employees.find((x) => x.profile.name !== 'bot-cook');
          if (e) applyAction(s, 'p1', { type: 'transferEmployee', employeeId: e.id, toStoreId: branch.id }, ctx);
          expect(applyAction(s, 'p1', { type: 'enterStore', storeId: branch.id }, ctx).ok).toBe(true);
        },
      }),
    );
    expect(s.company.activeStoreId).toBe(branch.id);
    out.push(deviceDay(s, ctx, { demand: { [home.id]: 0.7, [branch.id]: 0.9 } }));
    for (const d of out) {
      expect(d.v.reject, `${d.gameDate}日目`).toEqual([]);
      expect(d.v.flags, `${d.gameDate}日目`).toEqual([]);
    }
    // 支店にいる日は、本店が1日単位の計算（店長がいないので休業）
    expect(storeReport(s, home, lastCompanyDay(s))!.managed).toBe('closed');
    expect(storeReport(s, branch, lastCompanyDay(s))!.managed).toBeUndefined();
  });
});

describe('端末のデータの確かめ方: 手を加えたデータ', () => {
  /** 1日をふつうに営業したあと、tamper を加えて確かめる */
  function tampered(tamper: (s: GameState, prev: GameState) => void, seed = 410) {
    const { s, ctx } = setup(seed);
    deviceDay(s, ctx);
    const prev = clone(s);
    const gameDate = lastCompanyDay(prev) + 1;
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 30000) step(s, 0.1, ctx);
    nextDay(s, ctx);
    tamper(s, prev);
    return verifyCommit(prev, s, { gameDate, demand: {} });
  }

  it('能力が1日で伸びる幅を超える → 受け取らない', { timeout: 60_000 }, () => {
    const v = tampered((s) => (s.employees[0]!.profile.skills.cooking += 0.2));
    expect(v.reject.some((x) => x.includes('能力'))).toBe(true);
  });

  it('取引のない店舗・融資・設備・拡張・在庫 → 受け取らない', { timeout: 60_000 }, () => {
    expect(tampered((s) => s.company.stores.push({ ...clone(s.company.stores[0]!), id: 'ghost', snapshot: null })).reject.length).toBeGreaterThan(0);
    expect(tampered((s) => s.loans.push({ id: 'L9', principal: 500_000, remaining: 500_000, dailyRate: 0, dailyPayment: 1, takenDay: s.day })).reject.some((x) => x.includes('融資'))).toBe(true);
    expect(tampered((s) => s.equipment.push({ ...clone(s.equipment.find((e) => e.type === 'fridge')!), id: 'E-ghost' })).reject.some((x) => x.includes('設備'))).toBe(true);
    expect(tampered((s) => (s.career.stage = 2)).reject.some((x) => x.includes('拡張'))).toBe(true);
    expect(tampered((s) => (s.arrears = [])).reject).toEqual([]);
  });

  it('未払金が支払いなしに消える → 受け取らない', { timeout: 60_000 }, () => {
    const { s, ctx } = setup(411);
    s.arrears.push({ id: 'ar1', amount: 30_000, reason: 'テスト', sinceDay: s.day, dueDay: s.day + 10 });
    s.money = 0;
    const prev = clone(s);
    const next = clone(s);
    next.arrears = [];
    const v = verifyCommit(prev, next, { gameDate: lastCompanyDay(prev) + 1, demand: {} });
    expect(v.reject.some((x) => x.includes('未払金'))).toBe(true);
    void ctx;
  });

  it('来客の水増し（客の取り合いの倍率で決まる上限を超える）→ 受け取るが順位から外す', { timeout: 60_000 }, () => {
    const { s, ctx } = setup(412);
    const demand = { [s.company.activeStoreId]: 0.5 };
    const d = deviceDay(s, ctx, { demand });
    expect(d.v.flags).toEqual([]);
    const prev = clone(s);
    const gameDate = lastCompanyDay(prev) + 1;
    s.marketDemand = demand;
    applyAction(s, 'p1', { type: 'openShop' }, ctx);
    let guard = 0;
    while (s.phase !== 'closed' && guard++ < 30000) step(s, 0.1, ctx);
    nextDay(s, ctx);
    const r = s.history.find((x) => x.day === gameDate)!;
    r.customers += 400;
    const v = verifyCommit(prev, s, { gameDate, demand });
    expect(v.reject).toEqual([]);
    expect(v.flags.some((x) => x.includes('来客'))).toBe(true);
  });

  it('提供・売上の上限（席数 × 1席の上限、提供 × 最高の値段）', { timeout: 60_000 }, () => {
    const v = tampered((s, prev) => {
      const r = s.history.find((x) => x.day === lastCompanyDay(prev) + 1)!;
      r.served = 500;
    });
    expect(v.flags.some((x) => x.includes('提供'))).toBe(true);
    expect(BALANCE.market.verify.servedPerSeat).toBeGreaterThanOrEqual(11);
  });

  it('形が壊れた状態・先の日付 → 受け取らない', () => {
    const { s } = setup(413);
    const prev = clone(s);
    expect(verifyCommit(prev, { ...clone(s), money: 'x' } as unknown as GameState, { gameDate: 1, demand: {} }).reject.length).toBeGreaterThan(0);
    const next = clone(s);
    next.day = 9;
    expect(verifyCommit(prev, next, { gameDate: 1, demand: {} }).reject.some((x) => x.includes('日付') || x.includes('日報'))).toBe(true);
  });
});
