import { describe, expect, it } from 'vitest';
import {
  addDays,
  autoPlayDay,
  BALANCE,
  commitDay,
  competitionFactors,
  createMarket,
  demandFor,
  finishSync,
  freeSlots,
  jstMidnight,
  joinMarket,
  marketAction,
  marketShare,
  marketView,
  MARKET_HOME_AREAS,
  MARKET_SCHEMA,
  migrateMarket,
  periodSummary,
  playerCompany,
  runSync,
  startDay,
  syncPending,
  type GameState,
  type MarketState,
} from '../src';
import { addBot, clone } from './helpers';

const P0 = '2026-11-04';
/** その日の JST の h 時 */
const at = (day: string, h: number, min = 0) => jstMidnight(day) + h * 3_600_000 + min * 60_000;
const T0 = at(P0, 10);

const mk = (seed = 5, creator = true, settings = {}): MarketState =>
  createMarket({ id: 'm', name: 'テスト市場', seed, now: T0, settings, creator: creator ? { ownerId: 'u1', companyName: 'テスト亭' } : null });

let tok = 0;
/** 端末の代わりに1日を営業して送る（速い道: 店長の営業で1日を作る。サーバーの確かめ方は同じ） */
function fastDay(m: MarketState, owner: string, now: number, tamper?: (s: GameState) => void) {
  const c = playerCompany(m, owner)!;
  const t = startDay(m, owner, now, `t${++tok}`, c.progress.stateVersion);
  if (!t.ok) throw new Error(t.reason);
  const s = clone(c.state);
  autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
  tamper?.(s);
  return { ticket: t.ticket, result: commitDay(m, owner, now + 60_000, t.ticket.token, s) };
}

/** 同期を最後まで（ランキングを書く代わりに集計を取ってから終える） */
function syncAll(m: MarketState, now: number, budget?: number) {
  let steps = 0;
  for (;;) {
    const r = runSync(m, now, budget);
    steps += 1;
    if (r.status === 'more') continue;
    if (r.status === 'ranking') {
      const summary = periodSummary(m, r.periodId);
      finishSync(m, now);
      return { status: 'done' as const, summary, steps, periodId: r.periodId };
    }
    return { status: r.status, steps };
  }
}

describe('共通市場: 作る・参加する', () => {
  it('作った人と AI 企業で合わせて6社。AI なしの市場も作れる。本店は3つの地域に分かれる', () => {
    const m = mk();
    expect(m.schema).toBe(MARKET_SCHEMA);
    expect(m.companies).toHaveLength(6);
    expect(m.companies.filter((c) => c.kind === 'ai')).toHaveLength(5);
    for (const a of MARKET_HOME_AREAS) expect(m.companies.filter((c) => c.homeArea === a.id)).toHaveLength(2);
    for (const c of m.companies) {
      expect(c.state.money).toBe(BALANCE.initialMoney);
      expect(c.state.phase).toBe('prep');
      expect(c.state.day).toBe(1);
      expect(c.progress.lastProcessedGameDate).toBe(0);
    }
    const human = mk(5, true, { aiFill: false, maxCompanies: 3 });
    expect(human.companies.map((c) => c.kind)).toEqual(['player']);
    expect(human.settings.maxCompanies).toBe(3);
  });

  it('設定は範囲に収める（2〜25社・期間の終わりは JST の0時）', () => {
    expect(mk(1, true, { maxCompanies: 99 }).settings.maxCompanies).toBe(25);
    expect(mk(1, true, { maxCompanies: 1 }).settings.maxCompanies).toBe(2);
    const s = mk(1, true, { periodDays: 30 }).settings;
    expect(s.endsAt).toBe(jstMidnight(addDays(P0, 30)));
    expect(mk().settings.endsAt).toBeNull();
  });

  it('いっぱいの市場にプレイヤーが入ると、シェアがいちばん小さい AI 企業が撤退する。人だけで上限になると入れない', () => {
    const m = mk(9, true, { maxCompanies: 3 });
    expect(m.companies).toHaveLength(3);
    expect(joinMarket(m, 'u2', '新顔亭').ok).toBe(true);
    expect(m.companies.filter((c) => c.status === 'active')).toHaveLength(3);
    expect(m.companies.filter((c) => c.status === 'retired')).toHaveLength(1);
    expect(joinMarket(m, 'u2', 'もう一度').company!.name).toBe('新顔亭');
    expect(joinMarket(m, 'u3', 'u3').ok).toBe(true);
    expect(joinMarket(m, 'u4', 'u4').ok).toBe(false);
    // 撤退した企業の店は取り合いに入らない
    const gone = m.companies.find((c) => c.status === 'retired')!;
    expect([...competitionFactors(m).keys()].some((k) => k.startsWith(`${gone.id}:`))).toBe(false);
  });
});

