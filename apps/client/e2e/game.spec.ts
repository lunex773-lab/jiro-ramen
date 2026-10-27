import { expect, test, type Locator, type Page } from '@playwright/test';

const SHOTS = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
}

/** 新しいキャリアを始めて店内に入る */
async function startNewGame(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText('ひとりで経営する')).toBeVisible();
  await shot(page, '01-title');
  await page.getByText('ひとりで経営する').click();
  await page.getByRole('button', { name: '新しく始める' }).first().click();
  const input = page.locator('.modal input');
  await input.fill('テスト亭');
  await page.getByRole('button', { name: '決定' }).click();
  // 初回は遊び方が出る
  await expect(page.getByText('ラーメンができるまで')).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByRole('button', { name: /開店する/ })).toBeVisible();
}

type Jiro = {
  host: { state: { phase: string; equipment: { id: string; type: string }[]; players: { hand: { kind: string } }[]; today: { served: number } } };
  debugFace(id: string): boolean;
};

/** タッチ端末ではタップ、PC ではクリックで押す */
async function press(loc: Locator) {
  if (test.info().project.use.hasTouch) await loc.tap();
  else await loc.click();
}

async function face(page: Page, type: string) {
  const ok = await page.evaluate((t) => {
    const app = (window as unknown as { __jiro: Jiro }).__jiro;
    const e = app.host.state.equipment.find((x) => x.type === t);
    return e ? app.debugFace(e.id) : false;
  }, type);
  expect(ok).toBe(true);
  await page.waitForTimeout(400);
}

test('タイトル→新規開始→店内HUDが表示される', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await startNewGame(page);
  await expect(page.locator('.hud-top')).toContainText('1日目');
  await expect(page.locator('.hud-top')).toContainText('¥300,000');
  await page.waitForTimeout(1500);
  await shot(page, '02-shop');
  expect(errors).toEqual([]);
});

test('設備を見ると操作ボタンが出て、丼を取って並べられる', async ({ page }) => {
  await startNewGame(page);
  await face(page, 'bowl_rack');
  const take = page.locator('.act', { hasText: 'きれいな丼を取る' });
  await expect(take).toBeVisible();
  await shot(page, '03-rack');
  await press(take);
  await expect(page.locator('.hud-hand')).toContainText('きれいな丼');
  await face(page, 'assembly');
  const place = page.locator('.act', { hasText: /丼を並べる|丼を置く/ });
  await expect(place).toBeVisible();
  await press(place);
  await expect(page.locator('.hud-detail')).toContainText('盛り付け台');
  await shot(page, '04-assembly');
});

test('開店すると時計が進み、客が来店する', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: /開店する/ }).click();
  await expect(page.locator('.clock')).toContainText('11:');
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.phase), { timeout: 10_000 }).toBe('open');
  // 速度ボタンが効くこと
  await page.locator('.chip', { hasText: '×1' }).click();
  await expect(page.locator('.chip', { hasText: '×2' })).toBeVisible();
  // 客を待つ。CI では描画が遅く実時間あたりのゲーム内時間が短いので、ゲーム内時間を直接進める（最大 240 秒）
  const arrived = await page.evaluate(() => {
    const app = (window as unknown as { __jiro: { host: { state: { orders: { status: string }[] }; tick(dt: number): void; speed: number } } }).__jiro;
    for (let i = 0; i < 1200; i++) {
      if (app.host.state.orders.some((o) => o.status === 'waiting')) return true;
      app.host.tick(0.1);
    }
    return false;
  });
  expect(arrived).toBe(true);
  await expect(page.locator('.ticket').first()).toBeVisible();
  await shot(page, '05-open');
});

test('経営メニューとレイアウト編集が開ける', async ({ page }) => {
  await startNewGame(page);
  await page.locator('.chip.menu').click();
  await expect(page.locator('.manage')).toBeVisible();
  await expect(page.locator('.manage')).toContainText('本日の損益');
  await shot(page, '06-manage');
  await page.getByRole('button', { name: '在庫・発注' }).click();
  await expect(page.locator('.manage')).toContainText('仕入れ');
  await page.getByRole('button', { name: '店舗' }).click();
  await page.getByRole('button', { name: 'レイアウト編集を開く' }).click();
  await expect(page.locator('.layout-editor')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '07-layout');
  await expect(page.locator('.layout-side')).toContainText(/問題ありません|注意/);
  await page.getByRole('button', { name: '完了' }).click();
});

test('保存して再読み込みしても続きから遊べる', async ({ page }) => {
  await startNewGame(page);
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: 'セーブ・設定' }).click();
  await page.getByRole('button', { name: '今すぐ保存' }).click();
  await expect(page.locator('.toast')).toContainText('保存しました');
  await page.reload();
  await page.getByText('ひとりで経営する').click();
  await expect(page.locator('.slot-card').first()).toContainText('テスト亭');
  await page.getByRole('button', { name: '続きから' }).first().click();
  await expect(page.locator('.hud-top')).toContainText('1日目');
});
