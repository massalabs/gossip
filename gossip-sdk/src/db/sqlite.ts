/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Two execution paths:
 *   - Browser (opfsPath set): Web Worker + AccessHandlePoolVFS — OPFS persistence,
 *     off the main thread. Uses the sync WASM build (wa-sqlite).
 *   - In-memory (tests): :memory: in-process — no persistence, fast, isolated.
 *     Uses the sync WASM build with wasmBinary passed directly.
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

export interface InitDbOptions {
  /**
   * OPFS directory path for persistent storage.
   * When set, spawns a Web Worker with AccessHandlePoolVFS for OPFS persistence.
   * When omitted, uses an in-memory database (for tests).
   */
  opfsPath?: string;

  /**
   * Pre-loaded WASM binary for environments where fetch() is unavailable
   * (e.g. Node.js tests). When omitted, the factory uses fetch() to load
   * the .wasm file (browser default).
   */
  wasmBinary?: ArrayBuffer;

  /**
   * URL to the wa-sqlite WASM file. Used in browser to tell the Emscripten
   * factory where to fetch the WASM binary (needed when bundlers like Vite
   * rewrite asset paths). When omitted, the factory uses its default path.
   */
  wasmUrl?: string;
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

/** PRAGMAs applied before migrations. */
const PRAGMAS = `
  PRAGMA journal_mode=MEMORY;
  PRAGMA temp_store=MEMORY;
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize wa-sqlite and create the Drizzle ORM instance.
 * Idempotent — subsequent calls are no-ops.
 *
 * @param options.opfsPath - Set to persist via OPFS Worker (production).
 *                           Omit for in-memory database (tests).
 */
export async function initDb(options: InitDbOptions = {}): Promise<void> {
  if (db.drizzleDb) return;

  if (options.opfsPath) {
    // Browser path: spawn Worker with OPFS + AccessHandlePoolVFS.
    // The sync WASM build runs in the Worker (no Asyncify needed).
    db.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), {
      type: 'module',
    });
    db.worker.onmessage = handleWorkerMessage;
    db.useWorker = true;

    try {
      await postToWorker({
        type: 'init',
        opfsPath: options.opfsPath,
        wasmUrl: options.wasmUrl,
        initSql: PRAGMAS,
      });
    } catch (err) {
      // Prevent dangling worker and "another open Access Handle" on retry:
      // only one SyncAccessHandle per file is allowed (e.g. another tab or
      // a previous failed init may hold it). Terminate and reset so retry
      // doesn't create a second worker.
      if (db.worker) {
        db.worker.terminate();
        db.worker = null;
      }
      db.useWorker = false;
      db.pending.clear();
      throw err;
    }
  } else {
    // In-memory mode (tests): sync WASM build, in-process, fast, isolated.
    const moduleArg: Record<string, unknown> = {};
    if (options.wasmBinary) {
      moduleArg.wasmBinary = options.wasmBinary;
    }

    const module = await SQLiteESMFactory(moduleArg);
    db.sqlite3 = SQLite.Factory(module);
    db.dbHandle = await db.sqlite3.open_v2(':memory:');
    db.useWorker = false;

    await db.sqlite3.exec(db.dbHandle, PRAGMAS);
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
