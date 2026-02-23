/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Four execution paths:
 *   - Browser/OPFS (opfsPath set): Web Worker + AccessHandlePoolVFS — fast, single-tab.
 *   - Browser/IDB (idbName set): Web Worker + IDBBatchAtomicVFS — multi-tab safe.
 *   - Node.js file (fsPath set): In-process + NodeFsVFS — file persistence via node:fs.
 *   - In-memory (tests): :memory: in-process — no persistence, fast, isolated.
 *
 * In Phase C the VFS will be swapped for the encrypted PlausibleDeniableVFS.
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema/index.js';
import { DDL } from './generated-ddl.js';
import { execStatements } from './exec-utils.js';

export type GossipDatabase = SqliteRemoteDatabase<typeof schema>;

/** Selects the SQLite storage backend. */
export type StorageConfig =
  | { type: 'opfs'; path: string; wasmUrl?: string }
  | { type: 'idb'; name: string; wasmUrl?: string }
  | { type: 'node-fs'; path: string }
  | { type: 'memory'; wasmBinary?: ArrayBuffer };

export interface InitDbOptions {
  /** Storage backend selection. Defaults to in-memory. */
  storage?: StorageConfig;
}

// ---------------------------------------------------------------------------
// All mutable state is encapsulated in a single object so that closeSqlite()
// can atomically reset everything by replacing it with a fresh instance.
// This prevents state leaks (e.g. a forgotten variable) and makes it
// impossible for tests to observe stale state from a previous init.
// ---------------------------------------------------------------------------

interface DbState {
  // Worker state (browser path)
  worker: Worker | null;
  msgId: number;

  pending: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >;
  lastInsertRowIdCache: number;

  // In-process state (test path)
  sqlite3: ReturnType<typeof SQLite.Factory> | null;
  dbHandle: number | null;

  // Shared state
  useWorker: boolean;
  drizzleDb: GossipDatabase | null;
  dbLock: Promise<unknown>;
  inTransaction: boolean;
}

function createDefaultState(): DbState {
  return {
    worker: null,
    msgId: 0,
    pending: new Map(),
    lastInsertRowIdCache: 0,
    sqlite3: null,
    dbHandle: null,
    useWorker: false,
    drizzleDb: null,
    dbLock: Promise.resolve(),
    inTransaction: false,
  };
}

let db = createDefaultState();

// ---------------------------------------------------------------------------
// Worker communication (browser path)
// ---------------------------------------------------------------------------

function postToWorker(
  msg: Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = ++db.msgId;
    db.pending.set(id, { resolve, reject });
    db.worker!.postMessage({ ...msg, id });
  });
}

function handleWorkerMessage(e: MessageEvent) {
  const { id, type, ...rest } = e.data;
  const p = db.pending.get(id);
  if (!p) return;
  db.pending.delete(id);
  if (type === 'error') {
    p.reject(new Error(rest.message));
  } else {
    p.resolve(rest);
  }
}

// ---------------------------------------------------------------------------
// Drizzle instance factory
// ---------------------------------------------------------------------------

function createDrizzleInstance() {
  return drizzle(
    async (sql, params, method) => {
      const rows = await execRaw(sql, params);
      if (method === 'get') {
        return { rows: rows[0] };
      }
      return { rows };
    },
    { schema }
  );
}

// ---------------------------------------------------------------------------
// Raw SQL execution
// ---------------------------------------------------------------------------

async function execRaw(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  // When inside a withTransaction(), the outer lock is already held —
  // skip re-acquisition to avoid deadlock.
  if (db.inTransaction) {
    return execRawDirect(sql, params);
  }
  const prev = db.dbLock;
  let release!: () => void;
  db.dbLock = new Promise<void>(r => (release = r));
  await prev;
  try {
    return await execRawDirect(sql, params);
  } finally {
    release();
  }
}

async function execRawDirect(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  if (db.useWorker) {
    const result = await postToWorker({ type: 'exec', sql, params });
    db.lastInsertRowIdCache = result.lastInsertRowId;
    return result.rows;
  }
  return execRawInProcess(sql, params);
}

async function execRawInProcess(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  if (!db.sqlite3 || db.dbHandle === null) {
    throw new Error('SQLite not initialized');
  }
  return execStatements(db.sqlite3, db.dbHandle, sql, params);
}

/** PRAGMAs applied before migrations (in-memory / browser worker). */
const PRAGMAS = `
  PRAGMA journal_mode=MEMORY;
  PRAGMA temp_store=MEMORY;
`;

