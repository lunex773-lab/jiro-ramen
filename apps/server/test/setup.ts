// 各テストファイルの前に D1 のマイグレーションを適用する（適用済みなら何もしない）。

import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
