/**
 * Regression tests for the session-persist debounce machinery. Exercises
 * the SDK through its public surface where possible and reaches into
 * the private state via narrow casts only for behaviors that have no
 * public hook (failure back-off, re-dirty during drain).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GossipSdk, SdkStatus } from '../../src/gossip';
import { clearAllTables, getTestStorageConfig } from '../testDb';
import { generateMnemonic } from '../../src/crypto/bip39';
import { MockMessageProtocol } from '../mocks';

vi.mock('../../src/api/messageProtocol', () => ({
  createMessageProtocol: () => new MockMessageProtocol(),
}));

vi.mock('../../src/api/authProtocol', () => ({
  createAuthProtocol: () => ({
    fetchPublicKeyByUserId: vi.fn().mockRejectedValue(new Error('not found')),
    postPublicKey: vi.fn().mockResolvedValue('ok'),
  }),
}));

/**
 * Narrow accessor for the private persist state. Kept here so the cast
 * is confined to one spot — the invariants tested below are the reason
 * those fields exist, and breaking them should fail the tests.
 */
type PersistInternals = {
  _persistDirty: boolean;
  _persistTimer: ReturnType<typeof setTimeout> | null;
  _persistInFlight: boolean;
  _persistBackoffMs: number;
  handleSessionPersist: () => void;
  flushPersist: () => Promise<void>;
};

function internals(sdk: GossipSdk): PersistInternals {
  return sdk as unknown as PersistInternals;
}

async function settle(ms = 5): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

describe('GossipSdk session persist (regression)', () => {
  let sdk: GossipSdk;

  beforeEach(async () => {
    await clearAllTables();
    vi.clearAllMocks();
    sdk = new GossipSdk();
  });

  afterEach(async () => {
    try {
      await sdk.destroy();
    } catch {
      // ignore
    }
  });

  it('arms a debounced timer on dirty — H4 baseline', async () => {
    await sdk.init({ storage: getTestStorageConfig() });
    sdk.setPersistDebounceMsForTesting(20);
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      onPersist: async () => {},
    });
    const s = internals(sdk);
    expect(s._persistTimer).toBe(null);
    s.handleSessionPersist();
    expect(s._persistDirty).toBe(true);
    expect(s._persistTimer).not.toBe(null);
  });

  it('applies exponential back-off on persist failure — H4', async () => {
    let fail = true;
    const onPersist = vi.fn(async () => {
      if (fail) throw new Error('boom');
    });
    await sdk.init({ storage: getTestStorageConfig() });
    sdk.setPersistDebounceMsForTesting(10);
    await sdk.openSession({ mnemonic: generateMnemonic(), onPersist });

    const s = internals(sdk);

    // Trigger a failing flush.
    s._persistDirty = true;
    await s.flushPersist();
    const first = s._persistBackoffMs;
    expect(first).toBeGreaterThan(0);

    // Second failure doubles (or at least grows).
    s._persistDirty = true;
    await s.flushPersist();
    expect(s._persistBackoffMs).toBeGreaterThan(first);

    // Recovery resets the back-off.
    fail = false;
    s._persistDirty = true;
    await s.flushPersist();
    expect(s._persistBackoffMs).toBe(0);
  });

  it('rejects shutdown rather than exporting stale session state', async () => {
    const onPersist = vi.fn(async () => {
      throw new Error('durable write failed');
    });
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic: generateMnemonic(), onPersist });
    internals(sdk)._persistDirty = true;

    await expect(sdk.closeSession()).rejects.toThrow(
      'Unable to durably persist the latest messaging session state'
    );
    expect(sdk.isSessionOpen).toBe(true);
    expect(internals(sdk)._persistDirty).toBe(true);
  });

  it('accepts a successful final bounded drain attempt', async () => {
    let attempts = 0;
    const onPersist = vi.fn(async () => {
      attempts += 1;
      if (attempts < 16) throw new Error('temporary durable failure');
    });
    await sdk.init({ storage: getTestStorageConfig() });
    await sdk.openSession({ mnemonic: generateMnemonic(), onPersist });
    internals(sdk)._persistDirty = true;

    await expect(sdk.closeSession()).resolves.toBeUndefined();
    expect(attempts).toBe(16);
    expect(internals(sdk)._persistDirty).toBe(false);
  });

  it('drains a persist re-dirtied during shutdown — H5', async () => {
    const writes: number[] = [];
    let call = 0;
    // First persist re-marks dirty (simulating another WASM callback
    // firing between the drain await and cleanup).
    const onPersist = vi.fn(async () => {
      call += 1;
      writes.push(call);
      if (call === 1) {
        internals(sdk)._persistDirty = true;
      }
    });

    await sdk.init({ storage: getTestStorageConfig() });
    sdk.setPersistDebounceMsForTesting(5);
    await sdk.openSession({ mnemonic: generateMnemonic(), onPersist });

    const s = internals(sdk);
    s._persistDirty = true;

    await sdk.closeSession();
    await settle();

    // The re-dirty during drain must be observed: at least two persist
    // calls, and after close the state must be clean.
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(s._persistDirty).toBe(false);
    expect(s._persistTimer).toBe(null);
  });
});

