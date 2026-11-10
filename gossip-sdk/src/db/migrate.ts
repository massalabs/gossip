/**
 * Migration runner for the Gossip SDK SQLite database.
 *
 * Tracks applied migrations in a `_migrations` table and runs only
 * pending ones. On an existing database each migration executes in its own
 * transaction so a failure at migration N leaves 0..N-1 committed.
 *
 * A brand-new database (no ledger table yet) has nothing to protect between
 * migrations, so the ledger and every migration are applied in a single
 * transaction. On the encrypted backend a commit costs hundreds of
 * milliseconds, and this turns nine commits into one at account creation.
 */

import { MIGRATIONS } from './generated-migrations.js';

export type ExecRaw = (sql: string, params?: unknown[]) => Promise<unknown[][]>;
type WithTransaction = <T>(
  fn: (txExecRaw: ExecRaw) => Promise<T>
) => Promise<T>;
export interface MigrationStatement {
  sql: string;
  params: unknown[];
}
/**
 * Optional fast path: run all statements as ONE atomic transaction in a
 * single round trip to the storage backend. Must roll back completely on
 * any failure.
 */
export type ExecAtomicBatch = (
  statements: MigrationStatement[]
) => Promise<void>;

const CREATE_LEDGER_SQL = `CREATE TABLE IF NOT EXISTS _migrations (
      idx INTEGER PRIMARY KEY,
      tag TEXT NOT NULL,
      digest TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`;
const INSERT_LEDGER_SQL =
  'INSERT INTO _migrations (idx, tag, digest, applied_at) VALUES (?, ?, ?, ?)';
export const MIGRATION_LEDGER_EXISTS_QUERY =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_migrations' LIMIT 1";

function freshDatabaseStatements(): MigrationStatement[] {
  const statements: MigrationStatement[] = [
    { sql: CREATE_LEDGER_SQL, params: [] },
  ];
  const appliedAt = Date.now();
  for (const migration of MIGRATIONS) {
    for (const stmt of migration.statements) {
      statements.push({
        sql: makeCreateStatementsIdempotent(stmt),
        params: [],
      });
    }
    statements.push({
      sql: INSERT_LEDGER_SQL,
      params: [migration.idx, migration.tag, migration.digest, appliedAt],
    });
  }
  return statements;
}

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
  withTransaction: WithTransaction,
  execAtomicBatch?: ExecAtomicBatch
): Promise<void> {
  const ledgerExists =
    (await execRaw(MIGRATION_LEDGER_EXISTS_QUERY)).length > 0;
  if (!ledgerExists) {
    const statements = freshDatabaseStatements();
    if (execAtomicBatch) {
      await execAtomicBatch(statements);
    } else {
      await withTransaction(async txExecRaw => {
        for (const statement of statements) {
          await txExecRaw(statement.sql, statement.params);
        }
      });
    }
    return;
  }

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
      await txExecRaw(INSERT_LEDGER_SQL, [
        migration.idx,
        migration.tag,
        migration.digest,
        Date.now(),
      ]);
    });
  }
}
