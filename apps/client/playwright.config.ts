import { defineConfig, devices } from '@playwright/test';

// この開発環境ではプリインストールの Chromium を使う（CI では playwright install したものを使う）
const executablePath = process.env.CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4180',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    },
  },
  projects: [
    {
      name: 'iphone',
      use: {
        // iPhone 13 を横向きにした Safari の表示領域（750×342）とタッチ。横向き専用のゲームなので一番狭い条件で試す
        // （エンジンは Chromium。実機 Safari の検証は別途必要）
        viewport: devices['iPhone 13 landscape'].viewport,
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 13 landscape'].userAgent,
      },
    },
    {
      name: 'desktop',
      use: { viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'npx vite --port 4180 --strictPort',
    url: 'http://localhost:4180',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