describe('portable export admission', () => {
  it('reserves SDK admission before asynchronous session shutdown', async () => {
    const sdk = new GossipSdk();
    let finishClose!: () => void;
    const closeSession = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishClose = resolve;
        })
    );
    const exportPortable = vi.fn(async () => {});
    Object.assign(sdk as unknown as Record<string, unknown>, {
      _conn: {
        isSecureStorage: true,
        storageState: 'locked',
        secureStorageExportPortableV1: exportPortable,
      },
      closeSessionInternal: closeSession,
    });

    const first = sdk.exportPortableV1(() => {});
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
    await expect(sdk.exportPortableV1(() => {})).rejects.toThrow(
      'Portable export is already active'
    );
    await expect(sdk.destroy()).rejects.toThrow(
      'Cannot destroy SDK during portable export'
    );
    finishClose();
    await first;
    expect(exportPortable).toHaveBeenCalledOnce();
    await expect(sdk.secureStorageUnlock('password')).rejects.toThrow(
      'This SDK runtime ended for portable export; reload first'
    );
  });

  it('forces the latest encrypted session into namespace 1 without a callback', async () => {
    const sdk = new GossipSdk();
    const blobs = [new Uint8Array([9, 8, 7]), new Uint8Array([6, 5, 4])];
    const persisted: Uint8Array[] = [];
    const conn = {
      isSecureStorage: true,
      storageState: 'unlocked',
      async secureStorageReplaceNamespaceData(
        _namespace: number,
        value: Uint8Array
      ) {
        persisted.push(value.slice());
        if (persisted.length === 1) internals(sdk)._persistDirty = true;
      },
      async secureStorageLock() {
        conn.storageState = 'locked';
      },
      async secureStorageExportPortableV1() {},
    };
    Object.assign(sdk as unknown as Record<string, unknown>, {
      _conn: conn,
      state: {
        status: SdkStatus.SESSION_OPEN,
        messageProtocol: {},
        config: {},
        session: {
          toEncryptedBlob: () => blobs.shift()!,
          dispose: vi.fn(),
        },
        encryptionKey: { free: vi.fn() },
        onPersist: undefined,
      },
    });

    await sdk.exportPortableV1(() => {});

    expect(persisted).toEqual([
      new Uint8Array([9, 8, 7]),
      new Uint8Array([6, 5, 4]),
    ]);
    expect(blobs).toHaveLength(0);
  });

  it('does not terminalize an empty installation on rejected export', async () => {
    const sdk = new GossipSdk();
    const secureStorageCreate = vi.fn(async () => {});
    Object.assign(sdk as unknown as Record<string, unknown>, {
      _conn: {
        isSecureStorage: true,
        storageState: 'empty',
        secureStorageCreate,
      },
    });

    await expect(sdk.exportPortableV1(() => {})).rejects.toThrow(
      'Portable export requires an existing locked installation'
    );
    await expect(
      sdk.secureStorageCreate(0, 'password')
    ).resolves.toBeUndefined();
    expect(secureStorageCreate).toHaveBeenCalledOnce();
  });

  it('rejects export when account creation reserved lifecycle first', async () => {
    const sdk = new GossipSdk();
    let finishCreate!: () => void;
    const secureStorageCreate = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishCreate = resolve;
        })
    );
    Object.assign(sdk as unknown as Record<string, unknown>, {
      _conn: {
        isSecureStorage: true,
        storageState: 'locked',
        secureStorageCreate,
      },
    });

    const create = sdk.secureStorageCreate(0, 'password');
    await vi.waitFor(() => expect(secureStorageCreate).toHaveBeenCalledOnce());
    await expect(sdk.exportPortableV1(() => {})).rejects.toThrow(
      'SDK lifecycle operation is already active'
    );
    await expect(sdk.destroy()).rejects.toThrow(
      'SDK lifecycle operation is already active'
    );
    finishCreate();
    await create;
  });

  it('rejects export when session shutdown reserved lifecycle first', async () => {
    const sdk = new GossipSdk();
    let finishClose!: () => void;
    const closeSessionInternal = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishClose = resolve;
        })
    );
    Object.assign(sdk as unknown as Record<string, unknown>, {
      _conn: { isSecureStorage: true, storageState: 'locked' },
      closeSessionInternal,
    });

    const close = sdk.closeSession();
    await vi.waitFor(() => expect(closeSessionInternal).toHaveBeenCalledOnce());
    await expect(sdk.exportPortableV1(() => {})).rejects.toThrow(
      'SDK lifecycle operation is already active'
    );
    finishClose();
    await close;
  });
});

describe('persistSessionBlob plausible-deniability (regression)', () => {
  it('routes every persist through the atomic replace — PD-M2', async () => {
    // The PD invariant (no block-count side-channel between persists) now
    // rides on `secureStorageReplaceNamespaceData`, whose implementation
    // always stages a wipe before the write. Asserting that every persist
    // call hits this single fused primitive — regardless of whether the
    // new blob is larger, smaller, or the same size as the previous one
    // — is what guards the invariant at this layer.
    const calls: Array<{ namespace: number; len: number }> = [];
    const fakeConn = {
      isSecureStorage: true,
      async secureStorageReplaceNamespaceData(
        namespace: number,
        data: Uint8Array
      ) {
        calls.push({ namespace, len: data.byteLength });
      },
    };

    const sdk = new GossipSdk();
    (sdk as unknown as { _conn: unknown })._conn = fakeConn;

    await sdk.persistSessionBlob(new Uint8Array(2048));
    await sdk.persistSessionBlob(new Uint8Array(128));

    expect(calls).toHaveLength(2);
    expect(calls[0].len).toBe(2048);
    expect(calls[1].len).toBe(128);
    // Both writes target the session-blob namespace.
    expect(new Set(calls.map(c => c.namespace)).size).toBe(1);
  });
});
