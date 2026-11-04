// オンライン市場の画面（Phase 3+4）。サーバーを偽物に差し替え、core の市場の規則（createMarket・marketView・marketAction）で答える。
import { expect, test, type Page } from '@playwright/test';
import { advanceMarketTo, createMarket, marketAction, marketView, type Action, type MarketState } from '@jiro/core';

const SERVER = 'https://mock.jiro.test';
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
};

function mockMarket(page: Page) {
  let market: MarketState | null = null;
  const DAY_MS = 600_000;
  const start = Date.now();
  const cids = new Set<string>();
  const acts: Action[] = [];
  return {
    get market() {
      return market;
    },
    acts,
    async install() {
      await page.route(`${SERVER}/api/v1/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const send = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const p = url.pathname;
        if (p === '/api/v1/auth/anonymous') return send({ playerId: 'u1', token: 'tok' });
        if (p === '/api/v1/profile') return send({ playerId: 'u1', name: 'テスター' });
        if (p === '/api/v1/markets') return send({ markets: market ? [{ marketId: 'mk1', code: 'MKT234', name: market.name, createdAt: start, isOwner: true }] : [] });
        if (p === '/api/v1/market/create') {
          const b = JSON.parse(req.postData() ?? '{}') as { name?: string; companyName: string };
          market = createMarket({ id: 'mk1', name: b.name || 'テストの市場', seed: 4242, creator: { ownerId: 'u1', companyName: b.companyName } });
          // 3日分すでに進んでいる（サーバーの時計）
          advanceMarketTo(market, 4);
          return send({ marketId: 'mk1', code: 'MKT234', name: market.name }, 201);
        }
        if (p === '/api/v1/market/mk1/act') {
          const b = JSON.parse(req.postData() ?? '{}') as { cid: string; action: Action };
          if (cids.has(b.cid)) return send({ ok: true, duplicate: true });
          cids.add(b.cid);
          acts.push(b.action);
          return send(marketAction(market!, 'u1', b.action));
        }
        if (p === '/api/v1/market/mk1') {
          const v = marketView(market!, 'u1');
          const now = Date.now();
          return send({ ...v, clock: { day: v.day, dayMs: DAY_MS, nextDayAt: now + 125_000, serverNow: now }, code: 'MKT234', isOwner: true, joined: true });
        }
        return send({ error: 'not_found', message: 'not found' }, 404);
      });
    },
  };
}

test('オンライン市場: 市場を作ると AI 企業と同じ街で始まり、順位・招待コード・次の日までの時間・AI の判断が見え、値段を変えられる', async ({ page }) => {
  const mock = mockMarket(page);
  await mock.install();
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  const lobby = page.locator('.market-lobby');
  await lobby.locator('input.input').first().fill(SERVER);
  await lobby.locator('input[placeholder="会社（店）の名前"]').fill('テスト亭');
  await lobby.locator('[data-create-market]').click();
  // 市場の画面
  const screen = page.locator('.screen.market');
  await expect(screen.locator('.market-head')).toContainText('テストの市場');
  await expect(screen.locator('.market-head .room-code')).toHaveText('MKT234');
  await expect(screen.locator('[data-market-day]')).toHaveText('3日目まで営業済み');
  await expect(screen.locator('.market-head')).toContainText('次の日まで');
  const rows = screen.locator('.market-standings .trow[data-company]');
  await expect(rows).toHaveCount(6);
  await expect(screen.locator('.market-standings .trow.mine')).toContainText('テスト亭（あなた）');
  await expect(screen.locator('.market-standings')).toContainText('AI・');
  await expect(screen.locator('.market-mine')).toContainText('あなたの会社: テスト亭');
  await expect(screen.locator('.store-card').first()).toContainText('店主（あなた）が営業');
  await expect(screen.locator('.market-log')).toContainText('日目');
  await shot(page, '60-market');
  // 本店の値段を定価の90%にする（サーバーへ操作を送る）
  const storeId = mock.market!.companies[0]!.state.company.stores[0]!.id;
  await screen.locator(`[data-price="${storeId}"]`).selectOption('0.9');
  await expect.poll(() => mock.market!.companies[0]!.state.company.stores[0]!.policy.priceMult).toBe(0.9);
  expect(mock.acts.map((a) => a.type)).toContain('setStorePolicy');
  await expect(screen.locator(`[data-price="${storeId}"]`)).toHaveValue('0.9');
  // 市場から出ると入口に戻り、参加している市場が並ぶ
  await page.getByRole('button', { name: '← 市場から出る' }).click();
  await expect(page.locator('.market-lobby [data-open-market="mk1"]')).toBeVisible();
});
