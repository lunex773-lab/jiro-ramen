// 共通市場の画面と、端末での営業（docs/MARKET_RANKING_PLAN.md）。
// サーバーを偽物に差し替え、core の市場の規則（createMarket・marketView・startDay・commitDay・runSync）で答える。
// 端末で1日を営業して「翌日の仕込みへ」で送ると、サーバーの確かめ方（verify）を通って受け取られることまで確かめる。
import { expect, test, type Page } from '@playwright/test';
import {
  addDays,
  commitDay,
  createMarket,
  finishSync,
  jstDateKey,
  jstMidnight,
  marketAction,
  marketView,
  nextJstMidnight,
  nextSyncAt,
  periodSummary,
  playerCompany,
  runSync,
  startDay,
  syncPending,
  type Action,
  type GameState,
  type MarketState,
} from '@jiro/core';

import { computeRanking, type RankAggRow, type RankBoard, type RankMetric } from '../../server/src/ranking';

const SERVER = 'https://mock.jiro.test';

/** 同期が済んだ期間の集計から、ランキングのもとの行を作る（サーバーの rank_agg と同じ形。期間はまとめて1つ） */
function rankRows(m: MarketState): RankAggRow[] {
  const by = new Map<string, RankAggRow>();
  for (const run of m.syncLog) {
    for (const r of periodSummary(m, run.periodId)) {
      const cur = by.get(r.companyId) ?? {
        scope_key: 'W', market_id: m.id, company_id: r.companyId, entry: m.settings.entry, kind: r.kind, player_id: r.ownerId, name: r.name, days: 0, manual_days: 0, flagged_days: 0,
        net_sales: 0, operating_profit: 0, final_profit: 0, sat_sum: 0, sat_count: 0, market_net_sales: 0, emp_sat_sum: 0, emp_sat_days: 0, quality_sum: 0, quality_days: 0, value_start: r.valueStart, value_end: r.valueEnd,
      };
      cur.days += r.days;
      cur.manual_days += r.manualDays;
      cur.net_sales += r.netSales;
      cur.operating_profit += r.operatingProfit;
      cur.final_profit += r.finalProfit;
      cur.sat_sum += r.satisfactionSum;
      cur.sat_count += r.satisfactionCount;
      cur.market_net_sales += r.marketNetSales;
      cur.emp_sat_sum += r.empSatSum;
      cur.emp_sat_days += r.empSatDays;
      cur.quality_sum += r.qualitySum;
      cur.quality_days += r.qualityDays;
      cur.value_end = r.valueEnd;
      by.set(r.companyId, cur);
    }
  }
  return [...by.values()];
}
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
};

