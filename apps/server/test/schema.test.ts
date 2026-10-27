import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/migrations.gen';
import { applyMigrations, splitSql } from '../src/schema';

const appliedNames = async (): Promise<string[]> =>
  (await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);

describe('D1 のテーブルを Worker が自分で用意する', () => {
  it('SQL を行コメントを除いて文に分ける', () => {
    expect(splitSql('-- 説明; ここは無視\nCREATE TABLE x (a INT); -- 後ろのコメント\n\nCREATE INDEX y ON x(a);\n')).toEqual([
      'CREATE TABLE x (a INT)',
      'CREATE INDEX y ON x(a)',
    ]);
  });

  it('wrangler で適用済みの記録があれば何もしない', async () => {
    // テストの準備で wrangler と同じ方法（applyD1Migrations）で適用済み
    const before = await appliedNames();
    expect(before).toEqual(MIGRATIONS.map((m) => m.name));
    await applyMigrations(env.DB);
    expect(await appliedNames()).toEqual(before);
  });

  it('未適用ならすべての文を実行して記録する（何度実行してもテーブルは壊れない）', async () => {
    await env.DB.prepare('INSERT INTO players (id, token_hash, name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)').bind('schema-test', 'h-schema-test', 'x', 1, 1).run();
    await env.DB.prepare('DELETE FROM d1_migrations').run();
    await applyMigrations(env.DB);
    expect(await appliedNames()).toEqual(MIGRATIONS.map((m) => m.name));
    // 既存のデータは残る
    const p = await env.DB.prepare('SELECT name FROM players WHERE id = ?').bind('schema-test').first<{ name: string }>();
    expect(p?.name).toBe('x');
    const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    for (const t of ['players', 'save_slots', 'save_bodies', 'rooms', 'room_members', 'room_snapshots', 'audit_log']) expect(tables).toContain(t);
  });
});
