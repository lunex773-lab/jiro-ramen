// migrations/*.sql から src/migrations.gen.ts を作る（Worker が起動時に自分でテーブルを作るため）。
// 使い方: npm run schema:gen -w @jiro/server（SQL を変えたら実行する。テストは一致しないと失敗する）

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_PATH = join(root, 'src/migrations.gen.ts');

/** 生成するファイルの内容 */
export function renderMigrationsModule() {
  const dir = join(root, 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const items = files.map((f) => `  { name: ${JSON.stringify(f)}, sql: ${JSON.stringify(readFileSync(join(dir, f), 'utf8'))} },`);
  return [
    '// 自動生成（scripts/gen-schema.mjs）。直接編集しない。migrations/*.sql を変えたら npm run schema:gen -w @jiro/server を実行する。',
    '',
    'export const MIGRATIONS: { name: string; sql: string }[] = [',
    ...items,
    '];',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(GENERATED_PATH, renderMigrationsModule());
  console.log(`wrote ${GENERATED_PATH}`);
}
