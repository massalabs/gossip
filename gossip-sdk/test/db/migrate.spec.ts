import { describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate';

describe('runMigrations', () => {
  it('rewrites CREATE TABLE/INDEX statements to IF NOT EXISTS', async () => {
    const executedSql: string[] = [];
    const execRaw = vi
      .fn<(sql: string, params?: unknown[]) => Promise<unknown[][]>>()
      .mockImplementation(async (sql: string) => {
        executedSql.push(sql);
        if (sql === 'SELECT MAX(idx) FROM _migrations') {
          return [[null]];
        }
        return [];
      });

    const withTransaction = async <T>(fn: () => Promise<T>): Promise<T> => fn();

    await runMigrations(execRaw, withTransaction);

    const createStatements = executedSql.filter(sql =>
      /^\s*CREATE\s+(TABLE|(?:UNIQUE\s+)?INDEX)\s+/i.test(sql)
    );

    expect(createStatements.length).toBeGreaterThan(0);
    expect(
      createStatements.every(
        sql =>
          /^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i.test(sql) ||
          /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(sql)
      )
    ).toBe(true);
  });
});
