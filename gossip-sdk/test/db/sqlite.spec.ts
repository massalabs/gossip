import { describe, expect, it, vi } from 'vitest';
import {
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
  lock: ReturnType<typeof vi.fn>;
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
  it('keeps a rejected underlying lock retryable', async () => {
    const lock = vi
      .fn()
      .mockRejectedValueOnce(new Error('flush failed'))
      .mockResolvedValueOnce(undefined);
    const connection = lifecycleConnection({ create: vi.fn(), lock });
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

  it('surfaces worker allocation recovery as a typed error', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        new Error(`${SECURE_STORAGE_RECOVERY_REQUIRED} reload failed`)
      );
    const connection = lifecycleConnection({ create, lock: vi.fn() });

    await expect(
      connection.secureStorageCreate(0, 'test-password')
    ).rejects.toBeInstanceOf(SecureStorageRecoveryRequiredError);
    expect(connection.storageState).toBe('unlocked');
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
