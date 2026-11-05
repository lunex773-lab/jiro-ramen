import { expect, test, type Locator, type Page } from '@playwright/test';

const SHOTS = process.env.SHOTS_DIR;

// ページ内の例外・エラーをテストの出力に出す（CI で失敗したときに原因を追えるように）
test.beforeEach(({ page }) => {
  page.on('pageerror', (e) => console.log(`[pageerror] ${test.info().title}: ${e.message}\n${e.stack ?? ''}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log(`[console.error] ${test.info().title}: ${m.text()}`);
  });
});

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
}

/** 新しいキャリアを始めて店内に入る */
async function startNewGame(page: Page, path = '/') {
  await page.goto(path);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByText('ひとりで経営する')).toBeVisible();
  await closeHomeTip(page);
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

/** 縦向きの画面（表示を回している Safari）で最初に出る「ホーム画面に追加」の案内を閉じる */
async function closeHomeTip(page: Page) {
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
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

test('経営メニューで屋号（店名）を変えられる（空の名前は受け付けない）', async ({ page }) => {
  await startNewGame(page);
  await page.locator('.chip.menu').click();
  const manage = page.locator('.manage');
  await expect(manage.locator('.rename-card')).toBeVisible();
  const input = manage.locator('[data-rename-shop]');
  await input.fill('  麺処 テスト二郎  ');
  await manage.locator('[data-rename-shop-ok]').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: { host: { state: { shopName: string } } } }).__jiro.host.state.shopName)).toBe('麺処 テスト二郎');
  await expect(manage.locator('[data-rename-shop]')).toHaveValue('麺処 テスト二郎');
  // 空の名前は受け付けない（元の名前に戻る）
  await manage.locator('[data-rename-shop]').fill('   ');
  await manage.locator('[data-rename-shop]').press('Enter');
  await expect(manage.locator('[data-rename-shop]')).toHaveValue('麺処 テスト二郎');
  expect(await page.evaluate(() => (window as unknown as { __jiro: { host: { state: { shopName: string } } } }).__jiro.host.state.shopName)).toBe('麺処 テスト二郎');
  await shot(page, '08-rename');
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
    // Safari で回して表示しているときは、一度だけ全画面で遊ぶ方法を案内する
    await expect(page.locator('.modal')).toContainText('ホーム画面に追加');
    await page.getByRole('button', { name: 'わかった' }).click();
    await page.reload();
    await expect(page.locator('.modal')).toHaveCount(0);
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

  test('回した表示のまま、経営メニューを指の向きどおりにスクロールできる', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await startNewGame(page);
    await page.locator('.chip.menu').click();
    await page.getByRole('button', { name: '在庫・発注' }).click();
    const body = page.locator('.manage-body');
    await expect(body).toContainText('仕入れ');
    const top0 = await body.evaluate((el) => el.scrollTop);
    // 表示の上へなぞる（画面では右へ）と、下の行が見えるようにスクロールする
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 100, y: 330, id: 3 }] });
    for (let x = 120; x <= 260; x += 20) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: 330, id: 3 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeGreaterThan(top0 + 100);
  });

  test('指を離した合図が届かなくても歩き続けず、次のタッチで視点が飛ばない', async ({ page }) => {
    test.skip(!test.info().project.use.hasTouch, 'タッチ端末だけの動作');
    await startNewGame(page);
    // 遊び方の画面を閉じた後、操作の受付が戻るのを待つ（この環境は描画が遅い）
    await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: { controls: { enabled: boolean } } }).__jiro.controls.enabled)).toBe(true);
    // Safari がタッチを途中で取ったときのように、touchend を送らずに指が消えた状態を作る
    const r = await page.evaluate(() => {
      const app = (window as unknown as { __jiro: { controls: { forward: number; yaw: number; update(): void } } }).__jiro;
      const canvas = document.querySelector('canvas.game-canvas')!;
      const fire = (type: string, target: EventTarget, points: { id: number; x: number; y: number }[], changed: { id: number; x: number; y: number }[]) => {
        const mk = (p: { id: number; x: number; y: number }) => new Touch({ identifier: p.id, target, clientX: p.x, clientY: p.y });
        target.dispatchEvent(new TouchEvent(type, { touches: points.map(mk), changedTouches: changed.map(mk), bubbles: true, cancelable: true }));
      };
      const joy = { id: 7, x: 200, y: 120 };
      fire('touchstart', canvas, [joy], [joy]);
      const moved = { id: 7, x: 260, y: 120 };
      fire('touchmove', canvas, [moved], [moved]);
      app.controls.update();
      const walking = app.controls.forward;
      // 指7の touchend は来ないまま、別の指（ボタンの上）が触れる → 画面に残っている指と照合して離したことにする
      fire('touchstart', document.body, [{ id: 8, x: 10, y: 10 }], [{ id: 8, x: 10, y: 10 }]);
      app.controls.update();
      const after = app.controls.forward;
      // 視点: 1回で大きく動いた合図は使わない
      const look = { id: 9, x: 300, y: 600 };
      fire('touchstart', canvas, [look], [look]);
      const yaw0 = app.controls.yaw;
      fire('touchmove', canvas, [{ id: 9, x: 300, y: 100 }], [{ id: 9, x: 300, y: 100 }]);
      const jump = Math.abs(app.controls.yaw - yaw0);
      fire('touchmove', canvas, [{ id: 9, x: 300, y: 80 }], [{ id: 9, x: 300, y: 80 }]);
      const small = Math.abs(app.controls.yaw - yaw0);
      return { walking, after, jump, small };
    });
    expect(r.walking).toBeGreaterThan(0.5);
    expect(r.after).toBe(0);
    expect(r.jump).toBe(0);
    expect(r.small).toBeGreaterThan(0);
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

test.describe('共同経営のゲスト', () => {
  const SERVER = 'https://mock.jiro.test';
  const CODE = 'XYZ789';

  test('ゲストは経営メニューを閲覧専用で開け、操作ボタンは押せず、経営の操作を送らない', async ({ page }) => {
    // ひとりプレイで作った店の状態に、ゲストを足して偽のサーバーから配る
    await startNewGame(page);
    const state = await page.evaluate(() => {
      const s = JSON.parse(JSON.stringify((window as unknown as { __jiro: { host: { state: unknown } } }).__jiro.host.state)) as { players: Record<string, unknown>[]; prepSnapshot?: unknown };
      s.players.push({ ...s.players[0], id: 'g1', name: 'ゲスト', isHost: false, color: '#2e86de' });
      delete s.prepSnapshot;
      return s;
    });
    const sent: string[] = [];
    await page.route(`${SERVER}/api/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const bodies: Record<string, unknown> = {
        '/api/v1/game-version': { gameVersion: '0.9.0', minClientVersion: '0.1.0', protocol: 1 },
        '/api/v1/auth/anonymous': { playerId: 'u2', token: 'tok2' },
        '/api/v1/session/join': { roomId: 'room1', joinToken: 'jt2', isHost: false },
        '/api/v1/session/leave': { ended: false },
      };
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(bodies[url.pathname] ?? {}) });
    });
    await page.routeWebSocket(/mock\.jiro\.test\/api\/v1\/room\//, (ws) => {
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { t: string; rid?: string; a?: { type: string } };
        if (msg.t === 'hello') {
          ws.send(JSON.stringify({ t: 'welcome', playerId: 'g1', roomId: 'room1', isHost: false, protocol: 1, needInit: false }));
          ws.send(JSON.stringify({ t: 'full', seq: 0, state }));
          ws.send(JSON.stringify({ t: 'peers', list: [{ id: 'p1', name: '店主', color: '#e74c3c', connected: true, isHost: true }, { id: 'g1', name: 'ゲスト', color: '#2e86de', connected: true, isHost: false }] }));
        }
        if (msg.t === 'act' && msg.a && msg.a.type !== 'move') {
          sent.push(msg.a.type);
          ws.send(JSON.stringify({ t: 'res', rid: msg.rid, r: { ok: false, reason: 'ホストだけが実行できる操作です' } }));
        }
      });
    });
    await page.goto('/');
    await closeHomeTip(page);
    await page.getByRole('button', { name: /オンライン共同経営/ }).click();
    await page.locator('.lobby input.input').first().fill(SERVER);
    await page.locator('.lobby input.code').fill(CODE);
    await page.getByRole('button', { name: '参加する' }).click();
    // ゲストは開店できない
    await expect(page.locator('.hud-cta')).toContainText('ホストが開店するのを待っています');
    await expect(page.getByRole('button', { name: /開店する/ })).toHaveCount(0);
    // 経営メニューは閲覧専用で開ける（数値は表示される）
    await press(page.locator('.chip.menu'));
    await expect(page.locator('.readonly-badge')).toContainText('閲覧専用');
    await expect(page.locator('.manage-body')).toContainText('¥');
    await press(page.getByRole('button', { name: '在庫・発注', exact: true }));
    const order = page.locator('.manage-body button', { hasText: '翌朝便' }).first();
    await expect(order).toBeDisabled();
    await order.click({ force: true });
    await press(page.getByRole('button', { name: '設備', exact: true }));
    await expect(page.locator('.manage-body button').first()).toBeDisabled();
    await press(page.getByRole('button', { name: 'セーブ・設定', exact: true }));
    await expect(page.getByRole('button', { name: '今すぐ保存' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '設定（音・操作・画質）' })).toBeEnabled();
    await shot(page, '22-guest-readonly');
    // タブを行き来しても固まらない
    for (const tab of ['経営', '従業員', 'キャリア', '店舗']) {
      await press(page.getByRole('button', { name: tab, exact: true }));
      await expect(page.getByRole('button', { name: tab, exact: true })).toHaveClass(/on/);
    }
    // レイアウトの変更もホストだけ
    await expect(page.getByRole('button', { name: 'レイアウト編集を開く' })).toBeDisabled();
    await press(page.locator('.manage .close'));
    await expect(page.locator('.manage')).toHaveCount(0);
    expect(sent).toEqual([]);
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
    // メニューを開いたまま（時間が止まっている）1つ発注すると、すぐ次の手順へ進む（以前は進まず、発注を重ねて冷蔵庫がいっぱいになった）
    await page.locator('.manage-body').getByRole('button', { name: '翌朝便' }).first().click();
    await expect(panel).toContainText('値段を決める');
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

