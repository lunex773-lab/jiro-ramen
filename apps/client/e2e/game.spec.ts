import { expect, test, type Locator, type Page } from './fixtures';

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
  // 1店目の場所（出店マップ）は「あとで決める」
  await page.locator('[data-store-map] [data-map-close]').click();
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

test('隠し扉と武器庫: 店の外の横の壁を押すと開き、武器を持って席の客を襲うと血が出て客が逃げ、等速に戻り、警察が来て逮捕され、暗くなってその日の営業が終わる（じろ1 5.12・2026-11-11）', async ({ page }) => {
  // 警察が来るまで20秒・逮捕の流れ（歩いて来る〜暗くなる）があるので長め
  test.setTimeout(180_000);
  await startNewGame(page);
  type S = { phase: string; reputation: number; armory?: { doorOpen: boolean }; incident?: { police: boolean } | null; dirt: { kind: string }[]; seats: { id: string; customerId: string | null }[]; customers: { id: string; hurt?: boolean; state: string }[]; players: { hand: { kind: string } }[] };
  const state = () => page.evaluate(() => (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state);
  const faceId = async (id: string) => {
    expect(await page.evaluate((x) => (window as unknown as { __jiro: Jiro }).__jiro.debugFace(x), id)).toBe(true);
    await page.waitForTimeout(400);
  };
  await page.getByRole('button', { name: /開店する/ }).click();
  // 席に客が座るまでゲーム内時間を進める
  const seated = await page.evaluate(() => {
    const app = (window as unknown as { __jiro: { host: { state: S; tick(dt: number): void } } }).__jiro;
    for (let i = 0; i < 2400; i++) {
      const seat = app.host.state.seats.find((x) => x.customerId);
      if (seat) return seat.id;
      app.host.tick(0.1);
    }
    return null;
  });
  expect(seated).not.toBeNull();
  // 外壁（隠し扉）を押す
  await faceId('armory_door');
  const push = page.locator('.act[aria-label^="壁を押す"]');
  await expect(push).toBeVisible();
  await press(push);
  await expect.poll(async () => (await state()).armory?.doorOpen ?? false).toBe(true);
  await faceId('armory_rack');
  // 武器は買う（じろ2: 値段は案の2倍。高い買い物なので確かめてから）
  await page.evaluate(() => {
    (window as unknown as { __jiro: { host: { state: { money: number } } } }).__jiro.host.state.money = 5_000_000;
  });
  const look = page.locator('.act[aria-label^="武器の棚を見る"]');
  await expect(look).toBeVisible();
  await press(look);
  const panel = page.locator('[data-armory-panel]');
  await expect(panel.locator('[data-armory-weapon]')).toHaveCount(7);
  await shot(page, 'armory-buy');
  await panel.locator('[data-armory-verb="buy_weapon:pistol"]').click();
  await expect(page.locator('.modal').last()).toContainText('¥2,000,000');
  await page.locator('.modal').last().getByRole('button', { name: '買う' }).click();
  await expect.poll(async () => ((await state()) as unknown as { money: number }).money).toBe(3_000_000);
  await panel.locator('[data-armory-verb="buy_ammo:pistol"]').click();
  await page.locator('.modal').last().getByRole('button', { name: '買う' }).click();
  await expect.poll(async () => ((await state()) as unknown as { money: number }).money).toBe(2_900_000);
  await expect(panel.locator('[data-armory-weapon="pistol"]')).toContainText('弾 1発');
  const take = panel.locator('[data-armory-verb="weapon:pistol"]');
  await expect(take).toBeEnabled();
  await take.click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.hud-hand')).toContainText('拳銃');
  // 倍速にしておく（襲うと等速に戻る。オーナーの指示 2026-11-11）
  const speed = page.locator('.hud .chip', { hasText: /^×\d$/ });
  await speed.click();
  await expect(speed).toHaveText('×2');
  // 席の客を撃つ
  const rep = (await state()).reputation;
  await faceId(seated!);
  const shoot = page.locator('.act[aria-label^="拳銃で撃つ"]');
  await expect(shoot).toBeVisible();
  await press(shoot);
  await expect.poll(async () => (await state()).customers.some((c) => c.hurt)).toBe(true);
  const s1 = await state();
  expect(s1.dirt.some((d) => d.kind === 'blood')).toBe(true);
  expect(s1.reputation).toBeLessThan(rep);
  await page.waitForTimeout(300);
  await shot(page, 'armory-shot');
  await expect(speed).toHaveText('×1');
  await expect(speed).toBeDisabled();
  // 20秒後に警察が来て、警察官が歩いて来て手錠をかける（その間は動けない）
  type A = { incident?: { arrest?: { phase: string; officers: unknown[] } } };
  const tickUntil = (phase: string, extra = 0) =>
    page.evaluate(
      ([ph, more]) => {
        const app = (window as unknown as { __jiro: { host: { state: A; tick(dt: number): void } } }).__jiro;
        for (let i = 0; i < 1200; i++) {
          if (app.host.state.incident?.arrest?.phase === ph) {
            for (let k = 0; k < Number(more) * 10; k++) app.host.tick(0.1);
            return true;
          }
          app.host.tick(0.1);
        }
        return false;
      },
      [phase, extra] as const,
    );
  expect(await tickUntil('approach')).toBe(true);
  expect(((await state()) as unknown as A).incident?.arrest?.officers).toHaveLength(2);
  await expect(page.locator('.app.arrest-mode')).toHaveCount(1);
  expect(await tickUntil('cuff', 1)).toBe(true);
  await page.waitForTimeout(300);
  await shot(page, 'arrest-cuff');
  expect(await tickUntil('escort', 2)).toBe(true);
  await page.waitForTimeout(300);
  await shot(page, 'arrest-escort');
  // パトカーに乗せられたら画面が暗くなる
  expect(await tickUntil('fade', 1.2)).toBe(true);
  await expect.poll(async () => Number((await page.locator('[data-arrest-fade]').getAttribute('style'))?.match(/opacity:\s*([\d.]+)/)?.[1] ?? 0), { timeout: 5000 }).toBeGreaterThan(0.3);
  await shot(page, 'arrest-fade');
  // 暗くなったら、その日の営業は終わる
  const closed = await page.evaluate(() => {
    const app = (window as unknown as { __jiro: { host: { state: S; tick(dt: number): void } } }).__jiro;
    for (let i = 0; i < 3000; i++) {
      if (app.host.state.phase === 'closed') return true;
      app.host.tick(0.1);
    }
    return false;
  });
  expect(closed).toBe(true);
  const s2 = await state();
  expect(s2.incident?.police).toBe(true);
  expect(s2.players[0]!.hand.kind).toBe('none');
  // 精算の画面が出たら暗さは消える
  await expect(page.locator('[data-arrest-fade]')).toBeHidden({ timeout: 5000 });
});

test('開店すると時計が進み、客が来店する', async ({ page }) => {
  await startNewGame(page);
  await page.getByRole('button', { name: /開店する/ }).click();
  await expect(page.locator('.clock')).toContainText('11:');
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __jiro: Jiro }).__jiro.host.state.phase), { timeout: 10_000 }).toBe('open');
  // 速度ボタンが効くこと
  await page.locator('.chip', { hasText: '×1' }).click();
  await expect(page.locator('.chip', { hasText: '×2' })).toBeVisible();
  // ×2 → ×3 → ×5（5倍速）→ ×1 → ×2
  await page.locator('.chip', { hasText: '×2' }).click();
  await page.locator('.chip', { hasText: '×3' }).click();
  await expect(page.locator('.chip', { hasText: '×5' })).toBeVisible();
  await page.locator('.chip', { hasText: '×5' }).click();
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
  // じろ6: 先頭に大事な数字8つ（現金・売上・営業利益・最終利益・負債・在庫・来客・勤務）。まだ営業していない日は札で分かる
  await expect(page.locator('.manage .dash-kpis [data-kpi]')).toHaveCount(8);
  await expect(page.locator('.manage .dash-kpis')).toContainText('まだ営業していません');
  await expect(page.locator('.manage')).toContainText('今日のお金の流れ');
  for (const k of ['cash', 'sales', 'op', 'final', 'debt', 'stock', 'customers', 'staff']) await expect(page.locator(`.manage [data-kpi="${k}"]`)).toBeInViewport();
  await shot(page, '06-manage');
  await page.getByRole('button', { name: '在庫・発注' }).click();
  await expect(page.locator('.manage')).toContainText('仕入れ');
  // じろ6: 在庫・入荷予定・もつ日数を列で分ける。翌朝便で頼むと、何をいくらで・いつ届くか・入荷予定の前と後が出る
  const row = page.locator('.manage [data-stock-row]').first();
  await expect(row.locator('.sn.coming b')).toHaveText('—');
  await row.getByRole('button', { name: '翌朝便' }).click();
  await expect(page.locator('.toast').filter({ hasText: '入荷予定' }).last()).toContainText('翌朝便（あすの開店前に届く）で頼みました');
  await expect(row.locator('.sn.coming b')).toHaveText(/^\+/);
  // じろ6: 取り消せる操作は「元に戻す」で戻せる（自動の仕入れを止める → 元に戻す）
  const autoBtn = row.locator('[data-auto-item]');
  await expect(autoBtn).toHaveText('自動 ON');
  await autoBtn.click();
  await expect(autoBtn).toHaveText('自動 OFF');
  await page.locator('.toast [data-undo]').last().click();
  await expect(autoBtn).toHaveText('自動 ON');
  await page.getByRole('button', { name: '店舗' }).click();
  await page.getByRole('button', { name: 'レイアウト編集を開く' }).click();
  await expect(page.locator('.layout-editor')).toBeVisible();
  await page.waitForTimeout(500);
  await shot(page, '07-layout');
  await expect(page.locator('.layout-side')).toContainText(/問題ありません|注意/);
  await page.getByRole('button', { name: '完了' }).click();
});

