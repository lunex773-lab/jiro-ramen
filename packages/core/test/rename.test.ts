// 店名（屋号と各店舗の名前）を変える（オーナーの判断: 屋号と各店舗の両方）
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  autoPlayDay,
  cleanStoreName,
  commitDay,
  createMarket,
  isHostOnly,
  jstMidnight,
  marketAction,
  marketView,
  nextDay,
  playerCompany,
  startDay,
  storeDisplayName,
  STORE_NAME_MAX,
  validateState,
  type GameState,
  type SimCtx,
} from '../src';
import { addBot, addSoloBot, clone, newGame, runDay } from './helpers';

function playDay(s: GameState, ctx: SimCtx): void {
  if (s.phase === 'closed') nextDay(s, ctx);
  if (s.phase === 'prep') applyAction(s, 'p1', { type: 'openShop' }, ctx);
  runDay(s, ctx);
}

/** 2店目を出した会社 */
function twoStores(seed: number) {
  const { s, ctx } = newGame(seed);
  addSoloBot(s);
  const cook = addBot(s, 'cook', 0.7, 6000);
  playDay(s, ctx);
  s.money = 3_000_000;
  s.career.unlocked.push('stage2', 'hiring');
  expect(applyAction(s, 'p1', { type: 'expand' }, ctx).ok).toBe(true);
  s.reputation = 4.2;
  const r = applyAction(s, 'p1', { type: 'openStore', propertyId: 'residential', managerId: cook.id }, ctx);
  expect(r.ok, r.reason).toBe(true);
  return { s, ctx };
}

describe('店名を変える', () => {
  it('名前は前後の空白・制御文字を除き、空白をまとめ、20文字まで（絵文字も1文字）', () => {
    expect(cleanStoreName('  ラーメン　 次郎\n屋  ')).toBe('ラーメン 次郎 屋');
    expect(cleanStoreName('a\u0000b​c')).toBe('abc');
    expect(cleanStoreName('🍜'.repeat(30))).toBe('🍜'.repeat(STORE_NAME_MAX));
    expect(cleanStoreName('   ')).toBe('');
    expect(cleanStoreName(undefined)).toBe('');
  });

  it('屋号を変えると看板（本店）の名前が変わる。空の名前は受け付けない', () => {
    const { s, ctx } = newGame(901);
    expect(applyAction(s, 'p1', { type: 'rename', name: '  麺屋 まし太  ' }, ctx).ok).toBe(true);
    expect(s.shopName).toBe('麺屋 まし太');
    expect(storeDisplayName(s, s.company.stores[0]!)).toBe('麺屋 まし太');
    expect(s.company.stores[0]!.name).toBe('麺屋 まし太');
    const ng = applyAction(s, 'p1', { type: 'rename', name: ' \n ' }, ctx);
    expect(ng.ok).toBe(false);
    expect(s.shopName).toBe('麺屋 まし太');
    expect(validateState(s)).toEqual([]);
  });

  it('2店目以降は1店ずつ変えられる。屋号を変えると、自動で付けた名前のままの店だけ新しい屋号に合わせる', () => {
    const { s, ctx } = twoStores(902);
    const [home, branch] = s.company.stores;
    expect(branch!.name).toBe(`${s.shopName} 住宅街店`);
    // 屋号を変える → 自動の名前の支店も合わせる
    expect(applyAction(s, 'p1', { type: 'rename', name: '豚山' }, ctx).ok).toBe(true);
    expect(branch!.name).toBe('豚山 住宅街店');
    // 支店に自分で名前を付ける → 屋号を変えても、そのまま
    expect(applyAction(s, 'p1', { type: 'renameStore', storeId: branch!.id, name: 'ぶた山 郊外本陣' }, ctx).ok).toBe(true);
    expect(branch!.name).toBe('ぶた山 郊外本陣');
    expect(applyAction(s, 'p1', { type: 'rename', name: '豚山二郎' }, ctx).ok).toBe(true);
    expect(branch!.name).toBe('ぶた山 郊外本陣');
    // 本店を renameStore で変えると屋号が変わる
    expect(applyAction(s, 'p1', { type: 'renameStore', storeId: home!.id, name: '本家 豚山' }, ctx).ok).toBe(true);
    expect(s.shopName).toBe('本家 豚山');
    expect(applyAction(s, 'p1', { type: 'renameStore', storeId: 'nope', name: 'x' }, ctx).ok).toBe(false);
    expect(applyAction(s, 'p1', { type: 'renameStore', storeId: branch!.id, name: '' }, ctx).ok).toBe(false);
    expect(validateState(s)).toEqual([]);
  });

  it('共同経営では店名の変更はホストだけ（参加者の操作ではない）', () => {
    expect(isHostOnly('rename')).toBe(true);
    expect(isHostOnly('renameStore')).toBe(true);
  });
});

describe('共通市場の会社の名前', () => {
  const T0 = jstMidnight('2026-11-04') + 10 * 3_600_000;
  it('市場の画面で屋号を変えると、市場の会社の名前も変わる', () => {
    const m = createMarket({ id: 'r', name: 'r', seed: 3, now: T0, settings: {}, creator: { ownerId: 'u1', companyName: '一号店' } });
    expect(marketAction(m, 'u1', { type: 'rename', name: '豚の星' }, T0).ok).toBe(true);
    expect(playerCompany(m, 'u1')!.name).toBe('豚の星');
    expect(marketView(m, 'u1').companies.find((c) => c.mine)!.name).toBe('豚の星');
    const home = playerCompany(m, 'u1')!.state.company.stores[0]!;
    expect(marketAction(m, 'u1', { type: 'renameStore', storeId: home.id, name: '豚の星 本店' }, T0).ok).toBe(true);
    expect(playerCompany(m, 'u1')!.name).toBe('豚の星 本店');
  });

  it('端末の営業中に経営メニューで屋号を変えて送ると、市場の会社の名前も合わせる', () => {
    const m = createMarket({ id: 'r2', name: 'r2', seed: 4, now: T0, settings: {}, creator: { ownerId: 'u1', companyName: '一号店' } });
    const c = playerCompany(m, 'u1')!;
    const t = startDay(m, 'u1', T0, 'tok-rename-1', c.progress.stateVersion);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const s: GameState = clone(c.state);
    s.shopName = '  端末で\u0000付けた名前  ';
    autoPlayDay(s, t.ticket.gameDate, t.ticket.demand, { allowLoan: false });
    const r = commitDay(m, 'u1', T0 + 1000, t.ticket.token, s);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(playerCompany(m, 'u1')!.name).toBe('端末で付けた名前');
    expect(playerCompany(m, 'u1')!.state.shopName).toBe('端末で付けた名前');
  });
});
