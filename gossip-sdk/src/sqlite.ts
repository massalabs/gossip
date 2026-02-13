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
import * as schema from './schema.js';

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

// wa-sqlite's column_blob() returns a Uint8Array VIEW into WASM linear memory
// (Module.HEAPU8.subarray). These views become stale after finalize() frees the
// prepared statement, or if WASM memory grows. Copy blob values so callers get
// owned data that survives beyond the current query.
function copyRow(row: unknown[]): unknown[] {
  return row.map(v => (v instanceof Uint8Array ? new Uint8Array(v) : v));
}

async function execRawInProcess(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  if (!db.sqlite3 || db.dbHandle === null) {
    throw new Error('SQLite not initialized');
  }

  // Simple path for parameterless statements
  if (params.length === 0) {
    const rows: unknown[][] = [];
    await db.sqlite3.exec(db.dbHandle, sql, (row: unknown[]) => {
      rows.push(copyRow(row));
    });
    return rows;
  }

  // Prepared statement path for parameterized queries
  const str = db.sqlite3.str_new(db.dbHandle, sql);
  try {
    const prepared = await db.sqlite3.prepare_v2(
      db.dbHandle,
      db.sqlite3.str_value(str)
    );
    if (!prepared) return [];

    try {
      db.sqlite3.bind_collection(
        prepared.stmt,
        params as (number | string | Uint8Array | null)[]
      );
      const rows: unknown[][] = [];
      while ((await db.sqlite3.step(prepared.stmt)) === SQLite.SQLITE_ROW) {
        rows.push(copyRow(db.sqlite3.row(prepared.stmt)));
      }
      return rows;
    } finally {
      await db.sqlite3.finalize(prepared.stmt);
    }
  } finally {
    db.sqlite3.str_finish(str);
  }
}

// ---------------------------------------------------------------------------
// DDL — CREATE TABLE + indexes
//
// IMPORTANT: This DDL must stay in sync with schema.ts.
// When adding/removing/renaming columns, tables, or indexes, update BOTH files.
// schema.ts is the Drizzle type source; this DDL is the runtime CREATE source.
// ---------------------------------------------------------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerUserId TEXT NOT NULL,
    userId TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    publicKeys BLOB NOT NULL,
    isOnline INTEGER NOT NULL DEFAULT 0,
    lastSeen INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerUserId TEXT NOT NULL,
    contactUserId TEXT NOT NULL,
    messageId BLOB,
    content TEXT NOT NULL,
    serializedContent BLOB,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    metadata TEXT,
    seeker BLOB,
    replyTo TEXT,
    forwardOf TEXT,
    encryptedMessage BLOB,
    whenToSend INTEGER
  );

  CREATE TABLE IF NOT EXISTS userProfile (
    userId TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar TEXT,
    bio TEXT,
    status TEXT NOT NULL,
    lastSeen INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL,
    lastPublicKeyPush INTEGER,
    security TEXT NOT NULL,
    session BLOB NOT NULL
  );

  CREATE TABLE IF NOT EXISTS discussions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ownerUserId TEXT NOT NULL,
    contactUserId TEXT NOT NULL,
    direction TEXT NOT NULL,
    status TEXT NOT NULL,
    weAccepted INTEGER NOT NULL DEFAULT 0,
    sendAnnouncement TEXT,
    nextSeeker BLOB,
    initiationAnnouncement BLOB,
    announcementMessage TEXT,
    lastSyncTimestamp INTEGER,
    customName TEXT,
    lastMessageId INTEGER,
    lastMessageContent TEXT,
    lastMessageTimestamp INTEGER,
    unreadCount INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pendingEncryptedMessages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seeker BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    fetchedAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pendingAnnouncements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    announcement BLOB NOT NULL,
    fetchedAt INTEGER NOT NULL,
    counter TEXT
  );

  CREATE TABLE IF NOT EXISTS activeSeekers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seeker BLOB NOT NULL
  );

  -- Indexes: contacts
  CREATE INDEX IF NOT EXISTS contacts_owner_user_idx ON contacts(ownerUserId, userId);
  CREATE INDEX IF NOT EXISTS contacts_owner_name_idx ON contacts(ownerUserId, name);

  -- Indexes: messages
  CREATE INDEX IF NOT EXISTS messages_owner_contact_idx ON messages(ownerUserId, contactUserId);
  CREATE INDEX IF NOT EXISTS messages_owner_status_idx ON messages(ownerUserId, status);
  CREATE INDEX IF NOT EXISTS messages_owner_contact_status_idx ON messages(ownerUserId, contactUserId, status);
  CREATE INDEX IF NOT EXISTS messages_owner_seeker_idx ON messages(ownerUserId, seeker);
  CREATE INDEX IF NOT EXISTS messages_owner_contact_dir_idx ON messages(ownerUserId, contactUserId, direction);
  CREATE INDEX IF NOT EXISTS messages_owner_dir_status_idx ON messages(ownerUserId, direction, status);
  CREATE INDEX IF NOT EXISTS messages_timestamp_idx ON messages(timestamp);

  -- Indexes: userProfile
  CREATE INDEX IF NOT EXISTS userProfile_username_idx ON userProfile(username);
  CREATE INDEX IF NOT EXISTS userProfile_status_idx ON userProfile(status);

  -- Indexes: discussions
  CREATE UNIQUE INDEX IF NOT EXISTS discussions_owner_contact_idx ON discussions(ownerUserId, contactUserId);
  CREATE INDEX IF NOT EXISTS discussions_owner_status_idx ON discussions(ownerUserId, status);

  -- Indexes: pendingEncryptedMessages
  CREATE INDEX IF NOT EXISTS pending_encrypted_seeker_idx ON pendingEncryptedMessages(seeker);
  CREATE INDEX IF NOT EXISTS pending_encrypted_fetchedAt_idx ON pendingEncryptedMessages(fetchedAt);

  -- Indexes: pendingAnnouncements
  CREATE UNIQUE INDEX IF NOT EXISTS pending_announcements_announcement_idx ON pendingAnnouncements(announcement);
  CREATE INDEX IF NOT EXISTS pending_announcements_fetchedAt_idx ON pendingAnnouncements(fetchedAt);

  -- Indexes: activeSeekers
  CREATE INDEX IF NOT EXISTS active_seekers_seeker_idx ON activeSeekers(seeker);

  CREATE TABLE IF NOT EXISTS announcementCursors (
    userId TEXT PRIMARY KEY,
    counter TEXT NOT NULL
  );
