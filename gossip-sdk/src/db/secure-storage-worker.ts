import { logger } from '../utils/logs.js';
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
  destroySession,
} from '../assets/generated/wasm-secureStorage/secureStorage.js';

import {
  SQL_NAMESPACE,
  SESSION_BLOB_NAMESPACE,
  COVER_TRAFFIC_NAMESPACES,
} from './secure-storage-namespaces.js';
export { SQL_NAMESPACE, SESSION_BLOB_NAMESPACE };

/**
 * Number of rayon worker threads. Capped at SESSION_COUNT (3) since the
 * crypto parallelism is per-session-slot and additional threads sit idle.
 */
const RAYON_THREADS = Math.min(3, navigator.hardwareConcurrency || 3);

/** Minimum delay between cover traffic ticks (ms). */
const COVER_TRAFFIC_MIN_INTERVAL_MS = 10_000;
/** Maximum delay between cover traffic ticks (ms). */
const COVER_TRAFFIC_MAX_INTERVAL_MS = 30_000;

export interface InitResult {
  /** True when IDB already holds keypairs from a prior run. */
  hasExistingData: boolean;
  backend: 'idb';
}

export interface ExecResult {
  rows: unknown[][];
  lastInsertRowId: number;
}

function randomCoverInterval(): number {
  // crypto.getRandomValues so a weak Math.random stream cannot predict
  // tick timing and correlate cover with real activity (PD).
  const u32 = crypto.getRandomValues(new Uint32Array(1))[0];
  const range = COVER_TRAFFIC_MAX_INTERVAL_MS - COVER_TRAFFIC_MIN_INTERVAL_MS;
  return COVER_TRAFFIC_MIN_INTERVAL_MS + (u32 % range);
}

export class SecureStorageWorkerApi {
  private coverTimerId: ReturnType<typeof setTimeout> | null = null;
  private coverTickInProgress = false;

  /**
   * Run one cover-traffic pass over every cover namespace and flush.
   * Each `coverTrafficTick(ns)` picks a random block index and
   * rerandomizes it across ALL session slots (real + dummies) in
   * shuffled order, see `lifecycle::cover_traffic_tick` in the Rust
   * core; the TS side just drives the schedule.
   *
   * Re-entrancy guard: a second call while the first is still in
   * `flushEncrypted()` silently no-ops (defense in depth; with the
   * single-shot setTimeout used by `startCoverTraffic` the recurring
   * tick cannot overlap with itself, but the explicit `cover()` RPC
   * could be called concurrently by the SDK consumer).
   *
   * PD-critical: errors are logged at `logger.debug` only. Logging
   * at error level fingerprinted "secure-storage user with persistent
   * storage failure" in console history. Errors do not change the
   * scheduling cadence either: backing off would itself leak ("cover
   * slows down => user has problems with their slot"), and stopping
   * after N retries would resolve the most damaging PD ambiguity
   * ("user exists at all"). The schedule keeps the same 10-30s random
   * interval regardless of success/failure.
   */
  private async runCoverTick(): Promise<void> {
    if (this.coverTickInProgress) return;
    this.coverTickInProgress = true;
    try {
      for (const ns of COVER_TRAFFIC_NAMESPACES) {
        coverTrafficTick(ns);
      }
      await flushEncrypted();
    } catch (err) {
      logger.debug('[SecureStorage] cover traffic tick failed', err);
    } finally {
      this.coverTickInProgress = false;
    }
  }

  private startCoverTraffic(): void {
    // Cancel any pending timer before re-arming, so a stale `init()`
    // call (or a future caller invoking startCoverTraffic twice) does
    // not leave two concurrent schedules running.
    this.stopCoverTraffic();
    const tick = async () => {
      await this.runCoverTick();
      // Only re-arm if stopCoverTraffic() didn't run during the tick.
      if (this.coverTimerId !== null) {
        this.coverTimerId = setTimeout(tick, randomCoverInterval());
      }
    };
    this.coverTimerId = setTimeout(tick, randomCoverInterval());
  }

  private stopCoverTraffic(): void {
    if (this.coverTimerId !== null) {
      clearTimeout(this.coverTimerId);
      this.coverTimerId = null;
    }
  }

