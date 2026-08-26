import { describe, expect, it, vi } from 'vitest';
import {
  classifyStatement,
  DatabaseConnection,
  SecureStorageRecoveryRequiredError,
} from '../../src/db/sqlite';
import { SECURE_STORAGE_RECOVERY_REQUIRED } from '../../src/db/secure-storage-errors';
import { getTestConnection } from '../testDb';

type RawConnection = {
  execRaw(sql: string, params?: unknown[]): Promise<unknown[][]>;
  execRawDirect(sql: string, params?: unknown[]): Promise<unknown[][]>;
};

function rawConnection(): RawConnection {
  return getTestConnection() as unknown as RawConnection;
}

type LifecycleProxy = {
  create: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function lifecycleConnection(proxy: LifecycleProxy): DatabaseConnection {
  const connection = Object.create(
    DatabaseConnection.prototype
  ) as DatabaseConnection;
  const internals = connection as unknown as {
    state: {
      drizzleDb: unknown;
      storageState: 'empty' | 'locked' | 'unlocked';
      useNativePlugin: boolean;
      secureProxy: LifecycleProxy;
    };
  };
  internals.state = {
    drizzleDb: {},
    storageState: 'locked',
    useNativePlugin: false,
    secureProxy: proxy,
  };
  return connection;
}

describe('DatabaseConnection secure lifecycle recovery', () => {
  it('retains failed portable install ownership until cleanup succeeds', async () => {
    const proxy = {
      installPortableImport: vi
        .fn()
        .mockRejectedValue(new Error('install failed')),
      abortPortableTransfer: vi.fn().mockResolvedValue(undefined),
    };
    const connection = Object.create(
      DatabaseConnection.prototype
    ) as DatabaseConnection;
    const internals = connection as unknown as {
      state: {
        storageState: 'locked';
        useNativePlugin: false;
        secureProxy: typeof proxy;
        portableTransferActive: boolean;
      };
    };
    internals.state = {
      storageState: 'locked',
      useNativePlugin: false,
      secureProxy: proxy,
      portableTransferActive: true,
    };

    await expect(
      connection.secureStorageInstallPortableImport()
    ).rejects.toThrow('install failed');
    expect(internals.state.portableTransferActive).toBe(true);

    await connection.secureStorageAbortPortableImport();
    expect(proxy.abortPortableTransfer).toHaveBeenCalledOnce();
    expect(internals.state.portableTransferActive).toBe(false);
  });

  it('re-locks when post-unlock migration validation rejects', async () => {
    const unlock = vi.fn().mockResolvedValue(true);
    const lock = vi.fn().mockResolvedValue(undefined);
    const connection = lifecycleConnection({
      create: vi.fn(),
      unlock,
      lock,
      destroy: vi.fn(),
    });
    const finalizeError = new Error('Unsupported database migration history');
    (connection as unknown as { finalize: () => Promise<void> }).finalize = vi
      .fn()
      .mockRejectedValue(finalizeError);

    await expect(connection.secureStorageUnlock('password')).rejects.toBe(
      finalizeError
    );
    expect(lock).toHaveBeenCalledOnce();
    expect(connection.storageState).toBe('locked');
  });

  it('keeps a rejected underlying lock retryable', async () => {
    const lock = vi
      .fn()
      .mockRejectedValueOnce(new Error('flush failed'))
      .mockResolvedValueOnce(undefined);
    const connection = lifecycleConnection({
      create: vi.fn(),
      unlock: vi.fn(),
      lock,
      destroy: vi.fn(),
    });
    const state = connection as unknown as {
      state: { storageState: string };
    };
    state.state.storageState = 'unlocked';

    await expect(connection.secureStorageLock()).rejects.toThrow(
      'flush failed'
    );
    expect(connection.storageState).toBe('unlocked');

    await expect(connection.secureStorageLock()).resolves.toBeUndefined();
    expect(lock).toHaveBeenCalledTimes(2);
    expect(connection.storageState).toBe('locked');
  });

  it('destroys a new slot when post-create migration validation rejects', async () => {
    const finalizeError = new Error('Unsupported database migration history');
    const destroy = vi.fn().mockResolvedValue(undefined);
    const connection = lifecycleConnection({
      create: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn(),
      lock: vi.fn(),
      destroy,
    });
    (connection as unknown as { finalize: () => Promise<void> }).finalize = vi
      .fn()
      .mockRejectedValue(finalizeError);

    await expect(
      connection.secureStorageCreate(0, 'test-password')
    ).rejects.toBe(finalizeError);
    expect(destroy).toHaveBeenCalledWith(Uint8Array.from([0, 1]));
    expect(connection.storageState).toBe('locked');
  });

  it('surfaces worker allocation recovery as a typed error', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new Error(`${SECURE_STORAGE_RECOVERY_REQUIRED} reload failed`)
      );
    const connection = lifecycleConnection({
      create,
      unlock: vi.fn(),
      lock: vi.fn(),
      destroy: vi.fn(),
    });

    await expect(
      connection.secureStorageCreate(0, 'test-password')
    ).rejects.toBeInstanceOf(SecureStorageRecoveryRequiredError);
    expect(connection.storageState).toBe('unlocked');
  });
});