// ───────────────── 営業中のイベント（テスト用の強制発生: URL に ?debug=1） ─────────────────

/** 経営メニューの「セーブ・設定」にあるテスト用のボタンでイベントを起こす */
async function forceEvent(page: Page, kind: string) {
  await press(page.locator('.chip.menu'));
  await press(page.getByRole('button', { name: 'セーブ・設定' }));
  await press(page.locator(`[data-event="${kind}"]`));
  await expect(page.locator('.manage')).toHaveCount(0);
}

/** 店の中で設定の画面を開く（経営メニュー →「セーブ・設定」→「設定」） */
async function openSettings(page: Page) {
  await press(page.locator('.chip.menu'));
  await press(page.getByRole('button', { name: 'セーブ・設定' }));
  await press(page.getByRole('button', { name: '設定（音・操作・画質）' }));
}

type JiroState = { t: number; day: number; money: number; phase: string; players: { pos: { x: number; z: number } }[]; events?: { accident: unknown; buzz: unknown } };
const jiroState = (page: Page) => page.evaluate(() => (window as unknown as { __jiro: { host: { state: JiroState } } }).__jiro.host.state);

test('従業員: アルバイトとして採用し、カレンダーで日にちごと・毎週のシフトを決め、記録を見て社員にできる（勤怠・辛抱の数値は出ない）', async ({ page }) => {
  await startNewGame(page);
  // 採用を解放し、候補者を1人入れる（隠しパラメータの値は画面に出てはいけない）
  await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: { career: { unlocked: string[] }; candidates: unknown[] } } } }).__jiro.host.state;
    s.career.unlocked.push('hiring');
    s.candidates = [
      {
        id: 'cand-e2e',
        profile: {
          name: '山田 花子', role: 'server', skills: { speed: 0.6, cooking: 0.4, service: 0.8, hygiene: 0.5, movement: 0.6 },
          wage: 9000, hireFee: 10000, experience: 0, employment: 'part', hourly: 2000, diligence: 0.123, patience: 0.456, look: 4242,
        },
      },
    ];
  });
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  const body = page.locator('.manage-body');
  await expect(body).toContainText('時給¥2,000');
  // 見た目の個性（制服の色・頭・小物）。候補のときと採用したあとで同じ
  const candLook = (await body.locator('.emp .emp-look').first().textContent()) ?? '';
  expect(candLook).toContain('前掛け');
  await body.getByRole('button', { name: '採用する' }).click();
  const card = body.locator('.emp[data-emp]').first();
  await expect(card).toContainText('アルバイト');
  await expect(card.locator('.emp-look')).toHaveText(candLook);
  // 通常の採用は、採用の2日後（3日目）から出勤する
  await expect(card).toContainText('3日目から出勤');
  await expect(body).toContainText('今日（1日目・月曜）の出勤');
  // シフト: 4週間のカレンダー（日にちごと＋毎週のくりかえし）
  await card.getByRole('button', { name: '📅 シフト' }).click();
  const cal = card.locator('.cal');
  const day = (d: number) => cal.locator(`.cal-day[data-day="${d}"]`);
  await expect(cal.locator('.cal-day[data-day]')).toHaveCount(28);
  await expect(cal.locator('.cal-head')).toHaveCount(7);
  await expect(day(1)).toContainText('今日');
  await expect(day(2)).toContainText('手続き中');
  // 9日目（火曜）だけ 12:00〜14:00（13:00 から30分休憩）にする
  await day(9).click();
  await expect(day(9)).toHaveClass(/on/);
  const edit = card.locator('.shift-edit');
  await expect(edit).toContainText('選んだ日: 9日目（火）');
  await edit.locator('label', { hasText: '出勤' }).locator('select').selectOption('60');
  await edit.locator('label', { hasText: '退勤' }).locator('select').selectOption('180');
  await edit.locator('label', { hasText: /^休憩/ }).first().locator('select').selectOption('30');
  await edit.locator('label', { hasText: '休憩の開始' }).locator('select').selectOption('120');
  await expect(edit).toContainText('1日の給与の目安 ¥3,000（1.5時間）');
  await edit.locator('[data-save="once"]').click();
  await expect(day(9)).toContainText('12:00〜14:00（休憩30分）');
  await expect(day(9)).toContainText('この日だけ');
  // 次の週の火曜（16日目）はくりかえしのまま
  await expect(day(16)).toContainText('仕込み〜15:00');
  await shot(page, '40-staff-shift');
  // 10日目と11日目をまとめて選んで休みにする
  await day(10).click();
  await day(11).click();
  await expect(edit).toContainText('10日目（水）・11日目（木）');
  await edit.getByRole('button', { name: '休みにする' }).click();
  await edit.locator('[data-save="once"]').click();
  await expect(day(10)).toContainText('休み');
  await expect(day(11)).toContainText('休み');
  // 曜日の見出し「金」で金曜（5・12・19・26日目）をまとめて選び、毎週くりかえす 12:00〜13:00 にする
  await cal.locator('.cal-head', { hasText: '金' }).click();
  for (const d of [5, 12, 19, 26]) await expect(day(d)).toHaveClass(/on/);
  await edit.locator('label', { hasText: '出勤' }).locator('select').selectOption('60');
  await edit.locator('label', { hasText: '退勤' }).locator('select').selectOption('120');
  await edit.locator('[data-save="weekly"]').click();
  for (const d of [5, 12, 19, 26]) await expect(day(d)).toContainText('12:00〜13:00');
  await expect(card.locator('.cal-repeat')).toContainText('金 12:00〜13:00');
  // 9日目をくりかえしの予定に戻す
  await day(9).click();
  await edit.locator('[data-save="reset"]').click();
  await expect(day(9)).toContainText('仕込み〜15:00');
  await expect(day(9)).not.toContainText('この日だけ');
  await shot(page, '40b-staff-calendar');
  // 記録（まだ何も起きていない）
  await card.getByRole('button', { name: '📝 記録' }).click();
  await expect(card).toContainText('まだ勤務の記録がありません');
  // 隠しパラメータの名前と値は出さない
  const text = (await body.textContent()) ?? '';
  for (const w of ['勤怠', '辛抱', '信頼性', '安定', '0.123', '0.456', '12.3', '45.6']) expect(text).not.toContain(w);
  // 社員にする（参考情報を見てから決める）
  await card.getByRole('button', { name: '社員にする' }).click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('昇格の目安');
  await expect(modal.locator('.promote-checks li')).toHaveCount(5);
  await shot(page, '41-staff-promote');
  await modal.getByRole('button', { name: '社員にする' }).click();
  await expect(card.locator('.emp-type')).toHaveText('社員');
  await expect(card).toContainText('日給');
  await expect(card.getByRole('button', { name: '社員にする' })).toHaveCount(0);
});