  /**
   * Initialize the secure-storage worker. Runs one cover-traffic pass
   * synchronously before returning so the first 10-30s window after
   * init does not have real writes happening with no cover activity
   * (otherwise an observer would see a gap of real-only writes in the
   * fresh-startup window). After the synchronous first tick, recurring
   * ticks are scheduled at random 10-30s intervals.
   *
   * The recurring schedule never backs off and never stops, even on
   * persistent failure: see `runCoverTick` for the PD rationale.
   */
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
    // `crossOriginIsolated` is always defined on Window/Worker globals,
    // so the condition is purely a boolean check.
    if (crossOriginIsolated) {
      await initThreadPool(RAYON_THREADS);
    }
    await initSecureStorage(domain, 'idb');
    const hasExistingData = await wasmIdbHasData();
    if (!hasExistingData) {
      provisionStorage();
    }
    // Cover traffic is started unconditionally, including when the
    // storage is locked. `cover_traffic_tick` only needs public keys
    // (see lifecycle.rs: "Does not require an unlocked session"); gating
    // it on the locked state would create a PD distinguisher (absence
    // of cover writes during the locked window => "user exists, locked").
    // Run one tick synchronously so the first-tick gap (10-30s) does
    // not expose real writes that may happen right after init returns.
    await this.runCoverTick();
    this.startCoverTraffic();
    return { hasExistingData, backend: 'idb' };
  }

  provision(): void {
    provisionStorage();
  }

  /**
   * Open a brand-new encrypted session in `slot`. MUST be awaited:
   * the WASM allocate runs synchronously, the password buffer is
   * zeroed synchronously, but encrypted blocks are durable to IDB
   * only after `flushEncrypted()` resolves. The caller (sqlite.ts)
   * then runs migrations through `exec()`, which assumes the
   * underlying DB is open and durable.
   */
  async create(slot: number, password: Uint8Array): Promise<void> {
    try {
      allocateSession(slot, password);
    } finally {
      password.fill(0);
    }
    await flushEncrypted();
    openDatabase();
  }

  /**
   * Try to unlock the existing slot for `password`. Returns `true`
   * on success (DB opened, ready for queries) and `false` on a
   * wrong password (no state change). MUST be awaited: the WASM
   * unlock runs synchronously and returns the boolean, but if
   * unlock succeeded the database open call follows; the caller
   * cannot rely on the DB being usable until the returned promise
   * resolves.
   */
  async unlock(password: Uint8Array): Promise<boolean> {
    let ok: boolean;
    try {
      ok = unlockSession(password);
    } finally {
      password.fill(0);
    }
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

  /**
   * Permanently destroy the data of the currently unlocked slot.
   *
   * Sequence (mirrors `lock` but with the wipe in the middle):
   *   1. `closeDatabase()` — drops the SafeDb; SQLite's xWrite on close
   *      flushes any dirty pages into IdbBlockStorage's pending state
   *      under the still-current keypair.
   *   2. `destroySession(namespaces)` — Rust writes a fresh dummy
   *      keypair, truncates the slot's blockstreams, and re-pads them
   *      with cover blocks under the new PK. All writes accumulate in
   *      pending state.
   *   3. `flushEncrypted()` — single async commit to IDB. Process
   *      crash before this resolves rolls everything back: the slot
   *      is left exactly as it was, the user retries.
   *
   * After this resolves, the old secret no longer unlocks the slot
   * and the namespaces no longer hold the user's encrypted data.
   */
  async destroy(namespaces: Uint8Array): Promise<void> {
    closeDatabase();
    destroySession(namespaces);
    await flushEncrypted();
  }

  /**
   * Execute a statement. Durability semantics:
   *   * When `inTransaction` is true, skip the flush on every inner
   *     statement. The caller is responsible for flushing once on COMMIT
   *     (we detect it below) or by calling `flush()` explicitly.
   *   * Outside a transaction, flush on any write statement. Schema
   *     mutations (`CREATE/DROP/ALTER`), mutations via CTE (`WITH … INSERT`)
   *     and `REPLACE` are all covered.
   *
   * `BEGIN` and `ROLLBACK` do NOT flush — neither boundary has new
   * durable state to preserve (BEGIN opens a txn that hasn't written
   * yet, ROLLBACK discards what was buffered), so a flush there would
   * just be wasted IO and would also break the batching that the
   * COMMIT-driven flush relies on.
   */
  async exec(
    sql: string,
    params: unknown[] = [],
    inTransaction: boolean = false
  ): Promise<ExecResult> {
    const result = execSql(sql, params);
    const rows = result.rows as unknown[][];
    const lastInsertRowId = result.lastInsertRowId;
    result.free();

    const trimmed = sql.trimStart();
    const isCommit = /^COMMIT\b/i.test(trimmed);
    if (isCommit) {
      await flushEncrypted();
    } else if (!inTransaction) {
      if (
        /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH|VACUUM|PRAGMA)\b/i.test(
          trimmed
        )
      ) {
        await flushEncrypted();
      }
    }

    return { rows, lastInsertRowId };
  }

  /**
   * Drive cover traffic on a single namespace. Defaults to rerandomizing
   * every namespace participating in the cover-traffic rotation so callers
   * don't accidentally leave a namespace untouched (see PD review).
   */
  cover(namespace?: number): void {
    if (namespace === undefined) {
      for (const ns of COVER_TRAFFIC_NAMESPACES) {
        coverTrafficTick(ns);
      }
    } else {
      coverTrafficTick(namespace);
    }
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

  /**
   * Atomic clear+write equivalent of the native plugin's
   * `replaceNamespaceData`. The two wasm calls below mutate in-memory
   * state synchronously; only the trailing `flushEncrypted` writes
   * to IndexedDB, batching both ops into a single IDB transaction.
   * That preserves atomicity equivalent to the native single-fsync
   * path: a process kill before the flush leaves IDB untouched, a
   * crash mid-flush gets rolled back by IDB itself, and a successful
   * flush lands the new blob with the previous content fully replaced.
   *
   * Without this proxy method, the caller had to chain `clearNamespace`
   * and `writeNamespaceData` from `sqlite.ts`, each producing its own
   * IDB transaction; a kill between them left the namespace empty and
   * the session blob silently lost.
   */
  async replaceNamespaceData(
    namespace: number,
    data: Uint8Array
  ): Promise<void> {
    clearNamespace(namespace);
    writeNamespaceData(namespace, 0, data);
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

// INTERNAL - do not re-export from the SDK package entry point. Leaking
// this type would expose `Comlink.Remote<T>` as part of the public API
// and tie consumers to the worker's RPC shape.
export type SecureStorageWorkerProxy = Comlink.Remote<SecureStorageWorkerApi>;

Comlink.expose(new SecureStorageWorkerApi());