test('出店マップ: 新しく始めるときに1店目の場所を選べる（拡大縮小・戻る・パンくず・検索）', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await closeHomeTip(page);
  await page.getByText('ひとりで経営する').click();
  await page.getByRole('button', { name: '新しく始める' }).first().click();
  await page.locator('.modal input').fill('地図亭');
  await page.getByRole('button', { name: '決定' }).click();
  await page.getByRole('button', { name: 'スキップして1日目から' }).click();
  const map = page.locator('[data-store-map]');
  await expect(map).toContainText('1店目の場所を選ぶ');
  await expect(map.locator('[data-pref]')).toHaveCount(47);
  const svg = map.locator('svg.store-map-svg');
  const vb = () => svg.getAttribute('viewBox');
  // 拡大・縮小・全体
  const v0 = await vb();
  await map.locator('[data-map-zoom-in]').click();
  const v1 = await vb();
  expect(v1).not.toBe(v0);
  await map.locator('[data-map-reset]').click();
  expect(await vb()).toBe(v0);
  if (!test.info().project.use.hasTouch) {
    // ホイールで拡大、ドラッグで動かす（PC）
    const box = (await svg.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await expect.poll(vb).not.toBe(v0);
    const before = (await vb())!.split(' ').map(Number);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 6 });
    await page.mouse.up();
    const after = (await vb())!.split(' ').map(Number);
    expect(after[0]).toBeLessThan(before[0]!);
    await map.locator('[data-map-reset]').click();
  }
  // 地方 → 戻る → 全国
  await map.locator('[data-map-region="九州・沖縄"]').click();
  await expect(map.locator('[data-map-crumbs]')).toContainText('九州・沖縄');
  await map.locator('[data-map-back]').click();
  await expect(map.locator('[data-map-region="関東"]')).toBeVisible();
  // 関東 → 東京都 → 「新宿」で探す → 新宿区 → パンくずで東京都に戻ってから選び直す
  await map.locator('[data-map-region="関東"]').click();
  await map.locator('[data-map-pref="13"]').click();
  await map.locator('[data-map-search]').fill('新宿');
  await expect(map.locator('[data-map-muni]')).toHaveCount(1);
  await map.locator('[data-map-muni="13104"]').click();
  await expect(map.locator('[data-map-crumbs]')).toContainText('新宿区');
  await map.locator('[data-crumb="2"]').click();
  await expect(map.locator('[data-map-crumbs]')).not.toContainText('新宿区');
  await map.locator('[data-map-search]').fill('新宿');
  await map.locator('[data-map-muni="13104"]').click();
  await expect(map.locator('.map-detail .kv', { hasText: '来客' })).toContainText('+');
  await expect(map.locator('.map-detail .kv', { hasText: '家賃' })).toContainText('+');
  await map.locator('[data-map-confirm]').click();
  await expect(map).toHaveCount(0);
  await expect(page.getByText('ラーメンができるまで')).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  const loc = await page.evaluate(() => (window as unknown as { __jiro: { host: { state: { company: { stores: { location?: string }[] } } } } }).__jiro.host.state.company.stores[0]!.location);
  expect(loc).toBe('13104');
  // 経営メニューに本店の場所が出る
  await page.locator('.chip.menu').click();
  await expect(page.locator('.manage [data-home-location]')).toHaveText('東京都 新宿区');
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
    await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
    await page.getByRole('button', { name: /オンライン共同経営/ }).click();
    await expect(page.locator('.lobby [data-server-url]')).toHaveText(SERVER);
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
    await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
    await page.getByRole('button', { name: /オンライン共同経営/ }).click();
    await expect(page.locator('.lobby [data-server-url]')).toHaveText(SERVER);
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
    await page.locator('[data-store-map] [data-map-close]').click();
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
    const slice = page.locator('.act[aria-label^="豚を切る"]');
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