test('従業員は店の外から歩いて入り、「おはようございます」とあいさつして手を洗ってから働き、「お疲れ様でした」と言って歩いて帰る', async ({ page }) => {
  await startNewGame(page);
  type CW = { __jiro: { controls: { yaw: number; pitch: number }; host: { tick(dt: number): void; state: Record<string, any> } } };
  await page.evaluate(() => {
    const s = (window as unknown as CW).__jiro.host.state;
    s.career.unlocked.push('hiring');
    s.candidates = [
      {
        id: 'cand-walk',
        profile: {
          name: '歩 太郎', role: 'cook', skills: { speed: 0.6, cooking: 0.6, service: 0.6, hygiene: 0.6, movement: 0.6 },
          wage: 9000, hireFee: 0, experience: 0, employment: 'part', hourly: 2000, diligence: 1, patience: 1, look: 777,
        },
      },
    ];
  });
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  // 通常の採用は2日後から来るので、今日すぐ来る短期バイトを呼ぶ
  await page.locator('.manage-body [data-temp="cook"]').click();
  await press(page.locator('.manage .close'));
  // 呼んだ人は店の外（歩道）から歩いて来る
  const emp = () => page.evaluate(() => {
    const e = (window as unknown as CW).__jiro.host.state.employees[0];
    return { x: e.pos.x, z: e.pos.z, present: e.presentToday, commute: e.commute ? { kind: e.commute.kind, phase: e.commute.phase } : null, say: e.say ? e.say.text : null };
  });
  const e0 = await emp();
  expect(e0.commute).toEqual({ kind: 'arrive', phase: 'walkIn' });
  expect(e0.z).toBeLessThan(0);
  // 時間を進め、店に入って厨房の入口であいさつするところで止める
  const tickUntil = (cond: string, max = 600) =>
    page.evaluate(([code, n]) => {
      const a = (window as unknown as CW).__jiro;
      const f = new Function('e', 's', `return (${code});`) as (e: unknown, s: unknown) => boolean;
      for (let i = 0; i < (n as number); i++) {
        const st = a.host.state;
        if (f(st.employees[0], st)) return true;
        a.host.tick(0.1);
      }
      return false;
    }, [cond, max] as const);
  expect(await tickUntil("e.commute && e.commute.phase === 'greet'")).toBe(true);
  // その人の方を向く
  await page.evaluate(() => {
    const a = (window as unknown as CW).__jiro;
    const e = a.host.state.employees[0];
    const p = a.host.state.players[0];
    a.controls.yaw = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
    a.controls.pitch = -0.05;
  });
  await expect(page.locator('.bubble.greet')).toContainText('おはようございま', { timeout: 15_000 });
  await shot(page, '42-staff-greet');
  // 手を洗ってから働き始める（手洗いの間は仕事をしない）
  expect(await tickUntil("e.commute && e.commute.phase === 'wash'")).toBe(true);
  expect((await emp()).commute?.phase).toBe('wash');
  expect(await tickUntil('!e.commute')).toBe(true);
  // 開店して、退勤の時刻にする →「お疲れ様でした」と言って歩いて店の外へ
  await page.getByRole('button', { name: /開店する/ }).click();
  await page.evaluate(() => {
    const s = (window as unknown as CW).__jiro.host.state;
    s.employees[0].att.leaveAt = s.openT + 0.5;
  });
  expect(await tickUntil("e.commute && e.commute.kind === 'leave'")).toBe(true);
  await page.evaluate(() => {
    const a = (window as unknown as CW).__jiro;
    const e = a.host.state.employees[0];
    const p = a.host.state.players[0];
    a.controls.yaw = Math.atan2(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
  });
  await expect(page.locator('.bubble.greet')).toContainText('お疲れ様でした', { timeout: 15_000 });
  await shot(page, '43-staff-goodbye');
  expect(await tickUntil('!e.presentToday', 900)).toBe(true);
  const e1 = await emp();
  expect(e1.z).toBeLessThan(0);
});

test('店の前に「禁煙」の張り紙があり、店の外でタバコを吸う客に声をかけられる', async ({ page }) => {
  await startNewGame(page);
  type W = { __jiro: { world: { scene: { getObjectByName(n: string): unknown } }; host: { state: Record<string, any>; tick(dt: number): void }; debugFace(id: string): boolean } };
  expect(await page.evaluate(() => !!(window as unknown as W).__jiro.world.scene.getObjectByName('no-smoking-sign'))).toBe(true);
  await page.getByRole('button', { name: /開店する/ }).click();
  // お客さんが来るまで進め、その人を店の前で吸っている客にする（食事のあとの喫煙の場面を作る）
  const id = await page.evaluate(() => {
    const app = (window as unknown as W).__jiro;
    // 来店は確率で決まるので、評判を上げて来やすくし、来るまで（最大300秒）進める
    app.host.state.reputation = 5;
    for (let i = 0; i < 3000 && app.host.state.customers.length === 0; i++) app.host.tick(0.1);
    const s = app.host.state;
    const c = s.customers[0];
    if (!c) throw new Error('お客さんが来なかった');
    s.queue = s.queue.filter((x: string) => x !== c.id);
    c.state = 'smoking';
    c.path = [];
    c.pos = { x: -0.6, z: -1.6 };
    c.traits.manners = 1;
    c.traits.complaintPropensity = 0;
    c.smoke = { until: -1, troubleId: 'tr-e2e', annoyed: [], warned: false, ignored: 0, nextCheck: 0 };
    app.host.tick(0.1);
    return c.id as string;
  });
  // 店の前を少し離れて見る（張り紙・タバコ・煙の見た目の確認用の画面写真）
  if (SHOTS) {
    await page.evaluate(() => {
      const app = (window as unknown as { __jiro: { localPos: { x: number; z: number }; controls: { yaw: number; pitch: number }; host: { move(x: number, z: number, yaw: number): void } } }).__jiro;
      app.localPos = { x: 1.4, z: -3.6 };
      app.controls.yaw = Math.atan2(-0.6 - 1.4, -1.0 + 3.6);
      app.controls.pitch = 0.05;
      app.host.move(1.4, -3.6, app.controls.yaw);
    });
    await page.waitForTimeout(1500);
    await shot(page, '43-shopfront');
  }
  expect(await page.evaluate((cid) => (window as unknown as W).__jiro.debugFace(cid), id)).toBe(true);
  const warn = page.locator('.act[aria-label="禁煙をお伝えする"]');
  await expect(warn).toBeVisible();
  await expect(page.locator('.hud-detail')).toContainText('禁煙');
  await page.waitForTimeout(500);
  await shot(page, '42-smoker');
  // 長押しの操作（声をかける 1.5 秒）: 押している間にゲーム内時間を進める
  const box = (await warn.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator('.work-bar')).toBeVisible();
  await page.evaluate(() => {
    const app = (window as unknown as W).__jiro;
    for (let i = 0; i < 25; i++) app.host.tick(0.1);
  });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate((cid) => (window as unknown as W).__jiro.host.state.customers.find((x: { id: string }) => x.id === cid)?.state ?? 'left', id)).not.toBe('smoking');
});

