// 画面の配置の検査（スマホの横向き・縦向きで回した表示・PC）。ボタンや文字の重なり、画面の外へのはみ出し、
// ノッチ・ホームバーの安全領域へのかぶり、文字の切れを、全部の画面で調べる。向きを変えたときに表示がずれないことも調べる。
// iPhone のホーム画面から開いたとき（Safari のバーがない）を、画面の大きさと安全領域（CSS の変数）で再現する。
// LAYOUT_DUMP=フォルダ を付けると、見つけた問題（JSON）と画面の写真を書き出す（測定用）。
// ふだん（CI）は代表の画面（いちばん小さい横向き・縦向きで回した表示・PC）だけを調べる。LAYOUT_ALL=1 で全部の機種を調べる。
import { expect, test, type Page } from '@playwright/test';
import {
  createMarket,
  jstDateKey,
  marketAction,
  marketView,
  nextJstMidnight,
  nextSyncAt,
  syncPending,
  type Action,
  type MarketState,
} from '@jiro/core';

const SERVER = 'https://mock.jiro.test';
const DUMP = process.env.LAYOUT_DUMP;

interface Profile {
  name: string;
  width: number;
  height: number;
  /** 端末の安全領域（画面の向きでの上下左右） */
  inset: { top: number; right: number; bottom: number; left: number };
  touch: boolean;
}

/** iPhone のホーム画面から開いたとき（横向き・縦向き）と PC */
const PHONES: Profile[] = [
  { name: 'se-land', width: 667, height: 375, inset: { top: 0, right: 0, bottom: 0, left: 0 }, touch: true },
  { name: 'x-land', width: 844, height: 390, inset: { top: 0, right: 47, bottom: 21, left: 47 }, touch: true },
  { name: 'promax-land', width: 932, height: 430, inset: { top: 0, right: 59, bottom: 21, left: 59 }, touch: true },
  { name: 'x-portrait', width: 390, height: 844, inset: { top: 47, right: 0, bottom: 34, left: 0 }, touch: true },
];
const PC: Profile = { name: 'pc', width: 1280, height: 800, inset: { top: 0, right: 0, bottom: 0, left: 0 }, touch: false };

interface Issue {
  kind: 'overlap' | 'offscreen' | 'safe-area' | 'clipped';
  screen: string;
  a: string;
  b?: string;
  detail: string;
}

/** 安全領域を CSS の変数で再現する（回した表示では、表示の左 = 画面の上、右 = 画面の下） */
async function applyInsets(page: Page, p: Profile) {
  const rotated = p.touch && p.height > p.width;
  const i = p.inset;
  const v = rotated ? { sat: i.right, sar: i.bottom, sab: i.left, sal: i.top } : { sat: i.top, sar: i.right, sab: i.bottom, sal: i.left };
  await page.addStyleTag({
    content: `.app.app { --sat: ${v.sat}px !important; --sar: ${v.sar}px !important; --sab: ${v.sab}px !important; --sal: ${v.sal}px !important; }`,
  });
  await page.evaluate(() => document.querySelector('.app')?.classList.add('standalone'));
  return v;
}

