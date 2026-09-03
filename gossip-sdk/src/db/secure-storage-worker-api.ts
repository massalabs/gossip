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
import { SECURE_STORAGE_RECOVERY_REQUIRED } from './secure-storage-errors.js';
import {
  classifyStatement,
  TOP_LEVEL_SAVEPOINT_ERROR,
} from './sql-statement.js';
import {
  PortableWebExport,
  PortableWebImport,
  accountGenerationEpochWeb,
  accountGenerationMetadataWeb,
  accountGenerationStateWeb,
  initializeEmptyAccountGenerationWeb,
  installOnboardingGenerationWeb,
  type AccountGenerationState,
} from './secure-storage-portable-web.js';

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
  reloadDurableStorage,
  resetSqlDatabaseToDurable,
  openDatabase,
  closeDatabase,
  execSql,
  initThreadPool,
  writeNamespaceData,
  readNamespaceData,
  namespaceDataLength,
  clearNamespace,
  destroySession,
  verifyStorageGeneration,
  validatePortableKeypair,
  validatePortableBlock,
  beginCandidatePreview,
  beginOnboardingCandidate as beginOnboardingCandidateWasm,
  exportOnboardingCandidate,
  activateOnboardingGeneration,
  endOnboardingCandidate,
  appendCandidatePreviewBlock,
  finishCandidatePreview,
  queryCandidatePreview,
  endCandidatePreview,
  endOuterMigration,
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
const STORAGE_INSTALLATION_FENCE_LOCK_NAME =
  'gossip-secure-storage-generation-install';

export interface ImportedAccountPreview {
  userId: string;
  username: string;
  avatar: string | null;
  createdAtMs: number;
}

export interface InitResult {
  /** True when IDB already holds physical secure-storage records. */
  hasExistingData: boolean;
  accountGenerationState: AccountGenerationState;
  accountGenerationEpoch: string | null;
  backend: 'idb';
}

export interface ExecResult {
  rows: unknown[][];
  lastInsertRowId: number;
}

interface QueuedCoverOperation {
  kind: 'cover';
  resolve: () => void;
  reject: (reason: unknown) => void;
}