type AnyApp = { __jiro: { host: { state: Record<string, any>; tick(dt: number): void }; world: { scene: { getObjectByName(n: string): unknown } }; localPos: { x: number; z: number }; controls: { yaw: number; pitch: number } } };

test('YouTuber が撮影の許可を求めると、ホストに確認の画面が出て、許可すると撮影できる', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: /開店する/ }).click();
  // YouTuber が来る予定を作り、来るまで進める（許可を求める場面にする）
  await page.evaluate(() => {
    const app = (window as unknown as AnyApp).__jiro;
    const s = app.host.state;
    s.reputation = 5;
    s.events.youtuberPlan = { day: s.day, afterOpenT: 0, forced: true };
    for (let i = 0; i < 3000 && !s.customers.some((c: any) => c.special?.kind === 'youtuber'); i++) app.host.tick(0.1);
    const c = s.customers.find((x: any) => x.special?.kind === 'youtuber');
    if (!c) throw new Error('YouTuber が来なかった');
    if (c.special.film.permission !== 'asking') {
      c.special.film.permission = 'asking';
      s.events.requests = [{ id: 'rq-e2e', kind: 'filming', subjectId: c.id, text: 'すみません、YouTubeの撮影をしてもいいですか？', askedAt: s.t, timeoutAt: s.t + 30 }];
      c.special.film.requestId = 'rq-e2e';
    }
  });
  const prompt = page.locator('.request-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('撮影の許可');
  await expect(prompt).toContainText('秒で「断る」');
  await shot(page, '44-filming-request');
  // 確認の画面を開いている間は時間が止まる（ひとりプレイ）
  const t0 = await page.evaluate(() => (window as unknown as AnyApp).__jiro.host.state.t);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as AnyApp).__jiro.host.state.t)).toBe(t0);
  await press(prompt.getByRole('button', { name: '撮影を許可する' }));
  await expect(prompt).toBeHidden();
  const perm = await page.evaluate(() => (window as unknown as AnyApp).__jiro.host.state.customers.find((x: any) => x.special?.kind === 'youtuber')?.special.film.permission);
  expect(perm).toBe('permitted');
});

