/**
 * Bordercrypt Web Worker — encrypted SQLite via wa-sqlite + bordercrypt WASM.
 *
 * Loads both WASM modules, registers storage callbacks for bordercrypt,
 * then opens an encrypted SQLite database.
 *
 * Supports two storage backends:
 *   - 'opfs': OPFS sync access handles (mobile / single-tab)
 *   - 'idb':  In-memory + IndexedDB persistence (browser / multi-tab safe)
 *
 * Messages:
 *   init      → load WASM, open DB
 *   exec      → SQL execution
 *   close     → close DB + lock session
 *   unlock    → decrypt session with password
 *   lock      → zeroize session keys
 *   provision → initialize fresh storage
 *   allocate  → create session in slot
 *   cover     → run one cover traffic round
 */

import * as SQLite from 'wa-sqlite';
import { execStatements } from './exec-utils.js';
import { BLOCK_SIZE, SESSION_COUNT } from './bordercrypt-constants.js';
import type { BordercryptVFS } from './bordercrypt-vfs.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

let sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
let dbHandle: number | null = null;
let bordercryptWasm: any = null;
let vfs: BordercryptVFS | null = null;

// Saved init config for deferred SQLite open after unlock
let savedInitSql: string | null = null;
let savedWasmUrl: string | null = null;
// Permanent copy of init SQL — savedInitSql gets nulled after first open,
// but we need PRAGMAs when reopening SQLite for slot switches.
let initSqlPermanent: string | null = null;

const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

// ── Storage backend interface ───────────────────────────────────

interface StorageBackend {
  readBlock(session: number, block: number): Uint8Array;
  writeBlock(session: number, block: number, data: Uint8Array): void;
  appendBlock(session: number, data: Uint8Array): void;
  blockCount(session: number): number;
  fsync(session: number): void;
  hasDirty(): boolean;
  flushAll(): void;
  readKeypair(session: number): Uint8Array;
  writeKeypair(session: number, data: Uint8Array): void;
  close(): void;
}

let storage: StorageBackend | null = null;

function assertSession(session: number): void {
  if (session < 0 || session >= SESSION_COUNT) {
    throw new Error(`Invalid session index: ${session}`);
  }
}

function registerBordercryptCallbacks(): void {
  const g = globalThis as any;

  g.bordercryptReadBlock = (session: number, block: number): Uint8Array => {
    assertSession(session);
    return storage!.readBlock(session, block);
  };

  g.bordercryptWriteBlock = (
    session: number,
    block: number,
    data: Uint8Array
  ): void => {
    assertSession(session);
    storage!.writeBlock(session, block, data);
  };

  g.bordercryptAppendBlock = (session: number, data: Uint8Array): void => {
    assertSession(session);
    storage!.appendBlock(session, data);
  };

  g.bordercryptBlockCount = (session: number): number => {
    assertSession(session);
    return storage!.blockCount(session);
  };

  g.bordercryptFsync = (session: number): void => {
    assertSession(session);
    storage!.fsync(session);
  };

  g.bordercryptReadKeypair = (session: number): Uint8Array => {
    assertSession(session);
    return storage!.readKeypair(session);
  };

  g.bordercryptWriteKeypair = (session: number, data: Uint8Array): void => {
    assertSession(session);
    storage!.writeKeypair(session, data);
  };
}

// ── OPFS backend ────────────────────────────────────────────────

