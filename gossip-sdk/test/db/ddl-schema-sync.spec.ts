/**
 * Validates that the drizzle-kit generated migration creates all expected
 * tables, columns, and indexes when run against a real SQLite instance.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import * as schema from '../../src/db/schema';
import { getTableColumns } from 'drizzle-orm';

const require = createRequire(import.meta.url);
const waSqlitePath = dirname(require.resolve('wa-sqlite/package.json'));
const waSqliteWasm = readFileSync(resolve(waSqlitePath, 'dist/wa-sqlite.wasm'));
const waSqliteWasmBinary = waSqliteWasm.buffer.slice(
  waSqliteWasm.byteOffset,
  waSqliteWasm.byteOffset + waSqliteWasm.byteLength
);

// Read all migration SQL files from drizzle/ in order
const drizzleDir = resolve(__dirname, '../../drizzle');
const migrationSql = readdirSync(drizzleDir)
  .filter(f => f.endsWith('.sql'))
  .sort()
  .map(f =>
    readFileSync(resolve(drizzleDir, f), 'utf-8').replace(
      /--> statement-breakpoint\n?/g,
      '\n'
    )
  )
  .join('\n');

const ALL_TABLES = [
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

describe('Drizzle migration SQL', () => {
  it('creates all expected tables with correct columns', async () => {
    const module = await SQLiteESMFactory({ wasmBinary: waSqliteWasmBinary });
    const sqlite3 = SQLite.Factory(module);
    const dbHandle = await sqlite3.open_v2(':memory:');
    await sqlite3.exec(dbHandle, migrationSql);

    const errors: string[] = [];

    for (const { drizzleTable, name } of ALL_TABLES) {
      const sqliteColumns: string[] = [];
      await sqlite3.exec(
        dbHandle,
        `PRAGMA table_info(${name})`,
        (row: unknown[]) => {
          sqliteColumns.push(row[1] as string);
        }
      );

      if (sqliteColumns.length === 0) {
        errors.push(`${name}: table not created by migration SQL`);
        continue;
      }

      const drizzleColumns = Object.keys(getTableColumns(drizzleTable));
      const sortedSqlite = [...sqliteColumns].sort();
      const sortedDrizzle = [...drizzleColumns].sort();

      const inSqliteOnly = sortedSqlite.filter(c => !sortedDrizzle.includes(c));
      const inDrizzleOnly = sortedDrizzle.filter(
        c => !sortedSqlite.includes(c)
      );

      if (inSqliteOnly.length > 0) {
        errors.push(
          `${name}: unexpected columns in migration SQL: ${inSqliteOnly.join(', ')}`
        );
      }
      if (inDrizzleOnly.length > 0) {
        errors.push(
          `${name}: missing columns in migration SQL: ${inDrizzleOnly.join(', ')}`
        );
      }
    }

    await sqlite3.close(dbHandle);

    if (errors.length > 0) {
      throw new Error('Migration SQL issues:\n  ' + errors.join('\n  '));
    }
  });

  it('creates all expected indexes', async () => {
    const module = await SQLiteESMFactory({ wasmBinary: waSqliteWasmBinary });
    const sqlite3 = SQLite.Factory(module);
    const dbHandle = await sqlite3.open_v2(':memory:');
    await sqlite3.exec(dbHandle, migrationSql);

    const indexes: string[] = [];
    await sqlite3.exec(
      dbHandle,
      `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`,
      (row: unknown[]) => {
        indexes.push(row[0] as string);
      }
    );

    await sqlite3.close(dbHandle);

    expect(indexes).toContain('contacts_owner_user_idx');
    expect(indexes).toContain('messages_owner_contact_idx');
    expect(indexes).toContain('discussions_owner_contact_idx');
    expect(indexes).toContain('pending_announcements_announcement_idx');
    expect(indexes).toContain('active_seekers_seeker_idx');
  });
});
