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
        const { domain, backend, wasmUrl } = e.data;
        const moduleArg: Record<string, unknown> = {};
        if (wasmUrl) moduleArg.locateFile = () => wasmUrl;
        await init(moduleArg);
        await initBordercrypt(domain, backend);

        // Check if IDB has existing data (= needs unlock) or is fresh (= needs onboarding).
        let needsUnlock = false;
        if (backend === 'idb') {
          needsUnlock = await idbHasData();
        }
        // For OPFS, we'd check file sizes, but that's handled inside WASM.

        if (!needsUnlock) {
          // First launch: provision empty slots so allocate can work.
          provisionStorage();
        }
        post({ id, type: 'init-result', needsUnlock });
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
        allocateSession(slot, pw);
        pw.fill(0);
        // Flush immediately so IDB has data before any lock/reload.
        await flushEncrypted();
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
