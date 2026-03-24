/**
 * Secure Storage Web Worker — thin relay to bordercrypt WASM.
 *
 * All storage logic (VFS, encryption, SQLite, IDB/OPFS persistence)
 * lives inside the WASM module. This worker is a message router.
 *
 * Messages:
 *   init       → load WASM, init bordercrypt + database
 *   exec       → SQL execution (prepare/bind/step/finalize in WASM)
 *   provision  → provision 5 session slots
 *   allocate   → allocate session in slot, auto-unlock, open SQLite
 *   unlock     → unlock session by password, open SQLite
 *   lock       → flush + close SQLite + zeroize keys
 *   cover      → one round of cover traffic
 *   flush      → explicit flush to backing store
 *   close      → close database
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — generated WASM module path resolved at build time
import init, {
  initBordercrypt,
  provisionStorage,
  allocateSession,
  unlockSession,
  lockSession,
  execute,
  closeDatabase,
  coverTrafficTick,
  flushEncrypted,
} from '../assets/generated/wasm-bordercrypt/bordercrypt.js';

/** Check if the bordercrypt IDB store has any data (= previously provisioned). */
async function idbHasData(): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('bordercrypt-storage', 1);
      req.onupgradeneeded = () => {
        // DB just created → no data.
        resolve(false);
        req.result.close();
      };
      req.onsuccess = () => {
        const db = req.result;
        try {
          const tx = db.transaction('data', 'readonly');
          const store = tx.objectStore('data');
          const countReq = store.count();
          countReq.onsuccess = () => resolve(countReq.result > 0);
          countReq.onerror = () => resolve(false);
        } catch {
          resolve(false);
        } finally {
          db.close();
        }
      };
      req.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Check if OPFS secureStorage directory has any session data. */
async function opfsHasData(): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('secureStorage', {
      create: false,
    });
    // Check if any session block file has non-zero size.
    for (let i = 0; i < 5; i++) {
      try {
        const fh = await dir.getFileHandle(`session_${i}.blocks`, {
          create: false,
        });
        const file = await fh.getFile();
        if (file.size > 0) return true;
      } catch {
        // File doesn't exist → no data for this session.
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Detect best available backend: prefer opfs-wal, fall back to idb. */
async function detectBackend(): Promise<string> {
  try {
    await navigator.storage.getDirectory();
    return 'opfs-wal';
  } catch {
    return 'idb';
  }
}

const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

// Periodic flush timer — persists encrypted blocks to IDB every 2s.
// synchronous=OFF means SQLite never calls xSync, so this is the only
// automatic persistence path. Explicit flushes on lock/background also exist.
const FLUSH_INTERVAL_MS = 2000;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let dirty = false;

function markDirty() {
  dirty = true;
}

function startFlushTimer() {
  stopFlushTimer();
  flushTimer = setInterval(async () => {
    if (dirty) {
      dirty = false;
      try {
        await flushEncrypted();
      } catch {
        // Flush failed — will retry on next interval.
        dirty = true;
      }
    }
  }, FLUSH_INTERVAL_MS);
}

function stopFlushTimer() {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// Sequential message queue (same pattern as sqlite-worker.ts)
const queue: Array<{ e: MessageEvent; resolve: () => void }> = [];
let processing = false;

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  while (queue.length > 0) {
    const { e, resolve } = queue.shift()!;
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
        const { domain, wasmUrl } = e.data;
        // Auto-detect best backend if not explicitly provided.
        const backend: string = e.data.backend ?? (await detectBackend());
        console.log('[SecureStorageWorker] backend:', backend);

        // Check OPFS data BEFORE init — SyncAccessHandle locks prevent
        // getFile() from working after initSecureStorage opens handles.
        let needsUnlock = false;
        if (backend === 'opfs-wal' || backend === 'opfs') {
          needsUnlock = await opfsHasData();
        }

        const moduleArg: Record<string, unknown> = {};
        if (wasmUrl) moduleArg.locateFile = () => wasmUrl;
        let t0 = performance.now();
        await init(moduleArg);
        console.log(
          '[SecureStorageWorker] wasm init:',
          (performance.now() - t0) | 0,
          'ms'
        );
        t0 = performance.now();
        await initSecureStorage(domain, backend);
        console.log(
          '[SecureStorageWorker] initSecureStorage:',
          (performance.now() - t0) | 0,
          'ms'
        );

        // IDB check can happen after init (no locking issue).
        if (backend === 'idb') {
          needsUnlock = await idbHasData();
        }

        if (!needsUnlock) {
          // First launch: provision empty slots so allocate can work.
          t0 = performance.now();
          provisionStorage();
          console.log(
            '[SecureStorageWorker] provision:',
            (performance.now() - t0) | 0,
            'ms'
          );
        }
        console.log('[SecureStorageWorker] needsUnlock:', needsUnlock);
        post({ id, type: 'init-result', needsUnlock, backend });
        break;
      }

      case 'provision': {
        provisionStorage();
        post({ id, type: 'provision-result' });
        break;
      }

      case 'allocate': {
        const { slot, password } = e.data;
        const pw = new Uint8Array(password);
        let t1 = performance.now();
        allocateSession(slot, pw);
        console.log(
          '[SecureStorageWorker] allocate:',
          (performance.now() - t1) | 0,
          'ms'
        );
        pw.fill(0);
        // Flush immediately so backing store has data before any lock/reload.
        t1 = performance.now();
        await flushEncrypted();
        console.log(
          '[SecureStorageWorker] flush:',
          (performance.now() - t1) | 0,
          'ms'
        );
        startFlushTimer();
        post({ id, type: 'allocate-result' });
        break;
      }

      case 'unlock': {
        const { password } = e.data;
        const pw = new Uint8Array(password);
        const ok = unlockSession(pw);
        pw.fill(0);
        if (ok) startFlushTimer();
        post({ id, type: 'unlock-result', ok });
        break;
      }

      case 'lock': {
        stopFlushTimer();
        await lockSession();
        post({ id, type: 'lock-result' });
        break;
      }

      case 'exec': {
        const { sql, params } = e.data;
        const result = execute(sql, params ?? []);
        markDirty();
        post({
          id,
          type: 'exec-result',
          rows: result.rows,
          columns: result.columns,
          lastInsertRowId: result.lastInsertRowId,
          changes: result.changes,
        });
        break;
      }

      case 'cover': {
        coverTrafficTick();
        post({ id, type: 'cover-result' });
        break;
      }

      case 'flush': {
        await flushEncrypted();
        post({ id, type: 'flush-result' });
        break;
      }

      case 'close': {
        stopFlushTimer();
        closeDatabase();
        post({ id, type: 'close-result' });
        break;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[SecureStorageWorker] Error:', type, message, err);
    post({ id, type: 'error', message });
  }
}

addEventListener('message', (e: MessageEvent) => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  queue.push({ e, resolve });
  promise.then(() => processQueue());
  processQueue();
});