function mockMarket(page: Page) {
  let market: MarketState | null = null;
  const start = Date.now();
  const cids = new Set<string>();
  const acts: Action[] = [];
  const commits: { ok: boolean; flags?: string[]; reject?: string[] }[] = [];
  let skew = 0;
  const now = () => Date.now() + skew;
  return {
    get market() {
      return market;
    },
    acts,
    commits,
    /** サーバーの時計を、次の JST の0時の31分後（営業中の日を待つ30分のあと）に進めて同期する（アラームの代わり） */
    midnight() {
      const t = nextJstMidnight(now()) + 31 * 60_000;
      skew = t - Date.now();
      for (;;) {
        const r = runSync(market!, now());
        if (r.status === 'more') continue;
        if (r.status === 'ranking') finishSync(market!, now());
        break;
      }
    },
    async install() {
      await page.route(`${SERVER}/api/v1/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const send = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const p = url.pathname;
        if (p === '/api/v1/game-version') return send({ gameVersion: 'e2e', minClientVersion: '0.0.0', protocol: 1 });
        if (p === '/api/v1/auth/anonymous') return send({ playerId: 'u1', token: 'tok' });
        if (p === '/api/v1/profile') return send({ playerId: 'u1', name: 'テスター' });
        if (p === '/api/v1/markets') return send({ markets: market ? [{ marketId: 'mk1', code: 'MKT234', name: market.name, createdAt: start, isOwner: true }] : [] });
        if (p === '/api/v1/market/create') {
          const b = JSON.parse(req.postData() ?? '{}') as { name?: string; companyName: string; settings?: Record<string, unknown> };
          market = createMarket({ id: 'mk1', name: b.name || 'テストの市場', seed: 4242, now: now(), settings: b.settings ?? {}, creator: { ownerId: 'u1', companyName: b.companyName } });
          return send({ marketId: 'mk1', code: 'MKT234', name: market.name }, 201);
        }
        if (p === '/api/v1/market/mk1/act') {
          const b = JSON.parse(req.postData() ?? '{}') as { cid: string; action: Action };
          if (cids.has(b.cid)) return send({ ok: true, duplicate: true });
          cids.add(b.cid);
          acts.push(b.action);
          return send(marketAction(market!, 'u1', b.action, now()));
        }
        if (p === '/api/v1/market/mk1/day/start') {
          const b = JSON.parse(req.postData() ?? '{}') as { token: string; baseVersion: number };
          const r = startDay(market!, 'u1', now(), b.token, b.baseVersion);
          return r.ok ? send({ ok: true, ticket: r.ticket }) : send({ error: r.reason, code: r.code }, 409);
        }
        if (p === '/api/v1/market/mk1/day/commit') {
          const b = JSON.parse(req.postData() ?? '{}') as { token: string; state: GameState };
          const r = commitDay(market!, 'u1', now(), b.token, b.state);
          commits.push(r);
          return send({ ...r, companyId: playerCompany(market!, 'u1')?.id ?? null });
        }
        if (p === '/api/v1/rankings') {
          const board = (url.searchParams.get('board') ?? 'community') as RankBoard;
          const metric = (url.searchParams.get('metric') ?? 'overall') as RankMetric;
          const lines = computeRanking(market ? rankRows(market) : [], board, metric).map((l) => ({ ...l, prevRank: null, mine: l.playerId === 'u1' }));
          return send({ board, scope: url.searchParams.get('scope'), scopeKey: 'W2026-11-02', prevKey: 'W2026-10-26', metric, metricLabel: metric, perDay: board !== 'community', total: lines.length, rows: lines, mine: lines.filter((l) => l.mine) });
        }
        if (p === '/api/v1/rewards') return send({ rewards: [{ key: 'r1', title: '🥇 2026-11-02の週・コミュニティ 総合1位', createdAt: start }] });
        if (p === '/api/v1/market/mk1') {
          const v = marketView(market!, 'u1');
          const t = now();
          return send({
            ...v,
            clock: { serverNow: t, nextMidnight: nextJstMidnight(t), nextSyncAt: nextSyncAt(market!, t), syncPending: syncPending(market!, t) },
            code: 'MKT234',
            isOwner: true,
            joined: true,
            today: jstDateKey(t),
          });
        }
        return send({ error: 'not found', code: 'not_found' }, 404);
      });
    },
  };
}

type Jiro = {
  host: { state: GameState; speed: number; tick(dt: number): void; act(a: Action): Promise<{ ok: boolean; reason?: string }> };
  returnToTitle(): Promise<void>;
};

test('共通市場: 市場を作り、端末で1日を営業して送ると受け取られ、0時に全社がそろう', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = mockMarket(page);
  await mock.install();
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  const lobby = page.locator('.market-lobby');
  // サーバーの URL は入口では変えられない（表示だけ）。設定の画面で「変更する」を押して変える
  await expect(lobby.locator('input[placeholder*="workers.dev"]')).toHaveCount(0);
  await expect(lobby.locator('[data-server-url-missing], [data-server-url]').first()).toBeVisible();
  await lobby.locator('[data-open-settings]').click();
  const settings = page.locator('.screen.settings');
  await settings.locator('[data-server-url-edit]').click();
  await settings.locator('[data-server-url-input]').fill(`${SERVER}/`);
  await settings.locator('[data-server-url-save]').click();
  await expect(settings.locator('[data-server-url]')).toHaveText(SERVER);
  await settings.getByRole('button', { name: '閉じる' }).click();
  await expect(lobby.locator('[data-server-url]')).toHaveText(SERVER);
  await lobby.locator('input[placeholder="会社（店）の名前"]').fill('テスト亭');
  // 作る人が決める: 参加企業数（AI で埋める）
  await lobby.locator('[data-max-companies]').selectOption('4');
  // 市場の街を地図で選ぶ（市場は1つの街）
  await lobby.locator('[data-pick-city]').click();
  const cityMap = page.locator('[data-store-map]');
  await cityMap.locator('[data-map-region="近畿"]').click();
  await cityMap.locator('[data-map-pref="27"]').click();
  await cityMap.locator('[data-map-muni="27100"]').click();
  await cityMap.locator('[data-map-confirm]').click();
  await expect(cityMap).toHaveCount(0);
  await expect(lobby.locator('[data-city-label]')).toHaveText('大阪府 大阪市');
  await lobby.locator('[data-create-market]').click();
  // 市場の画面
  const screen = page.locator('.screen.market');
  await expect(screen.locator('.market-head')).toContainText('テストの市場');
  await expect(screen.locator('.market-head .room-code')).toHaveText('MKT234');
  await expect(screen.locator('[data-market-day]')).toHaveText('まだ0日');
  await expect(screen.locator('[data-auto-status]')).toHaveText('まだありません');
  await expect(screen.locator('[data-sync]')).toContainText('次の0時まで');
  const rows = screen.locator('.market-standings .trow[data-company]');
  await expect(rows).toHaveCount(4);
  expect(mock.market!.settings.maxCompanies).toBe(4);
  await expect(screen.locator('.market-standings .trow.mine')).toContainText('テスト亭（あなた）');
  await expect(screen.locator('.market-rules')).toContainText('4社まで');
  expect(mock.market!.settings.cityCode).toBe('27100');
  expect(mock.market!.companies.every((c) => c.state.company.stores[0]!.location === '27100')).toBe(true);
  await expect(screen.locator('.market-rules')).toContainText('大阪府 大阪市');
  // 市場の画面: 街の地図で出店先を見る（その街だけ。駅前・住宅街・郊外の3か所）
  await screen.locator('[data-market-open-map]').click();
  const siteMap = page.locator('[data-store-map]');
  await expect(siteMap.locator('[data-muni]')).toHaveCount(1);
  await expect(siteMap.locator('[data-site]')).toHaveCount(3);
  await siteMap.locator('[data-map-site="station"] button').click();
  await expect(siteMap.locator('[data-map-site="station"]')).toContainText('空き');
  await expect(siteMap.locator('[data-map-confirm]')).toBeDisabled();
  await siteMap.locator('[data-map-close]').click();
  await expect(siteMap).toHaveCount(0);
  // 屋号を変える（市場の会社の名前も変わる）
  await screen.locator('[data-rename-shop]').fill('テスト亭 本舗');
  await screen.locator('[data-rename-shop-ok]').click();
  await expect.poll(() => mock.market!.companies[0]!.name).toBe('テスト亭 本舗');
  await expect(screen.locator('.market-standings .trow.mine')).toContainText('テスト亭 本舗（あなた）');
  expect(mock.acts.map((a) => a.type)).toContain('rename');
  await shot(page, '60-market');
  // 営業していない間の経営: 本店の方針の値段を定価の90%にする（サーバーへ操作を送る）
  const storeId = mock.market!.companies[0]!.state.company.stores[0]!.id;
  await screen.locator(`[data-price="${storeId}"]`).selectOption('0.9');
  await expect.poll(() => mock.market!.companies[0]!.state.company.stores[0]!.policy.priceMult).toBe(0.9);
  expect(mock.acts.map((a) => a.type)).toContain('setStorePolicy');
  // 自動経営の方針（会社全体）: 借入の許可は、変更前と後を見せて確かめてから変える
  await expect(screen.locator('.market-auto')).toContainText('自動経営の方針');
  await screen.locator('[data-pol-loan]').selectOption('true');
  const modal = page.locator('.modal');
  await expect(modal).toContainText('変更前: 許可しない');
  await expect(modal).toContainText('変更後: 許可する');
  await modal.getByRole('button', { name: '変更する' }).click();
  await expect.poll(() => mock.market!.companies[0]!.state.company.policy?.allowLoan ?? false).toBe(true);
  // 店ごとの方針: 人手が足りない日の短期バイト
  await screen.locator(`[data-temp-policy="${storeId}"]`).selectOption('1');
  await expect.poll(() => mock.market!.companies[0]!.state.company.stores[0]!.policy.tempWhenShort ?? false).toBe(true);

  // 端末で1日目を営業する（その日の条件 = 同じ地域の会社との客の取り合いの倍率をもらう）
  await screen.locator('[data-market-play]').click();
  await expect(page.locator('.hud-top')).toBeVisible();
  const demand = await page.evaluate(() => {
    const s = (window as unknown as { __jiro: Jiro }).__jiro.host.state;
    return s.marketDemand?.[s.company.activeStoreId] ?? null;
  });
  expect(demand).not.toBeNull();
  expect(demand!).toBeLessThan(1);
  expect(mock.market!.pendingPeriods).toHaveLength(1);
  // 1日を早送り（開店 → 閉店まで）
  const phase = await page.evaluate(async () => {
    const app = (window as unknown as { __jiro: Jiro }).__jiro;
    const h = app.host;
    await h.act({ type: 'openShop' });
    h.speed = 3;
    for (let i = 0; i < 40_000 && h.state.phase !== 'closed'; i++) h.tick(0.25);
    return h.state.phase;
  });
  expect(phase).toBe('closed');
  // 翌日へ → その日をサーバーへ送る（確かめて受け取られる）
  await page.getByRole('button', { name: '翌日の仕込みへ →' }).click();
  await expect.poll(() => mock.commits.length).toBe(1);
  expect(mock.commits[0]!.reject ?? []).toEqual([]);
  expect(mock.commits[0]!.ok).toBe(true);
  expect(mock.commits[0]!.flags ?? []).toEqual([]);
  const me = () => playerCompany(mock.market!, 'u1')!;
  expect(me().progress.lastProcessedGameDate).toBe(1);
  expect(me().progress.manualProgressDays).toBe(1);
  // 送ったあと、2日目の条件をもらって続けられる
  await expect.poll(() => me().openDay?.gameDate ?? null).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.day)).toBe(2);
  await shot(page, '61-market-play');

  // 市場の画面へ戻る（2日目は送られていない → やり直しになると知らせる）
  void page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.returnToTitle());
  await page.getByRole('button', { name: '市場の画面に戻る' }).click();
  await expect(screen.locator('[data-leader-day]')).toHaveText('1日目まで');
  await expect(screen.locator('.market-standings .trow.mine [data-progress]')).toContainText('1日目まで（今日 手動1日）');

  // 0時: いちばん進んだ会社（あなた・1日目）まで、AI 企業を自動営業でそろえる
  mock.midnight();
  expect(mock.market!.commonMarketDate).toBe(1);
  expect(mock.market!.companies.filter((c) => c.kind === 'ai').every((c) => c.progress.lastProcessedGameDate === 1 && c.days[0]?.source === 'auto')).toBe(true);
  await page.getByRole('button', { name: '← 市場から出る' }).click();
  await page.locator('.market-lobby [data-open-market="mk1"]').click();
  await expect(screen.locator('[data-market-day]')).toHaveText('1日目まで');
  // 0時に営業中だった2日目は30分を過ぎて無効 → サーバーの1日目の終わりの状態から2日目をやり直す
  await expect(screen.locator('[data-market-play]')).toContainText('2日目');
  await expect(screen.locator('.market-log')).toContainText('日目');
  // 自動営業の実行状況と競争の記録（仕様書 8.1・8.4）
  await expect(screen.locator('[data-auto-status]')).toContainText('1日目までそろえた・自動営業 3社日');
  await expect(screen.locator('[data-history] [data-sync-run]')).toHaveCount(1);
  await expect(screen.locator('[data-history] [data-sync-run]')).toContainText('1日目まで全社をそろえた');

  // ランキング（コミュニティ・全体、期間、種別、自社の順位、称号）
  await screen.locator('[data-open-ranking]').click();
  const rk = page.locator('.screen.ranking');
  await expect(rk.locator('[data-rank-row]')).toHaveCount(4);
  await expect(rk.locator('.trow.mine')).toContainText('テスト亭 本舗（あなた）');
  await expect(rk.locator('[data-my-rank]')).toContainText('位');
  await rk.locator('[data-metric]').selectOption('sales');
  await expect(rk.locator('.ranking-mine')).toContainText('sales');
  await rk.locator('[data-board="grown"]').click();
  await expect(rk.locator('.ranking-mine')).toContainText('1日あたり');
  await rk.locator('[data-scope="month"]').click();
  await expect(rk.locator('[data-reward="r1"]')).toContainText('総合1位');
  await shot(page, '62-ranking');
  await rk.locator('[data-ranking-back]').click();
  await expect(screen.locator('[data-market-day]')).toHaveText('1日目まで');
});

test('共通市場: 0時を過ぎて計算が済んでいない間は、新しい日を始められない', async ({ page }) => {
  const mock = mockMarket(page);
  await mock.install();
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
  await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  const lobby = page.locator('.market-lobby');
  await lobby.locator('input[placeholder="会社（店）の名前"]').fill('夜更かし亭');
  await lobby.locator('[data-create-market]').click();
  const screen = page.locator('.screen.market');
  await expect(screen.locator('[data-market-play]')).toBeEnabled();
  // 昨日（JST）に始めた日がまだ同期されていない
  const m = mock.market!;
  const yesterday = addDays(jstDateKey(Date.now()), -1);
  m.pendingPeriods = [yesterday];
  expect(syncPending(m, Date.now())).toBe(true);
  expect(jstMidnight(yesterday)).toBeLessThan(Date.now());
  await page.getByRole('button', { name: '← 市場から出る' }).click();
  await page.locator('.market-lobby [data-open-market="mk1"]').click();
  await expect(screen.locator('[data-sync]')).toHaveAttribute('data-sync', 'pending');
  await expect(screen.locator('[data-market-play]')).toBeDisabled();
});
