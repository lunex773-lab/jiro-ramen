// 共通市場の画面と、端末での営業（docs/MARKET_RANKING_PLAN.md）。
// サーバーを偽物に差し替え、core の市場の規則（createMarket・marketView・startDay・commitDay・runSync）で答える。
// 端末で1日を営業すると、営業の終わり（閉店して精算したとき）にその日を送り、サーバーの確かめ方（verify）を通って受け取られることまで確かめる（じろ7 5）。
// 営業の途中のセーブ（じろ7 4）も、core の決まり（checkpointProblem・validCheckpoint）で答える。
import { expect, test, type Page } from './fixtures';
import {
  addDays,
  checkpointProblem,
  checksum,
  commitDay,
  createMarket,
  updateMarketSettings,
  finishSync,
  jstDateKey,
  joinMarket,
  jstMidnight,
  marketAction,
  marketCredit,
  type CreditOp,
  marketView,
  nextJstMidnight,
  nextSyncAt,
  periodSummary,
  playerCompany,
  retireCompany,
  runSync,
  startDay,
  syncPending,
  validCheckpoint,
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
  const commits: { ok: boolean; flags?: string[]; reject?: string[]; duplicate?: boolean }[] = [];
  /** 途中のセーブ（会社の id → 中身）と、受け取った版 */
  const cpTexts = new Map<string, string>();
  const checkpoints: number[] = [];
  /** 通信が切れたときの代わり（true の間、送信を届かなくする） */
  const net = { offline: false };
  let skew = 0;
  const now = () => Date.now() + skew;
  return {
    get market() {
      return market;
    },
    acts,
    commits,
    checkpoints,
    net,
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
        if (p === '/api/v1/market/mk1/settings') {
          const r = updateMarketSettings(market!, JSON.parse(req.postData() ?? '{}'), { by: 'u1', now: now() });
          return r.ok ? send({ ok: true, name: market!.name, settings: market!.settings, changed: r.changed }) : send({ error: r.reason, code: 'settings_refused' }, 409);
        }
        if (p === '/api/v1/market/mk1/act') {
          const b = JSON.parse(req.postData() ?? '{}') as { cid: string; action: Action };
          if (cids.has(b.cid)) return send({ ok: true, duplicate: true });
          cids.add(b.cid);
          acts.push(b.action);
          return send(marketAction(market!, 'u1', b.action, now()));
        }
        if (p === '/api/v1/market/mk1/retire') {
          const r = retireCompany(market!, 'u1', now());
          return r.ok ? send({ ok: true }) : send({ error: r.reason, code: 'retire_refused' }, 409);
        }
        if (p === '/api/v1/market/mk1/credit') {
          const b = JSON.parse(req.postData() ?? '{}') as { cid: string; op: CreditOp };
          if (cids.has(b.cid)) return send({ ok: true, duplicate: true });
          cids.add(b.cid);
          const r = marketCredit(market!, 'u1', b.op, now());
          return send(r.ok ? { ok: true, creditId: r.credit.id, status: r.credit.status } : { ok: false, reason: r.reason });
        }
        if (p === '/api/v1/market/mk1/day/start') {
          const b = JSON.parse(req.postData() ?? '{}') as { token: string; baseVersion: number };
          const r = startDay(market!, 'u1', now(), b.token, b.baseVersion);
          return r.ok ? send({ ok: true, ticket: r.ticket }) : send({ error: r.reason, code: r.code }, 409);
        }
        if (p === '/api/v1/market/mk1/day/commit' && net.offline) return route.abort('internetdisconnected');
        if (p === '/api/v1/market/mk1/day/commit') {
          const b = JSON.parse(req.postData() ?? '{}') as { token: string; state: GameState };
          const r = commitDay(market!, 'u1', now(), b.token, b.state);
          commits.push(r);
          return send({ ...r, companyId: playerCompany(market!, 'u1')?.id ?? null });
        }
        if (p === '/api/v1/market/mk1/checkpoint') {
          const c = playerCompany(market!, 'u1');
          if (req.method() === 'GET') {
            const cp = c ? validCheckpoint(c) : null;
            if (!c || !cp) return send({ ok: false, code: 'none' });
            return send({ ok: true, meta: cp, stateText: cpTexts.get(c.id) });
          }
          const b = JSON.parse(req.postData() ?? '{}') as { rev: number; baseVersion: number; token: string; sum: string; stateText: string };
          if (checksum(b.stateText) !== b.sum) return send({ error: 'corrupt', message: '中身が変わりました' }, 400);
          const st = JSON.parse(b.stateText) as GameState;
          const bad = checkpointProblem(c ?? null, b, st);
          if (bad || !c) return send({ error: bad?.code ?? 'not_member', message: bad?.reason ?? '' }, 409);
          c.checkpoint = { rev: b.rev, baseVersion: b.baseVersion, token: b.token, savedAt: now(), day: st.day, phase: st.phase, sum: b.sum, length: b.stateText.length, slot: 0 };
          cpTexts.set(c.id, b.stateText);
          checkpoints.push(b.rev);
          return send({ ok: true, rev: b.rev, savedAt: now() });
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
  // じろ6: 先頭に自分の順位・シェア・売上・企業価値（どの切り替えでも見える）
  await expect(screen.locator('.market-head [data-my-market-rank]')).toContainText('位 / 4社');
  await expect(screen.locator('.market-head .market-my-kpis')).toContainText('企業価値');
  // 決まりは「設定」の切り替え
  await screen.locator('[data-market-tab="settings"]').click();
  await expect(screen.locator('.market-rules')).toContainText('4社まで');
  expect(mock.market!.settings.cityCode).toBe('27100');
  expect(mock.market!.companies.every((c) => c.state.company.stores[0]!.location === '27100')).toBe(true);
  await expect(screen.locator('.market-rules')).toContainText('大阪府 大阪市');
  // 出店の範囲（じろ1 Q13）: はじめは市場の街。次の「同じ都道府県」の条件の様子が出る（「出店と採用」の切り替え）
  await screen.locator('[data-market-tab="grow"]').click();
  const range = screen.locator('[data-market-range="city"]');
  await expect(range).toContainText('出店の範囲: 市場の街');
  await expect(range.locator('[data-range-check="cityStores"]')).toContainText('市場の街に2店以上（今 1店）');
  await expect(range.locator('[data-range-check="share"]')).toBeVisible();
  // 市場の画面: 地図で出店先を見る（市場の街を開いた状態で始まる。駅前・住宅街・郊外の3か所。ほかの市区町村へも移れる。じろ1 Q11）
  await screen.locator('[data-market-open-map]').click();
  const siteMap = page.locator('[data-store-map]');
  await expect(siteMap.locator('[data-muni="27100"]')).toHaveClass(/selected/);
  await expect(siteMap.locator('[data-muni]').nth(1)).toBeAttached();
  await expect(siteMap.locator('[data-site]')).toHaveCount(3);
  // 出店の範囲（じろ1 Q13）: はじめは市場の街の中だけ
  await expect(siteMap).toContainText('出店の範囲: 市場の街');
  await siteMap.locator('[data-map-site="station"] button').click();
  await expect(siteMap.locator('[data-map-site="station"]')).toContainText('空き');
  await expect(siteMap.locator('[data-map-site="station"]')).toContainText('競合 同じ場所');
  await expect(siteMap.locator('[data-map-confirm]')).toBeDisabled();
  await siteMap.locator('[data-map-close]').click();
  await expect(siteMap).toHaveCount(0);
  // 屋号を変える（市場の会社の名前も変わる。「自社」の切り替え）
  await screen.locator('[data-market-tab="mine"]').click();
  await screen.locator('[data-rename-shop]').fill('テスト亭 本舗');
  await screen.locator('[data-rename-shop-ok]').click();
  await expect.poll(() => mock.market!.companies[0]!.name).toBe('テスト亭 本舗');
  await screen.locator('[data-market-tab="rank"]').click();
  await expect(screen.locator('.market-standings .trow.mine')).toContainText('テスト亭 本舗（あなた）');
  expect(mock.acts.map((a) => a.type)).toContain('rename');
  await shot(page, '60-market');
  // 営業していない間の経営: 本店の方針の値段を定価の90%にする（サーバーへ操作を送る）
  const storeId = mock.market!.companies[0]!.state.company.stores[0]!.id;
  await screen.locator('[data-market-tab="mine"]').click();
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
  // 営業の終わり（閉店して精算したとき）に、その日の結果を確定して送る（確かめて受け取られる。じろ7 5）。「翌日の仕込みへ」を押す前に届く
  await expect.poll(() => mock.commits.length).toBe(1);
  expect(mock.commits[0]!.reject ?? []).toEqual([]);
  expect(mock.commits[0]!.ok).toBe(true);
  expect(mock.commits[0]!.flags ?? []).toEqual([]);
  const me = () => playerCompany(mock.market!, 'u1')!;
  expect(me().progress.lastProcessedGameDate).toBe(1);
  expect(me().progress.manualProgressDays).toBe(1);
  expect(me().state.phase).toBe('closed');
  expect(me().state.finalizedDay).toBe(1);
  await expect(page.locator('[data-send-status]')).toHaveAttribute('data-send-status', 'done');
  await expect(page.locator('[data-send-status]')).toContainText('確定済み');
  await shot(page, '61a-market-sent');
  // 送ったあと、2日目の条件をもらう。「翌日の仕込みへ」で端末の2日目へ（もう一度は送らない）
  await expect.poll(() => me().openDay?.gameDate ?? null).toBe(2);
  await page.getByRole('button', { name: '翌日の仕込みへ →' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.day)).toBe(2);
  expect(mock.commits).toHaveLength(1);
  await shot(page, '61-market-play');
  // 営業の途中のセーブ（じろ7 4）: 経営メニューの「☁ クラウドに保存」でサーバーへ（次の日へ進んだときにも自動で保存する）
  await expect.poll(() => mock.checkpoints.length).toBeGreaterThan(0);
  const savedBefore = mock.checkpoints.length;
  await page.evaluate(() => {
    const h = (window as unknown as { __jiro: Jiro }).__jiro.host;
    h.state.money += 0; // 状態の版を進めるための操作の代わりに、仕込みの時間を少し進める
    h.tick(0.5);
  });
  await page.locator('.chip.menu').click();
  await page.locator('.manage .tab[data-tab="system"]').click();
  await page.locator('[data-market-save] button', { hasText: '☁ クラウドに保存' }).click();
  await expect.poll(() => mock.checkpoints.length).toBeGreaterThan(savedBefore);
  await expect(page.locator('[data-cloud-status]')).toHaveAttribute('data-cloud-status', 'saved');
  await page.getByRole('button', { name: /閉じる/ }).first().click();
  // 営業中の経営メニューの「会社」に、企業間の貸し借り（オーナーの指示 2026-11-11）
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '会社', exact: true }).click();
  await expect(page.locator('.manage-body [data-market-credit=""]')).toContainText('貸し出しを申し込む');
  await page.getByRole('button', { name: /閉じる/ }).first().click();

  // 市場の画面へ戻る（途中の状態を保存してから戻る）。もう一度始めると、途中のセーブ（2日目の仕込み）から続ける
  const marker = await page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.t);
  void page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.returnToTitle());
  await page.getByRole('button', { name: '市場の画面に戻る' }).click();
  await expect(screen.locator('[data-market-play]')).toBeVisible();
  await screen.locator('[data-market-play]').click();
  await expect(page.locator('.hud-top')).toBeVisible();
  await expect(page.locator('.toast').filter({ hasText: '途中のセーブ' })).toBeVisible();
  const resumed = await page.evaluate(() => {
    const s = (window as unknown as { __jiro: Jiro }).__jiro.host.state;
    return { day: s.day, phase: s.phase, t: s.t };
  });
  expect(resumed.day).toBe(2);
  expect(resumed.phase).toBe('prep');
  expect(resumed.t).toBeGreaterThanOrEqual(marker - 0.01);
  void page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.returnToTitle());
  await page.getByRole('button', { name: '市場の画面に戻る' }).click();
  await expect(screen.locator('[data-leader-day]')).toHaveText('1日目まで');
  await screen.locator('[data-market-tab="rank"]').click();
  await expect(screen.locator('.market-standings .trow.mine [data-progress]')).toContainText('1日目まで（今日 手動1日）');
  // 端末で2日目を営業中でも、市場の画面から経営の操作ができる（オーナーの指示 2026-11-11）
  await expect(screen.locator('[data-playing-note]')).toContainText('2日目を営業中');
  await screen.locator('[data-market-tab="mine"]').click();
  await screen.locator(`[data-price="${storeId}"]`).selectOption('1.1');
  await expect.poll(() => mock.market!.companies[0]!.state.company.stores[0]!.policy.priceMult).toBe(1.1);

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

