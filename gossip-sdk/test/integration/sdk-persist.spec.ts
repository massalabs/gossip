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
