import * as Comlink from 'comlink';
import { SecureStorageWorkerApi } from './secure-storage-worker-api.js';
import { classifyStatement } from './sql-statement.js';

interface IndexedDbFaultPlan {
  readwrite?: number;
  readonly?: number;
  readonlyAfterReadwrite?: number;
}

class SecureStorageTestWorkerApi extends SecureStorageWorkerApi {
  private indexedDbFaults = {
    readwrite: 0,
    readonly: 0,
    readonlyAfterReadwrite: 0,
  };
  private rejectNextSqlRollback = false;
  private readonlyFaultsAfterRollback = 0;
  private originalIndexedDbTransaction:
    | typeof IDBDatabase.prototype.transaction
    | null = null;

  private restoreIndexedDbTransaction(): void {
    if (!this.originalIndexedDbTransaction) return;
    IDBDatabase.prototype.transaction = this.originalIndexedDbTransaction;
    this.originalIndexedDbTransaction = null;
  }

  injectIndexedDbFaultsForTesting(plan: IndexedDbFaultPlan): void {
    this.indexedDbFaults.readwrite += plan.readwrite ?? 0;
    this.indexedDbFaults.readonly += plan.readonly ?? 0;
    this.indexedDbFaults.readonlyAfterReadwrite +=
      plan.readonlyAfterReadwrite ?? 0;
    if (this.originalIndexedDbTransaction) return;

    const faultState = this.indexedDbFaults;
    const restoreTransaction = () => this.restoreIndexedDbTransaction();
    const original = IDBDatabase.prototype.transaction;
    this.originalIndexedDbTransaction = original;
    IDBDatabase.prototype.transaction = function (
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions
    ): IDBTransaction {
      const transaction = original.call(this, storeNames, mode, options);
      const kind = mode === 'readwrite' ? 'readwrite' : 'readonly';
      if (faultState[kind] > 0) {
        faultState[kind] -= 1;
        if (kind === 'readwrite' && faultState.readonlyAfterReadwrite > 0) {
          faultState.readonly += faultState.readonlyAfterReadwrite;
          faultState.readonlyAfterReadwrite = 0;
        }
        queueMicrotask(() => {
          try {
            transaction.abort();
          } catch {
            // The VFS rejection is the assertion target. A transaction that
            // already aborted or committed needs no secondary error.
          }
        });
      }
      if (
        faultState.readwrite === 0 &&
        faultState.readonly === 0 &&
        faultState.readonlyAfterReadwrite === 0
      ) {
        restoreTransaction();
      }
      return transaction;
    };
  }

  rejectNextSqlRollbackForTesting(readonlyFaults = 0): void {
    this.rejectNextSqlRollback = true;
    this.readonlyFaultsAfterRollback = readonlyFaults;
  }

  protected override executeSqlStatement(sql: string, params: unknown[]) {
    if (this.rejectNextSqlRollback && classifyStatement(sql) === 'rollback') {
      this.rejectNextSqlRollback = false;
      if (this.readonlyFaultsAfterRollback > 0) {
        this.injectIndexedDbFaultsForTesting({
          readonly: this.readonlyFaultsAfterRollback,
        });
        this.readonlyFaultsAfterRollback = 0;
      }
      throw new Error('injected SQL rollback failure');
    }
    return super.executeSqlStatement(sql, params);
  }

  clearIndexedDbFaultsForTesting(): void {
    this.indexedDbFaults.readwrite = 0;
    this.indexedDbFaults.readonly = 0;
    this.indexedDbFaults.readonlyAfterReadwrite = 0;
    this.readonlyFaultsAfterRollback = 0;
    this.restoreIndexedDbTransaction();
  }

  retryFailedCoverNowForTesting(): boolean {
    if (this.coverRetryTimerId === null) return false;
    clearTimeout(this.coverRetryTimerId);
    this.coverRetryTimerId = null;
    this.pumpOperationQueue();
    return true;
  }

  stopPeriodicCoverForTesting(): void {
    this.stopCoverTraffic();
  }
}

Comlink.expose(new SecureStorageTestWorkerApi());