interface SyncHandle {
  read(buffer: Uint8Array, opts?: { at?: number }): number;
  write(buffer: Uint8Array, opts?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

class OpfsBackend implements StorageBackend {
  private blockHandles: SyncHandle[] = [];
  private keypairHandles: SyncHandle[] = [];

  async init(dirPath: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirPath, { create: true });

    for (let i = 0; i < SESSION_COUNT; i++) {
      const blockFile = await dir.getFileHandle(`session_${i}.blocks`, {
        create: true,
      });
      this.blockHandles.push(
        (await (blockFile as any).createSyncAccessHandle()) as SyncHandle
      );

      const keypairFile = await dir.getFileHandle(`session_${i}.keypair`, {
        create: true,
      });
      this.keypairHandles.push(
        (await (keypairFile as any).createSyncAccessHandle()) as SyncHandle
      );
    }
  }

  readBlock(session: number, block: number): Uint8Array {
    const handle = this.blockHandles[session];
    const buf = new Uint8Array(BLOCK_SIZE);
    handle.read(buf, { at: block * BLOCK_SIZE });
    return buf;
  }

  writeBlock(session: number, block: number, data: Uint8Array): void {
    this.blockHandles[session].write(data, { at: block * BLOCK_SIZE });
  }

  appendBlock(session: number, data: Uint8Array): void {
    const handle = this.blockHandles[session];
    const size = handle.getSize();
    handle.write(data, { at: size });
  }

  blockCount(session: number): number {
    return Math.floor(this.blockHandles[session].getSize() / BLOCK_SIZE);
  }

  fsync(_session: number): void {
    // No-op: data is already in the sync handle buffer.
    // Flushed to disk on flushAll() (after exec / on close).
  }

  hasDirty(): boolean {
    // OPFS writes go to sync access handles; flush is cheap, always return true.
    return true;
  }

  flushAll(): void {
    for (const h of this.blockHandles) h.flush();
  }

  readKeypair(session: number): Uint8Array {
    const handle = this.keypairHandles[session];
    const size = handle.getSize();
    if (size === 0) return new Uint8Array(0);
    const buf = new Uint8Array(size);
    handle.read(buf);
    return buf;
  }

  writeKeypair(session: number, data: Uint8Array): void {
    const handle = this.keypairHandles[session];
    handle.truncate(0);
    handle.write(data);
    handle.flush();
  }

  close(): void {
    this.flushAll();
    for (const h of this.blockHandles) h.close();
    for (const h of this.keypairHandles) h.close();
    this.blockHandles = [];
    this.keypairHandles = [];
  }
}

// ── IDB backend (memory-buffered + IndexedDB persistence) ───────

class IdbBackend implements StorageBackend {
  private blocks: Uint8Array[][] = [];
  private keypairs: Uint8Array[] = [];
  private db: IDBDatabase | null = null;
  private storeName: string;
  private dirtySessions: Set<number> = new Set();

  constructor(storeName: string) {
    this.storeName = storeName;
  }

  async init(): Promise<void> {
    this.db = await this.openDb();

    for (let i = 0; i < SESSION_COUNT; i++) {
      const blockData = await this.idbGet<Uint8Array>(`blocks_${i}`);
      if (blockData && blockData.byteLength > 0) {
        const count = Math.floor(blockData.byteLength / BLOCK_SIZE);
        const arr: Uint8Array[] = [];
        for (let b = 0; b < count; b++) {
          arr.push(
            new Uint8Array(
              blockData.buffer,
              blockData.byteOffset + b * BLOCK_SIZE,
              BLOCK_SIZE
            )
          );
        }
        this.blocks[i] = arr;
      } else {
        this.blocks[i] = [];
      }

      const kp = await this.idbGet<Uint8Array>(`keypair_${i}`);
      this.keypairs[i] = kp ?? new Uint8Array(0);
    }
  }

  readBlock(session: number, block: number): Uint8Array {
    const arr = this.blocks[session];
    if (block < arr.length) return arr[block];
    return new Uint8Array(BLOCK_SIZE);
  }

  writeBlock(session: number, block: number, data: Uint8Array): void {
    while (this.blocks[session].length <= block) {
      this.blocks[session].push(new Uint8Array(BLOCK_SIZE));
    }
    this.blocks[session][block] = new Uint8Array(data);
    this.dirtySessions.add(session);
  }

  appendBlock(session: number, data: Uint8Array): void {
    this.blocks[session].push(new Uint8Array(data));
    this.dirtySessions.add(session);
  }

  blockCount(session: number): number {
    return this.blocks[session].length;
  }

  fsync(_session: number): void {
    // No-op: data is in memory, persisted on flushAll().
  }

  hasDirty(): boolean {
    return this.dirtySessions.size > 0;
  }

  flushAll(): void {
    for (const session of this.dirtySessions) {
      this.persistSession(session);
    }
    this.dirtySessions.clear();
  }

  readKeypair(session: number): Uint8Array {
    return this.keypairs[session];
  }

  writeKeypair(session: number, data: Uint8Array): void {
    this.keypairs[session] = new Uint8Array(data);
    this.persistKeypair(session);
  }

  close(): void {
    this.flushAll();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.blocks = [];
    this.keypairs = [];
  }

  private persistSession(session: number): void {
    const arr = this.blocks[session];
    const total = arr.length * BLOCK_SIZE;
    const buf = new Uint8Array(total);
    for (let i = 0; i < arr.length; i++) {
      buf.set(arr[i], i * BLOCK_SIZE);
    }
    this.idbPut(`blocks_${session}`, buf);
  }

  private persistKeypair(session: number): void {
    this.idbPut(`keypair_${session}`, this.keypairs[session]);
  }

