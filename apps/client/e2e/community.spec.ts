// コミュニティ（公開の一覧・育てた会社の持ち込み・終わったあとの営業・引退）の画面（オーナーの判断 15〜18）。
// サーバーを偽物に差し替え、core の市場の規則（joinMarket・exportCompany・importCompany・retireCompany・marketView）で答える。
import { expect, test, type Page } from '@playwright/test';
import {
  createMarket,
  exportCompany,
  importCompany,
  isEnded,
  joinMarket,
  jstDateKey,
  marketView,
  nextJstMidnight,
  nextSyncAt,
  playerCompany,
  restoreCompany,
  retireCompany,
  syncPending,
  type MarketState,
} from '@jiro/core';

const SERVER = 'https://mock.jiro.test';
const ME = 'u1';
const DAY = 86_400_000;
const SHOTS = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
};

interface Entry {
  m: MarketState;
  code: string;
  owner: string;
}

function mockCommunities(page: Page) {
  const now = Date.now();
  const markets = new Map<string, Entry>();
  // 40日前に始まり、30日で終わった市場（自分の会社を育てた）。2つ
  for (const [id, name, money] of [
    ['old1', '去年の大会', 456_789],
    ['old2', 'おととしの大会', 123_456],
  ] as const) {
    const m = createMarket({ id, name, seed: 11, now: now - 40 * DAY, settings: { periodDays: 30 }, creator: { ownerId: ME, companyName: `${name}の店` } });
    playerCompany(m, ME)!.state.money = money;
    markets.set(id, { m, code: id === 'old1' ? 'OLD111' : 'OLD222', owner: ME });
  }
  // ほかの人が作った公開の市場（育てた企業も参加できる）と、新規の企業だけの公開の市場
  const pub = createMarket({ id: 'pub1', name: 'みんなの市場', seed: 22, now, settings: { visibility: 'public', maxCompanies: 4, description: '誰でもどうぞ' }, creator: { ownerId: 'u2', companyName: '先客の店' } });
  markets.set('pub1', { m: pub, code: 'PUB111', owner: 'u2' });
  const fresh = createMarket({ id: 'pub2', name: '新人戦', seed: 33, now, settings: { visibility: 'public', entry: 'fresh', aiFill: false }, creator: { ownerId: 'u3', companyName: '新人の店' } });
  markets.set('pub2', { m: fresh, code: 'PUB222', owner: 'u3' });
  const mineIn = (m: MarketState) => [...m.companies].reverse().find((c) => c.kind === 'player' && c.ownerId === ME) ?? null;
  return {
    markets,
    async install() {
      await page.route(`${SERVER}/api/v1/**`, async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const send = (body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const t = Date.now();
        const p = url.pathname;
        if (p === '/api/v1/auth/anonymous') return send({ playerId: ME, token: 'tok' });
        if (p === '/api/v1/profile') return send({ playerId: ME, name: 'テスター' });
        if (p === '/api/v1/markets') {
          const list = [...markets.entries()]
            .filter(([, e]) => mineIn(e.m))
            .map(([id, e]) => {
              const c = mineIn(e.m)!;
              const otherCompanies = e.m.companies.filter((x) => x.kind === 'player' && x.ownerId !== ME).length;
              return { marketId: id, code: e.code, name: e.m.name, createdAt: e.m.createdAt, isOwner: e.owner === ME, endsAt: e.m.settings.endsAt, ended: isEnded(e.m, t), entry: e.m.settings.entry, companyId: c.id, companyName: c.name, companyStatus: c.status, otherCompanies };
            });
          return send({ markets: list });
        }
        if (p === '/api/v1/communities') {
          const list = [...markets.entries()]
            .filter(([, e]) => e.m.settings.visibility === 'public' && !isEnded(e.m, t))
            .map(([id, e]) => ({
              marketId: id,
              name: e.m.name,
              description: e.m.settings.description,
              entry: e.m.settings.entry,
              aiFill: e.m.settings.aiFill,
              maxCompanies: e.m.settings.maxCompanies,
              periodDays: e.m.settings.periodDays,
              endsAt: e.m.settings.endsAt,
              players: e.m.companies.filter((c) => c.kind === 'player' && c.status === 'active').length,
              createdAt: e.m.createdAt,
            }));
          return send({ communities: list });
        }
        if (p === '/api/v1/market/join') {
          const b = JSON.parse(req.postData() ?? '{}') as { marketId?: string; code?: string; companyName?: string; bring?: { marketId: string; companyId: string } };
          const id = b.marketId ?? [...markets.entries()].find(([, e]) => e.code === b.code)?.[0];
          const target = id ? markets.get(id) : undefined;
          if (!id || !target) return send({ error: '市場が見つかりません', code: 'market_not_found' }, 404);
          if (b.bring) {
            if (target.m.settings.entry === 'fresh') return send({ error: 'この市場は新規の企業だけが参加できます', code: 'fresh_only' }, 409);
            const src = markets.get(b.bring.marketId)!;
            const ex = exportCompany(src.m, ME, t);
            if (!ex.ok) return send({ error: ex.reason, code: 'export_refused' }, 409);
            const im = importCompany(target.m, ME, ex.company!, t);
            if (!im.ok) {
              restoreCompany(src.m, ME);
              return send({ error: im.reason, code: 'import_refused' }, 409);
            }
            return send({ marketId: id, companyId: im.company!.id });
          }
          const r = joinMarket(target.m, ME, b.companyName ?? '', t);
          if (!r.ok) return send({ error: r.reason, code: 'join_refused' }, 409);
          return send({ marketId: id, companyId: r.company!.id });
        }
        const retire = /^\/api\/v1\/market\/([^/]+)\/retire$/.exec(p);
        if (retire) {
          const e = markets.get(retire[1]!)!;
          const r = retireCompany(e.m, ME, t);
          return r.ok ? send({ ok: true }) : send({ error: r.reason, code: 'retire_refused' }, 409);
        }
        const view = /^\/api\/v1\/market\/([^/]+)$/.exec(p);
        if (view && req.method() === 'DELETE') {
          const e = markets.get(view[1]!);
          if (!e) return send({ error: '市場が見つかりません', code: 'market_not_found' }, 404);
          if (e.owner !== ME) return send({ error: '市場を作った人だけが消せます', code: 'not_owner' }, 403);
          markets.delete(view[1]!);
          return send({ ok: true });
        }
        if (view && markets.has(view[1]!)) {
          const e = markets.get(view[1]!)!;
          return send({
            ...marketView(e.m, ME, t),
            clock: { serverNow: t, nextMidnight: nextJstMidnight(t), nextSyncAt: nextSyncAt(e.m, t), syncPending: syncPending(e.m, t) },
            code: e.code,
            isOwner: e.owner === ME,
            joined: !!playerCompany(e.m, ME),
            today: jstDateKey(t),
          });
        }
        if (p === '/api/v1/rewards') return send({ rewards: [] });
        return send({ error: 'not found', code: 'not_found' }, 404);
      });
    },
  };
}