test('共通市場: 営業の終わりに送れないときは送信待ちとして端末に残し、通信が戻ると同じ日を一度だけ送る（じろ7 5-4・5-5）', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = mockMarket(page);
  await mock.install();
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
  await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  await page.locator('.market-lobby input[placeholder="会社（店）の名前"]').fill('圏外亭');
  await page.locator('.market-lobby [data-create-market]').click();
  const screen = page.locator('.screen.market');
  await screen.locator('[data-market-play]').click();
  await expect(page.locator('.hud-top')).toBeVisible();
  // 通信が切れた状態で1日を営業して閉店する
  mock.net.offline = true;
  await page.evaluate(async () => {
    const h = (window as unknown as { __jiro: Jiro }).__jiro.host;
    await h.act({ type: 'openShop' });
    h.speed = 3;
    for (let i = 0; i < 40_000 && h.state.phase !== 'closed'; i++) h.tick(0.25);
  });
  const status = page.locator('[data-send-status]');
  await expect(status).toHaveAttribute('data-send-status', 'pending');
  await expect(status).toContainText('送信待ち');
  // 端末に残っている（画面を閉じても消えない）
  expect(await page.evaluate(() => !!localStorage.getItem('jiro.market.pending.mk1'))).toBe(true);
  expect(mock.commits).toHaveLength(0);
  // 送れるまで次の日へは進めない
  await page.getByRole('button', { name: '翌日の仕込みへ →' }).click();
  await expect(page.locator('.toast').filter({ hasText: '送信待ち' }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.day)).toBe(1);
  await shot(page, '63-market-pending');
  // 通信が戻る → 「もう一度送る」で送る（同じ日の ID なので、何度送っても一度だけ数える）
  mock.net.offline = false;
  await status.locator('[data-send-retry]').click();
  await expect(status).toHaveAttribute('data-send-status', 'done');
  expect(mock.commits).toHaveLength(1);
  expect(mock.commits[0]!.ok).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('jiro.market.pending.mk1'))).toBeNull();
  const me = playerCompany(mock.market!, 'u1')!;
  expect(me.progress.manualProgressDays).toBe(1);
  await page.getByRole('button', { name: '翌日の仕込みへ →' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.day)).toBe(2);
  expect(playerCompany(mock.market!, 'u1')!.progress.manualProgressDays).toBe(1);
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