test('従業員: 新しく始めた1日目から、採用の候補がいて雇える（通常の採用は3日目から出勤）', async ({ page }) => {
  await startNewGame(page);
  const state = () => page.evaluate(() => (window as unknown as { __jiro: { host: { state: { day: number; career: { unlocked: string[] }; candidates: unknown[]; employees: unknown[] } } } }).__jiro.host.state);
  const s0 = await state();
  expect(s0.day).toBe(1);
  expect(s0.career.unlocked).toContain('hiring');
  expect(s0.candidates.length).toBeGreaterThan(0);
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  const body = page.locator('.manage-body');
  await expect(body).toContainText('採用候補');
  await body.getByRole('button', { name: '採用する' }).first().click();
  await expect.poll(async () => (await state()).employees.length).toBe(1);
  await expect(body.locator('.emp[data-emp]').first()).toContainText('3日目から出勤');
});

test('従業員: みんなの勤務のカレンダーで日を選んでシフトを変え、仕込みの目安を決め、社員をシフトリーダーにできる（じろ1）', async ({ page }) => {
  await startNewGame(page);
  type S = { day: number; employees: { id: string; profile: { role: string; employment: string; wage: number; skills: Record<string, number>; initialSkills?: Record<string, number> }; dateShifts?: Record<string, unknown> }[]; prepTargets?: Record<string, number> };
  const state = () => page.evaluate(() => (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state);
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  const body = page.locator('.manage-body');
  await body.getByRole('button', { name: '採用する' }).first().click();
  await expect.poll(async () => (await state()).employees.length).toBe(1);
  const s1 = await state();
  expect(s1.employees[0]!.profile.initialSkills).toBeTruthy();
  // 2週間のカレンダー。3日目（出勤できる最初の日）を選んで「休み」にする
  await expect(body.locator('.team-cal .team-day')).toHaveCount(14);
  await body.locator('[data-team-day="3"]').click();
  const edit = body.locator('[data-team-edit="3"]');
  await expect(edit).toBeVisible();
  const empId = s1.employees[0]!.id;
  await edit.locator(`[data-team-shift="${empId}"]`).selectOption({ label: '→ 休み' });
  await expect(body.locator('[data-team-day="3"] .td-count')).toHaveText('0人');
  // 月の表（じろ2）: 従業員別の行。職種別にすると職種の行。日の見出しを押すとその日の見方
  await body.locator('[data-cal-view-btn="month"]').click();
  await expect(body.locator(`[data-cal-row="${empId}"]`)).toBeVisible();
  await expect(body.locator(`[data-cal-cell="${empId}:3"]`)).toHaveText('休');
  await body.locator('[data-cal-group="role"]').click();
  await expect(body.locator('[data-cal-role]').first()).toBeVisible();
  await shot(page, 'calendar-month');
  await body.locator('[data-cal-head="3"]').click();
  await expect(body.locator('[data-cal-day="3"]')).toBeVisible();
  await body.locator('[data-cal-group="staff"]').click();
  await expect(body.locator(`[data-cal-emp="${empId}"]`)).toContainText('休み');
  await body.locator('[data-cal-view-btn="twoWeeks"]').click();
  // 仕込みのタブ（オーナーの指示 2026-11-12）: 仕込みの目安（「○人前」）・開店前の計画・時間帯と曜日
  await page.getByRole('button', { name: '仕込み', exact: true }).click();
  await expect(body.locator('[data-prep-target="yasai"] option').nth(2)).toContainText('人前');
  await expect(body.locator('[data-prep-row="yasai"]')).toContainText('1人前');
  await body.locator('[data-prep-target="yasai"]').selectOption({ index: 2 });
  await expect.poll(async () => (await state()).prepTargets?.yasai ?? 0).toBeGreaterThan(0);
  // 開店前の計画: 予想から決める → 品ごとに量と進み具合。1品の量を変える
  await body.locator('[data-plan-suggest]').click();
  type P = { prepPlan?: { items: Record<string, number> }; prepSchedule?: { weekday?: number[] } };
  await expect.poll(async () => Object.keys(((await state()) as unknown as P).prepPlan?.items ?? {}).length).toBeGreaterThan(0);
  await body.locator('[data-plan-item="garlic"]').selectOption({ index: 2 });
  await expect.poll(async () => ((await state()) as unknown as P).prepPlan?.items.garlic ?? 0).toBeGreaterThan(0);
  await expect(body.locator('[data-plan-row="garlic"] .plan-meter')).toContainText('%');
  // 曜日で変える（7番目の曜日を多め）
  await body.locator('[data-sched-weekday="6"]').selectOption('1.5');
  await expect.poll(async () => ((await state()) as unknown as P).prepSchedule?.weekday?.[6] ?? 1).toBe(1.5);
  await shot(page, 'prep-tab');
  // 食材ごとの自動の仕入れ（じろ2）と仕入れの記録
  await page.getByRole('button', { name: '在庫・発注', exact: true }).click();
  await body.locator('[data-auto-item="moyashi"]').click();
  await expect(body.locator('[data-auto-item="moyashi"]')).toHaveText('自動 OFF');
  await expect(body.locator('[data-purchase-log]')).toBeVisible();
  // 社員にして、能力が足りればシフトリーダーにできる
  await page.evaluate(() => {
    const e = (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state.employees[0]!;
    e.profile.employment = 'full';
    for (const k of Object.keys(e.profile.skills)) e.profile.skills[k] = 0.8;
  });
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  await body.locator(`[data-promote-leader="${empId}"]`).click();
  await page.locator('.modal').getByRole('button', { name: 'シフトリーダーにする' }).click();
  await expect.poll(async () => (await state()).employees[0]!.profile.role).toBe('leader');
  await expect(body.locator('.emp[data-emp]').first()).toContainText('シフトリーダー');
  // 自分で仕込むときに量を選べる（煮込み鍋の説明の欄で量を選ぶと、仕込むボタンの隅に倍率）
  await page.locator('.manage .close').click();
  await face(page, 'braise_pot');
  const chip = page.locator('[data-prep-mult="braise_pork:2"]');
  await expect(chip).toBeVisible();
  await press(chip);
  await expect(page.locator('.act[data-verb="prep:braise_pork"] .act-badge')).toHaveText('×2');
});

test('従業員: シフト表で曜日 × 時間の人数と必要な人数を見て、「シフトを自動で組む」でアルバイトのシフトを組める。店長がいれば「店長に任せる」を選べる', async ({ page }) => {
  await startNewGame(page);
  type E = { id: string; profile: { employment: string; wishDays?: boolean[] }; shifts?: unknown[] };
  type S = { day: number; employees: E[]; history: { customers: number; balked: number; served: number }[]; company: { activeStoreId: string; stores: { id: string; managerId?: string | null; policy: { shiftBy?: string } }[] } };
  const state = () => page.evaluate(() => (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state);
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  const body = page.locator('.manage-body');
  await body.getByRole('button', { name: '採用する' }).first().click();
  await expect.poll(async () => (await state()).employees.length).toBe(1);
  const card = body.locator('[data-shift-table]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-shift-row]')).toHaveCount(7);
  // 忙しい店の記録にして（来客110人）、自動で組む
  await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state;
    const e = s.employees[0]!;
    e.profile.wishDays = [true, true, true, true, true, true, true];
    const base = { customers: 110, balked: 0, served: 60 } as Record<string, unknown>;
    for (let d = 1; d <= 3; d++) (s.history as unknown[]).push({ ...base, day: d, sales: 0, refunds: 0, cogs: 0, waste: 0, wages: 0, rent: 0, upkeep: 0, utilities: 0, repairs: 0, hiring: 0, interest: 0, purchases: 0, capex: 0, lost: 0, totalSeatWait: 0, totalQueueWait: 0, satisfactionSum: 0, satisfactionCount: 0, mistakes: 0, stockouts: 0, complaints: 0, breakdowns: 0, remakes: 0, wasteItems: {}, operatingProfit: 0, netSales: 0, finalProfit: 0, cashStart: 0, cashEnd: 0, reputation: 3, reviews: 0, avgSatisfaction: 0, avgWait: 0 });
  });
  await page.getByRole('button', { name: '経営', exact: true }).click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  const before = JSON.stringify((await state()).employees[0]!.shifts ?? null);
  await card.locator('[data-auto-shifts]').click();
  await expect.poll(async () => JSON.stringify((await state()).employees[0]!.shifts ?? null)).not.toBe(before);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __jiro: { host: { state: { notices: { code: string; text: string }[] } } } }).__jiro.host.state.notices.find((n) => n.code === 'autoShifts')?.text ?? '')).toContain('シフトを組みました');
  // 店長がいれば「店長に任せる / 自分で組む」
  await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state;
    const st = s.company.stores.find((x) => x.id === s.company.activeStoreId)!;
    s.employees[0]!.profile.employment = 'full';
    st.managerId = s.employees[0]!.id;
  });
  await page.getByRole('button', { name: '経営', exact: true }).click();
  await page.getByRole('button', { name: '従業員', exact: true }).click();
  await expect(card.locator('[data-shift-by="manager"]')).toBeVisible();
  await card.getByRole('button', { name: '自分で組む' }).click();
  await expect.poll(async () => {
    const s = await state();
    return s.company.stores.find((x) => x.id === s.company.activeStoreId)!.policy.shiftBy;
  }).toBe('self');
});