async function openLobby(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const ok = page.getByRole('button', { name: 'わかった' });
  if (await ok.isVisible()) await ok.click();
  await page.evaluate((u) => localStorage.setItem('jiro.serverUrl', u), SERVER);
  await page.getByRole('button', { name: /オンライン市場/ }).click();
  const lobby = page.locator('.market-lobby');
  await expect(lobby.locator('[data-server-url]')).toHaveText(SERVER);
  await lobby.locator('[data-load-public]').click();
  await lobby.getByRole('button', { name: '一覧を読み込む' }).click();
  return lobby;
}

test('コミュニティ: 公開の一覧から、終わった市場で育てた会社を持って入る（お金はそのまま・日付は入る市場に合わせる）', async ({ page }) => {
  const mock = mockCommunities(page);
  await mock.install();
  const lobby = await openLobby(page);
  // 公開の一覧（終わった市場・非公開は出ない）
  const pub = lobby.locator('[data-public-list]');
  await expect(pub.locator('[data-public="pub1"]')).toContainText('みんなの市場');
  await expect(pub.locator('[data-public="pub1"]')).toContainText('育てた企業も参加できる');
  await expect(pub.locator('[data-public="pub1"]')).toContainText('誰でもどうぞ');
  await expect(pub.locator('[data-public="pub2"]')).toContainText('新規の企業だけ');
  await expect(pub.locator('[data-public="old1"]')).toHaveCount(0);
  // 参加している市場: 終わった市場が分かる
  await expect(lobby.locator('[data-my-market="old1"]')).toContainText('競争期間は終了');
  // 持っていく会社を選ぶ
  const bring = lobby.locator('[data-bring]');
  await expect(bring.locator('option')).toHaveCount(3);
  await bring.selectOption({ label: '去年の大会の店を持っていく（去年の大会から）' });
  await shot(page, '70-community-lobby');
  // 新規の企業だけの市場には持っていけない
  await pub.locator('[data-join-public="pub2"]').click();
  await page.locator('.modal').getByRole('button', { name: '持っていく' }).click();
  await expect(lobby.locator('[data-lobby-status]')).toContainText('新規の企業だけ');
  expect(playerCompany(mock.markets.get('old1')!.m, ME)!.status).toBe('active');
  // 育てた企業も参加できる市場へ
  await pub.locator('[data-join-public="pub1"]').click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('入る市場の日付に合わせて');
  await modal.getByRole('button', { name: '持っていく' }).click();
  const screen = page.locator('.screen.market');
  await expect(screen.locator('.market-head')).toContainText('みんなの市場');
  await expect(screen.locator('.market-mine')).toContainText('¥456,789');
  await expect(screen.locator('.market-standings .trow.mine')).toContainText('去年の大会の店（あなた）');
  await expect(screen.locator('.market-rules')).toContainText('公開（一覧から誰でも）');
  await expect(screen.locator('[data-description]')).toHaveText('誰でもどうぞ');
  await expect(screen.locator('[data-history]')).toContainText('無期限');
  await expect(screen.locator('[data-market-play]')).toContainText('1日目を営業する');
  // 元の市場では「移った」
  expect(mock.markets.get('old1')!.m.companies.find((c) => c.ownerId === ME)!.status).toBe('moved');
  await screen.getByRole('button', { name: '← 市場から出る' }).click();
  const lobby2 = await openLobby(page);
  await expect(lobby2.locator('[data-my-market="old1"]')).toContainText('移動済み');
  await expect(lobby2.locator('[data-bring] option')).toHaveCount(2);
});

