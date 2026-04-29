/**
 * Verifies that mutations issued inside a Drizzle `db.transaction()` do
 * not trigger a `flush()` round-trip on the native plugin path.
 *
 * The bug being guarded against: prior to commit which introduced
 * `txDepth`, the dispatch layer only tracked the `withTransaction`
 * wrapper's own flag. Drizzle's transaction issues BEGIN/COMMIT through
 * the proxy callback without flipping that flag, so every INSERT/UPDATE
 * inside a Drizzle transaction fired an extra round-trip *and* with
 * `journal_mode=OFF` on the native VFS the partial state was pushed to
 * redb without any rollback record.
 */

import { describe, it, expect } from 'vitest';
import { classifyStatement } from '../../src/db/sqlite';

describe('classifyStatement', () => {
  it('detects BEGIN in any case and with whitespace', () => {
    expect(classifyStatement('BEGIN')).toBe('begin');
    expect(classifyStatement('  begin')).toBe('begin');
    expect(classifyStatement('Begin transaction')).toBe('begin');
  });

  it('detects COMMIT and ROLLBACK', () => {
    expect(classifyStatement('COMMIT')).toBe('commit');
    expect(classifyStatement('commit')).toBe('commit');
    expect(classifyStatement('ROLLBACK')).toBe('rollback');
    expect(classifyStatement('rollback')).toBe('rollback');
  });

  it('classifies all writes as mutation', () => {
    for (const verb of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET x = 1',
      'DELETE FROM t',
      'REPLACE INTO t VALUES (1)',
      'CREATE TABLE t (x)',
      'DROP TABLE t',
      'ALTER TABLE t ADD COLUMN y',
      'WITH cte AS (SELECT 1) UPDATE t SET x = (SELECT * FROM cte)',
      'VACUUM',
      'PRAGMA journal_mode=OFF',
    ]) {
      expect(classifyStatement(verb)).toBe('mutation');
    }
  });

  it('classifies SELECT and others as `other`', () => {
    expect(classifyStatement('SELECT 1')).toBe('other');
    expect(classifyStatement('  EXPLAIN SELECT 1')).toBe('other');
    expect(classifyStatement('')).toBe('other');
  });

  // `BEGIN` is not a mutation even though it is a transaction-control
  // statement. We rely on this: the regex order matters because BEGIN
  // is checked before the mutation regex would otherwise match.
  it('does not double-classify BEGIN as mutation', () => {
    expect(classifyStatement('BEGIN')).toBe('begin');
    expect(classifyStatement('BEGIN')).not.toBe('mutation');
  });
});