test('テレビ取材: 確認の画面で受けると8人のチームが来ていて、サインは店の壁に飾られる', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: /開店する/ }).click();
  await page.evaluate(() => {
    const app = (window as unknown as AnyApp).__jiro;
    const s = app.host.state;
    s.events.tvPlan = { day: s.day, afterOpenT: s.openT, forced: true };
    app.host.tick(0.1);
  });
  const prompt = page.locator('.request-prompt');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('テレビ取材');
  await press(prompt.getByRole('button', { name: '取材を受ける' }));
  await expect(prompt).toBeHidden();
  const crew = await page.evaluate(() => {
    const s = (window as unknown as AnyApp).__jiro.host.state;
    const kinds = s.customers.filter((c: any) => c.special?.eventId === s.events.tv.id).map((c: any) => c.special.kind);
    return { status: s.events.tv.status, kinds };
  });
  expect(crew.status).toBe('accepted');
  expect(crew.kinds.filter((k: string) => k === 'tv_performer')).toHaveLength(2);
  expect(crew.kinds.filter((k: string) => k === 'tv_camera')).toHaveLength(2);
  expect(crew.kinds.filter((k: string) => k === 'tv_staff')).toHaveLength(4);
  // サイン（取材が成功したときの記録）を壁に飾る
  await page.evaluate(() => {
    const s = (window as unknown as AnyApp).__jiro.host.state;
    s.events.signs = [
      { celebId: 'cel_menta', name: '麺田 ススル', show: '突撃！となりの行列店', day: 1, visits: 1, lastDay: 1 },
      { celebId: 'cel_mashiko', name: 'ヤサイ マシ子', show: '突撃！となりの行列店', day: 1, visits: 2, lastDay: 1 },
    ];
  });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as AnyApp).__jiro.world.scene.getObjectByName('autograph-cel_mashiko'))).toBe(true);
  if (SHOTS) {
    await page.evaluate(() => {
      const app = (window as unknown as AnyApp).__jiro;
      app.localPos = { x: 3.2, z: 3.4 };
      app.controls.yaw = Math.PI;
      app.controls.pitch = 0.32;
    });
    await page.waitForTimeout(1500);
    await shot(page, '45-autographs');
  }
});

test('イベントの吹き出しは縁が違い、複数出ても重ならず画面からはみ出さない', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: /開店する/ }).click();
  await page.evaluate(() => {
    const app = (window as unknown as AnyApp).__jiro;
    const s = app.host.state;
    s.reputation = 5;
    for (let i = 0; i < 3000 && s.customers.length < 3; i++) app.host.tick(0.1);
    const cs = s.customers.slice(0, 3);
    cs.forEach((c: any, i: number) => {
      s.queue = s.queue.filter((x: string) => x !== c.id);
      s.insideQueue = s.insideQueue.filter((x: string) => x !== c.id);
      const seat = s.seats[i + 2];
      seat.customerId = c.id;
      c.seatId = seat.id;
      c.state = 'eating';
      c.path = [];
      c.eatTotal = 600;
      c.eatLeft = 500;
      c.say = i === 0 ? 'うまっ' : 'これはイベントの長いセリフです。画面の端でも折り返して、ほかの吹き出しとも重ならないように表示されます';
      c.sayUntil = s.t + 60;
      c.sayEvent = i !== 0;
    });
    app.localPos = { x: 3.2, z: 2.9 };
    app.controls.yaw = Math.PI;
    app.controls.pitch = -0.2;
  });
  await expect(page.locator('.bubble.event')).toHaveCount(2);
  await expect(page.locator('.bubble:not(.event)')).toHaveCount(1);
  await page.waitForTimeout(600);
  const boxes = await page.locator('.bubble').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as { left: number; top: number; right: number; bottom: number }));
  const vp = page.viewportSize()!;
  for (const b of boxes) {
    expect(b.left).toBeGreaterThanOrEqual(-1);
    expect(b.top).toBeGreaterThanOrEqual(-1);
    expect(b.right).toBeLessThanOrEqual(vp.width + 1);
    expect(b.bottom).toBeLessThanOrEqual(vp.height + 1);
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      expect(a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom, `${i}/${j}`).toBe(false);
    }
  }
  // イベントの吹き出しは縁が違う（通常の吹き出しは今までどおり）
  const border = await page.locator('.bubble.event').first().evaluate((e) => getComputedStyle(e).borderTopWidth);
  const normal = await page.locator('.bubble:not(.event)').first().evaluate((e) => getComputedStyle(e).borderTopWidth);
  expect(border).not.toBe(normal);
  await shot(page, '46-event-bubbles');
});

