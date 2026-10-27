// D1 のテーブルを Worker が自分で用意する（デプロイ時にマイグレーションのコマンドを実行しなくてよいように）。
// 適用済みの記録は wrangler と同じ d1_migrations 表に残すので、`wrangler d1 migrations apply` と併用しても二重に適用しない。
// マイグレーションは何度実行しても同じ結果になる書き方（CREATE ... IF NOT EXISTS）に限る。

import { MIGRATIONS } from './migrations.gen';
import { log } from './util';

/** wrangler の既定のマイグレーション記録表と同じ定義 */
const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS d1_migrations(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

/** SQL ファイルを文に分ける（行コメントを除き、; で区切る。文字列の中に ; は書かない約束） */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

let ready: Promise<void> | null = null;

/** 未適用のマイグレーションを適用する（Worker のインスタンスごとに最初の1回だけ確認する） */
export function ensureSchema(db: D1Database): Promise<void> {
  ready ??= applyMigrations(db).catch((e: unknown) => {
    ready = null; // 次の要求でやり直す
    throw e;
  });
  return ready;
}

/** 未適用のマイグレーションを適用する（テストからも呼ぶ） */
export async function applyMigrations(db: D1Database): Promise<void> {
  await db.prepare(CREATE_MIGRATIONS_TABLE).run();
  const rows = await db.prepare('SELECT name FROM d1_migrations').all<{ name: string }>();
  const done = new Set(rows.results.map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    // 1つのマイグレーションの文と記録をまとめて（トランザクションで）実行する
    const stmts = splitSql(m.sql).map((q) => db.prepare(q));
    stmts.push(db.prepare('INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)').bind(m.name));
    await db.batch(stmts);
    log('info', 'schema_migrated', { name: m.name });
  }
}