test('営業時間: 経営のタブから昼と夜の2つの枠と定休日を決めると、次の日から使い、時計と開店のボタンが枠に合わせて変わる（じろ1）', async ({ page }) => {
  await startNewGame(page);
  type S = { day: number; phase: string; sessionIdx?: number; todayHours?: { sessions: { open: number; close: number }[]; closedDays: number[] }; company: { activeStoreId: string; stores: { id: string; hours?: { sessions: { open: number; close: number }[]; closedDays: number[] } }[] } };
  const state = () => page.evaluate(() => (window as unknown as { __jiro: { host: { state: S } } }).__jiro.host.state);
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: '経営', exact: true }).click();
  const body = page.locator('.manage-body');
  const card = body.locator('.hours-card');
  await expect(card).toContainText('11:00〜15:00');
  await card.locator('[data-edit-hours]').click();
  const dlg = page.locator('.modal.hours-modal');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.demand-strip .demand-col')).toHaveCount(24);
  // 昼 11:00〜14:00、夜 18:00〜翌1:00、日曜休み
  await dlg.locator('[data-close="0"]').selectOption({ label: '14:00' });
  await dlg.locator('[data-add-session]').click();
  await dlg.locator('[data-open="1"]').selectOption({ label: '18:00' });
  await dlg.locator('[data-close="1"]').selectOption({ label: '翌1:00' });
  await dlg.locator('[data-closed-day="6"]').click();
  await expect(dlg.locator('[data-hours-problem]')).toHaveCount(0);
  await expect(dlg).toContainText('うち深夜');
  await dlg.locator('[data-hours-save]').click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => {
    const s = await state();
    return JSON.stringify(s.company.stores.find((x) => x.id === s.company.activeStoreId)?.hours);
  }).toBe(JSON.stringify({ sessions: [{ open: 660, close: 840 }, { open: 1080, close: 1500 }], closedDays: [6] }));
  // 今日はまだ今までの営業時間（次の営業日から）
  await expect(card).toContainText('次の営業日から');
  await expect(card).toContainText('11:00〜14:00・18:00〜翌1:00／定休日 日');
  // 次の日の朝の状態にして、時計と中休みの開店ボタンを確かめる
  await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: S & { openT: number; breakPending?: boolean } } } }).__jiro.host.state;
    s.todayHours = { sessions: [{ open: 660, close: 840 }, { open: 1080, close: 1500 }], closedDays: [6] };
    s.sessionIdx = 1;
    s.phase = 'prep';
    s.openT = 3 * 60 * 2.25;
  });
  await page.locator('.manage .close').click();
  await expect(page.getByRole('button', { name: '🏮 開店する（18:00〜）' })).toBeVisible();
  await page.getByRole('button', { name: '🏮 開店する（18:00〜）' }).click();
  await expect.poll(async () => (await state()).phase).toBe('open');
  await expect(page.locator('.clock').first()).toContainText(/1[89]:\d\d/);
});

