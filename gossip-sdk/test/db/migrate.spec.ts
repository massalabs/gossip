import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  ExecRaw,
  MIGRATION_LEDGER_QUERY,
  runMigrations,
} from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/generated-migrations';

const removeIdempotentCreateClause = (statement: string) =>
  statement
    .replace(/^(\s*CREATE\s+TABLE\s+)IF\s+NOT\s+EXISTS\s+/i, '$1')
    .replace(
      /^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+)IF\s+NOT\s+EXISTS\s+/i,
      '$1'
    );

const ledgerRows = (migrations: typeof MIGRATIONS) =>
  migrations.map(migration => [
    migration.idx,
    migration.tag,
    migration.tag.length,
    migration.digest,
    migration.digest.length,
  ]);

describe('runMigrations', () => {
  it('rewrites CREATE TABLE/INDEX statements to IF NOT EXISTS', async () => {
    const executedSql: string[] = [];
    const execRaw = vi
      .fn<(sql: string, params?: unknown[]) => Promise<unknown[][]>>()
      .mockImplementation(async (sql: string) => {
        executedSql.push(sql);
        if (sql === MIGRATION_LEDGER_QUERY) {
          return [];
        }
        return [];
      });

    const withTransaction = async <T>(
      fn: (txExecRaw: ExecRaw) => Promise<T>
    ): Promise<T> => fn(execRaw);

    await runMigrations(execRaw, withTransaction);

    const createStatements = executedSql.filter(sql =>
      /^\s*CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+/i.test(sql)
    );

    expect(createStatements.length).toBeGreaterThan(0);
    expect(
      executedSql.filter(sql => sql.startsWith('INSERT INTO _migrations'))
    ).toHaveLength(MIGRATIONS.length);
    expect(
      createStatements.every(
        sql =>
          /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(sql) ||
          /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(sql)
      )
    ).toBe(true);
  });

  it('accepts only an exact known migration prefix', async () => {
    for (const rows of [
      [[MIGRATIONS[0].idx, 'wrong-tag', 9, MIGRATIONS[0].digest, 64]],
      [
        [
          MIGRATIONS[0].idx + 1,
          MIGRATIONS[0].tag,
          MIGRATIONS[0].tag.length,
          MIGRATIONS[0].digest,
          64,
        ],
      ],
      [
        [
          MIGRATIONS[0].idx,
          MIGRATIONS[0].tag,
          MIGRATIONS[0].tag.length,
          '0'.repeat(64),
          64,
        ],
      ],
      [
        ledgerRows(MIGRATIONS.slice(0, 1))[0],
        ledgerRows(MIGRATIONS.slice(0, 1))[0],
      ],
      [...ledgerRows(MIGRATIONS), [999, 'future', 6, '0'.repeat(64), 64]],
    ]) {
      const execRaw = vi.fn(async (sql: string): Promise<unknown[][]> => {
        if (sql === MIGRATION_LEDGER_QUERY) {
          return rows;
        }
        return [];
      });
      const withTransaction = vi.fn();

      await expect(runMigrations(execRaw, withTransaction)).rejects.toThrow(
        'Unsupported database migration history'
      );
      expect(withTransaction).not.toHaveBeenCalled();
    }
  });

  it('runs each pending migration entirely inside its transaction', async () => {
    const prefix = MIGRATIONS.slice(0, 1);
    const execRaw = vi.fn(async (sql: string): Promise<unknown[][]> => {
      if (sql === MIGRATION_LEDGER_QUERY) {
        return ledgerRows(prefix);
      }
      return [];
    });
    const transactionExecutors: ReturnType<typeof vi.fn>[] = [];
    const withTransaction = async <T>(
      fn: (txExecRaw: ExecRaw) => Promise<T>
    ): Promise<T> => {
      const txExecRaw = vi.fn(async (): Promise<unknown[][]> => []);
      transactionExecutors.push(txExecRaw);
      return fn(txExecRaw);
    };

    await runMigrations(execRaw, withTransaction);

    const pending = MIGRATIONS.slice(prefix.length);
    expect(transactionExecutors).toHaveLength(pending.length);
    for (let index = 0; index < pending.length; index++) {
      const calls = transactionExecutors[index].mock.calls;
      expect(calls).toHaveLength(pending[index].statements.length + 1);
      expect(
        calls.slice(0, -1).map(([sql]) => removeIdempotentCreateClause(sql))
      ).toEqual(pending[index].statements);
      expect(calls.at(-1)?.[0]).toContain('INSERT INTO _migrations');
      expect(calls.at(-1)?.[1]?.[0]).toBe(pending[index].idx);
      for (const statement of pending[index].statements) {
        expect(execRaw.mock.calls.some(([sql]) => sql === statement)).toBe(
          false
        );
      }
    }
    expect(
      execRaw.mock.calls.some(([sql]) =>
        String(sql).startsWith('INSERT INTO _migrations')
      )
    ).toBe(false);
  });

  it('keeps the journal, SQL files, and embedded migrations synchronized', () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../../drizzle/meta/_journal.json', import.meta.url),
        'utf8'
      )
    ) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    expect(
      journal.entries.map(({ idx, tag, when }) => ({ idx, tag, when }))
    ).toEqual(MIGRATIONS.map(({ idx, tag, when }) => ({ idx, tag, when })));
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(
        new URL(`../../drizzle/${migration.tag}.sql`, import.meta.url),
        'utf8'
      ).replace(/\r\n?/g, '\n');
      const statements = sql
        .split('--> statement-breakpoint')
        .map(statement => statement.trim())
        .filter(Boolean);
      expect(statements).toEqual(migration.statements);
      expect(
        createHash('sha256')
          .update(
            JSON.stringify({
              idx: migration.idx,
              tag: migration.tag,
              statements,
            })
          )
          .digest('hex')
      ).toBe(migration.digest);
    }

    const initialSnapshot = JSON.parse(
      readFileSync(
        new URL('../../drizzle/meta/0000_snapshot.json', import.meta.url),
        'utf8'
      )
    ) as { id: string };
    const previousSnapshot = JSON.parse(
      readFileSync(
        new URL('../../drizzle/meta/0005_snapshot.json', import.meta.url),
        'utf8'
      )
    ) as { id: string; prevId: string };
    expect(previousSnapshot.prevId).toBe(initialSnapshot.id);
    const latestSnapshot = JSON.parse(
      readFileSync(
        new URL('../../drizzle/meta/0006_snapshot.json', import.meta.url),
        'utf8'
      )
    ) as {
      prevId: string;
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    expect(latestSnapshot.prevId).toBe(previousSnapshot.id);
    expect(Object.keys(latestSnapshot.tables.messages.columns)).toEqual(
      expect.arrayContaining(['editOf', 'reactionOf'])
    );
    expect(Object.keys(latestSnapshot.tables.discussions.columns)).toEqual(
      expect.arrayContaining([
        'pinned',
        'messageRetentionDuration',
        'retentionPolicySetAt',
        'mutedNotifications',
      ])
    );
    expect(Object.keys(latestSnapshot.tables.accountSettings.columns)).toEqual([
      'userId',
      'formatVersion',
      'mnsEnabled',
      'defaultRetentionDuration',
    ]);
  });

  it('does no transaction work for the complete known prefix', async () => {
    const execRaw = vi.fn(async (sql: string): Promise<unknown[][]> => {
      if (sql === MIGRATION_LEDGER_QUERY) {
        return ledgerRows(MIGRATIONS);
      }
      return [];
    });
    const withTransaction = vi.fn();

    await runMigrations(execRaw, withTransaction);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});
