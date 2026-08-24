import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_TRAFFIC_NAMESPACES } from '../../src/db/secure-storage-namespaces';
import type { SecureStorageWorkerApi } from '../../src/db/secure-storage-worker-api';

const wasmMock = vi.hoisted(() => ({
  init: vi.fn(),
  initSecureStorage: vi.fn(),
  idbHasData: vi.fn(),
  provisionStorage: vi.fn(),
  allocateSession: vi.fn(),
  unlockSession: vi.fn(),
  lockSession: vi.fn(),
  coverTrafficTick: vi.fn(),
  flushEncrypted: vi.fn(),
  reloadDurableStorage: vi.fn(),
  resetSqlDatabaseToDurable: vi.fn(),
  openDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  execSql: vi.fn(),
  initThreadPool: vi.fn(),
  writeNamespaceData: vi.fn(),
  readNamespaceData: vi.fn(),
  namespaceDataLength: vi.fn(),
  clearNamespace: vi.fn(),
  destroySession: vi.fn(),
}));

vi.mock(
  '../../src/assets/generated/wasm-secureStorage/secureStorage.js',
  () => ({
    default: wasmMock.init,
    ...wasmMock,
  })
);

vi.mock('comlink', () => ({
  expose: vi.fn(),
}));

describe('SecureStorageWorkerApi password cleanup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    wasmMock.flushEncrypted.mockResolvedValue(undefined);
    wasmMock.reloadDurableStorage.mockResolvedValue(undefined);
    wasmMock.resetSqlDatabaseToDurable.mockResolvedValue(undefined);
    wasmMock.execSql.mockReturnValue({
      rows: [],
      lastInsertRowId: 0,
      free: vi.fn(),
    });
  });

  it('reloads durable state and zeroes the password when allocation throws', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const password = new Uint8Array([1, 2, 3]);
    wasmMock.allocateSession.mockImplementation(() => {
      throw new Error('allocate failed');
    });

    await expect(api.create(0, password)).rejects.toThrow('allocate failed');

    expect(Array.from(password)).toEqual([0, 0, 0]);
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'create',
      (api: SecureStorageWorkerApi, value: Uint8Array) => api.create(0, value),
    ],
    [
      'unlock',
      (api: SecureStorageWorkerApi, value: Uint8Array) => api.unlock(value),
    ],
  ])(
    'zeroes the password when close rejects %s admission',
    async (_name, run) => {
      const { SecureStorageWorkerApi } =
        await import('../../src/db/secure-storage-worker-api');
      const api = new SecureStorageWorkerApi();
      const password = new Uint8Array([4, 5, 6]);
      const close = api.close();

      await expect(run(api, password)).rejects.toThrow(
        'Secure storage worker is closing'
      );
      expect(Array.from(password)).toEqual([0, 0, 0]);
      await close;
    }
  );

  it.each([
    [
      'create',
      (api: SecureStorageWorkerApi, value: Uint8Array) => api.create(0, value),
      wasmMock.allocateSession,
    ],
    [
      'unlock',
      (api: SecureStorageWorkerApi, value: Uint8Array) => api.unlock(value),
      wasmMock.unlockSession,
    ],
  ])(
    'zeroes the password when prerequisite recovery rejects before %s',
    async (_name, run, passwordOperation) => {
      const { SecureStorageWorkerApi } =
        await import('../../src/db/secure-storage-worker-api');
      const api = new SecureStorageWorkerApi();
      const password = new Uint8Array([7, 8, 9]);
      (
        api as unknown as { durableRecoveryRequired: boolean }
      ).durableRecoveryRequired = true;
      wasmMock.reloadDurableStorage.mockRejectedValueOnce(
        new Error('recovery failed')
      );

      await expect(run(api, password)).rejects.toThrow('recovery failed');
      expect(Array.from(password)).toEqual([0, 0, 0]);
      expect(passwordOperation).not.toHaveBeenCalled();
    }
  );

  it('waits for an active cover flush before allocation starts', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCover!: () => void;
    const activeCover = new Promise<void>(resolve => {
      finishCover = resolve;
    });
    wasmMock.flushEncrypted
      .mockReturnValueOnce(activeCover)
      .mockResolvedValueOnce(undefined);

    const cover = (
      api as unknown as { runCoverTick: () => Promise<void> }
    ).runCoverTick();
    await vi.waitFor(() =>
      expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
    );
    const create = api.create(0, new Uint8Array([1, 2, 3]));
    await Promise.resolve();
    expect(wasmMock.allocateSession).not.toHaveBeenCalled();

    finishCover();
    await cover;
    await create;
    expect(wasmMock.allocateSession).toHaveBeenCalledOnce();
  });

  it('applies cover traffic deferred during allocation', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCreate!: () => void;
    const createFlush = new Promise<void>(resolve => {
      finishCreate = resolve;
    });
    wasmMock.flushEncrypted
      .mockReturnValueOnce(createFlush)
      .mockResolvedValueOnce(undefined);

    const create = api.create(0, new Uint8Array([4, 5, 6]));
    await vi.waitFor(() =>
      expect(wasmMock.allocateSession).toHaveBeenCalledOnce()
    );
    const deferredCover = (
      api as unknown as { runCoverTick: () => Promise<void> }
    ).runCoverTick();
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();

    finishCreate();
    await create;
    await deferredCover;
    expect(wasmMock.coverTrafficTick.mock.calls.map(([ns]) => ns)).toEqual(
      COVER_TRAFFIC_NAMESPACES
    );
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('applies every concurrent cover request as its own durable pass', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const firstFlush = new Promise<void>(resolve => {
      finishFirst = resolve;
    });
    const secondFlush = new Promise<void>(resolve => {
      finishSecond = resolve;
    });
    wasmMock.flushEncrypted
      .mockReturnValueOnce(firstFlush)
      .mockReturnValueOnce(secondFlush);

    const internals = api as unknown as {
      runCoverTick: () => Promise<void>;
    };
    const first = internals.runCoverTick();
    const second = internals.runCoverTick();
    await vi.waitFor(() =>
      expect(wasmMock.flushEncrypted).toHaveBeenCalledOnce()
    );

    finishFirst();
    await first;
    await vi.waitFor(() =>
      expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2)
    );
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    finishSecond();
    await second;
    expect(wasmMock.coverTrafficTick.mock.calls.map(([ns]) => ns)).toEqual([
      ...COVER_TRAFFIC_NAMESPACES,
      ...COVER_TRAFFIC_NAMESPACES,
    ]);
  });

  it('persists a failed pre-allocation cover pass before allocating', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('cover flush failed'))
      .mockResolvedValue(undefined);

    const internals = api as unknown as {
      runCoverTick: () => Promise<void>;
      coverRetryTimerId: ReturnType<typeof setTimeout> | null;
      pumpOperationQueue: () => void;
    };
    const cover = internals.runCoverTick();
    const create = api.create(0, new Uint8Array([1, 2, 3]));

    await vi.waitFor(() => expect(internals.coverRetryTimerId).not.toBeNull());
    expect(wasmMock.reloadDurableStorage).not.toHaveBeenCalled();
    expect(wasmMock.allocateSession).not.toHaveBeenCalled();

    clearTimeout(internals.coverRetryTimerId!);
    internals.coverRetryTimerId = null;
    internals.pumpOperationQueue();
    await cover;
    await create;

    expect(wasmMock.allocateSession).toHaveBeenCalledOnce();
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(3);
  });

  it('keeps cover queued across failed allocation recovery', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const { SECURE_STORAGE_RECOVERY_REQUIRED } =
      await import('../../src/db/secure-storage-errors');
    const api = new SecureStorageWorkerApi();
    let rejectFirstReload!: (reason: Error) => void;
    const firstReload = new Promise<void>((_resolve, reject) => {
      rejectFirstReload = reject;
    });
    wasmMock.flushEncrypted.mockRejectedValueOnce(new Error('flush failed'));
    wasmMock.reloadDurableStorage
      .mockReturnValueOnce(firstReload)
      .mockRejectedValueOnce(new Error('reload still failed'))
      .mockResolvedValue(undefined);

    const create = api.create(0, new Uint8Array([7, 8, 9]));
    await vi.waitFor(() =>
      expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce()
    );
    const cover = (
      api as unknown as { runCoverTick: () => Promise<void> }
    ).runCoverTick();
    rejectFirstReload(new Error('reload failed'));

    await expect(create).rejects.toThrow(SECURE_STORAGE_RECOVERY_REQUIRED);
    await vi.waitFor(() =>
      expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(2)
    );
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();

    const internals = api as unknown as {
      coverRetryTimerId: ReturnType<typeof setTimeout> | null;
      pumpOperationQueue: () => void;
    };
    await vi.waitFor(() => expect(internals.coverRetryTimerId).not.toBeNull());
    clearTimeout(internals.coverRetryTimerId!);
    internals.coverRetryTimerId = null;
    internals.pumpOperationQueue();
    await cover;

    wasmMock.unlockSession.mockReturnValue(false);
    await expect(api.unlock(new Uint8Array([1]))).resolves.toBe(false);
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(3);
    expect(wasmMock.coverTrafficTick.mock.calls.map(([ns]) => ns)).toEqual(
      COVER_TRAFFIC_NAMESPACES
    );
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('reloads durable state after a rejected create flush', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const password = new Uint8Array([7, 8, 9]);
    wasmMock.flushEncrypted.mockRejectedValueOnce(new Error('flush failed'));

    await expect(api.create(0, password)).rejects.toThrow('flush failed');

    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
    expect(wasmMock.openDatabase).not.toHaveBeenCalled();
    expect(Array.from(password)).toEqual([0, 0, 0]);
  });

  it('requires durable recovery before another lifecycle operation', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const { SECURE_STORAGE_RECOVERY_REQUIRED } =
      await import('../../src/db/secure-storage-errors');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted.mockRejectedValueOnce(new Error('flush failed'));
    wasmMock.reloadDurableStorage
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);

    await expect(api.create(0, new Uint8Array([1]))).rejects.toThrow(
      SECURE_STORAGE_RECOVERY_REQUIRED
    );

    wasmMock.unlockSession.mockReturnValue(false);
    await expect(api.unlock(new Uint8Array([2]))).resolves.toBe(false);
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(2);
  });

  it('keeps generic flush behind earlier cover work', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCover!: () => void;
    wasmMock.flushEncrypted
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          finishCover = resolve;
        })
      )
      .mockResolvedValueOnce(undefined);

    const cover = api.cover();
    await vi.waitFor(() =>
      expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
    );
    const flush = api.flush();
    await Promise.resolve();
    expect(wasmMock.flushEncrypted).toHaveBeenCalledOnce();

    finishCover();
    await cover;
    await flush;
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('keeps SQL behind earlier cover work', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCover!: () => void;
    wasmMock.flushEncrypted
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          finishCover = resolve;
        })
      )
      .mockResolvedValueOnce(undefined);

    const cover = api.cover();
    await vi.waitFor(() =>
      expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
    );
    const sql = api.exec('UPDATE userProfile SET username = ?', ['later']);
    await Promise.resolve();
    expect(wasmMock.execSql).not.toHaveBeenCalled();

    finishCover();
    await cover;
    await sql;
    expect(wasmMock.execSql).toHaveBeenCalledOnce();
  });

  it('keeps SQL behind a failed cover retry', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('cover flush failed'))
      .mockResolvedValue(undefined);
    const internals = api as unknown as {
      coverRetryTimerId: ReturnType<typeof setTimeout> | null;
      pumpOperationQueue: () => void;
    };

    const cover = api.cover();
    const sql = api.exec('UPDATE userProfile SET username = ?', ['later']);
    await vi.waitFor(() => expect(internals.coverRetryTimerId).not.toBeNull());
    expect(wasmMock.execSql).not.toHaveBeenCalled();

    clearTimeout(internals.coverRetryTimerId!);
    internals.coverRetryTimerId = null;
    internals.pumpOperationQueue();
    await cover;
    await sql;
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(3);
    expect(wasmMock.execSql).toHaveBeenCalledOnce();
  });

  it('keeps cover and lifecycle work outside a SQL transaction', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();

    await api.exec('BEGIN IMMEDIATE');
    const cover = api.cover();
    const close = api.close();
    await Promise.resolve();
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    await api.exec('INSERT INTO userProfile VALUES (?)', ['inside'], true);
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();
    await api.exec('COMMIT', [], true);
    await cover;
    await close;

    expect(wasmMock.execSql.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN IMMEDIATE',
      'INSERT INTO userProfile VALUES (?)',
      'COMMIT',
    ]);
    expect(wasmMock.coverTrafficTick).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
  });

  it('retains outer transaction ownership through savepoint rollback', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();

    await api.exec('BEGIN IMMEDIATE');
    const cover = api.cover();
    const close = api.close();
    await api.exec('SAVEPOINT sp_0', [], true);
    await api.exec('INSERT INTO userProfile VALUES (?)', ['nested'], true);
    await api.exec('ROLLBACK TO SAVEPOINT sp_0', [], true);
    await Promise.resolve();
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    await api.exec('RELEASE SAVEPOINT sp_0', [], true);
    expect(wasmMock.coverTrafficTick).not.toHaveBeenCalled();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();
    await api.exec('COMMIT', [], true);
    await cover;
    await close;

    expect(wasmMock.execSql.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN IMMEDIATE',
      'SAVEPOINT sp_0',
      'INSERT INTO userProfile VALUES (?)',
      'ROLLBACK TO SAVEPOINT sp_0',
      'RELEASE SAVEPOINT sp_0',
      'COMMIT',
    ]);
    expect(wasmMock.coverTrafficTick).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
  });

  it('releases transaction ownership after a commented full rollback', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();

    await api.exec('BEGIN IMMEDIATE');
    const cover = api.cover();
    const close = api.close();
    await api.exec('ROLLBACK /* complete */ TRANSACTION; -- trace', [], true);
    await cover;
    await close;

    expect(wasmMock.coverTrafficTick).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
  });

  it('resets poisoned SQL state before releasing queued durable work', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const sqlError = new Error('rollback failed');
    wasmMock.execSql.mockImplementation((sql: string) => {
      if (/^ROLLBACK$/i.test(sql)) throw sqlError;
      return { rows: [], lastInsertRowId: 0, free: vi.fn() };
    });

    await api.exec('BEGIN IMMEDIATE');
    const cover = api.cover();
    const close = api.close();
    await expect(api.exec('ROLLBACK', [], true)).rejects.toBe(sqlError);
    await cover;
    await close;

    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledOnce();
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledBefore(
      wasmMock.coverTrafficTick
    );
    expect(wasmMock.coverTrafficTick).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
  });

  it('resets a committed SQL image after its durable flush rejects', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const flushError = new Error('commit flush failed');
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(flushError)
      .mockResolvedValue(undefined);
    wasmMock.execSql.mockImplementation((sql: string) => {
      if (/^ROLLBACK$/i.test(sql)) {
        throw new Error('no active transaction');
      }
      return { rows: [], lastInsertRowId: 0, free: vi.fn() };
    });

    await api.exec('BEGIN IMMEDIATE');
    await api.exec('INSERT INTO userProfile VALUES (?)', ['pending'], true);
    await expect(api.exec('COMMIT', [], true)).rejects.toBe(flushError);
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledOnce();
    await expect(api.exec('ROLLBACK', [], true)).rejects.toThrow(
      'no active transaction'
    );

    await api.close();
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledOnce();
    expect(wasmMock.closeDatabase).toHaveBeenCalledOnce();
  });

  it('resets a rejected autocommit mutation before later durable work', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const flushError = new Error('mutation flush failed');
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(flushError)
      .mockResolvedValue(undefined);

    await expect(
      api.exec('INSERT INTO userProfile VALUES (?)', ['rejected'])
    ).rejects.toBe(flushError);
    const cover = api.cover();
    await cover;
    await api.exec('UPDATE userProfile SET username = ?', ['durable']);

    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledOnce();
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledBefore(
      wasmMock.coverTrafficTick
    );
    expect(wasmMock.execSql).toHaveBeenCalledTimes(2);
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(3);
  });

  it('keeps poisoned SQL cleanup retryable after reset rejection', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const { SECURE_STORAGE_RECOVERY_REQUIRED } =
      await import('../../src/db/secure-storage-errors');
    const api = new SecureStorageWorkerApi();
    wasmMock.execSql.mockImplementation((sql: string) => {
      if (/^ROLLBACK$/i.test(sql)) throw new Error('rollback failed');
      return { rows: [], lastInsertRowId: 0, free: vi.fn() };
    });
    wasmMock.resetSqlDatabaseToDurable
      .mockRejectedValueOnce(new Error('reset failed'))
      .mockResolvedValueOnce(undefined);

    await api.exec('BEGIN IMMEDIATE');
    await expect(api.exec('ROLLBACK', [], true)).rejects.toThrow(
      SECURE_STORAGE_RECOVERY_REQUIRED
    );
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    await api.close();
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledTimes(2);
    expect(wasmMock.resetSqlDatabaseToDurable).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
  });

  it('allows an explicitly rejected generic flush to be retried', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('flush failed'))
      .mockResolvedValueOnce(undefined);

    await expect(api.flush()).rejects.toThrow('flush failed');
    await expect(api.flush()).resolves.toBeUndefined();
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'write',
      (api: {
        writeNamespaceData: SecureStorageWorkerApi['writeNamespaceData'];
      }) => api.writeNamespaceData(1, 0, new Uint8Array([1])),
      wasmMock.writeNamespaceData,
    ],
    [
      'clear',
      (api: { clearNamespace: SecureStorageWorkerApi['clearNamespace'] }) =>
        api.clearNamespace(1),
      wasmMock.clearNamespace,
    ],
    [
      'replace',
      (api: {
        replaceNamespaceData: SecureStorageWorkerApi['replaceNamespaceData'];
      }) => api.replaceNamespaceData(1, new Uint8Array([2])),
      wasmMock.clearNamespace,
    ],
  ])(
    'recovers durable state before namespace %s',
    async (_name, run, mutate) => {
      const { SecureStorageWorkerApi } =
        await import('../../src/db/secure-storage-worker-api');
      const api = new SecureStorageWorkerApi();
      (
        api as unknown as { durableRecoveryRequired: boolean }
      ).durableRecoveryRequired = true;
      let finishEarlierCover!: () => void;
      wasmMock.flushEncrypted
        .mockReturnValueOnce(
          new Promise<void>(resolve => {
            finishEarlierCover = resolve;
          })
        )
        .mockResolvedValueOnce(undefined);

      const earlierCover = api.cover();
      await vi.waitFor(() =>
        expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
      );
      const mutation = run(api);
      await Promise.resolve();
      expect(mutate).not.toHaveBeenCalled();

      finishEarlierCover();
      await earlierCover;
      await mutation;

      expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
      expect(mutate).toHaveBeenCalledOnce();
      expect(wasmMock.flushEncrypted.mock.invocationCallOrder[0]).toBeLessThan(
        mutate.mock.invocationCallOrder[0]
      );
    }
  );

  it('recovers rejected lifecycle state before a generic flush', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const { SECURE_STORAGE_RECOVERY_REQUIRED } =
      await import('../../src/db/secure-storage-errors');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('allocation flush failed'))
      .mockResolvedValueOnce(undefined);
    wasmMock.reloadDurableStorage
      .mockRejectedValueOnce(new Error('reload failed'))
      .mockResolvedValueOnce(undefined);

    await expect(api.create(0, new Uint8Array([1]))).rejects.toThrow(
      SECURE_STORAGE_RECOVERY_REQUIRED
    );
    await api.flush();

    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(2);
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
    expect(
      wasmMock.reloadDurableStorage.mock.invocationCallOrder[1]
    ).toBeLessThan(wasmMock.flushEncrypted.mock.invocationCallOrder[1]);
  });

  it('waits for create to finish before locking', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCreate!: () => void;
    wasmMock.flushEncrypted
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          finishCreate = resolve;
        })
      )
      .mockResolvedValueOnce(undefined);

    const create = api.create(0, new Uint8Array([1]));
    await vi.waitFor(() =>
      expect(wasmMock.allocateSession).toHaveBeenCalledOnce()
    );
    const lock = api.lock();
    await Promise.resolve();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    finishCreate();
    await create;
    await lock;

    expect(wasmMock.openDatabase).toHaveBeenCalledBefore(
      wasmMock.closeDatabase
    );
    expect(wasmMock.lockSession).toHaveBeenCalledOnce();
  });

  it('waits for accepted cover work before unlocking', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCover!: () => void;
    wasmMock.flushEncrypted.mockReturnValueOnce(
      new Promise<void>(resolve => {
        finishCover = resolve;
      })
    );
    wasmMock.unlockSession.mockReturnValue(false);

    const cover = api.cover();
    await vi.waitFor(() =>
      expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
    );
    const unlock = api.unlock(new Uint8Array([1]));
    await Promise.resolve();
    expect(wasmMock.unlockSession).not.toHaveBeenCalled();

    finishCover();
    await cover;
    await expect(unlock).resolves.toBe(false);
  });

  it('drains accepted cover work before closing', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    let finishCover!: () => void;
    wasmMock.flushEncrypted
      .mockReturnValueOnce(
        new Promise<void>(resolve => {
          finishCover = resolve;
        })
      )
      .mockResolvedValueOnce(undefined);

    const cover = api.cover();
    await vi.waitFor(() =>
      expect(wasmMock.coverTrafficTick).toHaveBeenCalled()
    );
    const close = api.close();
    await Promise.resolve();
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();
    await expect(api.cover()).rejects.toThrow(
      'Secure storage worker is closing'
    );

    finishCover();
    await cover;
    await close;
    expect(wasmMock.closeDatabase).toHaveBeenCalledOnce();
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('keeps close behind a failed cover retry', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('cover flush failed'))
      .mockResolvedValue(undefined);
    const internals = api as unknown as {
      coverRetryTimerId: ReturnType<typeof setTimeout> | null;
      pumpOperationQueue: () => void;
    };

    const cover = api.cover();
    const close = api.close();
    await vi.waitFor(() => expect(internals.coverRetryTimerId).not.toBeNull());
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    clearTimeout(internals.coverRetryTimerId!);
    internals.coverRetryTimerId = null;
    internals.pumpOperationQueue();
    await cover;
    await close;

    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(3);
    expect(wasmMock.closeDatabase).toHaveBeenCalledOnce();
  });

  it('recovers rejected lifecycle state before closing and permits retry', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const { SECURE_STORAGE_RECOVERY_REQUIRED } =
      await import('../../src/db/secure-storage-errors');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted
      .mockRejectedValueOnce(new Error('allocation flush failed'))
      .mockResolvedValue(undefined);
    wasmMock.reloadDurableStorage
      .mockRejectedValueOnce(new Error('first reload failed'))
      .mockRejectedValueOnce(new Error('close reload failed'))
      .mockResolvedValueOnce(undefined);

    await expect(api.create(0, new Uint8Array([1]))).rejects.toThrow(
      SECURE_STORAGE_RECOVERY_REQUIRED
    );
    await expect(api.close()).rejects.toThrow('close reload failed');
    expect(wasmMock.closeDatabase).not.toHaveBeenCalled();

    await api.close();
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(3);
    expect(wasmMock.closeDatabase).toHaveBeenCalledOnce();
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('reloads durable state after a rejected destroy flush', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    wasmMock.flushEncrypted.mockRejectedValueOnce(new Error('flush failed'));

    await expect(api.destroy(new Uint8Array([0, 1]))).rejects.toThrow(
      'flush failed'
    );

    expect(wasmMock.destroySession).toHaveBeenCalledOnce();
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
  });

  it('zeroes unlock password bytes when unlock throws', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker-api');
    const api = new SecureStorageWorkerApi();
    const password = new Uint8Array([4, 5, 6]);
    wasmMock.unlockSession.mockImplementation(() => {
      throw new Error('unlock failed');
    });

    await expect(api.unlock(password)).rejects.toThrow('unlock failed');

    expect(Array.from(password)).toEqual([0, 0, 0]);
  });
});
