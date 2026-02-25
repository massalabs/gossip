/**
 * Migration runner for the Gossip SDK SQLite database.
 *
 * Tracks applied migrations in a `_migrations` table and runs only
 * pending ones. Each migration executes in its own transaction so
 * a failure at migration N leaves 0..N-1 committed.
 */

import { MIGRATIONS } from './generated-migrations.js';

type ExecRaw = (sql: string, params?: unknown[]) => Promise<unknown[][]>;
type WithTransaction = <T>(fn: () => Promise<T>) => Promise<T>;

function makeCreateStatementsIdempotent(statement: string): string {
  if (/^\s*CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/i.test(statement)) {
    return statement.replace(/^(\s*CREATE\s+TABLE\s+)/i, '$1IF NOT EXISTS ');
  }

  if (
    /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/i.test(statement)
  ) {
    return statement.replace(
      /^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)/i,
      '$1IF NOT EXISTS '
    );
  }

  return statement;
}

export async function runMigrations(
  execRaw: ExecRaw,
  withTransaction: WithTransaction
): Promise<void> {
  await execRaw(
    `CREATE TABLE IF NOT EXISTS _migrations (
      idx INTEGER PRIMARY KEY,
      tag TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`
  );

  const rows = await execRaw('SELECT MAX(idx) FROM _migrations');
  const maxApplied: number | null = (rows[0] as [number | null])[0];
  const pending = MIGRATIONS.filter(m => m.idx > (maxApplied ?? -1));

  for (const migration of pending) {
    await withTransaction(async () => {
      for (const stmt of migration.statements) {
        await execRaw(makeCreateStatementsIdempotent(stmt));
      }
      await execRaw(
        'INSERT INTO _migrations (idx, tag, applied_at) VALUES (?, ?, ?)',
        [migration.idx, migration.tag, Date.now()]
      );
    });
  }
}