describe('共通市場: 端末で営業する日（判断 1・1a・1b・1d）', () => {
  it('日を始めると、その日の条件（日付・期間・客の取り合いの倍率）を渡す。同じ日は続きとして同じ条件', () => {
    const m = mk();
    const c = playerCompany(m, 'u1')!;
    const t = startDay(m, 'u1', T0, 'a', c.progress.stateVersion);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.ticket.gameDate).toBe(1);
    expect(t.ticket.periodId).toBe(P0);
    const d = t.ticket.demand[c.state.company.stores[0]!.id]!;
    expect(d).toBeLessThan(1);
    expect(d).toBeGreaterThan(1 / (1 + BALANCE.market.competition * 2));
    const again = startDay(m, 'u1', T0 + 5000, 'b', c.progress.stateVersion);
    expect(again.ok && again.ticket.resumed && again.ticket.token === 'a').toBe(true);
    expect(m.pendingPeriods).toEqual([P0]);
  });

  it('古い状態（版が違う）からは日を始められない', () => {
    const m = mk();
    const r = startDay(m, 'u1', T0, 'a', 999);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('stale');
  });

  it('送られた日を確かめて受け取る。同じ token の送り直しは同じ答え（二度数えない）', () => {
    const m = mk();
    const { result } = fastDay(m, 'u1', T0);
    expect(result.ok).toBe(true);
    const c = playerCompany(m, 'u1')!;
    expect(c.progress.lastProcessedGameDate).toBe(1);
    expect(c.progress.manualProgressDays).toBe(1);
    expect(c.days).toHaveLength(1);
    expect(c.days[0]!.source).toBe('manual');
    expect(c.state.day).toBe(2);
    expect(c.state.prepSnapshot).toBeNull();
    const dup = commitDay(m, 'u1', T0 + 120_000, c.lastCommit!.token, clone(c.state));
    expect(dup.duplicate).toBe(true);
    expect(c.days).toHaveLength(1);
    expect(c.progress.manualProgressDays).toBe(1);
  });

  it('前の日から説明できない状態（お金・従業員・日報の書き換え）は受け取らず、前日の状態のまま', () => {
    const cases: [string, (s: GameState) => void][] = [
      ['お金', (s) => (s.money += 100_000)],
      ['日付', (s) => (s.day += 1)],
      ['従業員', (s) => void addBot(s, 'cook')],
      ['評判', (s) => (s.reputation = Math.min(5, s.reputation + 2))],
      ['日報の書き換え', (s) => (s.company.history[0]!.netSales += 1)],
      ['在庫', (s) => s.inventory.push({ id: 'x', itemId: 'pork', qty: 5000, unitCost: 3, quality: 1, createdDay: 1, expiresDay: 9 })],
      ['取引の水増し', (s) => s.transactions.push({ id: 'Tz', day: s.day - 1, t: 0, type: 'refund', amount: 50_000, memo: 'x', key: 'x' })],
    ];
    for (const [name, tamper] of cases) {
      const m = mk();
      const c = playerCompany(m, 'u1')!;
      // 1日目はふつうに受け取ったあと、2日目に手を加える
      expect(fastDay(m, 'u1', T0).result.ok).toBe(true);
      const before = JSON.stringify(c.state);
      const { result } = fastDay(m, 'u1', T0 + 1000, tamper);
      expect(result.ok, name).toBe(false);
      expect(result.code, name).toBe('rejected');
      expect(result.reject!.length, name).toBeGreaterThan(0);
      expect(JSON.stringify(c.state), name).toBe(before);
      expect(c.openDay, name).toBeNull();
      expect(c.progress.lastProcessedGameDate, name).toBe(1);
    }
  });

  it('上限を超える日（日報の売上の水増し）は受け取るが、順位から外す', () => {
    const m = mk();
    const { result } = fastDay(m, 'u1', T0, (s) => {
      const r = s.history[s.history.length - 1]!;
      r.sales += 500_000;
      r.netSales = (r.netSales ?? 0) + 500_000;
      r.operatingProfit += 500_000;
      r.finalProfit = (r.finalProfit ?? 0) + 500_000;
      const cr = s.company.history[s.company.history.length - 1]!;
      cr.netSales += 500_000;
      cr.stores[0]!.netSales += 500_000;
    });
    expect(result.ok).toBe(true);
    expect(result.flags!.some((f) => f.includes('売上'))).toBe(true);
    const c = playerCompany(m, 'u1')!;
    expect(c.days[0]!.flags).not.toBeNull();
    const sum = periodSummary(m, P0).find((x) => x.companyId === c.id)!;
    expect(sum.flaggedDays).toBe(1);
    expect(sum.days).toBe(0);
    expect(sum.netSales).toBe(0);
  });

  it('営業中・同期中は、サーバーでの経営の操作を断る。終われば使えて、状態の版が上がる', () => {
    const m = mk();
    const c = playerCompany(m, 'u1')!;
    const sid = c.state.company.stores[0]!.id;
    const pol = { type: 'setStorePolicy' as const, storeId: sid, policy: { priceMult: 1.1 } };
    startDay(m, 'u1', T0, 'a', c.progress.stateVersion);
    expect(marketAction(m, 'u1', pol, T0).ok).toBe(false);
    c.openDay = null;
    const v = c.progress.stateVersion;
    expect(marketAction(m, 'u1', pol, T0).ok).toBe(true);
    expect(c.progress.stateVersion).toBe(v + 1);
    expect(marketAction(m, 'u1', { type: 'nextDay' }, T0).ok).toBe(false);
    expect(marketAction(m, 'u1', { type: 'buyEquipment', equipType: 'fridge' }, T0).ok).toBe(false);
    // 0時を過ぎて同期していない期間がある
    expect(marketAction(m, 'u1', pol, at(addDays(P0, 1), 0, 1)).ok).toBe(false);
  });
});