test('コミュニティ: 終わった市場でも営業でき、会社を引退させられる', async ({ page }) => {
  const mock = mockCommunities(page);
  await mock.install();
  const lobby = await openLobby(page);
  await lobby.locator('[data-open-market="old2"]').click();
  const screen = page.locator('.screen.market');
  await expect(screen.locator('[data-market-ended]')).toContainText('競争期間は終わりました');
  await expect(screen.locator('[data-sync]')).toHaveAttribute('data-sync', 'ended');
  await expect(screen.locator('[data-market-play]')).toBeEnabled();
  await expect(screen.locator('[data-history]')).toContainText('ランキングの「累計」が大会の結果です');
  await shot(page, '71-community-ended');
  await screen.locator('[data-retire]').click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('記録・称号は残ります');
  await modal.getByRole('button', { name: '引退させる' }).click();
  await expect(screen.locator('[data-my-status="retired"]')).toBeVisible();
  await expect(screen.locator('[data-market-play]')).toHaveCount(0);
  expect(mock.markets.get('old2')!.m.companies.find((c) => c.ownerId === ME)!.status).toBe('retired');
});

test('コミュニティ: 自分が作った市場は、確認してから消せる（ほかの人が作った市場には消すボタンが出ない）', async ({ page }) => {
  const mock = mockCommunities(page);
  await mock.install();
  const lobby = await openLobby(page);
  // ほかの人が作った市場（入っている）には「消す」が出ない
  await lobby.locator('[data-join-public="pub1"]').click();
  const screen = page.locator('.screen.market');
  await expect(screen.locator('.market-head')).toContainText('みんなの市場');
  await expect(screen.locator('[data-delete-this-market]')).toHaveCount(0);
  await screen.getByRole('button', { name: '← 市場から出る' }).click();
  const lobby2 = await openLobby(page);
  await expect(lobby2.locator('[data-delete-market="pub1"]')).toHaveCount(0);
  // 自分が作った市場は消せる（キャンセルすると消えない）
  await lobby2.locator('[data-delete-market="old2"]').click();
  const modal = page.locator('.modal');
  await expect(modal).toContainText('元に戻せません');
  await modal.getByRole('button', { name: 'キャンセル' }).click();
  expect(mock.markets.has('old2')).toBe(true);
  await lobby2.locator('[data-delete-market="old2"]').click();
  await page.locator('.modal').getByRole('button', { name: '消す' }).click();
  await expect(lobby2.locator('[data-my-market="old2"]')).toHaveCount(0);
  expect(mock.markets.has('old2')).toBe(false);
  // 市場の画面からも消せる
  await lobby2.locator('[data-open-market="old1"]').click();
  await screen.locator('[data-delete-this-market]').click();
  await page.locator('.modal').getByRole('button', { name: '消す' }).click();
  await expect(page.locator('.market-lobby')).toBeVisible();
  expect(mock.markets.has('old1')).toBe(false);
});