`;

// ---------------------------------------------------------------------------
// Migrations — add columns that may be missing from older schema versions.
// ALTER TABLE … ADD COLUMN is idempotent via try/catch (SQLite errors on
// duplicate columns; we simply ignore that error).
// ---------------------------------------------------------------------------

/**
 * Run schema migrations that can't be expressed with CREATE TABLE IF NOT EXISTS.
 * Each migration is a single ALTER TABLE statement; duplicates are caught and ignored.
 */
async function runMigrations(
  tryExec: (sql: string) => Promise<void>
): Promise<void> {
  const alterStatements = [
    // v1: add messageId column to messages table
    'ALTER TABLE messages ADD COLUMN messageId BLOB;',
  ];

  for (const sql of alterStatements) {
    await tryExec(sql);
  }
}

/** PRAGMAs + DDL combined — sent to Worker during init or run in-process. */
const INIT_SQL = `
  PRAGMA journal_mode=MEMORY;
  PRAGMA temp_store=MEMORY;
  ${DDL}
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

    await postToWorker({
      type: 'init',
      opfsPath: options.opfsPath,
      wasmUrl: options.wasmUrl,
      initSql: INIT_SQL,
    });

    // Run migrations via Worker exec (ignore "duplicate column" errors)
    await runMigrations(async sql => {
      try {
        await postToWorker({ type: 'exec', sql, params: [] });
      } catch {
        // Expected: "duplicate column name: …" when column already exists
      }
    });
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

    await db.sqlite3.exec(db.dbHandle, INIT_SQL);

    // Run migrations in-process (ignore "duplicate column" errors)
    await runMigrations(async sql => {
      try {
        await db.sqlite3!.exec(db.dbHandle!, sql);
      } catch {
        // Expected: "duplicate column name: …" when column already exists
      }
    });
  }

  db.drizzleDb = createDrizzleInstance();
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
  const drizzleDb = getSqliteDb();
  await drizzleDb.delete(schema.messages);
  await drizzleDb.delete(schema.discussions);
  await drizzleDb.delete(schema.contacts);
  await drizzleDb.delete(schema.userProfile);
  await drizzleDb.delete(schema.pendingEncryptedMessages);
  await drizzleDb.delete(schema.pendingAnnouncements);
  await drizzleDb.delete(schema.activeSeekers);
  await drizzleDb.delete(schema.announcementCursors);
}

/**
 * Clear only conversation-related tables (contacts, discussions, messages).
 * Preserves user profiles and other data.
 */
export async function clearConversationTables(): Promise<void> {
  const drizzleDb = getSqliteDb();
  await drizzleDb.delete(schema.messages);
  await drizzleDb.delete(schema.discussions);
  await drizzleDb.delete(schema.contacts);
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

/** Exported for testing — the raw DDL string used to create tables. */
export const _DDL_FOR_TESTING = DDL;