describe('共通市場: 0時の同期（仕様書 3.4・12章 4〜9）', () => {
  it('最大進行企業が1社: 0時に締め、その日付まで AI 企業を自動営業でそろえる。新しい期間が始まる', () => {
    const m = mk();
    for (let i = 0; i < 3; i++) expect(fastDay(m, 'u1', T0 + i * 600_000).result.ok).toBe(true);
    const midnight = jstMidnight(addDays(P0, 1));
    expect(syncPending(m, midnight - 1)).toBe(false);
    expect(syncPending(m, midnight)).toBe(true);
    const r = startDay(m, 'u1', midnight + 1000, 'x', playerCompany(m, 'u1')!.progress.stateVersion);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('sync_pending');
    const s = syncAll(m, midnight + 1000);
    expect(s.status).toBe('done');
    expect(m.commonMarketDate).toBe(3);
    for (const c of m.companies) {
      expect(c.progress.lastProcessedGameDate).toBe(3);
      expect(c.state.day).toBe(4);
      expect(c.state.company.history.map((x) => x.day)).toEqual([1, 2, 3]);
      expect(c.progress.lastProcessedPeriod).toBe(P0);
      expect(c.progress.manualProgressDays).toBe(0);
    }
    const ai = m.companies.find((c) => c.kind === 'ai')!;
    expect(ai.progress.autoSimulationDays).toBe(3);
    expect(ai.days.every((d) => d.source === 'auto' && d.periodId === P0)).toBe(true);
    const sum = s.status === 'done' ? s.summary : [];
    expect(sum.find((x) => x.kind === 'player')!.manualDays).toBe(3);
    expect(sum.filter((x) => x.kind === 'ai').every((x) => x.autoDays === 3)).toBe(true);
    // 市場シェアは合計1
    expect(m.companies.reduce((a, c) => a + marketShare(m, c.id), 0)).toBeCloseTo(1, 6);
    expect(m.pendingPeriods).toEqual([]);
    expect(startDay(m, 'u1', midnight + 5000, 'y', playerCompany(m, 'u1')!.progress.stateVersion).ok).toBe(true);
  });

  it('全企業が同じ日数なら自動営業はいらない。進み方が違えば、遅れた分だけ自動営業する', () => {
    const m = mk(11, true, { aiFill: false });
    joinMarket(m, 'u2', '二号店');
    for (let i = 0; i < 2; i++) {
      fastDay(m, 'u1', T0 + i * 1e6);
      fastDay(m, 'u2', T0 + i * 1e6 + 1);
    }
    let s = syncAll(m, jstMidnight(addDays(P0, 1)));
    expect(s.status).toBe('done');
    expect(m.companies.every((c) => c.progress.autoSimulationDays === 0)).toBe(true);
    const P1 = addDays(P0, 1);
    for (let i = 0; i < 5; i++) fastDay(m, 'u1', at(P1, 10) + i * 1e6);
    fastDay(m, 'u2', at(P1, 20));
    s = syncAll(m, jstMidnight(addDays(P1, 1)));
    expect(s.status).toBe('done');
    const u2 = playerCompany(m, 'u2')!;
    expect(u2.progress.lastProcessedGameDate).toBe(7);
    expect(u2.progress.autoSimulationDays).toBe(4);
    expect(u2.days.filter((d) => d.periodId === P1).map((d) => d.source)).toEqual(['manual', 'auto', 'auto', 'auto', 'auto']);
    expect(playerCompany(m, 'u1')!.progress.autoSimulationDays).toBe(0);
  });

  it('0時に営業中の日は、届くまで待って前の期間に数える（最大30分）', () => {
    const m = mk();
    const c = playerCompany(m, 'u1')!;
    const late = at(P0, 23, 55);
    const t = startDay(m, 'u1', late, 'late', c.progress.stateVersion);
    expect(t.ok).toBe(true);
    const midnight = jstMidnight(addDays(P0, 1));
    const w = runSync(m, midnight + 5 * 60_000);
    expect(w.status).toBe('waiting');
    if (w.status === 'waiting') expect(w.until).toBe(midnight + BALANCE.market.closeGraceMs);
    const s = clone(c.state);
    autoPlayDay(s, 1, t.ok ? t.ticket.demand : {}, { allowLoan: false });
    expect(commitDay(m, 'u1', midnight + 10 * 60_000, 'late', s).ok).toBe(true);
    const done = syncAll(m, midnight + 11 * 60_000);
    expect(done.status).toBe('done');
    expect(c.days[0]!.periodId).toBe(P0);
    expect(m.commonMarketDate).toBe(1);
  });

  it('30分を過ぎても届かない日は無効（前の日の状態からやり直し）。あとから届いても受け取らない', () => {
    const m = mk();
    const c = playerCompany(m, 'u1')!;
    fastDay(m, 'u1', T0);
    const t = startDay(m, 'u1', at(P0, 23, 50), 'late', c.progress.stateVersion);
    expect(t.ok).toBe(true);
    const before = JSON.stringify(c.state);
    const midnight = jstMidnight(addDays(P0, 1));
    const done = syncAll(m, midnight + 31 * 60_000);
    expect(done.status).toBe('done');
    expect(c.openDay).toBeNull();
    expect(JSON.stringify(c.state)).toBe(before);
    expect(m.syncLog[0]!.expiredDays).toBe(1);
    const s = clone(c.state);
    autoPlayDay(s, 2, {}, { allowLoan: false });
    const r = commitDay(m, 'u1', midnight + 32 * 60_000, 'late', s);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('no_open_day');
  });

  it('同期は分けて進めても、一度に進めても同じ結果。途中で止まっても続きから・二重に実行しても進みすぎない', () => {
    const build = () => {
      tok = 0;
      const m = mk(21);
      for (let i = 0; i < 12; i++) fastDay(m, 'u1', T0 + i * 600_000);
      return m;
    };
    const midnight = jstMidnight(addDays(P0, 1));
    const a = build();
    const ra = syncAll(a, midnight);
    const b = build();
    // 1回に2社・日ずつ（サーバーが途中で止まって、アラームで続きから再開するのと同じ）
    const rb = syncAll(b, midnight, 2);
    expect(rb.steps).toBeGreaterThan(10);
    expect(JSON.stringify(b.companies.map((c) => c.state))).toBe(JSON.stringify(a.companies.map((c) => c.state)));
    expect(ra.status === 'done' && rb.status === 'done').toBe(true);
    // 同期のあとにもう一度呼んでも何もしない
    const snap = JSON.stringify(a);
    expect(runSync(a, midnight + 1000).status).toBe('idle');
    finishSync(a, midnight + 2000);
    expect(JSON.stringify(a)).toBe(snap);
    // ランキングを書く前に止まった（ranking のまま）なら、もう一度呼んでも ranking を返すだけで進めない
    const c = build();
    const r1 = runSync(c, midnight);
    expect(r1.status).toBe('ranking');
    const s1 = JSON.stringify(c);
    expect(runSync(c, midnight + 5000).status).toBe('ranking');
    expect(JSON.stringify(c)).toBe(s1);
  });

  it('大量の日数を自動営業で補完する（進行の上限なし。1社が200日進めた場合）', { timeout: 60_000 }, () => {
    const m = mk(31);
    for (let i = 0; i < 200; i++) expect(fastDay(m, 'u1', T0 + i * 1000).result.ok).toBe(true);
    const t = Date.now();
    const s = syncAll(m, jstMidnight(addDays(P0, 1)), 300);
    const ms = Date.now() - t;
    expect(s.status).toBe('done');
    expect(m.commonMarketDate).toBe(200);
    for (const c of m.companies.filter((x) => x.status === 'active')) expect(c.progress.lastProcessedGameDate).toBe(200);
    // 5社 × 200日 = 1000 社・日を4回に分けて計算
    expect(s.steps).toBeGreaterThanOrEqual(4);
    expect(ms).toBeLessThan(30_000);
  });

  it('客の取り合いは、同じ日付の相手の店の見込みで計算する（相手が先に進んでいても、その日付の記録を使う）', () => {
    const m = mk(5, true, { aiFill: false });
    joinMarket(m, 'u2', 'ライバル');
    const a = playerCompany(m, 'u1')!;
    const b = playerCompany(m, 'u2')!;
    b.homeArea = a.homeArea;
    // b が先に3日進む（1日目の見込みが記録される）
    for (let i = 0; i < 3; i++) fastDay(m, 'u2', T0 + i * 1000);
    const recorded = m.ledger['1']![`${b.id}:${b.state.company.stores[0]!.id}`]!;
    expect(recorded).toBeGreaterThan(0);
    // b の今の状態を変えても、a の1日目の倍率は b の1日目の記録で決まる
    b.state.company.stores[0]!.policy.priceMult = 0.7;
    b.state.prices = Object.fromEntries(Object.entries(b.state.prices).map(([k, v]) => [k, Math.round(v * 0.7)]));
    const d1 = demandFor(m, a, 1)[a.state.company.stores[0]!.id]!;
    const own = m.ledger['1']?.[`${a.id}:${a.state.company.stores[0]!.id}`];
    expect(own).toBeUndefined();
    const k = BALANCE.market.competition;
    const mine = (() => {
      const t = startDay(m, 'u1', T0 + 9000, 'q', a.progress.stateVersion);
      return t.ok ? t.ticket.demand[a.state.company.stores[0]!.id]! : 0;
    })();
    expect(mine).toBeCloseTo(d1, 6);
    const ownRec = m.ledger['1']![`${a.id}:${a.state.company.stores[0]!.id}`]!;
    expect(mine).toBeCloseTo(ownRec / (ownRec + k * recorded), 6);
  });

  it('同じ種と同じ操作の列なら、同じ結果になる', { timeout: 60_000 }, () => {
    const run = () => {
      tok = 0;
      const m = mk(77);
      for (let i = 0; i < 6; i++) fastDay(m, 'u1', T0 + i * 1000);
      syncAll(m, jstMidnight(addDays(P0, 1)));
      return JSON.stringify(m);
    };
    expect(run()).toBe(run());
  });

  it('自動営業で期限を過ぎた未払金を払えない企業は、破産して市場から消える', () => {
    const m = mk();
    fastDay(m, 'u1', T0);
    const c = m.companies[1]!;
    c.state.money = 0;
    c.state.arrears.push({ id: 'a', amount: 5_000_000, reason: 'テスト', sinceDay: 0, dueDay: 0 });
    syncAll(m, jstMidnight(addDays(P0, 1)));
    expect(c.status).toBe('bankrupt');
    expect(c.bankruptDay).toBe(1);
    expect(m.decisions.some((d) => d.companyId === c.id && d.text.includes('破産'))).toBe(true);
  });

  it('AI 企業は自動営業の日に理由つきで意思決定する（値段・人）', { timeout: 60_000 }, () => {
    const m = mk(3);
    for (let i = 0; i < 30; i++) fastDay(m, 'u1', T0 + i * 1000);
    syncAll(m, jstMidnight(addDays(P0, 1)));
    const texts = m.decisions.map((d) => d.text);
    expect(texts.some((t) => t.includes('雇いました'))).toBe(true);
    expect(texts.some((t) => t.includes('値下げ') || t.includes('値上げ'))).toBe(true);
  });

  it('出店先の物件は全社で取り合う（空いていなければ出店できない）', () => {
    const m = mk();
    const n = freeSlots(m, 'roadside');
    expect(n).toBe(BALANCE.market.branchSlots.roadside);
    for (const c of m.companies.slice(1, 1 + n)) c.state.company.stores.push({ ...c.state.company.stores[0]!, id: `x-${c.id}`, propertyId: 'roadside', snapshot: c.state.company.stores[0]!.snapshot });
    expect(freeSlots(m, 'roadside')).toBe(0);
    const r = marketAction(m, 'u1', { type: 'openStore', propertyId: 'roadside', managerId: 'e' }, T0);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('空いていません');
  });

  it('画面に出す市場: 各社の進み具合・同期の状態・自分の企業の中身', () => {
    const m = mk();
    fastDay(m, 'u1', T0);
    const v = marketView(m, 'u1');
    expect(v.leaderDay).toBe(1);
    expect(v.commonMarketDate).toBe(0);
    expect(v.companies.find((c) => c.mine)!.manualDays).toBe(1);
    expect(v.mine!.progress.stateVersion).toBe(2);
    expect(v.pendingPeriods).toEqual([P0]);
    expect(marketView(m, 'nobody').mine).toBeNull();
  });
});

