import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COVER_TRAFFIC_NAMESPACES } from '../../src/db/secure-storage-namespaces';

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
  });

  it('reloads durable state and zeroes the password when allocation throws', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker');
    const api = new SecureStorageWorkerApi();
    const password = new Uint8Array([1, 2, 3]);
    wasmMock.allocateSession.mockImplementation(() => {
      throw new Error('allocate failed');
    });

    await expect(api.create(0, password)).rejects.toThrow('allocate failed');

    expect(Array.from(password)).toEqual([0, 0, 0]);
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
  });

  it('waits for an active cover flush before allocation starts', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker');
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
      await import('../../src/db/secure-storage-worker');
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
      await import('../../src/db/secure-storage-worker');
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
      await import('../../src/db/secure-storage-worker');
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
    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledOnce();
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
      await import('../../src/db/secure-storage-worker');
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

    wasmMock.unlockSession.mockReturnValue(false);
    await expect(api.unlock(new Uint8Array([1]))).resolves.toBe(false);
    await cover;

    expect(wasmMock.reloadDurableStorage).toHaveBeenCalledTimes(3);
    expect(wasmMock.coverTrafficTick.mock.calls.map(([ns]) => ns)).toEqual(
      COVER_TRAFFIC_NAMESPACES
    );
    expect(wasmMock.flushEncrypted).toHaveBeenCalledTimes(2);
  });

  it('reloads durable state after a rejected create flush', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker');
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
      await import('../../src/db/secure-storage-worker');
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

  it('reloads durable state after a rejected destroy flush', async () => {
    const { SecureStorageWorkerApi } =
      await import('../../src/db/secure-storage-worker');
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
      await import('../../src/db/secure-storage-worker');
    const api = new SecureStorageWorkerApi();
    const password = new Uint8Array([4, 5, 6]);
    wasmMock.unlockSession.mockImplementation(() => {
      throw new Error('unlock failed');
    });

    await expect(api.unlock(password)).rejects.toThrow('unlock failed');

    expect(Array.from(password)).toEqual([0, 0, 0]);
  });
});
