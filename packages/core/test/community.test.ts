// コミュニティの終わり・育てた会社の移動・引退（仕様書 6.2・12章 16。オーナーの判断 15〜18）
import { describe, expect, it } from 'vitest';
import {
  addDays,
  autoPlayDay,
  commitDay,
  createMarket,
  exportCompany,
  finishSync,
  importCompany,
  isEnded,
  joinMarket,
  jstMidnight,
  lastCompanyDay,
  playerCompany,
  restoreCompany,
  retireCompany,
  runSync,
  shiftGameDays,
  startDay,
  syncPending,
  validateState,
  type GameState,
  type MarketState,
} from '../src';
import { clone } from './helpers';

const P0 = '2026-11-04';
const T0 = jstMidnight(P0) + 10 * 3_600_000;
let tok = 0;

function fastDay(m: MarketState, owner: string, now: number) {
  const c = playerCompany(m, owner)!;
  const t = startDay(m, owner, now, `t${++tok}`, c.progress.stateVersion);
  if (!t.ok) throw new Error(t.reason);
  const s: GameState = clone(c.state);
  autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
  return commitDay(m, owner, now + 1000, t.ticket.token, s);
}

function syncAll(m: MarketState, now: number) {
  for (;;) {
    const r = runSync(m, now);
    if (r.status === 'more') continue;
    if (r.status === 'ranking') finishSync(m, now);
    return;
  }
}

describe('競争期間の終わり（判断 16）', () => {
  it('終わったあとも営業は続けられる。0時の同期はしない。新しい企業は入れない', () => {
    const m = createMarket({ id: 'a', name: 'a', seed: 1, now: T0, settings: { periodDays: 30 }, creator: { ownerId: 'u1', companyName: 'x' } });
    const end = m.settings.endsAt!;
    expect(end).toBe(jstMidnight(addDays(P0, 30)));
    expect(isEnded(m, end - 1)).toBe(false);
    expect(isEnded(m, end)).toBe(true);
    // 最後の日に営業 → 0時に同期される
    expect(fastDay(m, 'u1', end - 3_600_000).ok).toBe(true);
    syncAll(m, end + 31 * 60_000);
    expect(m.commonMarketDate).toBe(1);
    // 終わったあとの営業: 期間を数えないので、0時を過ぎても同期待ちにならない
    expect(fastDay(m, 'u1', end + 3_600_000).ok).toBe(true);
    expect(m.pendingPeriods).toEqual([]);
    expect(syncPending(m, end + 2 * 86_400_000)).toBe(false);
    expect(playerCompany(m, 'u1')!.progress.lastProcessedGameDate).toBe(2);
    // 新しい企業は入れない
    expect(joinMarket(m, 'u9', 'late', end + 1000).ok).toBe(false);
  });
});

