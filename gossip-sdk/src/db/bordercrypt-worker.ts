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

/* eslint-disable @typescript-eslint/no-explicit-any */

const BLOCK_SIZE = 65536;
const SESSION_COUNT = 5;

let sqlite3: ReturnType<typeof SQLite.Factory> | null = null;
let dbHandle: number | null = null;
let bordercryptWasm: any = null;

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
  readKeypair(session: number): Uint8Array;
  writeKeypair(session: number, data: Uint8Array): void;
  close(): void;
}

let storage: StorageBackend | null = null;

function registerBordercryptCallbacks(): void {
  const g = globalThis as any;

  g.bordercryptReadBlock = (session: number, block: number): Uint8Array =>
    storage!.readBlock(session, block);

  g.bordercryptWriteBlock = (
    session: number,
    block: number,
    data: Uint8Array
  ): void => storage!.writeBlock(session, block, data);

  g.bordercryptAppendBlock = (session: number, data: Uint8Array): void =>
    storage!.appendBlock(session, data);

  g.bordercryptBlockCount = (session: number): number =>
    storage!.blockCount(session);

  g.bordercryptFsync = (session: number): void => storage!.fsync(session);

  g.bordercryptReadKeypair = (session: number): Uint8Array =>
    storage!.readKeypair(session);

  g.bordercryptWriteKeypair = (session: number, data: Uint8Array): void =>
    storage!.writeKeypair(session, data);
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

  fsync(session: number): void {
    this.blockHandles[session].flush();
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
  }

  appendBlock(session: number, data: Uint8Array): void {
    this.blocks[session].push(new Uint8Array(data));
  }

  blockCount(session: number): number {
    return this.blocks[session].length;
  }

  fsync(session: number): void {
    this.persistSession(session);
  }

  readKeypair(session: number): Uint8Array {
    return this.keypairs[session];
  }

  writeKeypair(session: number, data: Uint8Array): void {
    this.keypairs[session] = new Uint8Array(data);
    this.persistKeypair(session);
  }

  close(): void {
    for (let i = 0; i < SESSION_COUNT; i++) {
      this.persistSession(i);
    }
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

        // 1. Register storage callbacks before loading bordercrypt WASM
        registerBordercryptCallbacks();

        // 2. Initialize storage backend
        if (backend === 'idb') {
          const idb = new IdbBackend(dirPath);
          await idb.init();
          storage = idb;
        } else {
          const opfs = new OpfsBackend();
          await opfs.init(dirPath);
          storage = opfs;
        }

        // 3. Load bordercrypt WASM
        const bcModule = await import(
          /* @vite-ignore */
          '../assets/generated/wasm-bordercrypt/bordercrypt.js'
        );
        await bcModule.default();
        bordercryptWasm = bcModule;

        // 4. Initialize bordercrypt
        bordercryptWasm.initBordercrypt(domain || 'gossip');

        // 5. Load wa-sqlite
        const { default: SQLiteESMFactory } = await import(
          'wa-sqlite/dist/wa-sqlite.mjs'
        );
        const moduleArg: Record<string, unknown> = {};
        if (wasmUrl) moduleArg.locateFile = () => wasmUrl;
        const module = await SQLiteESMFactory(moduleArg);
        sqlite3 = SQLite.Factory(module);

        // 6. Register BordecryptVFS
        const { BordecryptVFS } = await import('./bordercrypt-vfs.js');
        const vfs = new BordecryptVFS(bordercryptWasm);
        sqlite3.vfs_register(vfs as never, true);

        // 7. Open database
        dbHandle = await sqlite3.open_v2('gossip.db');

        // 8. Run init SQL (PRAGMAs)
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

      case 'provision': {
        if (!bordercryptWasm)
          throw new Error('Bordercrypt not initialized');
        bordercryptWasm.provisionStorage();
        post({ id, type: 'provision-result', success: true });
        break;
      }

      case 'allocate': {
        const { slot, password } = e.data;
        if (!bordercryptWasm)
          throw new Error('Bordercrypt not initialized');
        bordercryptWasm.allocateSession(
          slot,
          new TextEncoder().encode(password)
        );
        post({ id, type: 'allocate-result', success: true });
        break;
      }

      case 'unlock': {
        const { password } = e.data;
        if (!bordercryptWasm)
          throw new Error('Bordercrypt not initialized');
        const unlocked = bordercryptWasm.unlockSession(
          new TextEncoder().encode(password)
        );
        post({ id, type: 'unlock-result', unlocked });
        break;
      }

      case 'lock': {
        if (bordercryptWasm) {
          bordercryptWasm.lockSession();
        }
        post({ id, type: 'lock-result' });
        break;
      }

      case 'cover': {
        if (!bordercryptWasm)
          throw new Error('Bordercrypt not initialized');
        bordercryptWasm.coverTrafficTick();
        post({ id, type: 'cover-result' });
        break;
      }

      case 'close': {
        if (dbHandle !== null && sqlite3) {
          await sqlite3.close(dbHandle);
          dbHandle = null;
        }
        sqlite3 = null;
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
    post({ id, type: 'error', message: (err as Error).message });
  }
});