test.describe('設定画面とタイトルへの帰還（第2版 21）', () => {
  type SetApp = { __jiro: { host: { state: { players: { name: string }[]; t: number; version: number } } | null; settings: Record<string, unknown>; controls: { settings: { lookSensitivity: number; invertY: boolean } } | null; world: { quality: string } | null } };
  const app = (page: Page) => page.evaluate(() => {
    const a = (window as unknown as SetApp).__jiro;
    return { name: a.host?.state.players[0]?.name, t: a.host?.state.t ?? -1, sens: a.controls?.settings.lookSensitivity, invert: a.controls?.settings.invertY, quality: a.world?.quality, settings: a.settings };
  });
  const closeSettings = (page: Page) => press(page.locator('.screen.settings').getByRole('button', { name: '閉じる', exact: true }));

  test('店の中で設定を開き、各項目を変えるとゲームに反映され、保存されて再読み込み後も保たれる。何度開閉しても固まらず、閉じたら操作に戻れる', async ({ page }) => {
    await startNewGame(page);
    await openSettings(page);
    const scr = page.locator('.screen.settings');
    await expect(scr).toBeVisible();
    // 各項目を操作する
    await scr.locator('label', { hasText: '効果音' }).locator('input').uncheck();
    await scr.locator('label', { hasText: 'コールの読み上げ' }).locator('input').uncheck();
    await scr.locator('label', { hasText: '音量' }).locator('input').fill('0.3');
    await scr.locator('label', { hasText: '視点の感度' }).locator('input').fill('1.8');
    await scr.locator('label', { hasText: '上下の視点操作を反転' }).locator('input').check();
    await scr.locator('label', { hasText: '画質' }).locator('select').selectOption('low');
    await scr.locator('label', { hasText: '動作の重さを表示' }).locator('input').check();
    await scr.locator('[data-setting="playerName"]').fill('ラーメン太郎');
    await scr.locator('[data-setting="playerName"]').blur();
    // ゲームに反映される（名前は店の中でもすぐ変わる）
    const a1 = await app(page);
    expect(a1.settings).toMatchObject({ sound: false, voice: false, volume: 0.3, lookSensitivity: 1.8, invertY: true, quality: 'low', showFps: true, playerName: 'ラーメン太郎' });
    expect(a1.sens).toBe(1.8);
    expect(a1.invert).toBe(true);
    expect(a1.quality).toBe('low');
    expect(a1.name).toBe('ラーメン太郎');
    await shot(page, '47-settings');
    // 何度開閉しても固まらない
    await closeSettings(page);
    for (let i = 0; i < 4; i++) {
      await press(page.getByRole('button', { name: '設定（音・操作・画質）' }));
      await expect(scr).toBeVisible();
      await closeSettings(page);
      await expect(scr).toHaveCount(0);
    }
    // メニューを閉じると操作に戻れる（fps の表示が出て、時間が進み、設備の操作ボタンが出る）
    await press(page.locator('.manage .close'));
    await expect(page.locator('.fps')).toBeVisible();
    const t0 = (await app(page)).t;
    await expect.poll(async () => (await app(page)).t).toBeGreaterThan(t0);
    await face(page, 'bowl_rack');
    await expect(page.locator('.act').first()).toBeVisible();
    // 再読み込み後も保たれる
    await page.reload();
    await page.getByText('ひとりで経営する').waitFor();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('jiro.settings') ?? '{}'));
    expect(saved).toMatchObject({ sound: false, voice: false, volume: 0.3, lookSensitivity: 1.8, invertY: true, quality: 'low', showFps: true, playerName: 'ラーメン太郎' });
    await press(page.getByRole('button', { name: '設定', exact: true }));
    await expect(page.locator('.screen.settings label', { hasText: '画質' }).locator('select')).toHaveValue('low');
    await expect(page.locator('.screen.settings [data-setting="playerName"]')).toHaveValue('ラーメン太郎');
  });

  test('タイトルへ戻るボタンは経営メニューの1つだけ。キャンセルでゲームに戻り、確定すると保存するか聞いてからタイトルへ。保存したデータは壊れていない', async ({ page }) => {
    await startNewGame(page);
    await page.getByRole('button', { name: /開店する/ }).click();
    await page.evaluate(() => {
      const a = (window as unknown as { __jiro: { host: { tick(dt: number): void } } }).__jiro;
      for (let i = 0; i < 50; i++) a.host.tick(0.1);
    });
    // 設定の画面にはタイトルへ戻るボタンがない（オーナーの判断で経営メニューの1つだけにした）
    await openSettings(page);
    await expect(page.locator('.screen.settings')).toBeVisible();
    await expect(page.locator('.screen.settings [data-title]')).toHaveCount(0);
    await expect(page.locator('.screen.settings')).not.toContainText('タイトル');
    await closeSettings(page);
    const menu = page.locator('.manage');
    await expect(menu.locator('[data-title]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /タイトル(画面)?に戻る/ })).toHaveCount(1);
    // キャンセル → 経営メニューとゲームに戻る
    await press(menu.locator('[data-title]'));
    await expect(page.locator('.modal')).toContainText('タイトル画面に戻りますか？');
    await press(page.locator('.modal').getByRole('button', { name: 'キャンセル' }));
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => !!(window as unknown as SetApp).__jiro.host)).toBe(true);
    // 確定 → 保存していない進み具合があるので保存するか聞かれる → 保存して戻る
    await press(menu.locator('[data-title]'));
    await press(page.locator('.modal').getByRole('button', { name: 'タイトル画面に戻る' }));
    await expect(page.locator('.modal')).toContainText('保存しますか？');
    await shot(page, '48-title-save');
    await press(page.locator('.modal').getByRole('button', { name: '保存して戻る' }));
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as SetApp).__jiro.host)).toBeNull();
    // 保存したデータは読み込める（壊れていない）。営業中の状態のまま続きから
    await page.getByText('ひとりで経営する').click();
    await page.getByRole('button', { name: '続きから' }).first().click();
    await expect(page.locator('.hud-top')).toContainText('1日目');
    const phase = await page.evaluate(() => (window as unknown as { __jiro: { host: { state: { phase: string; openT: number } } } }).__jiro.host.state);
    expect(phase.phase).toBe('open');
    expect(phase.openT).toBeGreaterThan(1);
  });

  test('共同経営のゲスト: ホストが終了するとお知らせが出てタイトルへ戻る。ゲストは経営メニューからタイトルへ戻れる（退出を伝える）', async ({ page }) => {
    const SERVER = 'https://mock.jiro.test';
    await startNewGame(page);
    const state = await page.evaluate(() => {
      const s = JSON.parse(JSON.stringify((window as unknown as { __jiro: { host: { state: unknown } } }).__jiro.host.state)) as { players: Record<string, unknown>[]; prepSnapshot?: unknown };
      s.players.push({ ...s.players[0], id: 'g1', name: 'ゲスト', isHost: false, color: '#2e86de' });
      delete s.prepSnapshot;
      return s;
    });
    const left: string[] = [];
    await page.route(`${SERVER}/api/v1/**`, async (route) => {
      const url = new URL(route.request().url());
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      if (url.pathname === '/api/v1/session/leave') left.push(url.pathname);
      const bodies: Record<string, unknown> = {
        '/api/v1/game-version': { gameVersion: '0.9.0', minClientVersion: '0.1.0', protocol: 1 },
        '/api/v1/auth/anonymous': { playerId: 'u2', token: 'tok2' },
        '/api/v1/session/join': { roomId: 'room1', joinToken: 'jt2', isHost: false },
        '/api/v1/session/leave': { ok: true, ended: false },
      };
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(bodies[url.pathname] ?? {}) });
    });
    let sock: { send(m: string): void } | null = null;
    await page.routeWebSocket(/mock\.jiro\.test\/api\/v1\/room\//, (ws) => {
      sock = ws;
      ws.onMessage((raw) => {
        const msg = JSON.parse(String(raw)) as { t: string };
        if (msg.t === 'hello') {
          ws.send(JSON.stringify({ t: 'welcome', playerId: 'g1', roomId: 'room1', isHost: false, protocol: 1, needInit: false }));
          ws.send(JSON.stringify({ t: 'full', seq: 0, state }));
        }
      });
    });
    const join = async () => {
      await page.goto('/');
      await closeHomeTip(page);
      await page.getByRole('button', { name: /オンライン共同経営/ }).click();
      await page.locator('.lobby input.input').first().fill(SERVER);
      await page.locator('.lobby input.code').fill('XYZ789');
      await page.getByRole('button', { name: '参加する' }).click();
      await expect(page.locator('.hud-cta')).toContainText('ホストが開店するのを待っています');
    };
    // 1. ゲストが経営メニューからタイトルへ戻る（退出をサーバーへ伝える。保存の確認は出ない）
    await join();
    await openSettings(page);
    await expect(page.locator('.screen.settings')).toContainText('次に参加したときから');
    await closeSettings(page);
    await press(page.locator('.manage [data-title]'));
    await expect(page.locator('.modal')).toContainText('ホストとほかのゲストはそのまま続けられます');
    await press(page.locator('.modal').getByRole('button', { name: 'タイトル画面に戻る' }));
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
    await expect.poll(() => left.length).toBeGreaterThan(0);
    // 2. ホストがルームを終了したら、お知らせを出してタイトルへ戻す
    await join();
    await expect.poll(() => sock !== null).toBe(true);
    sock!.send(JSON.stringify({ t: 'error', code: 'room_closed', message: 'ホストがルームを終了しました' }));
    await expect(page.locator('.modal')).toContainText('共同経営が終了しました');
    await shot(page, '49-room-closed');
    await press(page.locator('.modal').getByRole('button', { name: 'タイトル画面へ' }));
    await expect(page.getByText('ひとりで経営する')).toBeVisible();
  });
});