/** PRAGMAs for file-based persistence (Node.js). WAL gives crash recovery. */
const PRAGMAS_FILE = `
  PRAGMA journal_mode=WAL;
  PRAGMA temp_store=MEMORY;
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize wa-sqlite and create the Drizzle ORM instance.
 * Idempotent — subsequent calls are no-ops.
 */
export async function initDb(options: InitDbOptions = {}): Promise<void> {
  if (db.drizzleDb) return;

  const storage: StorageConfig = options.storage ?? { type: 'memory' };

  switch (storage.type) {
    case 'opfs':
    case 'idb': {
      // Spawn Worker with persistent VFS (browser).
      const dbPath = storage.type === 'opfs' ? storage.path : storage.name;
      const useOPFS = storage.type === 'opfs';

      db.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), {
        type: 'module',
      });
      db.worker.onmessage = handleWorkerMessage;
      db.useWorker = true;

      try {
        await postToWorker({
          type: 'init',
          dbPath,
          useOPFS,
          wasmUrl: storage.wasmUrl,
          initSql: PRAGMAS,
        });
      } catch (err) {
        // Prevent dangling worker on init failure.
        if (db.worker) {
          db.worker.terminate();
          db.worker = null;
        }
        db.useWorker = false;
        db.pending.clear();
        throw err;
      }
      break;
    }

    case 'node-fs': {
      // Node.js file mode: sync WASM build + NodeFsVFS — file persistence.
      // Dynamic imports avoid bundling node:fs / node:path in browser builds.
      const { NodeFsVFS } = await import('./node-fs-vfs.js');
      const { readFileSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      const { createRequire } = await import('node:module');

      // Load WASM binary from disk (fetch() is unreliable in Node.js).
      const require = createRequire(import.meta.url);
      const wasmDir = dirname(require.resolve('wa-sqlite/package.json'));
      const wasmBinary = readFileSync(resolve(wasmDir, 'dist/wa-sqlite.wasm'));

      const module = await SQLiteESMFactory({
        wasmBinary: wasmBinary.buffer.slice(
          wasmBinary.byteOffset,
          wasmBinary.byteOffset + wasmBinary.byteLength
        ),
      });
      db.sqlite3 = SQLite.Factory(module);
      db.sqlite3.vfs_register(new NodeFsVFS(storage.path) as never, true);
      db.dbHandle = await db.sqlite3.open_v2('gossip.db');
      db.useWorker = false;

      await db.sqlite3.exec(db.dbHandle, PRAGMAS_FILE);
      break;
    }

    case 'memory': {
      // In-memory mode (tests): sync WASM build, in-process, fast, isolated.
      const moduleArg: Record<string, unknown> = {};
      if (storage.wasmBinary) {
        moduleArg.wasmBinary = storage.wasmBinary;
      }

      const module = await SQLiteESMFactory(moduleArg);
      db.sqlite3 = SQLite.Factory(module);
      db.dbHandle = await db.sqlite3.open_v2(':memory:');
      db.useWorker = false;

      await db.sqlite3.exec(db.dbHandle, PRAGMAS);
      break;
    }
  }

  db.drizzleDb = createDrizzleInstance();

  // Run DDL (generated by npm run db:generate). Uses IF NOT EXISTS.
  for (const stmt of DDL) {
    await execRaw(stmt);
  }
}

/**
 * Get the Drizzle ORM database instance.
 * Throws if initDb() has not been called.
 */
export function getSqliteDb(): GossipDatabase {
  if (!db.drizzleDb) {
    throw new Error('SQLite not initialized. Call initDb() first.');
  }
  return db.drizzleDb;
}

export function isSqliteOpen(): boolean {
  return db.drizzleDb !== null;
}

/**
 * Run a callback inside a SQLite transaction (BEGIN / COMMIT / ROLLBACK).
 * All Drizzle operations inside the callback share the same transaction
 * and the same dbLock hold, so they cannot interleave with outside queries.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const prev = db.dbLock;
  let release!: () => void;
  db.dbLock = new Promise<void>(r => (release = r));
  await prev;

  try {
    await execRawDirect('BEGIN');
    db.inTransaction = true;
    try {
      const result = await fn();
      await execRawDirect('COMMIT');
      return result;
    } catch (e) {
      await execRawDirect('ROLLBACK');
      throw e;
    } finally {
      db.inTransaction = false;
    }
  } finally {
    release();
  }
}

export async function clearAllTables(): Promise<void> {
  await withTransaction(async () => {
    const drizzleDb = getSqliteDb();
    await drizzleDb.delete(schema.messages);
    await drizzleDb.delete(schema.discussions);
    await drizzleDb.delete(schema.contacts);
    await drizzleDb.delete(schema.userProfile);
    await drizzleDb.delete(schema.pendingEncryptedMessages);
    await drizzleDb.delete(schema.pendingAnnouncements);
    await drizzleDb.delete(schema.activeSeekers);
    await drizzleDb.delete(schema.announcementCursors);
  });
}

/**
 * Clear only conversation-related tables (contacts, discussions, messages).
 * Preserves user profiles and other data.
 */
export async function clearConversationTables(): Promise<void> {
  await withTransaction(async () => {
    const drizzleDb = getSqliteDb();
    await drizzleDb.delete(schema.messages);
    await drizzleDb.delete(schema.discussions);
    await drizzleDb.delete(schema.contacts);
  });
}

/**
 * Get the last auto-increment row ID inserted via this connection.
 * Used after INSERT into tables with INTEGER PRIMARY KEY AUTOINCREMENT.
 *
 * Browser path: returns the cached value from the last Worker exec response
 * (returned atomically with every exec — no race condition).
 * Test path: queries directly (same connection, serialized by dbLock).
 */
export async function getLastInsertRowId(): Promise<number> {
  if (db.useWorker) {
    return db.lastInsertRowIdCache;
  }
  const rows = await execRaw('SELECT last_insert_rowid()');
  return (rows[0] as number[])[0];
}

/**
 * Close the database and release all resources.
 * Browser path: sends close to Worker, then terminates it.
 * Test path: closes in-process database handle.
 * Atomically resets all state by replacing with a fresh default.
 */
export async function closeSqlite(): Promise<void> {
  if (db.useWorker && db.worker) {
    await postToWorker({ type: 'close' });
    db.worker.terminate();
  } else if (db.dbHandle !== null && db.sqlite3) {
    await db.sqlite3.close(db.dbHandle);
  }
  db = createDefaultState();
}
