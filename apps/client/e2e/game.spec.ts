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
  // チュートリアルを受けるか聞かれる（ここではスキップ）
  await page.getByRole('button', { name: 'スキップして1日目から' }).click();
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

test.describe('縦向きのスマホ', () => {
  // 横向き専用なので、縦向きでは案内を出してゲームを止める
  test.use({ viewport: { width: 390, height: 664 } });

  test('縦向きでは「横向きにしてください」が出て、横にすると消える', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await page.goto('/');
    const hint = page.locator('.rotate-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('横向きにしてください');
    await shot(page, '00-portrait');
    await page.setViewportSize({ width: 750, height: 342 });
    await expect(hint).toBeHidden();
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
  });

  test('縦向きの間はゲームの時間が止まる', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await page.setViewportSize({ width: 750, height: 342 });
    await startNewGame(page);
    await page.getByRole('button', { name: /開店する/ }).click();
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.phase)).toBe('open');
    await page.setViewportSize({ width: 390, height: 664 });
    await expect(page.locator('.rotate-hint')).toBeVisible();
    const t0 = await page.evaluate(() => (window as unknown as { __jiro: { host: { state: { t: number } } } }).__jiro.host.state.t);
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => (window as unknown as { __jiro: { host: { state: { t: number } } } }).__jiro.host.state.t);
    expect(t1).toBe(t0);
  });
});

test.describe('チュートリアル', () => {
  type TutJiro = Jiro & { host: { state: { day: number; tutorial: { step: number; finished: boolean } | null; equipment: { id: string; type: string }[] } } };
  const tut = (page: Page) => page.evaluate(() => (window as unknown as { __jiro: TutJiro }).__jiro.host.state.tutorial);

  test('新しく始めるときに選ぶと営業0日目の案内が出て、操作で手順が進み、やめると1日目になる', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByText('ひとりで経営する').click();
    await page.getByRole('button', { name: '新しく始める' }).first().click();
    await page.locator('.modal input').fill('練習亭');
    await page.getByRole('button', { name: '決定' }).click();
    await page.getByRole('button', { name: 'チュートリアルから始める' }).click();
    const panel = page.locator('.tutorial-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('ようこそ');
    await expect(page.locator('.hud-top')).toContainText('0日目');
    await shot(page, '10-tutorial-welcome');
    await press(panel.getByRole('button', { name: 'はじめる' }));
    await expect(panel).toContainText('移動と視点');
    // 歩くと次へ（ここでは仕込み台の前へ移動させる）
    await face(page, 'prep_table');
    await expect(panel).toContainText('豚を切る');
    await page.waitForTimeout(600);
    await shot(page, '11-tutorial-prep');
    // 長押しで豚を切ると、経営メニューの手順へ
    const slice = page.locator('.act', { hasText: '豚を切る' });
    await expect(slice).toBeVisible();
    const box = (await slice.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // 押している間に、描画の速さに左右されないようゲーム内時間を進める（作業は6秒）
    await expect(page.locator('.work-bar')).toBeVisible();
    await page.evaluate(() => {
      const host = (window as unknown as { __jiro: { host: { tick(dt: number): void } } }).__jiro.host;
      for (let i = 0; i < 80; i++) host.tick(0.1);
    });
    await expect(panel).toContainText('在庫と発注');
    await page.mouse.up();
    // 「☰ 経営」が目立ち、在庫・発注タブを開くと次へ
    await expect(page.locator('.chip.menu')).toHaveClass(/tut-pulse/);
    await page.locator('.chip.menu').click();
    await page.getByRole('button', { name: '在庫・発注' }).click();
    await expect(panel).toContainText('どれか1つ仕入れて');
    await expect(panel).toHaveClass(/docked/);
    await shot(page, '12-tutorial-stock');
    // やめると、練習をリセットして1日目から
    await panel.getByRole('button', { name: 'やめる' }).click();
    await page.getByRole('button', { name: 'やめる' }).last().click();
    await expect(page.locator('.hud-top')).toContainText('1日目');
    expect(await tut(page)).toBeNull();
    await expect(panel).toBeHidden();
  });

  test('3日目に従業員のチュートリアルを受けるか聞かれ、雇わずに終えられる', async ({ page }) => {
    await startNewGame(page);
    // 3日目のセーブを作って続きから始める
    await page.evaluate(() => {
      const app = (window as unknown as { __jiro: { host: { state: { day: number } }; saveNow(n: boolean): void } }).__jiro;
      app.host.state.day = 3;
      app.saveNow(false);
    });
    await page.reload();
    await page.getByText('ひとりで経営する').click();
    await page.getByRole('button', { name: '続きから' }).first().click();
    await expect(page.locator('.modal')).toContainText('従業員のチュートリアル');
    await page.getByRole('button', { name: '受ける' }).click();
    const panel = page.locator('.tutorial-panel');
    await expect(panel).toContainText('従業員を雇う');
    await press(panel.getByRole('button', { name: 'はじめる' }));
    await expect(page.locator('.chip.menu')).toHaveClass(/tut-pulse/);
    await page.locator('.chip.menu').click();
    await page.getByRole('button', { name: '従業員' }).click();
    await expect(panel).toContainText('候補者の見方');
    await shot(page, '13-tutorial-staff');
    await panel.getByRole('button', { name: '次へ' }).click();
    await panel.getByRole('button', { name: '今は雇わない' }).click();
    await expect(panel).toContainText('またいつでも');
    await panel.getByRole('button', { name: 'わかった' }).click();
    await expect(panel).toBeHidden();
    expect(await tut(page)).toBeNull();
  });

  test('タイトルの「チュートリアル」から始めて、やめるとタイトルに戻る', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /チュートリアル/ }).click();
    await expect(page.locator('.tutorial-panel')).toContainText('ようこそ');
    await page.locator('.tutorial-panel').getByRole('button', { name: 'やめる' }).click();
    await page.getByRole('button', { name: 'やめる' }).last().click();
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
  });
});