test('SNSでバズると、上部に「バズ中」と残り時間が出る', async ({ page }) => {
  await startNewGame(page, '/?debug=1');
  await page.getByRole('button', { name: /開店する/ }).click();
  await forceEvent(page, 'sns_buzz');
  await expect(page.locator('.hud-top .buzz')).toContainText('バズ中');
  await expect(page.locator('.hud-top .buzz')).toContainText('分');
  await page.waitForTimeout(600);
  await shot(page, '30-buzz');
});

test('爆発事故: 設定には起こすボタンがない。開発用の欄（?debug=1）から起こし、気を失って目覚め、焼け跡を歩けて、「リセットする」で仕込みの開始時点に戻る', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await startNewGame(page, '/?debug=1');
  // 爆発事故はランダムで突然起こるもの。設定の画面には起こすボタンを置かない（オーナーの判断）
  await openSettings(page);
  await expect(page.locator('.screen.settings')).toBeVisible();
  await expect(page.locator('[data-explode]')).toHaveCount(0);
  await expect(page.locator('.screen.settings')).not.toContainText('爆発');
  await press(page.getByRole('button', { name: '閉じる', exact: true }));
  // 開発用の欄でも1日目は起こせない（理由が出る）
  await press(page.getByRole('button', { name: 'セーブ・設定' }));
  await press(page.locator('[data-event="explosion"]'));
  await expect(page.locator('.toast', { hasText: '2日目から起きます' })).toBeVisible();
  await press(page.locator('.manage .close'));
  // 事故は2日目から。2日目の仕込み開始時点にする（控えの日付も合わせる）
  const money0 = await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: { day: number; money: number; prepSnapshot: { day: number; state: { day: number } } } } } }).__jiro.host.state;
    s.day = 2;
    s.prepSnapshot.day = 2;
    s.prepSnapshot.state.day = 2;
    return s.money;
  });
  // 開発用の欄から起こす → 仕込み中なので開店の3秒後に起きる
  await forceEvent(page, 'explosion');
  await page.getByRole('button', { name: /開店する/ }).click();
  // 倍速にしておく（発火したら強制的に等速に戻る）
  const speedChip = page.locator('button[title="ゲーム速度"], button[title="事故の間は倍速にできません"]');
  await press(speedChip);
  await press(speedChip);
  await expect(speedChip).toHaveText('×3');
  // ヘッドレスの描画は遅く（1〜2fps）ゲーム内の時間がなかなか進まないので、待つ代わりに時刻を進める（各段階の時間の進み方は core のテストで確認）
  const advance = (expr: string) =>
    page.evaluate((code) => {
      const s = (window as unknown as { __jiro: { host: { state: { openT: number; events: { accident: { t: number } | null } } } } }).__jiro.host.state;
      new Function('s', code)(s);
    }, expr);
  await advance('s.openT = Math.max(s.openT, 2.95)');
  await expect(page.locator('.acc-warn')).toBeVisible({ timeout: 20_000 });
  // 発火したら倍速をやめ、事故の間は倍速にできない（15秒の火事をそのまま見せる）
  await expect(speedChip).toHaveText('×1');
  await expect(speedChip).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { __jiro: { host: { speed: number } } }).__jiro.host.speed)).toBe(1);
  await shot(page, '31-warning');
  // 発火から15秒（以前の3倍）。その間に火は設備から設備へ燃え移り、炎が増える
  type FireW = { __jiro: { world: { scene: { getObjectByName(n: string): unknown; traverse(f: (o: { name: string }) => void): void } }; host: { state: { events: { accident: { stage: string; t: number; burning: { id: string }[] } } } } } };
  const flames = () => page.evaluate(() => {
    let n = 0;
    (window as unknown as FireW).__jiro.world.scene.traverse((o) => {
      if (o.name.startsWith('flame:')) n += 1;
    });
    return n;
  });
  await advance('s.events.accident.t = 2');
  await expect.poll(flames, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  const f1 = await flames();
  await advance('s.events.accident.t = 10');
  await page.waitForFunction(() => (window as unknown as FireW).__jiro.host.state.events.accident.burning.length >= 4, null, { timeout: 20_000 });
  await expect.poll(flames, { timeout: 20_000 }).toBeGreaterThan(f1 + 1);
  expect(await page.evaluate(() => (window as unknown as FireW).__jiro.host.state.events.accident.stage)).toBe('warning');
  await page.waitForTimeout(800);
  await shot(page, '31a-fire-spreading');
  // 予兆が終わると爆発 → 暗転 →「数時間後」→ 目覚め
  await advance('s.events.accident.t = 14.95');
  await page.waitForFunction(() => (window as unknown as { __jiro: { host: { state: { events: { accident: { stage: string } | null } } } } }).__jiro.host.state.events.accident?.stage === 'destroyed', null, { timeout: 20_000 });
  await advance('s.events.accident.t = 1.2');
  await page.waitForTimeout(800);
  await shot(page, '31b-blast');
  await advance('s.events.accident.t = 5.5');
  await expect(page.locator('.acc-caption')).toContainText('数時間後', { timeout: 20_000 });
  const reset = page.getByRole('button', { name: 'リセットする' });
  await expect(reset).toBeHidden();
  await advance('s.events.accident.t = 9.2');
  await expect(reset).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.acc-narration')).toContainText('誰ひとり動かない');
  // 一文は少しのあいだだけで、操作の説明（「歩くことができます」など）は出さない
  await advance('s.events.accident.t = 30');
  await expect(page.locator('.acc-narration')).toBeHidden();
  await expect(page.getByText('歩くことができます')).toHaveCount(0);
  await expect(reset).toBeVisible();
  // 営業の画面は隠れ、営業は止まっている（時刻・資金が進まない）
  await expect(page.locator('.hud-actions')).toBeHidden();
  await expect(page.locator('.chip.menu')).toBeVisible();
  const a = await jiroState(page);
  await page.waitForTimeout(1500);
  const b = await jiroState(page);
  expect({ t: b.t, money: b.money, phase: b.phase }).toEqual({ t: a.t, money: a.money, phase: 'open' });
  // 店内はぐちゃぐちゃ（落ちた天井・板・かけら・ガラス・焦げ跡などが散らばる）。燃え残りの火もある
  const wreck = await page.evaluate(() => {
    const names: string[] = [];
    (window as unknown as FireW).__jiro.world.scene.traverse((o) => {
      if (o.name.startsWith('wreck:')) names.push(o.name);
    });
    return names;
  });
  expect(wreck.length).toBeGreaterThanOrEqual(8);
  expect(await flames()).toBeGreaterThanOrEqual(1);
  await shot(page, '32-aftermath');
  // 焼け跡を歩ける（PC は W キー）
  if (!test.info().project.use.hasTouch) {
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(2000);
    await page.keyboard.up('KeyW');
    const c = await jiroState(page);
    expect(Math.hypot(c.players[0]!.pos.x - b.players[0]!.pos.x, c.players[0]!.pos.z - b.players[0]!.pos.z)).toBeGreaterThan(0.2);
  }
  await press(reset);
  await expect(page.locator('.toast', { hasText: '仕込みの開始時点に戻りました' })).toBeVisible();
  const after = await jiroState(page);
  expect({ phase: after.phase, day: after.day, money: after.money, accident: after.events?.accident }).toEqual({ phase: 'prep', day: 2, money: money0, accident: null });
  await expect(page.getByRole('button', { name: /開店する/ })).toBeVisible();
  await expect(reset).toBeHidden();
  await page.waitForTimeout(500);
  await shot(page, '33-after-reset');
  expect(errors).toEqual([]);
});

