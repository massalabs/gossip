/**
 * SQLite Web Worker — owns all WASM/SQLite state.
 *
 * Two VFS modes:
 *   - OPFS (mobile): AccessHandlePoolVFS + sync WASM — fast, single-tab.
 *   - IDB (web): IDBBatchAtomicVFS + async WASM — multi-tab safe.
 *
 * Messages:
 *   init  → load WASM + VFS, open DB, run init SQL (PRAGMAs + DDL)
 *   exec  → prepare/bind/step/finalize, return { rows, lastInsertRowId }
 *   close → close DB
 */

import * as SQLite from 'wa-sqlite';
import { execStatements } from './exec-utils.js';

let sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
let dbHandle: number | null = null;

// Add a message queue to process messages sequentially
const messageQueue: Array<{ e: MessageEvent; resolve: () => void }> = [];
let processing = false;

// Bind Worker's postMessage (avoids DOM lib signature mismatch at compile time)
const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

async function execSql(
  sql: string,
  params: unknown[]
): Promise<{ rows: unknown[][]; lastInsertRowId: number }> {
  if (!sqlite3 || dbHandle === null) throw new Error('SQLite not initialized');

  const rows = await execStatements(sqlite3, dbHandle, sql, params);

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

// Ensure that all messages are processed sequentially to avoid
// concurrent access to the underlying WASM/SQLite state, which
// can lead to heap corruption and "index out of bounds"/
// "unreachable executed" errors.
async function processMessageQueue() {
  if (processing || messageQueue.length === 0) return;
  processing = true;

  while (messageQueue.length > 0) {
    const { e, resolve } = messageQueue.shift()!;
    await handleMessage(e);
    resolve();
  }

  processing = false;
}

async function handleMessage(e: MessageEvent): Promise<void> {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'init': {
        const { dbPath, wasmBinary, initSql, useOPFS } = e.data;
        const moduleArg: Record<string, unknown> = {};
        // WASM bytes are pre-fetched in the main thread to avoid
        // Safari's chunked Transfer-Encoding bug in Worker fetch().
        if (wasmBinary) {
          moduleArg.instantiateWasm = (
            imports: WebAssembly.Imports,
            successCallback: (
              instance: WebAssembly.Instance,
              module: WebAssembly.Module
            ) => void
          ) => {
            WebAssembly.instantiate(wasmBinary, imports).then(result => {
              successCallback(result.instance, result.module);
            });
            return {};
          };
        }

        // Load the right WASM build + VFS.
        // NOTE: import() paths must be string literals — Vite can't resolve variables.
        if (useOPFS) {
          const { default: SQLiteESMFactory } =
            await import('wa-sqlite/dist/wa-sqlite.mjs');
          const { AccessHandlePoolVFS } =
            await import('wa-sqlite/src/examples/AccessHandlePoolVFS.js');
          const module = await SQLiteESMFactory(moduleArg);
          sqlite3 = SQLite.Factory(module);
          const vfs = new AccessHandlePoolVFS(dbPath);
          await vfs.isReady;
          sqlite3.vfs_register(vfs as never, true);
        } else {
          const { default: SQLiteESMFactory } =
            await import('wa-sqlite/dist/wa-sqlite-async.mjs');
          const { IDBBatchAtomicVFS } =
            await import('wa-sqlite/src/examples/IDBBatchAtomicVFS.js');
          const module = await SQLiteESMFactory(moduleArg);
          sqlite3 = SQLite.Factory(module);
          sqlite3.vfs_register(new IDBBatchAtomicVFS(dbPath) as never, true);
        }

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
}

addEventListener('message', (e: MessageEvent) => {
  // Chain each message onto the promise queue so that messages
  // are handled strictly one after another.
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  messageQueue.push({ e, resolve });
  promise.then(() => processMessageQueue());
  processMessageQueue();
});