  private openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.storeName, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('data');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private idbGet<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction('data', 'readonly');
      const req = tx.objectStore('data').get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  }

  private idbPut(key: string, value: unknown): void {
    const tx = this.db!.transaction('data', 'readwrite');
    tx.objectStore('data').put(value, key);
  }
}

// ── SQLite lifecycle ────────────────────────────────────────────

async function openSqlite(
  wasmUrl?: string | null,
  initSql?: string | null
): Promise<void> {
  const { default: SQLiteESMFactory } =
    await import('wa-sqlite/dist/wa-sqlite.mjs');
  const moduleArg: Record<string, unknown> = {};
  if (wasmUrl) moduleArg.locateFile = () => wasmUrl;
  const module = await SQLiteESMFactory(moduleArg);
  sqlite3 = SQLite.Factory(module);
  console.log('[BC-Worker] wa-sqlite loaded');

  const { BordercryptVFS } = await import('./bordercrypt-vfs.js');
  vfs = new BordercryptVFS(bordercryptWasm);
  sqlite3.vfs_register(vfs as never, true);
  console.log('[BC-Worker] VFS registered');

  dbHandle = await sqlite3.open_v2('gossip.db');
  console.log('[BC-Worker] database opened');

  if (initSql) {
    const stmts = initSql
      .split(';')
      .map(s => s.trim())
      .filter(Boolean);
    for (const stmt of stmts) {
      console.log(`[BC-Worker] init: ${stmt.substring(0, 80)}`);
      await sqlite3.exec(dbHandle, stmt);
    }
    console.log('[BC-Worker] init SQL done');
  }
}

// ── Deferred flush ──────────────────────────────────────────────
// Instead of flushing VFS dirty pages + IDB after every SQL exec,
// batch them on a 500ms timer. This dramatically reduces the number
// of bordercrypt encrypt cycles (each page × 5 sessions).
// Flush is forced on lock, close, allocate, and unlock.

const FLUSH_INTERVAL_MS = 500;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(): void {
  if (flushTimer) return; // already scheduled
  flushTimer = setTimeout(flushNow, FLUSH_INTERVAL_MS);
}

function flushNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (vfs) vfs.flushDirtyPages();
  if (storage && storage.hasDirty()) storage.flushAll();
}

// ── SQL execution ───────────────────────────────────────────────

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

// ── Message handler ─────────────────────────────────────────────

