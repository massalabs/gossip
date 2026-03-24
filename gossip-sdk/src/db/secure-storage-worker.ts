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

const post: (data: unknown) => void = (
  globalThis as unknown as { postMessage(data: unknown): void }
).postMessage.bind(globalThis);

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
        post({ id, type: 'init-result' });
        break;
      }

      case 'provision': {
        provisionStorage();
        post({ id, type: 'provision-result' });
        break;
      }

      case 'allocate': {
        const { slot, password } = e.data;
        allocateSession(slot, new Uint8Array(password));
        post({ id, type: 'allocate-result' });
        break;
      }

      case 'unlock': {
        const { password } = e.data;
        const ok = unlockSession(new Uint8Array(password));
        post({ id, type: 'unlock-result', ok });
        break;
      }

      case 'lock': {
        await lockSession();
        post({ id, type: 'lock-result' });
        break;
      }

      case 'exec': {
        const { sql, params } = e.data;
        const result = execute(sql, params ?? []);
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
        closeDatabase();
        post({ id, type: 'close-result' });
        break;
      }
    }
  } catch (err) {
    post({ id, type: 'error', message: (err as Error).message });
  }
}

addEventListener('message', (e: MessageEvent) => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  queue.push({ e, resolve });
  promise.then(() => processQueue());
  processQueue();
});
