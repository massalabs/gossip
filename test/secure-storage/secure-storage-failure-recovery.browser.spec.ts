import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GossipSdk } from '@massalabs/gossip-sdk';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { userProfile } from '@massalabs/gossip-sdk/db/schema';
import {
  COVER_TRAFFIC_NAMESPACES,
  SECURE_STORAGE_IDB_NAME,
  SESSION_BLOB_NAMESPACE,
} from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;
const IDB_STORE_NAME = 'blocks';
const SESSION_COUNT = 3;

type FaultPlan = { readwrite?: number; readonly?: number };
type FaultProxy = {
  injectIndexedDbFaultsForTesting(plan: FaultPlan): Promise<void>;
  clearIndexedDbFaultsForTesting(): Promise<void>;
  retryFailedCoverNowForTesting(): Promise<boolean>;
  stopPeriodicCoverForTesting(): Promise<void>;
  rejectNextSqlRollbackForTesting(): Promise<void>;
  exec(
    sql: string,
    params?: unknown[],
    inTransaction?: boolean
  ): Promise<unknown>;
};

type RawSnapshot = Map<string, Uint8Array>;

function config(domain: string) {
  return {
    storage: {
      type: 'secureStorage' as const,
      domain,
      secureStorageWasmUrl,
    },
  };
}

function sdkConnection(sdk: GossipSdk): DatabaseConnection {
  return (sdk as unknown as { _conn: DatabaseConnection })._conn;
}

function testProxy(connection: DatabaseConnection): FaultProxy {
  return (
    connection as unknown as {
      state: { secureProxy: FaultProxy | null };
    }
  ).state.secureProxy!;
}

async function deleteSecureStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('secure-storage IndexedDB deletion was blocked'));
  });
}

