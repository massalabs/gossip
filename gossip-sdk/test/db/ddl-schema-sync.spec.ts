/**
 * Validates that the hand-written DDL in sqlite.ts stays in sync with the
 * Drizzle schema definitions in schema.ts.
 *
 * The DDL is the runtime CREATE TABLE source (sent to wa-sqlite).
 * The Drizzle schema is the type/query source (used by ORM operations).
 * A column present in one but missing from the other causes silent runtime bugs.
 *
 * This test:
 *   1. Opens an in-memory SQLite DB using the raw DDL
 *   2. Queries PRAGMA table_info() for each table
 *   3. Compares column names against the Drizzle schema column definitions
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import * as schema from '../../src/schema';
import { _DDL_FOR_TESTING } from '../../src/sqlite';
import { getTableColumns } from 'drizzle-orm';

const require = createRequire(import.meta.url);
const waSqlitePath = dirname(require.resolve('wa-sqlite/package.json'));
const waSqliteWasm = readFileSync(resolve(waSqlitePath, 'dist/wa-sqlite.wasm'));
const waSqliteWasmBinary = waSqliteWasm.buffer.slice(
  waSqliteWasm.byteOffset,
  waSqliteWasm.byteOffset + waSqliteWasm.byteLength
);

// Map of Drizzle table exports to their SQL table names
const TABLES = [
  { drizzleTable: schema.contacts, name: 'contacts' },
  { drizzleTable: schema.messages, name: 'messages' },
  { drizzleTable: schema.userProfile, name: 'userProfile' },
  { drizzleTable: schema.discussions, name: 'discussions' },
  {
    drizzleTable: schema.pendingEncryptedMessages,
    name: 'pendingEncryptedMessages',
  },
  { drizzleTable: schema.pendingAnnouncements, name: 'pendingAnnouncements' },
  { drizzleTable: schema.activeSeekers, name: 'activeSeekers' },
  { drizzleTable: schema.announcementCursors, name: 'announcementCursors' },
] as const;

describe('DDL ↔ Drizzle schema sync', () => {
  it('DDL columns match Drizzle schema columns for every table', async () => {
    // Open a fresh in-memory DB with just the DDL
    const module = await SQLiteESMFactory({ wasmBinary: waSqliteWasmBinary });
    const sqlite3 = SQLite.Factory(module);
    const dbHandle = await sqlite3.open_v2(':memory:');
    await sqlite3.exec(dbHandle, _DDL_FOR_TESTING);

    const errors: string[] = [];

    for (const { drizzleTable, name } of TABLES) {
      // Get columns from DDL via PRAGMA
      const ddlColumns: string[] = [];
      await sqlite3.exec(
        dbHandle,
        `PRAGMA table_info(${name})`,
        (row: unknown[]) => {
          // PRAGMA table_info columns: cid, name, type, notnull, dflt_value, pk
          ddlColumns.push(row[1] as string);
        }
      );

      // Get columns from Drizzle schema
      const drizzleColumns = Object.keys(getTableColumns(drizzleTable));

      // Sort both for stable comparison
      const sortedDdl = [...ddlColumns].sort();
      const sortedDrizzle = [...drizzleColumns].sort();

      // Find mismatches
      const inDdlOnly = sortedDdl.filter(c => !sortedDrizzle.includes(c));
      const inDrizzleOnly = sortedDrizzle.filter(c => !sortedDdl.includes(c));

      if (inDdlOnly.length > 0) {
        errors.push(
          `${name}: columns in DDL but not in Drizzle schema: ${inDdlOnly.join(', ')}`
        );
      }
      if (inDrizzleOnly.length > 0) {
        errors.push(
          `${name}: columns in Drizzle schema but not in DDL: ${inDrizzleOnly.join(', ')}`
        );
      }
    }

    await sqlite3.close(dbHandle);

    if (errors.length > 0) {
      throw new Error(
        'DDL and Drizzle schema are out of sync:\n  ' + errors.join('\n  ')
      );
    }
  });

  it('DDL creates all tables defined in Drizzle schema', async () => {
    const module = await SQLiteESMFactory({ wasmBinary: waSqliteWasmBinary });
    const sqlite3 = SQLite.Factory(module);
    const dbHandle = await sqlite3.open_v2(':memory:');
    await sqlite3.exec(dbHandle, _DDL_FOR_TESTING);

    // Get all tables from SQLite
    const sqliteTables: string[] = [];
    await sqlite3.exec(
      dbHandle,
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      (row: unknown[]) => {
        sqliteTables.push(row[0] as string);
      }
    );

    await sqlite3.close(dbHandle);

    const expectedTables = TABLES.map(t => t.name);
    const missingTables = expectedTables.filter(t => !sqliteTables.includes(t));

    expect(missingTables).toEqual([]);
  });
});
