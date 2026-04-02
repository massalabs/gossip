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
  initSecureStorage,
  idbHasData as wasmIdbHasData,
  provisionStorage,
  allocateSession,
  unlockSession,
  lockSession,
  execute,
  closeDatabase,
  coverTrafficTick,
  flushEncrypted,
} from '../assets/generated/wasm-secureStorage/secureStorage.js';

// Backend is always IDB now (OPFS+WAL removed).

const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

// Periodic flush timer — persists dirty encrypted blocks to IDB.
// Fire-and-forget: don't block the worker message loop on IDB writes.
// Data is safe in memory; IDB is just durability.
const FLUSH_INTERVAL_MS = 2000;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let dirty = false;

function markDirty() {
  dirty = true;
}

function startFlushTimer() {
  stopFlushTimer();
  flushTimer = setInterval(() => {
    if (dirty) {
      dirty = false;
      // Fire-and-forget: don't await. Worker stays responsive.
      flushEncrypted().catch(() => {
        dirty = true; // Retry on next interval.
      });
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
        const backend = 'idb';

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

        // Check if IDB has existing data (= previously provisioned).
        const needsUnlock = await wasmIdbHasData();

        if (!needsUnlock) {
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
        // Only mark dirty on writes, not reads
        const isWrite =
          /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(
            sql
          );
        if (isWrite) markDirty();
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
