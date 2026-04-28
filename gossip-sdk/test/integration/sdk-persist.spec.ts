/**
 * Regression tests for the session-persist debounce machinery. Exercises
 * the SDK through its public surface where possible and reaches into
 * the private state via narrow casts only for behaviors that have no
 * public hook (failure back-off, re-dirty during drain).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GossipSdk } from '../../src/gossip';
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

describe('persistSessionBlob plausible-deniability (regression)', () => {
  it('always clears before write so block count never leaks direction — PD-M2', async () => {
    const events: string[] = [];
    const fakeConn = {
      isSecureStorage: true,
      async secureStorageNamespaceDataLength() {
        events.push('len');
        return 1024;
      },
      async secureStorageClearNamespace() {
        events.push('clear');
      },
      async secureStorageWriteNamespaceData() {
        events.push('write');
      },
    };

    const sdk = new GossipSdk();
    (sdk as unknown as { _conn: unknown })._conn = fakeConn;

    // Larger blob (old logic would NOT clear).
    await sdk.persistSessionBlob(new Uint8Array(2048));
    // Smaller blob.
    await sdk.persistSessionBlob(new Uint8Array(128));

    const clearCount = events.filter(e => e === 'clear').length;
    expect(clearCount).toBe(2);
    // Clear precedes each write.
    const writeIndexes = events
      .map((e, i) => (e === 'write' ? i : -1))
      .filter(i => i >= 0);
    for (const wi of writeIndexes) {
      expect(events[wi - 1]).toBe('clear');
    }
  });
});