test('会社: 12席・評判★4.0以上の店になると「会社」の画面が出て、物件を選んで出店し、閉店後に支店へ入れる', async ({ page }) => {
  await startNewGame(page);
  type CJ = {
    __jiro: {
      host: {
        state: Record<string, any>;
        act(a: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
      };
    };
  };
  // 採用した人を社員にし、12席・評判★4.3・資金300万円・閉店後の状態にする
  const hired = await page.evaluate(async () => {
    const app = (window as unknown as CJ).__jiro;
    const s = app.host.state;
    s.career.unlocked.push('hiring');
    s.candidates = [
      {
        id: 'cand-co',
        profile: {
          name: '佐藤 一郎', role: 'cook', skills: { speed: 0.7, cooking: 0.7, service: 0.6, hygiene: 0.6, movement: 0.7 },
          wage: 9000, hireFee: 10000, experience: 0, employment: 'part', hourly: 2000, diligence: 0.9, patience: 0.9, look: 77,
        },
      },
    ];
    const r = await app.host.act({ type: 'hire', candidateId: 'cand-co' });
    const e = s.employees[s.employees.length - 1];
    e.profile.employment = 'full';
    e.profile.wage = 9000;
    s.career.stage = 1;
    for (let i = s.seats.length; i < 12; i++) s.seats.push({ id: `seat${i}`, index: i, installed: false, offset: { x: 0, z: 0 }, dirt: 0, customerId: null, bowlId: null, lostItemId: null });
    s.money = 3_000_000;
    s.reputation = 4.3;
    s.phase = 'closed';
    s.version += 1;
    return { ok: r.ok, id: e.id };
  });
  expect(hired.ok).toBe(true);
  await page.locator('.chip.menu').click();
  const tab = page.getByRole('button', { name: '会社', exact: true });
  await expect(tab).toBeVisible();
  await tab.click();
  const body = page.locator('.manage-body');
  await expect(body).toContainText('会社の財務');
  await expect(body).toContainText('いまここ');
  await expect(body).toContainText('出店（2店舗目以降）');
  // 住宅街の店に、佐藤さんを店長にして出店する
  const row = body.locator('.prop-row[data-property="residential"]');
  await expect(row).toContainText('初期費用 ¥450,000');
  await row.locator('[data-open="residential"]').click();
  await page.locator('.modal').getByRole('button', { name: '出店する' }).click();
  await expect(page.locator('.toast', { hasText: /^出店しました$/ })).toBeVisible();
  const st = await page.evaluate(() => {
    const s = (window as unknown as CJ).__jiro.host.state;
    return { n: s.company.stores.length, money: s.money, branch: s.company.stores[1]?.id, mgr: s.company.stores[1]?.managerId };
  });
  expect(st.n).toBe(2);
  expect(st.money).toBe(3_000_000 - 450_000);
  expect(st.mgr).toBe(hired.id);
  const branchCard = body.locator(`.store-card[data-store="${st.branch}"]`);
  await expect(branchCard).toContainText('準備中');
  await expect(branchCard).toContainText('佐藤 一郎');
  await shot(page, '50-company');
  // 支店に入る（閉店後。明日からその店で営業）
  await branchCard.locator(`[data-enter="${st.branch}"]`).click();
  await page.locator('.modal').getByRole('button', { name: 'この店に入る' }).click();
  await expect(page.locator('.toast', { hasText: '住宅街店に入りました' }).first()).toBeVisible();
  const after = await page.evaluate(() => {
    const s = (window as unknown as CJ).__jiro.host.state;
    return { active: s.company.activeStoreId, stage: s.career.stage, emps: s.employees.map((e: { id: string }) => e.id), homeSnap: !!s.company.stores[0].snapshot };
  });
  expect(after.active).toBe(st.branch);
  expect(after.stage).toBe(0);
  expect(after.emps).toEqual([hired.id]);
  expect(after.homeSnap).toBe(true);
  await expect(body.locator(`.store-card[data-store="${st.branch}"]`)).toContainText('いまここ');
});
