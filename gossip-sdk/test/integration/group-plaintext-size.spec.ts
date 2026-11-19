/**
 * Size of the blob posted for a group plaintext: the plaintext is wrapped in a
 * session message of the group type and encrypted in the session, and the
 * ciphertext goes to the transport as the mesh payload. Two in-process SDKs,
 * real sessions, an in-memory transport; no backend is used.
 *
 * Measured: an overhead of 3,625 to 3,632 bytes, so the largest plaintext that
 * fits 65,536 bytes at the worst overhead is 61,904 bytes (it was 3,628 to
 * 3,634 inside a keep-alive, which also wrote an empty content field).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { decodeUserId } from '../../src/utils/userId';
import type { EncryptedMessage } from '../../src/api/messageProtocol/types';
import { group_max_plaintext_bytes } from '../../src/wasm/bindings';
import {
  SESSION_MESSAGE_MAX_BYTES,
  SessionMessageTooLargeError,
  type SessionModule,
} from '../../src/wasm/session';

/** Largest payload of a mesh blob. */
const MESH_PAYLOAD_MAX = 65_536;
/** Bound on the constant overhead of the wrapping and session encryption. */
const OVERHEAD_MAX = 8_192;
/**
 * Spread allowed between overheads: the length prefixes (protobuf and bincode
 * varints) grow with the plaintext, and the next seeker keypair travels as two
 * base58 strings that are at most 52 characters each and now and then a
 * character or two shorter (shorter only lowers the overhead).
 * Nothing else rides in the encrypted message: acknowledgements and heights
 * are implied by the seekers and the ratchet, not carried.
 */
const OVERHEAD_SPREAD_MAX = 16;

/** The engine's cap on a group plaintext (§13.10), read once wasm is loaded. */
let groupPlaintextMax = 0;

let clock = 1_800_000_000_000;

async function openPeer(net: MockMessageProtocol): Promise<GossipSdk> {
  const sdk = new GossipSdk();
  await sdk.init({ storage: getTestStorageConfig(), messageProtocol: net });
  await sdk.openSession({
    mnemonic: generateMnemonic(),
    encryptionKey: await generateEncryptionKey(),
    onPersist: async () => {},
    autoStartPolling: false,
    publishPublicKey: false,
  });
  (sdk.groups as unknown as { now: () => number }).now = () => clock;
  return sdk;
}

/** The group service's private parts this test drives. */
interface Internals {
  node: unknown;
  sendOne: (
    node: unknown,
    o: { handle: number; to: Uint8Array; plaintext: Uint8Array }
  ) => Promise<boolean>;
}

/**
 * Stands in for the group engine around one plaintext, so that the service's
 * own path runs: group-type wrapping, session encryption, session persist,
 * outbox row, transport.
 */
const fakeNode = {
  is_current: () => true,
  abandon: () => undefined,
  set_session: () => undefined,
  handed_off: () => undefined,
  published: () => undefined,
  take_batches: () => [],
};

