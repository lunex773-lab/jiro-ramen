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
  // 操作ボタンは小さな丸（絵文字＋短い名前）。正式な名前は読み上げ名（aria-label）
  const take = page.locator('.act[aria-label^="きれいな丼を取る"]');
  await expect(take).toContainText('丼取る');
  await expect(take).toBeVisible();
  await shot(page, '03-rack');
  await press(take);
  await expect(page.locator('.hud-hand')).toContainText('きれいな丼');
  await face(page, 'assembly');
  const place = page.locator('.act[aria-label^="丼を並べる"], .act[aria-label^="丼を置く"]');
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

test.describe('縦向きのスマホ（回転ロック中など）', () => {
  // 横画面専用。縦向きの画面では表示ごと 90° 回して横画面にし、そのまま遊べる（端末を左に倒して持つ）
  test.use({ viewport: { width: 390, height: 664 } });
  const viewOf = (page: Page) =>
    page.locator('.app').evaluate((el) => ({ rotated: el.classList.contains('rotated'), w: el.clientWidth, h: el.clientHeight }));

  test('縦向きの画面では表示を回して横画面にし、横にすると元に戻る', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await page.goto('/');
    expect(await viewOf(page)).toEqual({ rotated: true, w: 664, h: 390 });
    // 回した表示が画面にぴったり収まる
    const box = (await page.locator('.app').boundingBox())!;
    expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([0, 0, 390, 664]);
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
    await shot(page, '00-portrait-title');
    await page.setViewportSize({ width: 750, height: 342 });
    await expect.poll(() => viewOf(page)).toEqual({ rotated: false, w: 750, h: 342 });
  });

  test('回した表示のまま、ボタンを押して遊べ、指の操作の向きも合う', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await startNewGame(page);
    expect((await viewOf(page)).rotated).toBe(true);
    await face(page, 'bowl_rack');
    const take = page.locator('.act[aria-label^="きれいな丼を取る"]');
    await press(take);
    await expect(page.locator('.hud-hand')).toContainText('きれいな丼');
    await shot(page, '00-portrait-shop');
    // 本物のタッチを送る。表示の左側（画面では上側）を押して、表示の上（画面では右）へなぞると前に進む
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    const controls = () => page.evaluate(() => {
      const c = (window as unknown as { __jiro: { controls: { forward: number; strafe: number } } }).__jiro.controls;
      return { forward: c.forward, strafe: c.strafe };
    });
    await touch('touchStart', 200, 120);
    await touch('touchMove', 230, 120);
    await touch('touchMove', 260, 120);
    await expect.poll(async () => (await controls()).forward).toBeGreaterThan(0.5);
    expect(Math.abs((await controls()).strafe)).toBeLessThan(0.2);
    await touch('touchEnd', 0, 0);
    await expect.poll(async () => (await controls()).forward).toBe(0);
  });
});

test.describe('共同経営', () => {
  // サーバーを偽物に差し替えて、ルームを作ってから参加コードが見えるまでを確かめる
  const SERVER = 'https://mock.jiro.test';
  const CODE = 'ABC234';

  test('ルームを作ると参加コードを大きく表示し、店の中でも上部にいつも出ている', async ({ page }) => {
    await page.route(`${SERVER}/api/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const bodies: Record<string, unknown> = {
        '/api/v1/game-version': { gameVersion: '0.9.0', minClientVersion: '0.1.0', protocol: 1 },
        '/api/v1/auth/anonymous': { playerId: 'u1', token: 'tok' },
        '/api/v1/session/create': { roomId: 'room1', code: CODE, joinToken: 'jt' },
        '/api/v1/session/leave': { ended: true },
      };
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(bodies[url.pathname] ?? {}) });
    });
    await page.routeWebSocket(/mock\.jiro\.test\/api\/v1\/room\//, (ws) => {
      const peers = { t: 'peers', list: [{ id: 'p1', name: '店主', color: '#f2c200', connected: true, isHost: true }] };
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { t: string; state?: unknown };
        if (msg.t === 'hello') ws.send(JSON.stringify({ t: 'welcome', playerId: 'p1', roomId: 'room1', isHost: true, protocol: 1, needInit: true }));
        if (msg.t === 'hostInit') {
          ws.send(JSON.stringify({ t: 'full', seq: 0, state: msg.state }));
          ws.send(JSON.stringify(peers));
        }
      });
    });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.getByRole('button', { name: /オンライン共同経営/ }).click();
    await page.locator('.lobby input.input').first().fill(SERVER);
    await page.getByRole('button', { name: 'ルームを作成' }).click();
    // 待機画面: 参加コードを大きく表示
    await expect(page.locator('.room-wait .room-code')).toHaveText(CODE);
    await expect(page.locator('.room-wait')).toContainText('参加中 1人');
    await shot(page, '20-room-wait');
    await page.getByRole('button', { name: '店に入る' }).click();
    // 店の中: 上部にいつも参加コード。押すと大きく表示
    const chip = page.locator('.chip.conn');
    await expect(chip).toContainText(`コード ${CODE}`);
    await chip.click();
    await expect(page.locator('.modal .room-code')).toHaveText(CODE);
    await shot(page, '21-room-code');
    await page.locator('.modal').getByRole('button', { name: '閉じる' }).click();
    await expect(page.locator('.modal')).toBeHidden();
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
    const slice = page.locator('.act[aria-label="豚を切る"]');
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