async function snapshotSecureStorage(): Promise<RawSnapshot> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SECURE_STORAGE_IDB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<RawSnapshot>((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE_NAME, 'readonly');
      const store = transaction.objectStore(IDB_STORE_NAME);
      const keysRequest = store.getAllKeys();
      const valuesRequest = store.getAll();
      transaction.oncomplete = () => {
        const snapshot = new Map<string, Uint8Array>();
        for (let index = 0; index < keysRequest.result.length; index++) {
          const value = valuesRequest.result[index];
          snapshot.set(
            String(keysRequest.result[index]),
            value instanceof Uint8Array
              ? new Uint8Array(value)
              : new Uint8Array(value as ArrayBuffer)
          );
        }
        resolve(snapshot);
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

function expectSnapshotsEqual(
  expected: RawSnapshot,
  actual: RawSnapshot
): void {
  expect(new Set(actual.keys())).toEqual(new Set(expected.keys()));
  for (const [key, value] of expected) {
    expect(Array.from(actual.get(key) ?? []), key).toEqual(Array.from(value));
  }
}

function expectCoverChangedEverySlot(
  before: RawSnapshot,
  after: RawSnapshot
): void {
  for (const namespace of COVER_TRAFFIC_NAMESPACES) {
    const changedSessions = new Set<number>();
    for (const [key, oldValue] of before) {
      const match = /^s:(\d+):n:(\d+):b:(\d+)$/.exec(key);
      if (!match || Number(match[2]) !== namespace) continue;
      const newValue = after.get(key);
      if (
        newValue &&
        oldValue.some((byte, index) => byte !== newValue[index])
      ) {
        changedSessions.add(Number(match[1]));
      }
    }
    expect(changedSessions).toEqual(
      new Set(Array.from({ length: SESSION_COUNT }, (_, index) => index))
    );
  }
}

async function expectBaselineData(
  connection: DatabaseConnection,
  expectedNamespaceData: Uint8Array,
  expectedUsername = 'durable after rejected lock retry'
): Promise<void> {
  const rows = await connection.db
    .select({
      userId: userProfile.userId,
      username: userProfile.username,
    })
    .from(userProfile);
  expect(rows).toEqual([
    { userId: 'gossip1durablebaseline', username: expectedUsername },
  ]);
  expect(
    Array.from(
      await connection.secureStorageReadNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        expectedNamespaceData.length
      )
    )
  ).toEqual(Array.from(expectedNamespaceData));
}

describe('secure-storage real IndexedDB failure recovery', () => {
  const openConnections = new Set<DatabaseConnection>();

  async function openConnection(domain: string): Promise<DatabaseConnection> {
    const connection = await DatabaseConnection.create(config(domain));
    openConnections.add(connection);
    return connection;
  }

  beforeEach(async () => {
    await deleteSecureStorage();
  }, 60_000);

  afterEach(async () => {
    for (const connection of openConnections) {
      try {
        await testProxy(connection).clearIndexedDbFaultsForTesting();
        await connection.close();
      } catch {
        // Preserve the primary test failure; deletion below still detects a
        // genuinely leaked worker handle.
      }
    }
    openConnections.clear();
    await deleteSecureStorage();
  }, 60_000);

  it('invalidates SDK facades across a real rejected lock retry', async () => {
    const password = 'sdk-rejected-lock-password';
    const sdk = new GossipSdk();
    try {
      await sdk.init({
        protocolBaseUrl: 'http://127.0.0.1:1',
        storage: config('sdk-rejected-lock-readiness').storage,
      });
      await sdk.secureStorageCreate(0, password);
      const connection = sdkConnection(sdk);
      await testProxy(connection).stopPeriodicCoverForTesting();
      expect(sdk.dbReady).toBe(true);
      expect(() => sdk.queries).not.toThrow();
      expect(() => sdk.profiles).not.toThrow();

      await testProxy(connection).exec('PRAGMA user_version = 99', [], true);
      await testProxy(connection).injectIndexedDbFaultsForTesting({
        readwrite: 1,
      });
      await expect(sdk.secureStorageLock()).rejects.toThrow();

      expect(sdk.storageState).toBe('unlocked');
      expect(sdk.dbReady).toBe(false);
      expect(() => sdk.queries).toThrow();
      expect(() => sdk.profiles).toThrow();

      await sdk.secureStorageLock();
      expect(await sdk.secureStorageUnlock(password)).toBe(true);
      expect(sdk.dbReady).toBe(true);
      await sdk.secureStorageLock();
    } finally {
      await sdk.destroy();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }, 120_000);

  it('retries a real poisoned SQL reset before lifecycle cleanup', async () => {
    const domain = 'poisoned-sql-reset-recovery';
    const password = 'poisoned-sql-password';
    const namespaceData = new Uint8Array([4, 3, 2, 1]);
    let connection = await openConnection(domain);
    await testProxy(connection).stopPeriodicCoverForTesting();
    await connection.secureStorageCreate(0, password);
    const now = new Date();
    await connection.db.insert(userProfile).values({
      userId: 'gossip1poisonedbaseline',
      username: 'durable before poisoned rollback',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: '{}',
      session: new Uint8Array([9, 8, 7]),
    });
    await connection.secureStorageWriteNamespaceData(
      SESSION_BLOB_NAMESPACE,
      0,
      namespaceData
    );
    const beforePoisonedRollback = await snapshotSecureStorage();

    await testProxy(connection).exec('BEGIN IMMEDIATE');
    await testProxy(connection).exec(
      'UPDATE userProfile SET username = ? WHERE userId = ?',
      ['commit whose flush rejects', 'gossip1poisonedbaseline'],
      true
    );
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
    });
    await expect(
      testProxy(connection).exec('COMMIT', [], true)
    ).rejects.toThrow();
    expectSnapshotsEqual(beforePoisonedRollback, await snapshotSecureStorage());
    const afterRejectedCommit = await testProxy(connection).exec(
      'SELECT username FROM userProfile'
    );
    expect(afterRejectedCommit).toMatchObject({
      rows: [['durable before poisoned rollback']],
    });

    await testProxy(connection).exec('BEGIN IMMEDIATE');
    await testProxy(connection).exec(
      'UPDATE userProfile SET username = ? WHERE userId = ?',
      ['ambiguous uncommitted value', 'gossip1poisonedbaseline'],
      true
    );
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readonly: 1,
    });
    await testProxy(connection).rejectNextSqlRollbackForTesting();
    await expect(
      testProxy(connection).exec('ROLLBACK', [], true)
    ).rejects.toThrow('recovery-required');
    expectSnapshotsEqual(beforePoisonedRollback, await snapshotSecureStorage());

    await connection.secureStorageLock();
    await connection.close();
    openConnections.delete(connection);

    connection = await openConnection(domain);
    await testProxy(connection).stopPeriodicCoverForTesting();
    expect(await connection.secureStorageUnlock(password)).toBe(true);
    expect(
      await connection.db
        .select({ username: userProfile.username })
        .from(userProfile)
    ).toEqual([{ username: 'durable before poisoned rollback' }]);
    expect(
      Array.from(
        await connection.secureStorageReadNamespaceData(
          SESSION_BLOB_NAMESPACE,
          0,
          namespaceData.length
        )
      )
    ).toEqual(Array.from(namespaceData));
    await connection.secureStorageLock();
    await connection.close();
    openConnections.delete(connection);
  }, 120_000);

  it('preserves cover and lifecycle durability through real VFS failures', async () => {
    const domain = 'real-vfs-failure-recovery';
    const baselinePassword = 'baseline-password';
    const rejectedPassword = 'rejected-password';
    const recoveryRejectedPassword = 'recovery-rejected-password';
    const namespaceData = new Uint8Array([7, 6, 5, 4, 3, 2, 1]);
    let connection = await openConnection(domain);
    await testProxy(connection).stopPeriodicCoverForTesting();

    await connection.secureStorageCreate(0, baselinePassword);
    const now = new Date();
    await connection.db.insert(userProfile).values({
      userId: 'gossip1durablebaseline',
      username: 'durable baseline',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: '{}',
      session: new Uint8Array([1, 2, 3]),
    });
    await connection.secureStorageWriteNamespaceData(
      SESSION_BLOB_NAMESPACE,
      0,
      namespaceData
    );
    await connection.secureStorageLock();

    const beforeCover = await snapshotSecureStorage();
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
    });
    const settlementOrder: string[] = [];
    const cover = connection.secureStorageCoverTick().then(() => {
      settlementOrder.push('cover');
    });
    const unlock = connection
      .secureStorageUnlock(baselinePassword)
      .then(unlocked => {
        settlementOrder.push('unlock');
        return unlocked;
      });

    let unlockSettled = false;
    void unlock.then(() => {
      unlockSettled = true;
    });
    await vi.waitFor(
      async () => {
        expect(
          await testProxy(connection).retryFailedCoverNowForTesting()
        ).toBe(true);
      },
      { timeout: 30_000 }
    );
    expect(unlockSettled).toBe(false);
    await cover;
    expect(await unlock).toBe(true);
    expect(settlementOrder).toEqual(['cover', 'unlock']);
    await expectBaselineData(connection, namespaceData, 'durable baseline');

    await testProxy(connection).exec(
      'UPDATE userProfile SET username = ? WHERE userId = ?',
      ['durable after generic flush retry', 'gossip1durablebaseline'],
      true
    );
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
    });
    await expect(connection.secureStorageFlush()).rejects.toThrow();
    await connection.secureStorageFlush();
    await connection.secureStorageLock();
    await connection.close();
    openConnections.delete(connection);

    connection = await openConnection(domain);
    await testProxy(connection).stopPeriodicCoverForTesting();
    expect(await connection.secureStorageUnlock(baselinePassword)).toBe(true);
    await expectBaselineData(
      connection,
      namespaceData,
      'durable after generic flush retry'
    );
    await testProxy(connection).exec(
      'UPDATE userProfile SET username = ? WHERE userId = ?',
      ['durable after rejected lock retry', 'gossip1durablebaseline'],
      true
    );
    const beforeRejectedLock = await snapshotSecureStorage();
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
    });
    await expect(connection.secureStorageLock()).rejects.toThrow();
    expect(connection.storageState).toBe('unlocked');
    expectSnapshotsEqual(beforeRejectedLock, await snapshotSecureStorage());
    await connection.secureStorageLock();
    await connection.close();
    openConnections.delete(connection);

    connection = await openConnection(domain);
    await testProxy(connection).stopPeriodicCoverForTesting();
    expect(await connection.secureStorageUnlock(baselinePassword)).toBe(true);
    await expectBaselineData(connection, namespaceData);
    await connection.secureStorageLock();

    const afterCover = await snapshotSecureStorage();
    expectCoverChangedEverySlot(beforeCover, afterCover);

    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
    });
    await expect(
      connection.secureStorageCreate(1, rejectedPassword)
    ).rejects.toThrow();
    const afterRejectedCreate = await snapshotSecureStorage();
    expectSnapshotsEqual(afterCover, afterRejectedCreate);
    expect(await connection.secureStorageUnlock(rejectedPassword)).toBe(false);
    expect(await connection.secureStorageUnlock(baselinePassword)).toBe(true);
    await expectBaselineData(connection, namespaceData);
    await connection.secureStorageLock();

    const beforeRecoveryRejected = await snapshotSecureStorage();
    await testProxy(connection).injectIndexedDbFaultsForTesting({
      readwrite: 1,
      readonly: 6,
    });
    await expect(
      connection.secureStorageCreate(1, recoveryRejectedPassword)
    ).rejects.toThrow('recovery-required');
    await expect(
      connection.secureStorageWriteNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        new Uint8Array([99])
      )
    ).rejects.toThrow();
    await expect(
      connection.secureStorageClearNamespace(SESSION_BLOB_NAMESPACE)
    ).rejects.toThrow();
    await expect(
      connection.secureStorageReplaceNamespaceData(
        SESSION_BLOB_NAMESPACE,
        new Uint8Array([98])
      )
    ).rejects.toThrow();
    await expect(connection.secureStorageFlush()).rejects.toThrow();
    await expect(connection.close()).rejects.toThrow();
    await connection.close();
    openConnections.delete(connection);

    const afterGuardedClose = await snapshotSecureStorage();
    expectSnapshotsEqual(beforeRecoveryRejected, afterGuardedClose);

    const reopened = await openConnection(domain);
    await testProxy(reopened).stopPeriodicCoverForTesting();
    const afterRelaunchCover = await snapshotSecureStorage();
    expect(new Set(afterRelaunchCover.keys())).toEqual(
      new Set(afterGuardedClose.keys())
    );
    expectCoverChangedEverySlot(afterGuardedClose, afterRelaunchCover);

    expect(await reopened.secureStorageUnlock(rejectedPassword)).toBe(false);
    expect(await reopened.secureStorageUnlock(recoveryRejectedPassword)).toBe(
      false
    );
    expect(await reopened.secureStorageUnlock(baselinePassword)).toBe(true);
    await expectBaselineData(reopened, namespaceData);

    const beforeRejectedDestroy = await snapshotSecureStorage();
    await testProxy(reopened).injectIndexedDbFaultsForTesting({ readwrite: 1 });
    await expect(
      reopened.secureStorageDestroy([...COVER_TRAFFIC_NAMESPACES])
    ).rejects.toThrow();
    const afterRejectedDestroy = await snapshotSecureStorage();
    expectSnapshotsEqual(beforeRejectedDestroy, afterRejectedDestroy);

    expect(await reopened.secureStorageUnlock(baselinePassword)).toBe(true);
    await expectBaselineData(reopened, namespaceData);
    await reopened.secureStorageLock();
    await reopened.close();
    openConnections.delete(reopened);

    const destroyRelaunch = await openConnection(domain);
    await testProxy(destroyRelaunch).stopPeriodicCoverForTesting();
    try {
      expect(await destroyRelaunch.secureStorageUnlock(baselinePassword)).toBe(
        true
      );
      await expectBaselineData(destroyRelaunch, namespaceData);
      await destroyRelaunch.secureStorageLock();
    } finally {
      await destroyRelaunch.close();
      openConnections.delete(destroyRelaunch);
    }
  }, 180_000);
});