describe('育てた会社で別の市場へ（判断 15）', () => {
  function grown(days: number) {
    const a = createMarket({ id: 'A', name: 'A', seed: 2, now: T0, settings: { periodDays: 30, entry: 'grown' }, creator: { ownerId: 'u1', companyName: '育てた亭' } });
    for (let i = 0; i < days; i++) expect(fastDay(a, 'u1', T0 + i * 1000).ok).toBe(true);
    syncAll(a, jstMidnight(addDays(P0, 1)) + 60_000);
    return a;
  }

  it('暦をずらしても、お金・店・従業員・在庫・評判はそのまま。日付を表す値だけが同じ日数ずれる', () => {
    const a = grown(6);
    const s: GameState = clone(playerCompany(a, 'u1')!.state);
    const before = clone(s);
    shiftGameDays(s, -4);
    expect(s.day).toBe(before.day - 4);
    expect(s.money).toBe(before.money);
    expect(s.company.history.map((r) => r.day)).toEqual(before.company.history.map((r) => r.day - 4));
    expect(s.history.map((r) => r.day)).toEqual(before.history.map((r) => r.day - 4));
    expect(s.inventory.map((l) => l.expiresDay)).toEqual(before.inventory.map((l) => l.expiresDay - 4));
    expect(s.career.bestDayServed).toBe(before.career.bestDayServed);
    expect(s.reputation).toBe(before.reputation);
    expect(validateState(s)).toEqual([]);
  });

  it('終わった市場から出し、育てた企業で参加できる市場に入れる（入る市場の次の日付から）。続けて営業でき、サーバーの確かめ方も通る', () => {
    const a = grown(8);
    const mine = playerCompany(a, 'u1')!;
    const money = mine.state.money;
    // 競争期間中は出せない
    expect(exportCompany(a, 'u1', T0).ok).toBe(false);
    const end = a.settings.endsAt!;
    const ex = exportCompany(a, 'u1', end + 1000);
    expect(ex.ok).toBe(true);
    expect(mine.status).toBe('moved');
    // 移す先（育てた企業で参加できる・3日目まで済んでいる）
    const b = createMarket({ id: 'B', name: 'B', seed: 3, now: end, settings: { entry: 'grown' }, creator: { ownerId: 'u2', companyName: 'b' } });
    for (let i = 0; i < 3; i++) fastDay(b, 'u2', end + i * 1000);
    syncAll(b, jstMidnight(addDays(P0, 32)) + 60_000);
    expect(b.commonMarketDate).toBe(3);
    const im = importCompany(b, 'u1', ex.company!, end + 2 * 86_400_000);
    expect(im.ok, im.reason).toBe(true);
    const c = im.company!;
    expect(c.state.money).toBe(money);
    expect(lastCompanyDay(c.state)).toBe(3);
    expect(c.state.day).toBe(4);
    expect(c.progress.lastProcessedGameDate).toBe(3);
    const r = fastDay(b, 'u1', end + 2 * 86_400_000 + 1000);
    expect(r.ok, JSON.stringify(r.reject)).toBe(true);
    expect(r.flags ?? []).toEqual([]);
    expect(c.progress.lastProcessedGameDate).toBe(4);
  });

  it('新規の企業だけの市場には入れない。受け取れなかったら元の市場に戻せる', () => {
    const a = grown(2);
    const end = a.settings.endsAt!;
    const ex = exportCompany(a, 'u1', end + 1);
    const fresh = createMarket({ id: 'F', name: 'F', seed: 4, now: end, settings: { entry: 'fresh' }, creator: { ownerId: 'u3', companyName: 'f' } });
    expect(importCompany(fresh, 'u1', ex.company!, end + 2).ok).toBe(false);
    expect(restoreCompany(a, 'u1')).toBe(true);
    expect(playerCompany(a, 'u1')!.status).toBe('active');
  });

  it('引退: 競争期間中も自分から抜けられる（じろ2: オーナーの判断「引退として抜ける」）。終わったあと・破産したあともできる（記録は残る）', () => {
    const a = grown(1);
    expect(retireCompany(a, 'u1', a.settings.endsAt! + 1).ok).toBe(true);
    expect(a.companies.find((c) => c.ownerId === 'u1')!.status).toBe('retired');
    const d = grown(1);
    const before = playerCompany(d, 'u1')!;
    const days = before.days.length;
    expect(retireCompany(d, 'u1', T0).ok).toBe(true);
    expect(before.status).toBe('retired');
    // 記録は残る。店は市場から消える（営業している会社に入らない）。同じ会社では戻れず、新しい会社なら入り直せる
    expect(before.days.length).toBe(days);
    expect(playerCompany(d, 'u1')).toBeNull();
    const again = joinMarket(d, 'u1', '二代目', T0);
    expect(again.ok).toBe(true);
    expect(again.company!.id).not.toBe(before.id);
    const b = createMarket({ id: 'C', name: 'C', seed: 5, now: T0, creator: { ownerId: 'u4', companyName: 'c' } });
    playerCompany(b, 'u4')!.status = 'bankrupt';
    expect(retireCompany(b, 'u4', T0).ok).toBe(true);
  });
});