test('共通市場: 作った人は、あとから市場の名前・公開・会社の数の上限を変えられる', async ({ page }) => {
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
  await lobby.locator('input[placeholder="会社（店）の名前"]').fill('設定亭');
  await lobby.locator('[data-create-market]').click();
  const screen = page.locator('.screen.market');
  await screen.locator('[data-market-tab="settings"]').click();
  await expect(screen.locator('[data-edit-market]')).toBeVisible();
  await screen.locator('[data-edit-market]').click();
  const dlg = page.locator('.modal');
  await dlg.locator('[data-edit-name]').fill('名前を変えた市場');
  await dlg.locator('[data-edit-visibility]').selectOption('public');
  await dlg.locator('[data-edit-max]').selectOption('4');
  await expect(dlg.getByRole('button', { name: '次へ' })).toBeInViewport({ ratio: 1 });
  await dlg.getByRole('button', { name: '次へ' }).click();
  // 変える内容の確認（じろ2）
  const confirm = page.locator('.modal');
  await expect(confirm).toContainText('会社の数の上限: 6社 → 4社');
  await expect(confirm).toContainText('公開: 招待コードだけ → 公開');
  await confirm.getByRole('button', { name: '変更する' }).click();
  await expect(screen.locator('.market-head h2')).toHaveText('名前を変えた市場');
  // 変更の記録（いつ・誰が・何を）
  await expect(screen.locator('[data-settings-log]')).toContainText('市場の名前');
  expect(mock.market!.settings).toMatchObject({ visibility: 'public', maxCompanies: 4 });
  // AI で埋める市場なので、上限を4社にすると AI 企業が撤退して4社になる
  expect(mock.market!.companies.filter((c) => c.status === 'active').length).toBe(4);
});

