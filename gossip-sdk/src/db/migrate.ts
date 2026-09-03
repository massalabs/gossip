/**
 * Migration runner for the Gossip SDK SQLite database.
 *
 * Tracks applied migrations in a `_migrations` table and runs only
 * pending ones. Each migration executes in its own transaction so
 * a failure at migration N leaves 0..N-1 committed.
 */

import { MIGRATIONS } from './generated-migrations.js';

export type ExecRaw = (sql: string, params?: unknown[]) => Promise<unknown[][]>;
type WithTransaction = <T>(
  fn: (txExecRaw: ExecRaw) => Promise<T>
) => Promise<T>;

const MIGRATION_TAG_MAX_CHARS = 256;
const MIGRATION_DIGEST_CHARS = 64;
export const MIGRATION_LEDGER_QUERY =
  `SELECT idx, substr(tag, 1, ${MIGRATION_TAG_MAX_CHARS}), length(tag), ` +
  `substr(digest, 1, ${MIGRATION_DIGEST_CHARS}), length(digest) ` +
  `FROM _migrations ORDER BY idx ASC LIMIT ${MIGRATIONS.length + 1}`;
const LEGACY_MIGRATION_LEDGER_QUERY =
  `SELECT idx, substr(tag, 1, ${MIGRATION_TAG_MAX_CHARS}), length(tag) ` +
  `FROM _migrations ORDER BY idx ASC LIMIT ${MIGRATIONS.length + 1}`;

function validateLegacyLedgerRows(rows: unknown[][]): void {
  if (rows.length > MIGRATIONS.length) {
    throw new Error('Unsupported database migration history');
  }
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position] as [unknown, unknown, unknown];
    const expected = MIGRATIONS[position];
    if (
      !expected ||
      !Number.isSafeInteger(row[0]) ||
      row[0] !== expected.idx ||
      row[1] !== expected.tag ||
      row[2] !== expected.tag.length
    ) {
      throw new Error('Unsupported database migration history');
    }
  }
}

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
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`
  );

  let rows: unknown[][];
  try {
    rows = await execRaw(MIGRATION_LEDGER_QUERY);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/no such column(?: named)?:?\s*digest/i.test(error.message)
    ) {
      throw error;
    }
    await withTransaction(async txExecRaw => {
      const legacyRows = await txExecRaw(LEGACY_MIGRATION_LEDGER_QUERY);
      validateLegacyLedgerRows(legacyRows);
      await txExecRaw('ALTER TABLE _migrations ADD COLUMN digest TEXT');
      for (const migration of MIGRATIONS.slice(0, legacyRows.length)) {
        await txExecRaw(
          'UPDATE _migrations SET digest = ? WHERE idx = ? AND tag = ? AND digest IS NULL',
          [migration.digest, migration.idx, migration.tag]
        );
      }
    });
    rows = await execRaw(MIGRATION_LEDGER_QUERY);
  }
  if (rows.length > MIGRATIONS.length) {
    throw new Error('Unsupported database migration history');
  }
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position] as [unknown, unknown, unknown, unknown, unknown];
    const expected = MIGRATIONS[position];
    if (
      !expected ||
      !Number.isSafeInteger(row[0]) ||
      row[0] !== expected.idx ||
      row[1] !== expected.tag ||
      row[2] !== expected.tag.length ||
      row[3] !== expected.digest ||
      row[4] !== MIGRATION_DIGEST_CHARS
    ) {
      throw new Error('Unsupported database migration history');
    }
  }
  const pending = MIGRATIONS.slice(rows.length);

  for (const migration of pending) {
    await withTransaction(async txExecRaw => {
      for (const stmt of migration.statements) {
        await txExecRaw(makeCreateStatementsIdempotent(stmt));
      }
      await txExecRaw(
        'INSERT INTO _migrations (idx, tag, digest, applied_at) VALUES (?, ?, ?, ?)',
        [migration.idx, migration.tag, migration.digest, Date.now()]
      );
    });
  }
}