/** 画面の中の、見えている文字・ボタンを調べる */
async function audit(page: Page, screen: string, insets: { sat: number; sar: number; sab: number; sal: number }): Promise<Issue[]> {
  await page.waitForTimeout(250);
  const found = await page.evaluate(
    ({ screen, insets }) => {
      const issues: { kind: string; screen: string; a: string; b?: string; detail: string }[] = [];
      const root = document.querySelector('.app') as HTMLElement;
      const rotated = root.classList.contains('rotated');
      const W = window.innerWidth;
      const H = window.innerHeight;
      const vw = rotated ? H : W;
      const vh = rotated ? W : H;
      /** 画面の座標 → 表示の座標（回しているとき） */
      const toView = (r: DOMRect) => (rotated ? { l: r.top, t: W - r.right, r: r.bottom, b: W - r.left } : { l: r.left, t: r.top, r: r.right, b: r.bottom });
      const label = (el: Element) => {
        const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
        const cls = (el.getAttribute('class') ?? '').split(' ').filter(Boolean).slice(0, 2).join('.');
        return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}「${t || (el as HTMLInputElement).placeholder || ''}」`;
      };
      const isControl = (el: Element) => el.matches('button, input, select, textarea, a[href], .chip, [role="button"]');
      const ownText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
      const candidates = Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) => {
        if (el.closest('svg, canvas, .game-canvas, .overlay3d, [data-layout-ignore]')) return false;
        if (!(isControl(el) || ownText(el))) return false;
        // ボタンの中の文字はボタンとして数える
        if (!isControl(el) && el.closest('button, .chip, select')) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        for (let a: Element | null = el; a; a = a.parentElement) if (Number(getComputedStyle(a).opacity) < 0.05) return false;
        // 前にあるもので隠れていないか（真ん中の点で、その要素か中身・入れ物に当たるか）
        const cx = (r.left + r.right) / 2;
        const cy = (r.top + r.bottom) / 2;
        // 真ん中が画面の外にあるもの（スクロールして隠れているもの・画面の外にはみ出したもの）は、はみ出しの検査だけにする
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) return !el.closest('.screen, .manage-body, .map-side, .layout-side') && isControl(el);
        const hit = document.elementFromPoint(cx, cy);
        if (!hit) return false;
        if (!(hit === el || el.contains(hit) || hit.contains(el))) return false;
        return true;
      });
      /** 見えている部分の箱（スクロールする入れ物などで切られた部分を除く） */
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        let l = r.left;
        let t = r.top;
        let rr = r.right;
        let b = r.bottom;
        for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
          const c = a.getBoundingClientRect();
          l = Math.max(l, c.left);
          t = Math.max(t, c.top);
          rr = Math.min(rr, c.right);
          b = Math.min(b, c.bottom);
        }
        return { left: l, top: t, right: rr, bottom: b, width: Math.max(0, rr - l), height: Math.max(0, b - t) };
      };
      /** 重なりを比べる層（ダイアログ・画面・HUD・経営メニュー・お知らせ） */
      const layerOf = (el: Element) => el.closest('.modal-overlay, .screen, .manage, .toasts, .hud, .layout-editor, .ui-layer') ?? root;
      for (let i = 0; i < candidates.length; i++) {
        const a = candidates[i]!;
        const ra = shown(a);
        for (let j = i + 1; j < candidates.length; j++) {
          const b = candidates[j]!;
          if (a.contains(b) || b.contains(a)) continue;
          if (layerOf(a) !== layerOf(b)) continue;
          const rb = shown(b);
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const hgt = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w <= 2 || hgt <= 2) continue;
          const area = w * hgt;
          const small = Math.min(ra.width * ra.height, rb.width * rb.height);
          if (area < 24 || area < small * 0.12) continue;
          issues.push({ kind: 'overlap', screen, a: label(a), b: label(b), detail: `${Math.round(w)}×${Math.round(hgt)}px` });
        }
      }
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        const v = toView(r);
        // いちばん近いスクロールできる入れ物（あれば、その中で見えている要素だけを調べる）
        let scroller: { l: number; t: number; r: number; b: number } | null = null;
        for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
          const cs = getComputedStyle(a);
          if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1)) {
            scroller = toView(a.getBoundingClientRect());
            break;
          }
        }
        const cx = (v.l + v.r) / 2;
        const cy = (v.t + v.b) / 2;
        if (scroller) {
          // スクロールして隠れている要素は調べない
          if (cx < scroller.l || cx > scroller.r || cy < scroller.t || cy > scroller.b) continue;
        } else if (v.l < -2 || v.t < -2 || v.r > vw + 2 || v.b > vh + 2) {
          issues.push({ kind: 'offscreen', screen, a: label(el), detail: `表示 ${Math.round(v.l)},${Math.round(v.t)}〜${Math.round(v.r)},${Math.round(v.b)}（画面 ${vw}×${vh}）` });
        }
        // 安全領域（ノッチ・ホームバー）にかかるボタン。スクロールする中身は左右だけ（下はスクロールで上げられる）
        if (isControl(el)) {
          const side = Math.max(insets.sal - v.l, v.r - (vw - insets.sar));
          const vert = scroller ? 0 : Math.max(v.b - (vh - insets.sab), insets.sat - v.t);
          const into = Math.max(side, vert);
          if (into > 4) issues.push({ kind: 'safe-area', screen, a: label(el), detail: `安全領域に ${Math.round(into)}px かかる` });
        }
        // 文字の切れ（はみ出しを隠している）
        const cs = getComputedStyle(el);
        if ((cs.overflowX === 'hidden' || cs.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 3 && cs.textOverflow !== 'ellipsis') {
          issues.push({ kind: 'clipped', screen, a: label(el), detail: `幅 ${el.clientWidth}px に ${el.scrollWidth}px` });
        }
      }
      return issues;
    },
    { screen, insets },
  );
  return found as Issue[];
}

/** 市場の画面・ランキング用の偽のサーバー */
async function mockServer(page: Page) {
  let market: MarketState | null = null;
  const now = () => Date.now();
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
    if (p === '/api/v1/markets') return send({ markets: market ? [{ marketId: 'mk1', code: 'MKT234', name: market.name, createdAt: now(), isOwner: true, endsAt: null, ended: false, entry: 'grown', companyId: 'c1', companyName: '配置亭', companyStatus: 'active', otherCompanies: 0 }] : [] });
    if (p === '/api/v1/communities') return send({ communities: [{ marketId: 'pub9', name: 'とても長い名前のみんなの公開市場', description: '説明の文がとても長い場合でも画面からはみ出さずに折り返して表示されることを確かめるための文です', entry: 'grown', aiFill: true, maxCompanies: 6, periodDays: 30, endsAt: now() + 20 * 86_400_000, cityCode: '27100', cityName: '大阪府 大阪市', players: 2, createdAt: now() }] });
    if (p === '/api/v1/market/create') {
      const b = JSON.parse(req.postData() ?? '{}') as { name?: string; companyName: string; settings?: Record<string, unknown> };
      market = createMarket({ id: 'mk1', name: b.name || '配置の市場', seed: 77, now: now(), settings: { ...(b.settings ?? {}), cityCode: '27100' }, creator: { ownerId: 'u1', companyName: b.companyName } });
      return send({ marketId: 'mk1', code: 'MKT234', name: market.name }, 201);
    }
    if (p === '/api/v1/market/mk1/act') {
      const b = JSON.parse(req.postData() ?? '{}') as { action: Action };
      return send(marketAction(market!, 'u1', b.action, now()));
    }
    if (p === '/api/v1/rankings') return send({ board: 'community', scope: 'week', scopeKey: 'W2026-11-02', prevKey: 'W2026-10-26', metric: 'overall', metricLabel: '総合評価', perDay: false, total: 0, rows: [], mine: [] });
    if (p === '/api/v1/rewards') return send({ rewards: [{ key: 'r1', title: '🥇 2026-11-02の週・コミュニティ 総合1位', createdAt: now() }] });
    if (p === '/api/v1/market/mk1') {
      const t = now();
      return send({ ...marketView(market!, 'u1', t), clock: { serverNow: t, nextMidnight: nextJstMidnight(t), nextSyncAt: nextSyncAt(market!, t), syncPending: syncPending(market!, t) }, code: 'MKT234', isOwner: true, joined: true, today: jstDateKey(t) });
    }
    return send({ error: 'not found', code: 'not_found' }, 404);
  });
}

type J = { __jiro: { host: { state: Record<string, any>; tick(dt: number): void; act(a: Record<string, unknown>): Promise<{ ok: boolean }> }; debugFace(id: string): boolean } };

/** 全部の画面を順に開いて調べる */
async function walk(page: Page, p: Profile): Promise<{ issues: Issue[]; shots: string[] }> {
  const issues: Issue[] = [];
  const shots: string[] = [];
  await page.setViewportSize({ width: p.width, height: p.height });
  await mockServer(page);
  await page.goto('/');
  await page.evaluate((url) => {
    localStorage.clear();
    localStorage.setItem('jiro.serverUrl', url);
  }, SERVER);
  await page.reload();
  await page.waitForSelector('.app');
  const insets = await applyInsets(page, p);
  const check = async (screen: string) => {
    issues.push(...(await audit(page, screen, insets)));
    if (DUMP) {
      const path = `${DUMP}/${p.name}-${screen}.png`;
      await page.screenshot({ path });
      shots.push(path);
    }
  };
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await check('title');
  // ひとりで経営する → 新しく始める（名前・チュートリアル・1店目の場所・遊び方）
  await page.getByText('ひとりで経営する').click();
  await check('slots');
  await page.getByRole('button', { name: '新しく始める' }).first().click();
  await check('name-dialog');
  await page.locator('.modal input').fill('とても長い店名のラーメン屋さん本店');
  await page.getByRole('button', { name: '決定' }).click();
  await check('tutorial-dialog');
  await page.getByRole('button', { name: 'スキップして1日目から' }).click();
  const map = page.locator('[data-store-map]');
  await expect(map.locator('[data-map-region="関東"]')).toBeVisible();
  await check('map-national');
  await map.locator('[data-map-region="関東"]').click();
  await check('map-region');
  await map.locator('[data-map-pref="13"]').click();
  await expect(map.locator('[data-muni]').first()).toBeVisible();
  await check('map-pref');
  await map.locator('[data-map-muni="13104"]').click();
  await check('map-muni');
  await map.locator('[data-map-confirm]').click();
  await expect(page.getByText('ラーメンができるまで')).toBeVisible();
  await check('help');
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByRole('button', { name: /開店する/ })).toBeVisible();
  await check('hud-prep');
  // 設備の前で操作のボタン
  await page.evaluate(() => {
    const app = (window as unknown as J).__jiro;
    const e = (app.host.state.equipment as { id: string; type: string }[]).find((x) => x.type === 'prep_table');
    if (e) app.debugFace(e.id);
  });
  await page.waitForTimeout(500);
  await check('hud-actions');
  // アルバイトを1人雇っておく（従業員のタブ・社員にする確認の画面を調べるため。採用は仕込みの時間にできる）
  await page.evaluate(async () => {
    const app = (window as unknown as J).__jiro;
    const c = (app.host.state.candidates as { id: string }[])[0];
    if (c) await app.host.act({ type: 'hire', candidateId: c.id });
  });
  // 開店して客を呼ぶ
  await page.getByRole('button', { name: /開店する/ }).click();
  await page.evaluate(() => {
    const app = (window as unknown as J).__jiro;
    for (let i = 0; i < 900 && !(app.host.state.orders as { status: string }[]).some((o) => o.status === 'waiting'); i++) app.host.tick(0.1);
  });
  await page.waitForTimeout(500);
  await check('hud-open');
  // 経営メニューの全部のタブ
  await page.locator('.chip.menu').click();
  await expect(page.locator('.manage')).toBeVisible();
  // 半透明のメニューの後ろに HUD が透けて重ならない
  await expect(page.locator('.hud')).toBeHidden();
  const tabs = await page.locator('.manage .tabs .tab:visible').allTextContents();
  for (const t of tabs) {
    await page.locator('.manage .tabs .tab', { hasText: t }).first().click();
    await page.waitForTimeout(200);
    await check(`manage-${t.replace(/[・\s]/g, '')}`);
  }
  // 営業時間の設定（枠を2つにして定休日も選んだ状態。下の「保存する」が画面の中にあって押せる。じろ1 5.1）
  await page.locator('.manage .tabs .tab', { hasText: '経営' }).first().click();
  await page.locator('.manage [data-edit-hours]').first().click();
  {
    const dlg = page.locator('.modal.hours-modal');
    await expect(dlg).toBeVisible();
    await dlg.locator('[data-add-session]').click();
    await dlg.locator('[data-closed-day="6"]').click();
    await check('hours-dialog');
    await expect(dlg.getByRole('button', { name: '保存する' })).toBeInViewport({ ratio: 1 });
    await expect(dlg.getByRole('button', { name: 'やめる' })).toBeInViewport({ ratio: 1 });
    await dlg.getByRole('button', { name: 'やめる' }).click();
  }
  // 社員にする確認の画面（中身が長くても、下のボタンが画面の中にあって押せる）
  await page.locator('.manage .tabs .tab', { hasText: '従業員' }).first().click();
  const promote = page.locator('.manage').getByRole('button', { name: '社員にする' }).first();
  if (await promote.isVisible().catch(() => false)) {
    await promote.click();
    const dlg = page.locator('.modal-overlay .modal');
    await expect(dlg).toBeVisible();
    await check('promote-dialog');
    await expect(dlg.getByRole('button', { name: '社員にする' })).toBeInViewport({ ratio: 1 });
    await expect(dlg.getByRole('button', { name: 'キャンセル' })).toBeInViewport({ ratio: 1 });
    await dlg.getByRole('button', { name: 'キャンセル' }).click();
  } else {
    throw new Error('従業員のタブに「社員にする」がない');
  }
  // 設定（店の中から）
  await page.locator('.manage .tabs .tab', { hasText: 'セーブ・設定' }).first().click();
  const settingsBtn = page.locator('.manage').getByRole('button', { name: /^設定/ }).first();
  if (await settingsBtn.isVisible().catch(() => false)) {
    await settingsBtn.click();
    await check('settings-ingame');
    await page.locator('.screen.settings').getByRole('button', { name: '閉じる' }).click();
  }
  await page.locator('.manage').getByRole('button', { name: /閉じる/ }).first().click({ timeout: 3000 }).catch(() => undefined);
  // 1日の終わり（結果の画面）
  await page.evaluate(() => {
    const app = (window as unknown as J).__jiro;
    const h = app.host as unknown as { speed: number; tick(dt: number): void; state: { phase: string } };
    h.speed = 3;
    for (let i = 0; i < 40_000 && h.state.phase !== 'closed'; i++) h.tick(0.25);
  });
  await expect(page.locator('.screen.results')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.hud')).toBeHidden();
  await expect(page.locator('.toasts .toast')).toHaveCount(0);
  await check('results');
  // タイトルへ戻って、設定・遊び方・オンラインの入口
  await page.goto('/');
  await page.waitForSelector('.app');
  await applyInsets(page, p);
  if (await ok.isVisible().catch(() => false)) await ok.click();
  await page.getByRole('button', { name: '設定' }).first().click();
  await check('settings');
  await page.locator('.screen.settings').getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('button', { name: /オンライン共同経営/ }).click();
  await check('coop-lobby');
  await page.getByRole('button', { name: '← 戻る' }).first().click();
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  await expect(page.locator('[data-public="pub9"]')).toBeVisible();
  await check('market-lobby');
  await page.locator('.market-lobby input[placeholder="会社（店）の名前"]').fill('配置亭');
  await page.locator('[data-create-market]').click();
  await expect(page.locator('.screen.market .market-head')).toBeVisible();
  await page.waitForTimeout(400);
  await check('market');
  await page.locator('[data-open-ranking]').click();
  await expect(page.locator('.screen.ranking')).toBeVisible();
  await check('ranking');
  return { issues, shots };
}

/** .app の箱（画面の座標）と、ページがずれていないか */
async function frame(page: Page) {
  return page.evaluate(() => {
    const app = document.querySelector('.app') as HTMLElement;
    const r = app.getBoundingClientRect();
    return {
      rotated: app.classList.contains('rotated'),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      scroll: [window.scrollX, window.scrollY, document.scrollingElement?.scrollTop ?? 0],
      view: [app.clientWidth, app.clientHeight],
      page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    };
  });
}

test('向きを変えても表示が片側に寄らず、画面からはみ出さない（縦 → 横 → 縦、店の中とメニュー）', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!test.info().project.use.hasTouch, 'スマホの設定で調べる');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.app');
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible().catch(() => false)) await ok.click();
  const expectFrame = async (w: number, h: number) => {
    const rotated = h > w;
    // 向きを変えた直後（JS の知らせ・合わせ直しを待たない）でも、CSS だけで正しい大きさと位置になっている
    expect((await frame(page)).box).toEqual([0, 0, w, h]);
    await expect.poll(async () => (await frame(page)).rotated).toBe(rotated);
    const f = await frame(page);
    expect(f.box).toEqual([0, 0, w, h]);
    expect(f.view).toEqual(rotated ? [h, w] : [w, h]);
    expect(f.scroll).toEqual([0, 0, 0]);
    expect(f.page[0]).toBeLessThanOrEqual(w);
    expect(f.page[1]).toBeLessThanOrEqual(h);
  };
  await expectFrame(390, 844);
  await page.setViewportSize({ width: 844, height: 390 });
  await expectFrame(844, 390);
  // 店の中（新しく始める）
  await page.getByText('ひとりで経営する').click();
  await page.getByRole('button', { name: '新しく始める' }).first().click();
  await page.getByRole('button', { name: '決定' }).click();
  await page.getByRole('button', { name: 'スキップして1日目から' }).click();
  await page.locator('[data-store-map] [data-map-close]').click();
  await expect(page.getByText('ラーメンができるまで')).toBeVisible();
  await page.getByRole('button', { name: '閉じる' }).click();
  await expect(page.getByRole('button', { name: /開店する/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFrame(390, 844);
  // 回した表示でも、右上の「経営」が画面の中で押せる
  await page.locator('.chip.menu').click();
  await expect(page.locator('.manage')).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expectFrame(844, 390);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectFrame(390, 844);
});

const ALL = !!process.env.LAYOUT_ALL || !!DUMP;
const PROFILES = ALL ? [...PHONES, PC] : [...PHONES.filter((p) => p.name === 'se-land' || p.name === 'x-portrait'), PC];

for (const p of PROFILES) {
  test(`画面の配置: ${p.name}（${p.width}×${p.height}）でボタン・文字が重ならず、画面と安全領域からはみ出さない`, async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(p.touch !== !!test.info().project.use.hasTouch, 'スマホは iPhone の設定、PC は PC の設定で調べる');
    const { issues } = await walk(page, p);
    if (DUMP) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`${DUMP}/${p.name}-issues.json`, JSON.stringify(issues, null, 1));
    }
    expect(issues, issues.map((i) => `${i.screen} ${i.kind}: ${i.a}${i.b ? ` × ${i.b}` : ''}（${i.detail}）`).join('\n')).toEqual([]);
  });
}
