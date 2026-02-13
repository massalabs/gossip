/**
 * SQLite initialization module for the Gossip SDK.
 *
 * Uses wa-sqlite (WASM) with Drizzle ORM's sqlite-proxy driver.
 * Two modes:
 *   - Persistent (production): IDBBatchAtomicVFS — IndexedDB-backed, main-thread safe
 *     Uses the async WASM build (wa-sqlite-async) since IDBBatchAtomicVFS relies on
 *     async I/O via handleAsync, which requires Asyncify (the sync build uses
 *     Atomics.wait which is blocked on the main thread).
 *   - In-memory (tests): :memory: — no persistence, fast, isolated
 *     Uses the sync WASM build (wa-sqlite) for speed.
 *
 * In Phase C the VFS will be swapped for the encrypted PlausibleDeniableVFS.
 */

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import SQLiteAsyncESMFactory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from 'wa-sqlite';
import { IDBBatchAtomicVFS } from 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js';
import { drizzle, type SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema.js';

export type GossipDatabase = SqliteRemoteDatabase<typeof schema>;

export interface InitDbOptions {
  /**
   * OPFS directory path for persistent storage.
   * When set, uses AccessHandlePoolVFS to persist SQLite pages via OPFS.
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
   * rewrite asset paths). Should point to wa-sqlite-async.wasm when using
   * persistent mode (opfsPath set). When omitted, the factory uses its
   * default path.
   */
  wasmUrl?: string;
}

let sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
let dbHandle: number | null = null;
let vfs: IDBBatchAtomicVFS | null = null;

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

let drizzleDb: GossipDatabase | null = null;

// ---------------------------------------------------------------------------
// Raw SQL execution (used by Drizzle callback and DDL)
// ---------------------------------------------------------------------------

// Async mutex — wa-sqlite's prepare_v2 uses a shared tmpPtr in WASM memory.
// Concurrent calls (e.g. from React StrictMode double-invoked effects) can
// overwrite each other's pointers between the C call and the await resume,
// causing SQLITE_MISUSE errors. Serializing all calls prevents this.
let dbLock: Promise<unknown> = Promise.resolve();

async function execRaw(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  const prev = dbLock;
  let release!: () => void;
  dbLock = new Promise<void>(r => (release = r));
  await prev;
  try {
    return await execRawUnserialized(sql, params);
  } finally {
    release();
  }
}

// wa-sqlite's column_blob() returns a Uint8Array VIEW into WASM linear memory
// (Module.HEAPU8.subarray). These views become stale after finalize() frees the
// prepared statement, or if WASM memory grows. Copy blob values so callers get
// owned data that survives beyond the current query.
function copyRow(row: unknown[]): unknown[] {
  return row.map(v => (v instanceof Uint8Array ? new Uint8Array(v) : v));
}

async function execRawUnserialized(
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  if (!sqlite3 || dbHandle === null) {
    throw new Error('SQLite not initialized');
  }

  // Simple path for parameterless statements
  if (params.length === 0) {
    const rows: unknown[][] = [];
    await sqlite3.exec(dbHandle, sql, (row: unknown[]) => {
      rows.push(copyRow(row));
    });
    return rows;
  }

  // Prepared statement path for parameterized queries
  const str = sqlite3.str_new(dbHandle, sql);
  try {
    const prepared = await sqlite3.prepare_v2(dbHandle, sqlite3.str_value(str));
    if (!prepared) return [];

    try {
      sqlite3.bind_collection(
        prepared.stmt,
        params as (number | string | Uint8Array | null)[]
      );
      const rows: unknown[][] = [];
      while ((await sqlite3.step(prepared.stmt)) === SQLite.SQLITE_ROW) {
        rows.push(copyRow(sqlite3.row(prepared.stmt)));
      }
      return rows;
    } finally {
      await sqlite3.finalize(prepared.stmt);
    }
  } finally {
    sqlite3.str_finish(str);
  }
}

// ---------------------------------------------------------------------------
// DDL — CREATE TABLE + indexes (must match schema.ts definitions)
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize wa-sqlite and create the Drizzle ORM instance.
 * Idempotent — subsequent calls are no-ops.
 *
 * @param options.opfsPath - Set to persist via OPFS (production).
 *                           Omit for in-memory database (tests).
 */
export async function initDb(options: InitDbOptions = {}): Promise<void> {
  if (drizzleDb) return;

  const moduleArg: Record<string, unknown> = {};
  if (options.wasmBinary) {
    moduleArg.wasmBinary = options.wasmBinary;
  } else if (options.wasmUrl) {
    moduleArg.locateFile = () => options.wasmUrl;
  }

  if (options.opfsPath) {
    // Persistent mode: IDBBatchAtomicVFS stores SQLite pages in IndexedDB.
    // Must use the async WASM build (Asyncify) because IDBBatchAtomicVFS uses
    // handleAsync for I/O, and the sync build's Atomics.wait is blocked on
    // the main thread.
    const module = await SQLiteAsyncESMFactory(moduleArg);
    sqlite3 = SQLite.Factory(module);

    vfs = new IDBBatchAtomicVFS(options.opfsPath);
    await vfs.isReady;
    sqlite3.vfs_register(vfs as never, true);
    dbHandle = await sqlite3.open_v2('gossip.db');
  } else {
    // In-memory mode (tests): sync WASM build, fast, isolated.
    const module = await SQLiteESMFactory(moduleArg);
    sqlite3 = SQLite.Factory(module);
    dbHandle = await sqlite3.open_v2(':memory:');
  }

  // Keep all journal/temp data in memory (no extra files).
  // Required for the 2-file constraint once encrypted VFS is wired in.
  await sqlite3.exec(dbHandle, 'PRAGMA journal_mode=MEMORY;');
  await sqlite3.exec(dbHandle, 'PRAGMA temp_store=MEMORY;');

  await sqlite3.exec(dbHandle, DDL);

  drizzleDb = createDrizzleInstance();
}

/**
 * Get the Drizzle ORM database instance.
 * Throws if initDb() has not been called.
 */
export function getSqliteDb(): GossipDatabase {
  if (!drizzleDb) {
    throw new Error('SQLite not initialized. Call initDb() first.');
  }
  return drizzleDb;
}

export function isSqliteOpen(): boolean {
  return drizzleDb !== null;
}

export async function clearAllTables(): Promise<void> {
  const db = getSqliteDb();
  for (const table of Object.values(schema)) {
    await db.delete(table as never);
  }
}

/**
 * Clear only conversation-related tables (contacts, discussions, messages).
 * Preserves user profiles and other data.
 */
export async function clearConversationTables(): Promise<void> {
  const db = getSqliteDb();
  await db.delete(schema.messages as never);
  await db.delete(schema.discussions as never);
  await db.delete(schema.contacts as never);
}

/**
 * Get the last auto-increment row ID inserted via this connection.
 * Used after INSERT into tables with INTEGER PRIMARY KEY AUTOINCREMENT.
 */
export async function getLastInsertRowId(): Promise<number> {
  const rows = await execRaw('SELECT last_insert_rowid()');
  return (rows[0] as number[])[0];
}

/**
 * Close the database and release all resources.
 */
export async function closeSqlite(): Promise<void> {
  if (dbHandle !== null && sqlite3) {
    await sqlite3.close(dbHandle);
    dbHandle = null;
  }
  if (vfs) {
    await vfs.close();
    vfs = null;
  }
  drizzleDb = null;
  sqlite3 = null;
}