describe('DatabaseConnection transaction classification', () => {
  it.each([
    'ROLLBACK',
    'ROLLBACK TRANSACTION;',
    'ROLLBACK; -- trace',
    'ROLLBACK TRANSACTION /* reason */',
    '/* before */ ROLLBACK /* middle */ TRANSACTION; -- after',
  ])('recognizes a complete rollback boundary: %s', sql => {
    expect(classifyStatement(sql)).toBe('rollback');
  });

  it.each([
    ['\u00a0BEGIN IMMEDIATE\u00a0', 'begin'],
    ['\ufeffCOMMIT\ufeff', 'commit'],
    ['END TRANSACTION; -- alias', 'commit'],
    ['SAVEPOINT outer', 'savepoint'],
    ['ANALYZE userProfile', 'mutation'],
    ['REINDEX', 'mutation'],
    ['\u0085BEGIN', 'other'],
    ['COMMIT\u0085', 'other'],
    [';;BEGIN', 'other'],
    ["; /* empty */ UPDATE user_profile SET username = 'ignored'", 'other'],
    ['BEGIN -- trace\rROLLBACK', 'begin'],
    ['ROLLBACK -- trace\rTO SAVEPOINT ignored', 'rollback'],
    ['BEGIN -- trace\r\nROLLBACK', 'other'],
    ['BEGIN IMMEDIATE /* terminated by EOF', 'begin'],
    ['COMMIT; /* terminated by EOF', 'commit'],
    ['ROLLBACK /* terminated by EOF', 'rollback'],
    [
      "UPDATE userProfile SET username = 'changed' /* terminated by EOF",
      'mutation',
    ],
  ] as const)(
    'matches the Rust SQL boundary contract for %j',
    (sql, expected) => {
      expect(classifyStatement(sql)).toBe(expected);
    }
  );

  it('tracks commit aliases and nested savepoint rollbacks through real SQLite', async () => {
    const connection = getTestConnection();
    const state = connection as unknown as { state: { txDepth: number } };

    await connection.execRawDirect('BEGIN IMMEDIATE');
    await connection.execRawDirect('END TRANSACTION; -- release outer');
    expect(state.state.txDepth).toBe(0);

    await connection.execRawDirect('BEGIN IMMEDIATE');
    await connection.execRawDirect('SAVEPOINT sp_comment');
    await connection.execRawDirect(
      'ROLLBACK /* nested */ TO SAVEPOINT sp_comment; -- keep outer'
    );
    expect(state.state.txDepth).toBe(1);
    await connection.execRawDirect('RELEASE SAVEPOINT sp_comment');
    await connection.execRawDirect('ROLLBACK TRANSACTION; -- release outer');
    expect(state.state.txDepth).toBe(0);
  });

  it('rejects an outermost savepoint while preserving nested savepoints', async () => {
    const connection = getTestConnection();
    await expect(connection.execRawDirect('SAVEPOINT outer')).rejects.toThrow(
      'Top-level savepoints are not supported'
    );

    await connection.execRawDirect('BEGIN IMMEDIATE');
    await expect(connection.execRawDirect('SAVEPOINT nested')).resolves.toEqual(
      []
    );
    await connection.execRawDirect('RELEASE SAVEPOINT nested');
    await connection.execRawDirect('ROLLBACK');
  });

  it.each([
    'ROLLBACK TO SAVEPOINT sp_0',
    'ROLLBACK TRANSACTION TO sp_0',
    'ROLLBACK /* keep ownership */ TO SAVEPOINT sp_0; -- nested',
    'ROLLBACK LATER',
    'ROLLBACK; SELECT 1',
    "SELECT 'ROLLBACK; -- data'",
  ])('does not release ownership for a rollback lookalike: %s', sql => {
    expect(classifyStatement(sql)).toBe('other');
  });
});