test('値段と地域: 値段は5,000円まで決められ、都会の店では高めでも客が減りにくいと出る（じろ1 P4）', async ({ page }) => {
  await startNewGame(page);
  type S = { prices: Record<string, number>; company: { stores: { location?: string }[] } };
  const res = await page.evaluate(async () => {
    const app = (window as unknown as { __jiro: { host: { state: S; act(a: Record<string, unknown>): Promise<{ ok: boolean }> } } }).__jiro;
    const id = Object.keys(app.host.state.prices)[0] ?? 'small';
    const ok = (await app.host.act({ type: 'setPrice', menuId: id, price: 5000 })).ok;
    const ng = (await app.host.act({ type: 'setPrice', menuId: id, price: 5010 })).ok;
    app.host.state.company.stores[0]!.location = '13104';
    return { ok, ng, price: app.host.state.prices[id] };
  });
  expect(res).toEqual({ ok: true, ng: false, price: 5000 });
  await page.locator('.chip.menu').click();
  await page.getByRole('button', { name: 'メニュー', exact: true }).click();
  const note = page.locator('.manage-body [data-price-note]');
  await expect(note).toContainText('¥500〜¥5,000');
  await expect(note).toContainText('増しまでなら客が減りにくい');
  await expect(page.locator('.manage-body')).toContainText('¥5,000');
});

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
      // 団体の会話・食べ方の汚い客のセリフ（イベントの吹き出し）で、通常のセリフが置き換わらないようにする
      delete c.group;
      delete c.messy;
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
      await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
      await page.getByRole('button', { name: /オンライン共同経営/ }).click();
      await expect(page.locator('.lobby [data-server-url]')).toHaveText(SERVER);
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
    // 本店は大阪市（2〜5店目は本店と同じ都道府県に出せる。じろ1 5.6）
    s.company.stores[0].location = '27203';
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
  // 地図で出店先を選ぶ（本店の街を開いた状態で始まる）: 全国（大阪府の外は薄い）→ 近畿 → 大阪府 → 大阪市 → 住宅街。佐藤さんを店長にして出店する
  await body.locator('[data-open-map]').click();
  const map = page.locator('[data-store-map]');
  await expect(map.locator('[data-muni="27203"]')).toHaveClass(/selected/);
  await map.locator('[data-crumb="0"]').click();
  await expect(map.locator('[data-map-region="近畿"]')).toBeVisible();
  await expect(map.locator('[data-pref]')).toHaveCount(47);
  await expect(map.locator('[data-pref="13"]')).toHaveClass(/out/);
  await expect(map.locator('[data-pref="27"]')).not.toHaveClass(/out/);
  await expect(map.locator('[data-map-range]')).toContainText('大阪府');
  await map.locator('[data-map-region="近畿"]').click();
  await expect(map.locator('[data-map-crumbs]')).toContainText('全国 / 近畿');
  await map.locator('[data-map-pref="27"]').click();
  await expect(map.locator('[data-muni]').first()).toBeVisible();
  await expect(map.locator('[data-map-crumbs]')).toContainText('大阪府');
  await map.locator('[data-map-muni="27100"]').click();
  await expect(map.locator('[data-muni="27100"]')).toHaveClass(/selected/);
  await expect(map.locator('[data-site]')).toHaveCount(3);
  await map.locator('[data-map-site="residential"] button').click();
  await expect(map.locator('[data-map-site="residential"]')).toContainText('初期費用 ¥450,000');
  // 出店の見込みと公的な統計（じろ2）
  // 見込みは店長の営業と同じ計算（席と人手の上限・給与・家賃・維持費など。オーナーの判断 2026-11-12）
  await expect(map.locator('[data-map-site="residential"]')).toContainText('見込み（店長＋接客担当のアルバイト1人');
  await expect(map.locator('[data-map-site="residential"]')).toContainText('席と人手の上限');
  await expect(map.locator('[data-map-site="residential"]')).toContainText('利益は保証されません');
  await expect(map.locator('[data-map-daytime]')).toContainText('昼夜間人口比率');
  await expect(map.locator('[data-map-food]')).toContainText('店');
  await shot(page, '49-store-map');
  await map.locator('[data-map-confirm]').click();
  await expect(page.locator('.modal')).toContainText('大阪府 大阪市の住宅街');
  await page.locator('.modal').getByRole('button', { name: '出店する' }).click();
  await expect(page.locator('.toast', { hasText: /^出店しました$/ })).toBeVisible();
  await expect(map).toHaveCount(0);
  const st = await page.evaluate(() => {
    const s = (window as unknown as CJ).__jiro.host.state;
    return { n: s.company.stores.length, money: s.money, branch: s.company.stores[1]?.id, mgr: s.company.stores[1]?.managerId, loc: s.company.stores[1]?.location, name: s.company.stores[1]?.name };
  });
  expect(st.n).toBe(2);
  expect(st.money).toBe(3_000_000 - 450_000);
  expect(st.mgr).toBe(hired.id);
  expect(st.loc).toBe('27100');
  expect(st.name).toContain('大阪市住宅街店');
  // 2店以上は、会社の先頭に店舗ごとの売上（オーナーの指示 2026-11-12）
  await expect(body.locator('[data-company-store-sales]')).toContainText('店舗ごとの売上');
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

