/// <reference lib="webworker" />
// TODO: rename to session to account
/**
 * Storage Worker - Connects to Rust WASM encrypted storage with SQLite
 *
 * Uses the @gossip/storage library which integrates:
 * - wa-sqlite for SQL execution
 * - Rust WASM for encryption/decryption
 * - OPFS for file storage
 */

// Import directly from specific files to avoid loading NodeFileSystem (which requires Node.js fs)
import { Storage } from '../gossip-storage/ts/src/storage';
import { OpfsFileSystem } from '../gossip-storage/ts/src/filesystems/opfs';

import gossipWasmUrl from '../gossip-storage/ts/generated/gossip_storage_bg.wasm?url';
import waSqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';

console.log(
  '[Storage Worker] Imports loaded, OpfsFileSystem:',
  typeof OpfsFileSystem
);

// ============================================================
// WORKER STATE
// ============================================================

let storage: Storage | null = null;

function log(msg: string) {
  console.log('[Storage Worker] ' + msg);
  self.postMessage({ type: 'log', message: msg });
}

// ============================================================
// INITIALIZATION
// ============================================================

async function initialize(): Promise<{ success: boolean; error?: string }> {
  if (storage?.isInitialized()) {
    return { success: true };
  }

  try {
    log('Creating storage with OPFS filesystem...');
    storage = new Storage(new OpfsFileSystem());

    log('Initializing storage (loading WASM modules)...');
    await storage.init({
      gossipWasmUrl,
      waSqliteWasmUrl,
    });

    log(`Storage initialized: ${storage.getWasmVersion()}`);
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`Initialization error: ${error}`);
    return { success: false, error };
  }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function handleCreateSession(
  password: string
): Promise<{ success: boolean; error?: string }> {
  if (!storage?.isInitialized()) {
    const init = await initialize();
    if (!init.success) return init;
  }

  try {
    const success = await storage!.createSession(password);
    if (!success) {
      return { success: false, error: 'Failed to create session' };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleUnlockSession(
  password: string
): Promise<{ success: boolean; error?: string }> {
  if (!storage?.isInitialized()) {
    const init = await initialize();
    if (!init.success) return init;
  }

  try {
    const success = await storage!.unlockSession(password);
    if (!success) {
      return { success: false, error: 'Invalid password' };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleLockSession(): Promise<{ success: boolean }> {
  try {
    // Flush data before locking to ensure persistence
    if (storage?.isUnlocked()) {
      storage.flushData();
    }
    await storage!.lockSession();
    return { success: true };
  } catch (err) {
    log(`Lock error: ${err}`);
    return { success: false };
  }
}

// ============================================================
// SQL EXECUTION
// ============================================================

interface ExecResult {
  success: boolean;
  columns?: string[];
  rows?: Record<string, unknown>[];
  error?: string;
}

// ============================================================
// FILE DATA ACCESS (for visualization)
// ============================================================

interface FileDataResult {
  success: boolean;
  data?: Uint8Array;
  size?: number;
  error?: string;
}

async function handleGetFileData(
  fileId: number,
  maxBytes = 65536
): Promise<FileDataResult> {
  if (!storage?.isInitialized()) {
    return { success: false, error: 'Storage not initialized' };
  }

  try {
    const fs = storage.getFileSystem();
    const size = fs.getSize(fileId as 0 | 1);
    const bytesToRead = Math.min(size, maxBytes);
    const data = fs.read(fileId as 0 | 1, 0, bytesToRead);

    return { success: true, data, size };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleExec(sql: string): Promise<ExecResult> {
  if (!storage?.isUnlocked()) {
    return { success: false, error: 'Session not unlocked' };
  }

  try {
    const result = await storage.sql(sql);

    // NOTE: We don't auto-flush after every write because:
    // 1. Flush can be slow (writes Pareto padding - up to 600MB in prod)
    // 2. Flush happens automatically on lock
    // 3. User can manually flush if needed

    // Convert array rows to objects with column names as keys
    const rowsAsObjects = result.rows.map(row => {
      const obj: Record<string, unknown> = {};
      result.columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });

    return { success: true, columns: result.columns, rows: rowsAsObjects };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================

interface WorkerMessage {
  type: string;
  id?: number;
  password?: string;
  sql?: string;
  fileId?: number;
  maxBytes?: number;
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { type, id, password, sql } = e.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;

  switch (type) {
    case 'init':
      result = await initialize();
      break;

    case 'create-session':
      if (!password) {
        result = { success: false, error: 'Password required' };
      } else {
        result = await handleCreateSession(password);
      }
      break;

    case 'unlock-session':
      if (!password) {
        result = { success: false, error: 'Password required' };
      } else {
        result = await handleUnlockSession(password);
      }
      break;

    case 'lock-session':
      result = await handleLockSession();
      break;

    case 'exec':
      if (!sql) {
        result = { success: false, error: 'SQL required' };
      } else {
        result = await handleExec(sql);
      }
      break;

    case 'status':
      result = {
        initialized: storage?.isInitialized() ?? false,
        sessionUnlocked: storage?.isUnlocked() ?? false,
        dbOpen: storage?.isDatabaseOpen() ?? false,
        vfsStats: storage?.getVfsStats() ?? null,
      };
      break;

    case 'cleanup':
      // Explicit cleanup - flush and close everything
      try {
        if (storage?.isUnlocked()) {
          storage.flushData();
          await storage.lockSession();
        }
        if (storage) {
          await storage.close();
          storage = null;
        }
        result = { success: true };
        log('Cleanup complete');
      } catch (err) {
        result = { success: false, error: String(err) };
        log(`Cleanup error: ${err}`);
      }
      break;

    case 'get-file-data':
      result = await handleGetFileData(
        e.data.fileId ?? 0,
        e.data.maxBytes ?? 65536
      );
      break;

    default:
      result = { success: false, error: `Unknown message type: ${type}` };
  }

  self.postMessage({ type: `${type}-result`, id, ...result });
};

// Cleanup on worker termination (page unload)
self.addEventListener('beforeunload', () => {
  log('Worker unloading - cleaning up...');
  if (storage?.isUnlocked()) {
    try {
      // Flush and lock session before termination
      storage.flushData();
      storage.lockSession();
    } catch (err) {
      log(`Cleanup error: ${err}`);
    }
  }
});

log('Storage worker loaded');
