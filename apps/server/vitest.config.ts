// Workers ランタイム（workerd / Miniflare）の中でテストを実行する設定。
// wrangler.jsonc のバインディング（DO・D1・R2）をそのままローカルで再現する。

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(here('./migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // テスト専用の値（本番の秘密情報ではない）
            SESSION_SECRET: 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  };
});