test('複数店舗: 日ごとの店舗別の売上（日 × 店の表と積み上げの棒）の数字は、会社の日報の店ごとの行と同じ（オーナーの指示 2026-11-12）', async ({ page }) => {
  test.setTimeout(180_000);
  await startNewGame(page);
  const ok = await page.evaluate(async () => {
    const app = (window as unknown as { __jiro: { host: { state: any; act(a: unknown): Promise<{ ok: boolean }>; tick(dt: number): void } } }).__jiro;
    const s = app.host.state;
    s.money = 3_000_000;
    const out: boolean[] = [];
    for (const c of s.candidates.slice(0, 2)) out.push((await app.host.act({ type: 'hire', candidateId: c.id })).ok);
    for (const e of s.employees) {
      e.availableFrom = undefined;
      e.profile.employment = 'full';
      delete e.shifts;
    }
    await app.host.act({ type: 'openShop' });
    for (let i = 0; i < 20000 && app.host.state.phase !== 'closed'; i++) app.host.tick(0.5);
    app.host.state.career.stage = 1;
    app.host.state.reputation = 4.3;
    const [m1, m2] = app.host.state.employees;
    out.push((await app.host.act({ type: 'openStore', propertyId: 'residential', managerId: m1.id })).ok);
    out.push((await app.host.act({ type: 'openStore', propertyId: 'station', managerId: m2.id })).ok);
    for (let d = 0; d < 3; d++) {
      await app.host.act({ type: 'nextDay' });
      await app.host.act({ type: 'openShop' });
      for (let i = 0; i < 20000 && app.host.state.phase !== 'closed'; i++) app.host.tick(0.5);
    }
    await app.host.act({ type: 'nextDay' });
    return out;
  });
  expect(ok.every(Boolean)).toBe(true);
  await page.locator('.chip.menu').click();
  await page.locator('.manage .tabs .tab[data-tab="company"]').click();
  const card = page.locator('.manage [data-store-days]');
  await expect(card).toBeVisible();
  await expect(card.locator('.sd-legend span')).toHaveCount(3);
  const lines = await page.evaluate(() => {
    const s = (window as unknown as { __jiro: { host: { state: any } } }).__jiro.host.state;
    return s.company.history.flatMap((r: { day: number; stores: { storeId: string; netSales: number }[] }) => r.stores.map((l) => ({ key: `${r.day}:${l.storeId}`, sales: l.netSales })));
  });
  expect(lines.length).toBeGreaterThanOrEqual(9);
  for (const l of lines) {
    const cell = card.locator(`[data-store-day-cell="${l.key}"]`);
    const txt = (await cell.textContent()) ?? '';
    if (txt.startsWith('休')) expect(l.sales).toBe(0);
    else expect(txt).toContain(`¥${l.sales.toLocaleString('ja-JP')}`);
  }
  await shot(page, '51-store-days');
});
