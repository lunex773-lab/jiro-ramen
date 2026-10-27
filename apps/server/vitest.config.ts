// Workers ランタイム（workerd / Miniflare）の中でテストを実行する設定。
// wrangler.jsonc のバインディング（DO・D1）をそのままローカルで再現する。

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { GENERATED_PATH, renderMigrationsModule } from './scripts/gen-schema.mjs';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(here('./migrations'));
  // Worker が自分で適用するマイグレーション（src/migrations.gen.ts）が migrations/*.sql と同じか確かめる
  if (readFileSync(GENERATED_PATH, 'utf8') !== renderMigrationsModule()) {
    throw new Error('src/migrations.gen.ts が migrations/*.sql と一致しません。npm run schema:gen -w @jiro/server を実行してください');
  }
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