interface QueuedLifecycleOperation {
  kind: 'lifecycle';
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

interface QueuedSqlOperation {
  kind: 'sql';
  continuesTransaction: boolean;
  operation: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

type QueuedStorageOperation =
  | QueuedCoverOperation
  | QueuedLifecycleOperation
  | QueuedSqlOperation;

function errorWithCause(message: string, cause: unknown): Error {
  const error = new Error(message) as Error & { cause?: unknown };
  error.cause = cause;
  return error;
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
  protected coverRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private operationQueue: QueuedStorageOperation[] = [];
  private operationPumpActive = false;
  private durableRecoveryRequired = false;
  private durableRecoveryPromise: Promise<void> | null = null;
  private closeRequested = false;
  private coverOnlyMode = false;
  private closePromise: Promise<void> | null = null;
  private sqlTransactionActive = false;
  private sqlTransactionPoisoned = false;
  private sqlRecoveryPromise: Promise<void> | null = null;
  private portableExport: PortableWebExport | null = null;
  private portableImport: PortableWebImport | null = null;
  private portableExportStarting = false;
  private portableExportStartPromise: Promise<{ totalBytes: number }> | null =
    null;
  private portableExportStartAbort: AbortController | null = null;
  private portableImportStarting = false;
  private portableImportStartPromise: Promise<void> | null = null;
  private portableImportStartAbort: AbortController | null = null;
  private portablePreviewTail: Promise<void> = Promise.resolve();
  private portablePreviewRecoveryError: unknown = null;
  private generationStale = false;
  private domain = '';

  private isGenerationMismatch(error: unknown): boolean {
    return String(error).includes('secure-storage generation changed');
  }

  private isUnsupportedStorageVersion(error: unknown): boolean {
    const candidate = error as { code?: unknown; name?: unknown } | null;
    return (
      candidate?.code === 'UNSUPPORTED_VERSION' ||
      candidate?.name === 'UNSUPPORTED_VERSION'
    );
  }

  private markGenerationStale(): void {
    this.generationStale = true;
    this.closeRequested = true;
    this.coverOnlyMode = false;
    this.stopCoverTraffic();
    if (this.coverRetryTimerId !== null) {
      clearTimeout(this.coverRetryTimerId);
      this.coverRetryTimerId = null;
    }
  }

  private rejectQueuedForStaleGeneration(): void {
    const error = new Error(
      'Secure-storage generation changed; reload required'
    );
    for (const queued of this.operationQueue.splice(0)) {
      if (queued.kind === 'cover') queued.resolve();
      else queued.reject(error);
    }
  }

  private async flushEncryptedFenced(signal?: AbortSignal): Promise<void> {
    // Candidate installation owns this same exclusive Web Lock only for the
    // active-generation switch. Every current worker therefore checks and
    // commits its captured generation entirely before or after that switch,
    // while long destination streaming never blocks unrelated durable writes.
    try {
      if (!navigator.locks) {
        await flushEncrypted();
        return;
      }
      await navigator.locks.request(
        STORAGE_INSTALLATION_FENCE_LOCK_NAME,
        { mode: 'exclusive', signal },
        async () => flushEncrypted()
      );
    } catch (error) {
      if (this.isGenerationMismatch(error)) this.markGenerationStale();
      throw error;
    }
  }

  private async verifyGenerationFenced<T>(operation: () => T): Promise<T> {
    try {
      if (!navigator.locks) {
        await verifyStorageGeneration();
        return operation();
      }
      return await navigator.locks.request(
        STORAGE_INSTALLATION_FENCE_LOCK_NAME,
        { mode: 'exclusive' },
        async () => {
          await verifyStorageGeneration();
          return operation();
        }
      );
    } catch (error) {
      if (this.isGenerationMismatch(error)) this.markGenerationStale();
      throw error;
    }
  }

  private async recoverDurableStorage(): Promise<void> {
    if (this.durableRecoveryPromise) {
      await this.durableRecoveryPromise;
      return;
    }

    const recovery = (async () => {
      await reloadDurableStorage();
      this.durableRecoveryRequired = false;
    })();
    this.durableRecoveryPromise = recovery;
    try {
      await recovery;
    } catch (error) {
      if (this.isGenerationMismatch(error)) this.markGenerationStale();
      throw error;
    } finally {
      if (this.durableRecoveryPromise === recovery) {
        this.durableRecoveryPromise = null;
      }
    }
  }

  private async recoverPoisonedSqlTransaction(): Promise<void> {
    if (this.sqlRecoveryPromise) {
      await this.sqlRecoveryPromise;
      return;
    }

    const recovery = (async () => {
      await resetSqlDatabaseToDurable();
      this.sqlTransactionPoisoned = false;
    })();
    this.sqlRecoveryPromise = recovery;
    try {
      await recovery;
    } catch (error) {
      if (this.isGenerationMismatch(error)) this.markGenerationStale();
      throw error;
    } finally {
      if (this.sqlRecoveryPromise === recovery) {
        this.sqlRecoveryPromise = null;
      }
    }
  }

  private async recoverRejectedSqlBoundary(
    operation: 'commit' | 'rollback' | 'mutation',
    operationError: unknown
  ): Promise<never> {
    this.sqlTransactionPoisoned = true;
    this.sqlTransactionActive = false;
    try {
      await this.recoverPoisonedSqlTransaction();
    } catch (recoveryError) {
      throw errorWithCause(
        `${SECURE_STORAGE_RECOVERY_REQUIRED} ${operation} failed and SQL state could not be reset`,
        { operationError, recoveryError }
      );
    }
    throw operationError;
  }

  private async ensureDurableStorageRecovered(): Promise<void> {
    if (this.sqlTransactionPoisoned) {
      await this.recoverPoisonedSqlTransaction();
    }
    if (!this.durableRecoveryRequired) return;
    await this.recoverDurableStorage();
    // A foreground recovery should not leave safe queued cover work waiting for
    // a stale retry timer. Resume the FIFO immediately after the durable reload.
    if (this.coverRetryTimerId !== null) {
      clearTimeout(this.coverRetryTimerId);
      this.coverRetryTimerId = null;
    }
    this.pumpOperationQueue();
  }

  private enqueueLifecycleOperation<T>(
    operation: () => Promise<T>,
    allowDuringClose = false,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closeRequested && !allowDuringClose) {
      return Promise.reject(new Error('Secure storage worker is closing'));
    }
    if (signal?.aborted) {
      return Promise.reject(
        new DOMException('Operation aborted', 'AbortError')
      );
    }
    return new Promise<T>((resolve, reject) => {
      const queued = {} as QueuedLifecycleOperation;
      const abort = () => {
        const index = this.operationQueue.indexOf(queued);
        if (index >= 0) {
          this.operationQueue.splice(index, 1);
          reject(new DOMException('Operation aborted', 'AbortError'));
        }
      };
      Object.assign(queued, {
        kind: 'lifecycle',
        operation: async () => {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted) {
            throw new DOMException('Operation aborted', 'AbortError');
          }
          return operation();
        },
        resolve: (value: unknown) => resolve(value as T),
        reject,
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.operationQueue.push(queued);
      this.pumpOperationQueue();
    });
  }

  private enqueueSqlOperation<T>(
    continuesTransaction: boolean,
    operation: () => Promise<T>
  ): Promise<T> {
    if (this.closeRequested && !continuesTransaction) {
      return Promise.reject(new Error('Secure storage worker is closing'));
    }
    return new Promise<T>((resolve, reject) => {
      this.operationQueue.push({
        kind: 'sql',
        continuesTransaction,
        operation,
        resolve: value => resolve(value as T),
        reject,
      });
      this.pumpOperationQueue();
    });
  }

  protected pumpOperationQueue(): void {
    if (this.operationPumpActive || this.coverRetryTimerId !== null) return;
    void this.drainOperationQueue();
  }

  private async drainOperationQueue(): Promise<void> {
    if (this.operationPumpActive) return;
    this.operationPumpActive = true;
    try {
      while (this.operationQueue.length > 0) {
        if (this.generationStale) {
          this.rejectQueuedForStaleGeneration();
          return;
        }
        let queuedIndex = 0;
        if (this.sqlTransactionActive) {
          queuedIndex = this.operationQueue.findIndex(
            queued => queued.kind === 'sql' && queued.continuesTransaction
          );
          // BEGIN already owns the durable boundary. Later cover/lifecycle
          // work stays queued while continuation SQL advances the same
          // transaction to COMMIT or ROLLBACK.
          if (queuedIndex === -1) return;
        }
        const queued = this.operationQueue[queuedIndex];
        if (queued.kind === 'cover') {
          let persisted: boolean;
          try {
            persisted = await this.runCoverPassAttempt();
          } catch (error) {
            if (this.isGenerationMismatch(error)) {
              this.markGenerationStale();
              this.rejectQueuedForStaleGeneration();
              return;
            }
            if (this.isUnsupportedStorageVersion(error)) {
              this.operationQueue.splice(queuedIndex, 1);
              queued.reject(error);
              this.closeRequested = true;
              for (const pending of this.operationQueue.splice(0)) {
                pending.reject(error);
              }
              return;
            }
            throw error;
          }
          if (!persisted) {
            this.scheduleCoverRetry();
            return;
          }
          this.operationQueue.shift();
          queued.resolve();
          continue;
        }

        this.operationQueue.splice(queuedIndex, 1);
        try {
          queued.resolve(await queued.operation());
        } catch (error) {
          queued.reject(error);
        }
      }
    } finally {
      this.operationPumpActive = false;
    }
  }

  private scheduleCoverRetry(): void {
    if (this.coverRetryTimerId !== null) return;
    this.coverRetryTimerId = setTimeout(() => {
      this.coverRetryTimerId = null;
      this.pumpOperationQueue();
    }, randomCoverInterval());
  }

  private async recoverRejectedLifecycleOperation(
    operation: 'create' | 'destroy',
    operationError: unknown
  ): Promise<never> {
    this.durableRecoveryRequired = true;
    try {
      await this.recoverDurableStorage();
    } catch (recoveryError) {
      throw errorWithCause(
        `${SECURE_STORAGE_RECOVERY_REQUIRED} ${operation} failed and durable state could not be reloaded`,
        { operationError, recoveryError }
      );
    }
    throw operationError;
  }

  /**
   * Attempt one full cover pass over every configured namespace and make it
   * durable. A failed pass remains at the head of the FIFO for a fresh retry at
   * the same random 10-30 second cadence. The VFS restores a rejected flush's
   * drained writes to pending state; retrying the complete pass avoids replacing
   * the shared cache while an unrelated SQL flush may still be in flight. The
   * request never resolves early or lets allocation overtake unpersisted work.
   *
   * Each Rust tick picks a random block index from the current namespace layout
   * and rerandomizes it across every session slot in shuffled order. Therefore
   * a pass queued during allocation runs only after the allocation commit and
   * naturally observes the post-allocation layout; no allocated slot is
   * special-cased in a way that would bias the cover distribution.
   *
   * PD-critical failures remain debug-only. Error-level logging or stopping
   * after a fixed retry count would reveal persistent storage failures and could
   * distinguish whether a real session exists.
   */
  private async runCoverPassAttempt(): Promise<boolean> {
    try {
      await this.ensureDurableStorageRecovered();
    } catch (error) {
      if (
        this.isUnsupportedStorageVersion(error) ||
        this.isGenerationMismatch(error) ||
        this.generationStale
      ) {
        throw error;
      }
      logger.debug('[SecureStorage] durable cover recovery failed', error);
      return false;
    }

    try {
      for (const ns of COVER_TRAFFIC_NAMESPACES) {
        coverTrafficTick(ns);
      }
      await this.flushEncryptedFenced();
      return true;
    } catch (error) {
      if (
        this.isUnsupportedStorageVersion(error) ||
        this.isGenerationMismatch(error)
      ) {
        throw error;
      }
      logger.debug('[SecureStorage] cover traffic tick failed', error);
      return false;
    }
  }

  private runCoverTick(skipWhenClosing = false): Promise<void> {
    if (this.closeRequested && !this.coverOnlyMode) {
      return skipWhenClosing
        ? Promise.resolve()
        : Promise.reject(new Error('Secure storage worker is closing'));
    }
    return new Promise<void>((resolve, reject) => {
      this.operationQueue.push({ kind: 'cover', resolve, reject });
      this.pumpOperationQueue();
    });
  }

  private startCoverTraffic(): void {
    // Cancel any pending timer before re-arming, so a stale `init()`
    // call (or a future caller invoking startCoverTraffic twice) does
    // not leave two concurrent schedules running.
    this.stopCoverTraffic();
    const tick = async () => {
      await this.runCoverTick(true);
      // Only re-arm if stopCoverTraffic() didn't run during the tick.
      if (this.coverTimerId !== null) {
        this.coverTimerId = setTimeout(tick, randomCoverInterval());
      }
    };
    this.coverTimerId = setTimeout(tick, randomCoverInterval());
  }

  protected stopCoverTraffic(): void {
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
    this.domain = domain;
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
    // Reclaim an export snapshot left by a terminated tab before normal app
    // admission. The Rust loader ignores spool-prefixed values, and this
    // cleanup takes the same cross-tab lease as active exporters so it never
    // deletes a live snapshot.
    await PortableWebExport.cleanupInterrupted();
    // The cleanup lease may have waited behind another tab's export while that
    // tab committed cover writes. Refresh the in-memory VFS cache from the
    // post-lease durable image before this worker admits cover or lifecycle work.
    await reloadDurableStorage();
    const hasExistingData = await wasmIdbHasData();
    const accountGeneration = hasExistingData
      ? await accountGenerationMetadataWeb()
      : await initializeEmptyAccountGenerationWeb();
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
    return {
      hasExistingData,
      accountGenerationState: accountGeneration.state,
      accountGenerationEpoch: accountGeneration.epoch,
      backend: 'idb',
    };
  }

  accountGenerationMetadata() {
    return accountGenerationMetadataWeb();
  }

  accountGenerationState(): Promise<AccountGenerationState> {
    return accountGenerationStateWeb();
  }

  accountGenerationEpoch(): Promise<string | null> {
    return accountGenerationEpochWeb();
  }

  async beginOnboardingCandidate(): Promise<void> {
    await this.enqueueLifecycleOperation(async () => {
      if ((await accountGenerationStateWeb()) !== 'empty') {
        throw new Error('Onboarding generation is no longer empty');
      }
      beginOnboardingCandidateWasm();
    });
  }

  async commitOnboardingCandidate(): Promise<string> {
    return this.enqueueLifecycleOperation(async () => {
      const archive = exportOnboardingCandidate();
      try {
        const install = () =>
          installOnboardingGenerationWeb(archive, {
            validateKeypair: validatePortableKeypair,
            validateBlock: validatePortableBlock,
          });
        const generationEpoch = navigator.locks
          ? await navigator.locks.request(
              STORAGE_INSTALLATION_FENCE_LOCK_NAME,
              { mode: 'exclusive' },
              install
            )
          : await install();
        await activateOnboardingGeneration();
        return generationEpoch;
      } finally {
        archive.fill(0);
      }
    });
  }

  async abortOnboardingCandidate(): Promise<void> {
    await this.enqueueLifecycleOperation(async () => {
      endOnboardingCandidate();
    });
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
    const operation = this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      let allocationFailed = false;
      let allocationError: unknown;
      try {
        allocateSession(slot, password);
      } catch (error) {
        allocationFailed = true;
        allocationError = error;
      } finally {
        // Wipe before any async durable-recovery work begins.
        password.fill(0);
      }
      if (allocationFailed) {
        return this.recoverRejectedLifecycleOperation(
          'create',
          allocationError
        );
      }
      try {
        await this.flushEncryptedFenced();
      } catch (error) {
        return this.recoverRejectedLifecycleOperation('create', error);
      }
      try {
        openDatabase();
      } catch (error) {
        // The allocation is already durable and remains unlocked for immediate
        // caller-driven destruction. Mark it as requiring cleanup explicitly.
        throw errorWithCause(
          `${SECURE_STORAGE_RECOVERY_REQUIRED} created storage could not be opened`,
          error
        );
      }
    });
    try {
      return await operation;
    } finally {
      // Admission and prerequisite recovery can reject before the queued
      // callback reaches its earlier pre-flush wipe.
      password.fill(0);
    }
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
    const operation = this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
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
    });
    try {
      return await operation;
    } finally {
      password.fill(0);
    }
  }

  async lock(): Promise<void> {
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      closeDatabase();
      await this.flushEncryptedFenced();
      lockSession();
    });
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
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      try {
        closeDatabase();
        destroySession(namespaces);
        await this.flushEncryptedFenced();
      } catch (error) {
        return this.recoverRejectedLifecycleOperation('destroy', error);
      }
    });
  }

  protected executeSqlStatement(sql: string, params: unknown[]) {
    return execSql(sql, params);
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
    const kind = classifyStatement(sql);
    const beginsTransaction = kind === 'begin';
    const isCommit = kind === 'commit';
    const isFullRollback = kind === 'rollback';
    const endsTransaction = isCommit || isFullRollback;

    if (kind === 'savepoint' && !this.sqlTransactionActive) {
      // Defense in depth for direct worker callers that bypass the connection
      // guard. Nested savepoints remain valid once a tracked BEGIN owns the
      // queue.
      throw new Error(TOP_LEVEL_SAVEPOINT_ERROR);
    }

    return this.enqueueSqlOperation(inTransaction, async () => {
      await this.ensureDurableStorageRecovered();
      let result: ReturnType<typeof execSql>;
      try {
        result = await this.verifyGenerationFenced(() =>
          this.executeSqlStatement(sql, params)
        );
      } catch (error) {
        if (isFullRollback && this.sqlTransactionActive) {
          // SQLite rejected the only statement that can release transaction
          // ownership. Mark all cached SQL/VFS state ambiguous and allow only
          // the durable reset gate to run before subsequent queued work.
          return this.recoverRejectedSqlBoundary('rollback', error);
        }
        throw error;
      }
      const rows = result.rows as unknown[][];
      const lastInsertRowId = result.lastInsertRowId;
      result.free();

      // Set ownership only after SQLite accepts BEGIN. Release it as soon as
      // SQLite accepts COMMIT/ROLLBACK; this operation still owns the queue
      // until its required flush finishes or rejects.
      if (beginsTransaction) this.sqlTransactionActive = true;
      if (endsTransaction) this.sqlTransactionActive = false;

      if (isCommit) {
        try {
          await this.flushEncryptedFenced();
        } catch (error) {
          // SQLite already accepted COMMIT but its VFS transaction did not
          // become durable. Reset to the last committed IndexedDB image before
          // any queued cover/lifecycle work can persist ambiguous pending pages.
          return this.recoverRejectedSqlBoundary('commit', error);
        }
      } else if (!inTransaction) {
        if (kind === 'mutation') {
          try {
            await this.flushEncryptedFenced();
          } catch (error) {
            // The autocommit statement already changed SQLite and its pending
            // VFS pages. A rejected durable flush must restore the last durable
            // image before later work can persist a mutation whose promise
            // rejected.
            return this.recoverRejectedSqlBoundary('mutation', error);
          }
        }
      }

      return { rows, lastInsertRowId };
    });
  }

  /** Apply and flush one complete cover pass, serialized with lifecycle work. */
  async cover(): Promise<void> {
    await this.runCoverTick();
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
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      writeNamespaceData(namespace, offset, data);
      await this.flushEncryptedFenced();
    });
  }

  async readNamespaceData(
    namespace: number,
    offset: number,
    len: number
  ): Promise<Uint8Array> {
    if (this.generationStale) {
      throw new Error('Secure-storage generation changed; reload required');
    }
    return this.verifyGenerationFenced(() =>
      readNamespaceData(namespace, offset, len)
    );
  }

  async namespaceDataLength(namespace: number): Promise<number> {
    if (this.generationStale) {
      throw new Error('Secure-storage generation changed; reload required');
    }
    return this.verifyGenerationFenced(() => namespaceDataLength(namespace));
  }

  async clearNamespace(namespace: number): Promise<void> {
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      clearNamespace(namespace);
      await this.flushEncryptedFenced();
    });
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
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      clearNamespace(namespace);
      writeNamespaceData(namespace, 0, data);
      await this.flushEncryptedFenced();
    });
  }

  /**
   * End normal admission and prepare a locked, stable browser snapshot.
   * Reads after this point bypass the operation queue because no storage
   * mutation is admitted; a failed/cancelled export intentionally remains
   * terminal for this worker instance.
   */
  async beginPortableExport(): Promise<{ totalBytes: number }> {
    if (
      this.portableExportStarting ||
      this.portableExport ||
      this.portableImportStarting ||
      this.portableImport
    ) {
      throw new Error('Portable transfer is already active');
    }
    this.portableExportStarting = true;
    this.coverOnlyMode = false;
    this.stopCoverTraffic();
    this.closeRequested = true;
    const controller = new AbortController();
    this.portableExportStartAbort = controller;
    const start = this.enqueueLifecycleOperation(
      async () => {
        await this.ensureDurableStorageRecovered();
        closeDatabase();
        await this.flushEncryptedFenced(controller.signal);
        lockSession();
        const transfer = await PortableWebExport.begin(
          {
            validateKeypair: value => validatePortableKeypair(value),
            validateBlock: value => validatePortableBlock(value),
          },
          controller.signal
        );
        this.portableExport = transfer;
        // The spool is now immutable. Resume only periodic cover work against
        // active storage while keeping every normal lifecycle/SQL operation
        // permanently rejected for this terminal runtime.
        this.coverOnlyMode = true;
        this.startCoverTraffic();
        return { totalBytes: transfer.totalBytes };
      },
      true,
      controller.signal
    );
    this.portableExportStartPromise = start;
    try {
      return await start;
    } finally {
      if (this.portableExportStartPromise === start) {
        this.portableExportStartPromise = null;
        this.portableExportStartAbort = null;
        this.portableExportStarting = false;
      }
    }
  }

  async readPortableExportChunk(maxBytes: number): Promise<Uint8Array | null> {
    const transfer = this.portableExport;
    if (!transfer) throw new Error('Portable export is not active');
    return transfer.read(maxBytes);
  }

  async finishPortableExport(): Promise<void> {
    const transfer = this.portableExport;
    if (!transfer) throw new Error('Portable export is not active');
    await transfer.close();
    this.portableExport = null;
  }

  async beginPortableImport(): Promise<void> {
    if (
      this.portableImportStarting ||
      this.portableImport ||
      this.portableExportStarting ||
      this.portableExport
    ) {
      throw new Error('Portable transfer is already active');
    }
    this.portableImportStarting = true;
    this.coverOnlyMode = false;
    this.stopCoverTraffic();
    this.closeRequested = true;
    const controller = new AbortController();
    this.portableImportStartAbort = controller;
    // Drain every operation accepted before import, lock the active store, and
    // only then retain the cross-tab transfer lease. No active mutation from
    // this worker can race candidate authorization or the generation switch.
    const start = this.enqueueLifecycleOperation(
      async () => {
        await this.ensureDurableStorageRecovered();
        closeDatabase();
        await this.flushEncryptedFenced(controller.signal);
        lockSession();
        this.portableImport = await PortableWebImport.begin(
          {
            validateKeypair: value => validatePortableKeypair(value),
            validateBlock: value => validatePortableBlock(value),
          },
          controller.signal
        );
      },
      true,
      controller.signal
    );
    this.portableImportStartPromise = start;
    try {
      await start;
    } finally {
      if (this.portableImportStartPromise === start) {
        this.portableImportStartPromise = null;
        this.portableImportStartAbort = null;
        this.portableImportStarting = false;
      }
    }
  }

  async pushPortableImportChunk(data: Uint8Array): Promise<void> {
    const transfer = this.portableImport;
    if (!transfer) throw new Error('Portable import is not active');
    await transfer.push(data);
  }

  async finishPortableImportValidation(): Promise<void> {
    const transfer = this.portableImport;
    if (!transfer) throw new Error('Portable import is not active');
    await transfer.finishValidation();
  }

  private async restorePortablePreviewBackend(): Promise<void> {
    if (this.portablePreviewRecoveryError === null) return;
    try {
      await endCandidatePreview();
      this.portablePreviewRecoveryError = null;
    } catch (error) {
      this.portablePreviewRecoveryError = error;
      throw error;
    }
  }

  async authenticatePortableImportCandidate(
    password: Uint8Array
  ): Promise<ImportedAccountPreview | null> {
    const operation = async (): Promise<ImportedAccountPreview | null> => {
      let previewStarted = false;
      let failed = false;
      let failure: unknown;
      let preview: ImportedAccountPreview | null = null;
      try {
        await this.restorePortablePreviewBackend();
        const transfer = this.portableImport;
        if (!transfer) throw new Error('Portable import is not active');
        const authenticated = await transfer.previewCandidate(
          keypairs => {
            previewStarted = true;
            return beginCandidatePreview(this.domain, password, keypairs);
          },
          (slot, namespace, blockIndex, value) =>
            appendCandidatePreviewBlock(slot, namespace, blockIndex, value)
        );
        if (authenticated) {
          finishCandidatePreview();
          preview = queryCandidatePreview() as ImportedAccountPreview;
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      password.fill(0);
      if (previewStarted) {
        try {
          await endCandidatePreview();
          this.portablePreviewRecoveryError = null;
        } catch (error) {
          this.portablePreviewRecoveryError = error;
          throw error;
        }
      }
      if (failed) throw failure;
      return preview;
    };
    const result = this.portablePreviewTail.then(operation, operation);
    this.portablePreviewTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async beginPortableOuterMigration(): Promise<void> {
    await this.portablePreviewTail;
    await this.restorePortablePreviewBackend();
    const transfer = this.portableImport;
    if (!transfer) throw new Error('Portable import is not active');
    await transfer.beginOuterMigration(this.domain);
  }

  async admitPortableOuterMigrationPassword(
    password: Uint8Array
  ): Promise<void> {
    try {
      if (!this.portableImport) {
        throw new Error('Portable import is not active');
      }
      await this.portableImport.admitOuterMigrationPassword(password);
    } finally {
      password.fill(0);
    }
  }

  async finishPortableOuterMigration(): Promise<void> {
    const transfer = this.portableImport;
    if (!transfer) throw new Error('Portable import is not active');
    await transfer.finalizeOuterMigration();
  }

  async installPortableImport(): Promise<{
    generation: string;
    generationEpoch: string;
  }> {
    await this.portablePreviewTail;
    await this.restorePortablePreviewBackend();
    const transfer = this.portableImport;
    if (!transfer) throw new Error('Portable import is not active');
    this.stopCoverTraffic();
    this.closeRequested = true;
    const result = await this.enqueueLifecycleOperation(
      async () => transfer.install(),
      true
    );
    this.portableImport = null;
    return result;
  }

  async abortPortableTransfer(): Promise<void> {
    await this.portablePreviewTail;
    await this.restorePortablePreviewBackend();
    const pendingExport = this.portableExportStartPromise;
    if (pendingExport) {
      this.portableExportStartAbort?.abort();
      await pendingExport.catch(() => {});
    }
    const pendingImport = this.portableImportStartPromise;
    if (pendingImport) {
      this.portableImportStartAbort?.abort();
      await pendingImport.catch(() => {});
    }
    const transfer = this.portableExport ?? this.portableImport;
    if (this.portableImport) endOuterMigration();
    if (transfer) {
      // Clear fields only after cleanup succeeds. A rejected deletion keeps
      // the transfer retryable for the caller's recovery screen.
      await transfer.close();
      this.portableExport = null;
      this.portableImport = null;
    }
    this.portableExportStarting = false;
    this.portableImportStarting = false;
    if (this.closeRequested) {
      this.coverOnlyMode = true;
      if (this.coverTimerId === null) this.startCoverTraffic();
    }
  }

  async flush(): Promise<void> {
    return this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      await this.flushEncryptedFenced();
    });
  }

  async close(): Promise<void> {
    if (
      this.portableExportStarting ||
      this.portableExport ||
      this.portableImportStarting ||
      this.portableImport
    ) {
      throw new Error('Cannot close secure storage during portable transfer');
    }
    if (this.closePromise) return this.closePromise;

    // Prevent the periodic callback and public cover calls from admitting new
    // work, but retain the retry timer for already accepted cover requests.
    // Close enters at the FIFO tail and cannot complete until every earlier
    // request has reached a durable boundary.
    this.stopCoverTraffic();
    this.closeRequested = true;
    const closeOperation = this.enqueueLifecycleOperation(async () => {
      await this.ensureDurableStorageRecovered();
      closeDatabase();
      await this.flushEncryptedFenced();
    }, true);
    this.closePromise = closeOperation;
    try {
      await closeOperation;
    } catch (error) {
      // Keep cover admission stopped, but allow an explicit close retry after
      // storage recovery becomes available.
      if (this.closePromise === closeOperation) this.closePromise = null;
      throw error;
    }
  }
}

// INTERNAL - do not re-export from the SDK package entry point. Leaking
// this type would expose `Comlink.Remote<T>` as part of the public API
// and tie consumers to the worker's RPC shape.
export type SecureStorageWorkerProxy = Comlink.Remote<SecureStorageWorkerApi>;
