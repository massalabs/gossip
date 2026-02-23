/**
 * SQLite Web Worker — owns all WASM/SQLite state.
 *
 * Runs wa-sqlite (sync build) with AccessHandlePoolVFS for OPFS persistence.
 * The main thread communicates via postMessage with { id, type, ... } messages.
 *
 * Messages:
 *   init  → load WASM + VFS, open DB, run init SQL (PRAGMAs + DDL)
 *   exec  → prepare/bind/step/finalize, return { rows, lastInsertRowId }
 *   close → close DB
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { AccessHandlePoolVFS } from 'wa-sqlite/src/examples/AccessHandlePoolVFS.js';

let sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
let dbHandle: number | null = null;

// Bind Worker's postMessage (avoids DOM lib signature mismatch at compile time)
const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

function copyRow(row: unknown[]): unknown[] {
  return row.map(v => (v instanceof Uint8Array ? new Uint8Array(v) : v));
}

async function execSql(
  sql: string,
  params: unknown[]
): Promise<{ rows: unknown[][]; lastInsertRowId: number }> {
  if (!sqlite3 || dbHandle === null) throw new Error('SQLite not initialized');

  const rows: unknown[][] = [];

  if (params.length === 0) {
    await sqlite3.exec(dbHandle, sql, (row: unknown[]) => {
      rows.push(copyRow(row));
    });
  } else {
    const str = sqlite3.str_new(dbHandle, sql);
    try {
      const prepared = await sqlite3.prepare_v2(
        dbHandle,
        sqlite3.str_value(str)
      );
      if (prepared) {
        try {
          sqlite3.bind_collection(
            prepared.stmt,
            params as (number | string | Uint8Array | null)[]
          );
          while ((await sqlite3.step(prepared.stmt)) === SQLite.SQLITE_ROW) {
            rows.push(copyRow(sqlite3.row(prepared.stmt)));
          }
        } finally {
          await sqlite3.finalize(prepared.stmt);
        }
      }
    } finally {
      sqlite3.str_finish(str);
    }
  }

  // Only capture lastInsertRowId for INSERT statements (avoid unnecessary query on SELECT/UPDATE/DELETE)
  let lastInsertRowId = 0;
  if (sql.trimStart().toUpperCase().startsWith('INSERT')) {
    await sqlite3.exec(
      dbHandle,
      'SELECT last_insert_rowid()',
      (row: unknown[]) => {
        lastInsertRowId = row[0] as number;
      }
    );
  }

  return { rows, lastInsertRowId };
}

addEventListener('message', async (e: MessageEvent) => {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'init': {
        const { opfsPath, wasmUrl, initSql } = e.data;
        const moduleArg: Record<string, unknown> = {};
        if (wasmUrl) moduleArg.locateFile = () => wasmUrl;

        const module = await SQLiteESMFactory(moduleArg);
        sqlite3 = SQLite.Factory(module);

        const vfs = new AccessHandlePoolVFS(opfsPath);
        await vfs.isReady;
        sqlite3.vfs_register(vfs as never, true);
        dbHandle = await sqlite3.open_v2('gossip.db');

        if (initSql) {
          await sqlite3.exec(dbHandle, initSql);
        }

        post({ id, type: 'init-result', success: true });
        break;
      }

      case 'exec': {
        const { sql, params } = e.data;
        const result = await execSql(sql, params);
        post({
          id,
          type: 'exec-result',
          rows: result.rows,
          lastInsertRowId: result.lastInsertRowId,
        });
        break;
      }

      case 'close': {
        if (dbHandle !== null && sqlite3) {
          await sqlite3.close(dbHandle);
          dbHandle = null;
        }
        sqlite3 = null;
        post({ id, type: 'close-result' });
        break;
      }
    }
  } catch (err) {
    post({ id, type: 'error', message: (err as Error).message });
  }
});