test('共通市場: 銀行の融資は額を選べる。企業間の貸し借り: 申し込み → 相手の承認 → 前倒しで返す。競争中でも市場を抜けられる', async ({ page }) => {
  test.setTimeout(90_000);
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
  await lobby.locator('input[placeholder="会社（店）の名前"]').fill('貸し亭');
  await lobby.locator('[data-create-market]').click();
  const screen = page.locator('.screen.market');
  // じろ6: 貸し借りは「貸し借り」、銀行の融資は「自社」の切り替え
  await screen.locator('[data-market-tab="credit"]').click();
  await expect(screen.locator('[data-market-credit]')).toBeVisible();
  // 銀行の融資: 5万円刻みで選ぶ（日報がないので返済能力は最低の20万円）
  await screen.locator('[data-market-tab="mine"]').click();
  await expect(screen.locator('[data-loan-amount] option')).toHaveCount(4);
  await screen.locator('[data-loan-amount]').selectOption('100000');
  await screen.locator('[data-take-loan]').click();
  await page.locator('.modal').getByRole('button', { name: '借りる' }).click();
  await expect.poll(() => playerCompany(mock.market!, 'u1')!.state.loans.map((l) => l.principal)).toEqual([100_000]);
  // ほかのプレイヤーが入る（サーバーの代わりに core で）
  expect(joinMarket(mock.market!, 'u2', '借り軒').ok).toBe(true);
  await screen.getByRole('button', { name: '← 市場から出る' }).click();
  await page.locator('.market-lobby [data-open-market]').first().click();
  // 借入の総額と返済の残りを分けて出す
  await screen.locator('[data-market-tab="mine"]').click();
  await expect(screen.locator('[data-loan-summary]')).toContainText('借入の総額（借りた額）¥100,000');
  await screen.locator('[data-market-tab="credit"]').click();
  const credit = page.locator('.screen.market [data-market-credit]');
  await credit.locator('[data-credit-to]').selectOption({ label: '借り軒' });
  await credit.locator('[data-credit-amount]').selectOption('50000');
  await credit.locator('[data-credit-offer]').click();
  await expect(page.locator('.modal')).toContainText('借り軒に ¥50,000 を貸す申し込み');
  await page.locator('.modal').getByRole('button', { name: '申し込む' }).click();
  await expect(credit.locator('[data-credit-status="offered"]')).toContainText('返事待ち');
  // 相手が承認する（サーバーの代わりに core で）→ 画面にお金が動いた状態が出る
  const id = mock.market!.credits![0]!.id;
  expect(marketCredit(mock.market!, 'u2', { op: 'accept', creditId: id }, Date.now()).ok).toBe(true);
  await screen.getByRole('button', { name: '← 市場から出る' }).click();
  await page.locator('.market-lobby [data-open-market]').first().click();
  await screen.locator('[data-market-tab="credit"]').click();
  await expect(page.locator('.screen.market [data-credit-status="active"]')).toContainText('返している最中');
  await expect(page.locator('.screen.market [data-credit-book]')).toContainText('貸している ¥50,000');
  await page.locator('.screen.market [data-market-credit]').scrollIntoViewIfNeeded();
  await shot(page, '62-market-credit');
  // 競争中でも市場を抜けられる（引退）。危ない操作は「設定」のいちばん下
  await screen.locator('[data-market-tab="settings"]').click();
  await page.locator('.screen.market [data-retire]').click();
  await expect(page.locator('.modal')).toContainText('この市場の記録と順位は残ります');
  await page.locator('.modal').getByRole('button', { name: '抜ける' }).click();
  await expect(page.locator('.screen.market [data-my-status="retired"]')).toBeVisible();
  // 借りていた会社ではないので、貸したお金はそのまま（借り手が抜けたときは返せるだけ返して終わり）
  expect(mock.market!.credits![0]!.status).toBe('active');
});
