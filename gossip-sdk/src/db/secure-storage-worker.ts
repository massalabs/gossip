/**
 * Web worker that hosts the secure-storage WASM module and runs SQL on
 * the embedded sqlite-wasm-rs SQLite, routing main DB I/O through our
 * encrypted VFS (implemented in Rust).
 *
 * Single binary: wa-sqlite is no longer used on the secure-storage path
 * because sqlite-wasm-rs ships SQLite inside the same WASM module as our
 * crypto + custom VFS. The worker is a thin Comlink wrapper around the
 * Rust exports — there is no JS-side SQLite glue.
 *
 * Exposed via Comlink as a {@link SecureStorageWorkerApi} instance. The
 * main thread wraps it with `Comlink.wrap()` to obtain a typed proxy.
 */

import * as Comlink from 'comlink';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — generated WASM module path resolved at build time
import init, {
  initSecureStorage,
  idbHasData as wasmIdbHasData,
  provisionStorage,
  allocateSession,
  unlockSession,
  lockSession,
  coverTrafficTick,
  flushEncrypted,
  openDatabase,
  closeDatabase,
  execSql,
  initThreadPool,
  writeNamespaceData,
  readNamespaceData,
  namespaceDataLength,
  clearNamespace,
} from '../assets/generated/wasm-secureStorage/secureStorage.js';

/**
 * Namespace identifier for the SQLite VFS data stream. Mirrors the
 * `SQL_NAMESPACE` constant in the Rust crate. Cover-traffic ticks driven
 * by the worker default to this namespace.
 */
export const SQL_NAMESPACE = 0;

/**
 * Namespace where the SDK persists the encrypted session blob (the WASM
 * `SessionModule` snapshot). Lives on a stream of its own so the persist
 * doesn't pay the SQL/Drizzle/page-management cost on every save.
 */
export const SESSION_BLOB_NAMESPACE = 1;

/**
 * Number of rayon worker threads. Capped at SESSION_COUNT (3) since the
 * crypto parallelism is per-session-slot and additional threads sit idle.
 */
const RAYON_THREADS = Math.min(3, navigator.hardwareConcurrency || 3);

/** Minimum delay between cover traffic ticks (ms). */
const COVER_TRAFFIC_MIN_INTERVAL_MS = 10_000;
/** Maximum delay between cover traffic ticks (ms). */
const COVER_TRAFFIC_MAX_INTERVAL_MS = 30_000;
/** Namespaces that cover traffic must rerandomize each tick. */
const COVER_TRAFFIC_NAMESPACES = [
  SQL_NAMESPACE,
  SESSION_BLOB_NAMESPACE,
] as const;

export interface InitResult {
  needsUnlock: boolean;
  backend: 'idb';
}

export interface ExecResult {
  rows: unknown[][];
  lastInsertRowId: number;
}

function randomCoverInterval(): number {
  return (
    COVER_TRAFFIC_MIN_INTERVAL_MS +
    Math.random() *
      (COVER_TRAFFIC_MAX_INTERVAL_MS - COVER_TRAFFIC_MIN_INTERVAL_MS)
  );
}

class SecureStorageWorkerApi {
  private coverTimerId: ReturnType<typeof setTimeout> | null = null;

  private startCoverTraffic(): void {
    this.stopCoverTraffic();
    const tick = async () => {
      for (const ns of COVER_TRAFFIC_NAMESPACES) {
        coverTrafficTick(ns);
      }
      await flushEncrypted();
      this.coverTimerId = setTimeout(tick, randomCoverInterval());
    };
    this.coverTimerId = setTimeout(tick, randomCoverInterval());
  }

  private stopCoverTraffic(): void {
    if (this.coverTimerId !== null) {
      clearTimeout(this.coverTimerId);
      this.coverTimerId = null;
    }
  }

  async init(
    domain: string,
    secureStorageWasmUrl?: string
  ): Promise<InitResult> {
    await init(
      secureStorageWasmUrl
        ? { module_or_path: secureStorageWasmUrl }
        : undefined
    );
    // Spin up the rayon Web Worker pool. Each worker is a
    // SharedArrayBuffer-backed wasm thread, which requires the page to be
    // cross-origin isolated (COOP=same-origin + COEP=require-corp). When
    // not isolated (e.g. in test runners that don't set those headers),
    // we skip pool initialization and rayon falls back to single-thread
    // execution — same Rust code, just no parallelism.
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      await initThreadPool(RAYON_THREADS);
    }
    await initSecureStorage(domain, 'idb');
    const needsUnlock = await wasmIdbHasData();
    if (!needsUnlock) {
      provisionStorage();
    }
    this.startCoverTraffic();
    return { needsUnlock, backend: 'idb' };
  }

  provision(): void {
    provisionStorage();
  }

  async allocate(slot: number, password: Uint8Array): Promise<void> {
    allocateSession(slot, password);
    password.fill(0);
    await flushEncrypted();
    openDatabase();
  }

  async unlock(password: Uint8Array): Promise<boolean> {
    const ok = unlockSession(password);
    password.fill(0);
    if (ok) {
      openDatabase();
    }
    return ok;
  }

  async lock(): Promise<void> {
    closeDatabase();
    await flushEncrypted();
    lockSession();
  }

  async exec(sql: string, params: unknown[] = []): Promise<ExecResult> {
    const result = execSql(sql, params);
    const rows = result.rows as unknown[][];
    const lastInsertRowId = result.lastInsertRowId;
    result.free();

    if (
      /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|BEGIN|COMMIT|ROLLBACK)/i.test(
        sql
      )
    ) {
      await flushEncrypted();
    }

    return { rows, lastInsertRowId };
  }

  cover(namespace: number = SQL_NAMESPACE): void {
    coverTrafficTick(namespace);
  }

  // ── Generic namespace data storage ─────────────────────────────
  //
  // Each (session, namespace) pair owns an independent block stream
  // managed by the secureStorage Rust core. The SQLite VFS uses
  // SQL_NAMESPACE; the SDK can use any other namespace byte to store
  // arbitrary blobs without paying SQLite/Drizzle/page-management cost.

  async writeNamespaceData(
    namespace: number,
    offset: number,
    data: Uint8Array
  ): Promise<void> {
    writeNamespaceData(namespace, offset, data);
    await flushEncrypted();
  }

  readNamespaceData(
    namespace: number,
    offset: number,
    len: number
  ): Uint8Array {
    return readNamespaceData(namespace, offset, len);
  }

  namespaceDataLength(namespace: number): number {
    return namespaceDataLength(namespace);
  }

  async clearNamespace(namespace: number): Promise<void> {
    clearNamespace(namespace);
    await flushEncrypted();
  }

  async flush(): Promise<void> {
    await flushEncrypted();
  }

  async close(): Promise<void> {
    this.stopCoverTraffic();
    closeDatabase();
    await flushEncrypted();
  }
}

export type SecureStorageWorkerProxy = Comlink.Remote<SecureStorageWorkerApi>;

Comlink.expose(new SecureStorageWorkerApi());