describe('DatabaseConnection transaction callback guards', () => {
  it('rejects reentrant secure-storage operations without closing the transaction', async () => {
    const connection = getTestConnection();
    const error =
      'Secure storage operations are not allowed inside a transaction callback';
    const operations = [
      () => connection.secureStorageProvision(),
      () => connection.secureStorageCreate(0, 'password'),
      () => connection.secureStorageUnlock('password'),
      () => connection.secureStorageLock(),
      () => connection.secureStorageDestroy([0, 1]),
      () => connection.secureStorageCoverTick(),
      () => connection.secureStorageFlush(),
      () => connection.secureStorageWriteNamespaceData(1, 0, new Uint8Array()),
      () => connection.secureStorageClearNamespace(1),
      () => connection.secureStorageReplaceNamespaceData(1, new Uint8Array()),
      () => connection.close(),
    ];

    await connection.withTransaction(async () => {
      for (const operation of operations) {
        await expect(operation()).rejects.toThrow(error);
      }
    });
    await expect(
      connection.withTransaction(async () => undefined)
    ).resolves.toBeUndefined();
  });

  it('does not flush a native backend reentrantly before commit', async () => {
    const execSql = vi.fn(async () => ({ rows: [], lastInsertRowId: 0 }));
    const flush = vi.fn(async () => undefined);
    const readNamespaceData = vi.fn(async () => ({
      data: new Uint8Array([4, 2]),
    }));
    const namespaceDataLength = vi.fn(async () => ({ length: 2 }));
    const connection = Object.create(
      DatabaseConnection.prototype
    ) as DatabaseConnection;
    const internals = connection as unknown as {
      state: Record<string, unknown>;
    };
    internals.state = {
      worker: null,
      msgId: 0,
      pending: new Map(),
      lastInsertRowIdCache: 0,
      sqlite3: null,
      dbHandle: null,
      useWorker: false,
      isSecureStorage: true,
      storageState: 'unlocked',
      drizzleDb: null,
      dbLock: Promise.resolve(),
      txScopeGuard: null,
      transactionCallbackDepth: 0,
      txDepth: 0,
      secureProxy: null,
      nativePlugin: {
        execSql,
        flush,
        readNamespaceData,
        namespaceDataLength,
      },
      useNativePlugin: true,
    };

    await connection.withTransaction(async () => {
      await expect(
        connection.secureStorageReadNamespaceData(1, 0, 2)
      ).resolves.toEqual(new Uint8Array([4, 2]));
      await expect(
        connection.secureStorageNamespaceDataLength(1)
      ).resolves.toBe(2);
      await expect(connection.secureStorageFlush()).rejects.toThrow(
        'Secure storage operations are not allowed inside a transaction callback'
      );
      expect(flush).not.toHaveBeenCalled();
    });

    expect(flush).toHaveBeenCalledOnce();

    const raw = connection as unknown as RawConnection;
    await raw.execRawDirect('ANALYZE');
    await raw.execRawDirect('REINDEX');
    await raw.execRawDirect('BEGIN IMMEDIATE');
    await raw.execRawDirect('END TRANSACTION');
    await expect(raw.execRawDirect('SAVEPOINT outer')).rejects.toThrow(
      'Top-level savepoints are not supported'
    );

    expect(execSql.mock.calls.map(([request]) => request.sql)).toEqual([
      'BEGIN IMMEDIATE',
      'COMMIT',
      'ANALYZE',
      'REINDEX',
      'BEGIN IMMEDIATE',
      'END TRANSACTION',
    ]);
    expect(flush).toHaveBeenCalledTimes(4);
  });
});

describe('DatabaseConnection raw execution guards', () => {
  it('rejects undefined bind params on the public raw path', async () => {
    await expect(
      rawConnection().execRaw('SELECT ?', [undefined])
    ).rejects.toThrow(
      'SQLite bind param at index 0 is undefined; pass null explicitly if NULL is intended'
    );
  });

  it('rejects undefined bind params on the direct transaction path', async () => {
    await expect(
      rawConnection().execRawDirect('SELECT ?', [undefined])
    ).rejects.toThrow(
      'SQLite bind param at index 0 is undefined; pass null explicitly if NULL is intended'
    );
  });

  it('allows explicit null bind params', async () => {
    const rows = await rawConnection().execRawDirect('SELECT ? IS NULL', [
      null,
    ]);

    expect(rows).toEqual([[1]]);
  });
});