describe('Group plaintext size on the wire', { timeout: 300_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let posted: EncryptedMessage[];

  beforeAll(async () => {
    await ensureWasmInitialized();
    groupPlaintextMax = group_max_plaintext_bytes();
  });

  beforeEach(async () => {
    net = new MockMessageProtocol();
    posted = [];
    const send = net.sendMessage.bind(net);
    vi.spyOn(net, 'sendMessage').mockImplementation(async m => {
      posted.push(m);
      await send(m);
    });
    alice = await openPeer(net);
    bob = await openPeer(net);
    await setupSession(alice, bob, 'Bob', 'Alice');
  }, 120_000);

  afterEach(async () => {
    await alice.closeSession();
    await bob.closeSession();
  });

  /**
   * Sends one group plaintext from `from` to `to` through the service and
   * returns the size of the blob the transport received.
   */
  async function blobSize(
    from: GossipSdk,
    to: GossipSdk,
    size: number
  ): Promise<number> {
    const groups = from.groups as unknown as Internals;
    const plaintext = new Uint8Array(size).fill(0xa5);
    const before = posted.length;
    const real = groups.node;
    groups.node = fakeNode;
    try {
      const ok = await groups.sendOne(fakeNode, {
        handle: 0,
        to: decodeUserId(to.userId),
        plaintext,
      });
      expect(ok).toBe(true);
    } finally {
      groups.node = real;
    }
    expect(posted.length).toBe(before + 1);
    // The peer reads it, so the session moves on as it would in use.
    clock += 1_000;
    await to.messages.fetch();
    return posted[posted.length - 1].ciphertext.length;
  }

  it('adds a constant overhead, in both directions and as the session moves', async () => {
    expect(groupPlaintextMax).toBe(57_344);
    // The last one is over the cap: the transport would carry it, the engine
    // never produces it.
    const sizes = [
      0,
      1,
      1_000,
      16_384,
      groupPlaintextMax - 1,
      groupPlaintextMax,
      60_000,
    ];
    const overheads: number[] = [];
    const rows: string[] = [];
    const pairs: [GossipSdk, GossipSdk, string][] = [
      [alice, bob, 'alice->bob'],
      [bob, alice, 'bob->alice'],
    ];

    // Several rounds: the first right after the session is set up, later ones
    // after many messages each way (heights, acknowledgements, seeker
    // refreshes drawn one time in a few).
    for (let round = 0; round < 3; round++) {
      for (const [from, to, dir] of pairs) {
        for (const size of sizes) {
          const blob = await blobSize(from, to, size);
          overheads.push(blob - size);
          rows.push(
            `round ${round} ${dir} payload ${size} blob ${blob} overhead ${blob - size}`
          );
          if (size === groupPlaintextMax) {
            expect(blob).toBeLessThanOrEqual(MESH_PAYLOAD_MAX);
          }
        }
      }
      // Messages one way only, so the next round starts with the peer lagging.
      for (let i = 0; i < 5; i++) await blobSize(alice, bob, 100);
    }

    // Many small ones each way, for the spread that does not depend on size.
    const small: number[] = [];
    for (let i = 0; i < 40; i++) {
      const [from, to] = i % 3 === 0 ? [bob, alice] : [alice, bob];
      small.push((await blobSize(from, to, 0)) - 0);
    }

    const all = [...overheads, ...small];
    const min = Math.min(...all);
    const max = Math.max(...all);
    console.log(
      [
        ...rows,
        `overhead min ${min} max ${max} (small payloads: min ${Math.min(...small)} max ${Math.max(...small)})`,
        `largest plaintext within ${MESH_PAYLOAD_MAX} at the worst overhead seen: ${MESH_PAYLOAD_MAX - max}`,
      ].join('\n')
    );

    expect(max).toBeLessThanOrEqual(OVERHEAD_MAX);
    expect(max - min).toBeLessThanOrEqual(OVERHEAD_SPREAD_MAX);
    // The largest plaintext the engine produces fits at the worst overhead.
    expect(groupPlaintextMax + max).toBeLessThanOrEqual(MESH_PAYLOAD_MAX);
  });

  /**
   * §13.10: nothing is handed to a session for encryption unless it is known
   * to fit the packet ceiling once encrypted, since encryption advances the
   * session. The bound is the ceiling minus the largest overhead of the
   * session layer.
   */
  it('refuses before encryption a session message that may not fit one packet', async () => {
    expect(SESSION_MESSAGE_MAX_BYTES).toBe(MESH_PAYLOAD_MAX - 3_632);
    const session = (alice as unknown as { state: { session: SessionModule } })
      .state.session;
    const manager = (
      session as unknown as {
        sessionManager: { send_message: (...a: unknown[]) => unknown };
      }
    ).sessionManager;
    const encrypt = vi.spyOn(manager, 'send_message');
    const peer = decodeUserId(bob.userId);

    await expect(
      session.sendMessage(peer, new Uint8Array(SESSION_MESSAGE_MAX_BYTES + 1))
    ).rejects.toBeInstanceOf(SessionMessageTooLargeError);
    expect(encrypt).not.toHaveBeenCalled();

    // At the bound it is encrypted, and the ciphertext fits one packet.
    const out = await session.sendMessage(
      peer,
      new Uint8Array(SESSION_MESSAGE_MAX_BYTES).fill(7)
    );
    expect(encrypt).toHaveBeenCalledOnce();
    expect(out!.data.length).toBeLessThanOrEqual(MESH_PAYLOAD_MAX);
    encrypt.mockRestore();
    // The session did not move for the refused one: the peer reads the
    // accepted one, then the next.
    const bobSession = (bob as unknown as { state: { session: SessionModule } })
      .state.session;
    const read = bobSession.feedIncomingMessageBoardRead.bind(bobSession);
    const reads: number[] = [];
    vi.spyOn(bobSession, 'feedIncomingMessageBoardRead').mockImplementation(
      async (seeker, ciphertext) => {
        const r = await read(seeker, ciphertext);
        if (r) reads.push(r.message.length);
        return r;
      }
    );
    await net.sendMessage({ seeker: out!.seeker, ciphertext: out!.data });
    clock += 1_000;
    await bob.messages.fetch();
    expect(reads).toEqual([SESSION_MESSAGE_MAX_BYTES]);
    await blobSize(alice, bob, 100);
    expect(reads.length).toBe(2);
  });

  it('a group send over the bound is abandoned, never encrypted', async () => {
    const groups = alice.groups as unknown as Internals;
    const abandon = vi.fn();
    const node = { ...fakeNode, abandon };
    const real = groups.node;
    groups.node = node;
    const before = posted.length;
    try {
      const ok = await groups.sendOne(node, {
        handle: 7,
        to: decodeUserId(bob.userId),
        plaintext: new Uint8Array(SESSION_MESSAGE_MAX_BYTES),
      });
      expect(ok).toBe(false);
    } finally {
      groups.node = real;
    }
    expect(abandon).toHaveBeenCalledWith(7);
    expect(posted.length).toBe(before);
  });
});