addEventListener('message', async (e: MessageEvent) => {
  const { id, type } = e.data;

  try {
    switch (type) {
      case 'init': {
        const { dirPath, domain, backend, wasmUrl, initSql } = e.data;

        console.log('[BC-Worker] init start', { dirPath, domain, backend });

        // 1. Register storage callbacks
        registerBordercryptCallbacks();

        // 2. Initialize storage backend
        if (backend === 'idb') {
          const idb = new IdbBackend(dirPath);
          await idb.init();
          storage = idb;
          console.log('[BC-Worker] IDB backend ready');
        } else {
          const opfs = new OpfsBackend();
          await opfs.init(dirPath);
          storage = opfs;
          console.log('[BC-Worker] OPFS backend ready');
        }

        // 3. Load bordercrypt WASM
        const bcModule = await import(
          /* @vite-ignore */
          '../assets/generated/wasm-bordercrypt/bordercrypt.js'
        );
        await bcModule.default();
        bordercryptWasm = bcModule;
        console.log('[BC-Worker] bordercrypt WASM loaded');

        // 4. Initialize bordercrypt
        bordercryptWasm.initBordercrypt(domain || 'gossip');

        // 5. Always defer SQLite — it needs an unlocked session
        savedInitSql = initSql || null;
        savedWasmUrl = wasmUrl || null;
        initSqlPermanent = savedInitSql;

        const hasData = storage.blockCount(0) > 0;

        if (hasData) {
          console.log(
            '[BC-Worker] existing data found — SQLite deferred until unlock'
          );
          post({ id, type: 'init-result', success: true, needsUnlock: true });
        } else {
          console.log(
            '[BC-Worker] first use — provisioning storage, SQLite deferred until allocate'
          );
          bordercryptWasm.provisionStorage();
          post({ id, type: 'init-result', success: true, needsUnlock: false });
        }
        break;
      }

      case 'exec': {
        const { sql, params } = e.data;
        const result = await execSql(sql, params);
        // Defer flush — dirty pages accumulate and coalesce across
        // multiple SQL statements, reducing encrypt cycles.
        scheduleFlush();
        post({
          id,
          type: 'exec-result',
          rows: result.rows,
          lastInsertRowId: result.lastInsertRowId,
        });
        break;
      }

      case 'provision': {
        if (!bordercryptWasm) throw new Error('Bordercrypt not initialized');
        bordercryptWasm.provisionStorage();
        console.log('[BC-Worker] provision done');
        post({ id, type: 'provision-result', success: true });
        break;
      }

      case 'allocate': {
        const { slot, password } = e.data as {
          slot: number;
          password: Uint8Array;
        };
        if (!bordercryptWasm) throw new Error('Bordercrypt not initialized');

        // Flush all pending writes BEFORE switching slots.
        flushNow();

        // Close SQLite before switching slots — SQLite's internal state
        // (page cache, schema info, file format) is bound to the previous
        // slot's database. Reusing the handle after a slot switch causes
        // "file is not a database" errors.
        if (sqlite3 && dbHandle !== null) {
          await sqlite3.close(dbHandle);
          dbHandle = null;
        }

        bordercryptWasm.allocateSession(slot, password);
        console.log(
          `[BC-Worker] allocate slot=${slot}, session now unlocked=${bordercryptWasm.isUnlocked()}`
        );

        // Reopen SQLite with a fresh handle for the new slot
        if (sqlite3 && dbHandle === null) {
          dbHandle = await sqlite3.open_v2('gossip.db');
          if (initSqlPermanent) {
            const stmts = initSqlPermanent
              .split(';')
              .map(s => s.trim())
              .filter(Boolean);
            for (const stmt of stmts) {
              await sqlite3.exec(dbHandle, stmt);
            }
          }
        } else if (!sqlite3) {
          console.log('[BC-Worker] opening deferred SQLite after allocate');
          await openSqlite(savedWasmUrl, savedInitSql);
          savedInitSql = null;
          savedWasmUrl = null;
        }
        if (storage) storage.flushAll();

        post({ id, type: 'allocate-result', success: true });
        break;
      }

      case 'unlock': {
        const { password } = e.data as { password: Uint8Array };
        if (!bordercryptWasm) throw new Error('Bordercrypt not initialized');

        // Flush all pending writes before switching slots.
        flushNow();
        if (sqlite3 && dbHandle !== null) {
          await sqlite3.close(dbHandle);
          dbHandle = null;
        }

        const unlocked = bordercryptWasm.unlockSession(password);
        console.log(`[BC-Worker] unlock result=${unlocked}`);

        // Reopen SQLite with a fresh handle for the unlocked slot
        if (unlocked && sqlite3 && dbHandle === null) {
          dbHandle = await sqlite3.open_v2('gossip.db');
          if (initSqlPermanent) {
            const stmts = initSqlPermanent
              .split(';')
              .map(s => s.trim())
              .filter(Boolean);
            for (const stmt of stmts) {
              await sqlite3.exec(dbHandle, stmt);
            }
          }
        } else if (unlocked && !sqlite3) {
          console.log('[BC-Worker] opening deferred SQLite after unlock');
          await openSqlite(savedWasmUrl, savedInitSql);
          savedInitSql = null;
          savedWasmUrl = null;
        }
        if (unlocked && storage) storage.flushAll();

        post({ id, type: 'unlock-result', unlocked });
        break;
      }

      case 'lock': {
        flushNow();

        if (bordercryptWasm) {
          bordercryptWasm.lockSession();
          console.log('[BC-Worker] session locked');
        }
        post({ id, type: 'lock-result' });
        break;
      }

      case 'cover': {
        if (!bordercryptWasm) throw new Error('Bordercrypt not initialized');
        flushNow(); // flush pending writes before cover rerandomizes blocks
        bordercryptWasm.coverTrafficTick();
        if (storage) storage.flushAll();
        post({ id, type: 'cover-result' });
        break;
      }

      case 'flush': {
        flushNow();
        post({ id, type: 'flush-result' });
        break;
      }

      case 'close': {
        flushNow();
        if (dbHandle !== null && sqlite3) {
          await sqlite3.close(dbHandle);
          dbHandle = null;
        }
        sqlite3 = null;
        vfs = null;
        if (bordercryptWasm) {
          bordercryptWasm.lockSession();
          bordercryptWasm = null;
        }
        if (storage) {
          storage.close();
          storage = null;
        }
        post({ id, type: 'close-result' });
        break;
      }
    }
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.message
        : typeof err === 'number'
          ? `SQLite error code ${err}`
          : String(err);
    post({ id, type: 'error', message: msg });
  }
});
