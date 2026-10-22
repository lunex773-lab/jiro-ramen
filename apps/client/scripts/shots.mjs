// モデルギャラリーのスクリーンショットを撮る（Playwright + Chromium / SwiftShader）。
// 使い方: node apps/client/scripts/shots.mjs [section ...] [--dev] [--no-build] [--out DIR]
//   --dev: ビルドせず vite の開発サーバーで配信する（速い）
//   既定ではすべてのセクションを 1280×800 と 390×844（iPhone 相当）で撮影する。

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const noBuild = dev || args.includes('--no-build');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? resolve(args[outIdx + 1]) : '/tmp/claude-0/-home-user-jiro-ramen/16383418-87b2-51fb-aefd-fed5edb022de/scratchpad/shots';
const ALL = ['bowls', 'closeup', 'people', 'equipment', 'shop'];
const sections = args.filter((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
const targets = sections.length > 0 ? sections : ALL;
const PORT = 4179;

/** Playwright 同梱の Chromium を探す（playwright install は実行しない） */
function findChromium() {
  const base = '/opt/pw-browsers';
  const preferred = join(base, 'chromium-1194/chrome-linux/chrome');
  if (existsSync(preferred)) return preferred;
  if (existsSync(base)) {
    for (const d of readdirSync(base)) {
      const p = join(base, d, 'chrome-linux/chrome');
      if (d.startsWith('chromium-') && existsSync(p)) return p;
    }
  }
  return undefined;
}

mkdirSync(outDir, { recursive: true });

if (!noBuild) {
  console.log('vite build ...');
  const r = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: clientDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const server = spawn('npx', dev ? ['vite', '--port', String(PORT), '--strictPort'] : ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: clientDir, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
await new Promise((ok, ng) => {
  const timer = setTimeout(() => ng(new Error('preview server timeout')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(timer);
      ok();
    }
  });
});

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

const viewports = [
  { name: 'desktop', width: 1280, height: 800, dpr: 1 },
  { name: 'iphone', width: 390, height: 844, dpr: 2 },
];

try {
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dpr });
    for (const sec of targets) {
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') console.log(`[${sec}/${vp.name}] ${m.type()}: ${m.text()}`);
      });
      page.on('pageerror', (e) => console.log(`[${sec}/${vp.name}] pageerror: ${e.message}`));
      await page.goto(`http://localhost:${PORT}/model-gallery.html#${sec}`);
      await page.waitForFunction(() => window.__galleryReady === true, null, { timeout: 120000 });
      await page.waitForTimeout(1500);
      const file = join(outDir, `${sec}-${vp.name}.png`);
      await page.screenshot({ path: file });
      const info = await page.evaluate(() => document.body.innerText.match(/tris [^\n]*/)?.[0] ?? '');
      console.log(`${file}  ${info}`);
      await page.close();
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  // npx の子プロセス（vite）ごと止める
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    server.kill();
  }
}
process.exit(0);