describe('共通市場: 古い市場の移行', () => {
  it('schema 1（全社が同じ日付）の市場を、企業のデータを消さずに新しい形にする', () => {
    const m = mk();
    for (let i = 0; i < 2; i++) fastDay(m, 'u1', T0 + i * 1000);
    syncAll(m, jstMidnight(addDays(P0, 1)));
    // 古い形: day = 次に進める日、企業の状態は閉店後
    const old = {
      schema: 1,
      id: m.id,
      name: m.name,
      seed: m.seed,
      day: 3,
      companies: m.companies.map((c) => ({ id: c.id, name: c.name, kind: c.kind, ownerId: c.ownerId, strategy: c.strategy, homeArea: c.homeArea, joinedDay: 1, bankruptDay: null, state: { ...clone(c.state), phase: 'closed' }, memory: c.memory })),
      decisions: [],
      history: [],
    };
    const money = old.companies.map((c) => c.state.money);
    const n = migrateMarket(old as unknown as Record<string, unknown>, T0)!;
    expect(n.schema).toBe(MARKET_SCHEMA);
    expect(n.commonMarketDate).toBe(2);
    expect(n.companies.map((c) => c.state.money)).toEqual(money);
    for (const c of n.companies) {
      expect(c.state.phase).toBe('prep');
      expect(c.progress.lastProcessedGameDate).toBe(2);
    }
    expect(migrateMarket({ schema: 99 }, T0)).toBeNull();
  });
});
