/**
 * Size of the blob posted for a group plaintext: the plaintext is wrapped in a
 * keep-alive and encrypted in the one-to-one session, and the ciphertext goes
 * to the transport as the mesh payload. Two in-process SDKs, real sessions,
 * an in-memory transport; no backend is used.
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

/**
 * Candidate cap on a group plaintext (56 KiB). The value is under decision:
 * the test checks that it would fit, not that it is enforced.
 */
const CANDIDATE_GROUP_PLAINTEXT_MAX = 57_344;
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

const SIZES = [
  0,
  1,
  1_000,
  16_384,
  CANDIDATE_GROUP_PLAINTEXT_MAX - 1,
  CANDIDATE_GROUP_PLAINTEXT_MAX,
  60_000,
];

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
 * own path runs: keep-alive wrapping, session encryption, session persist,
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
        for (const size of SIZES) {
          const blob = await blobSize(from, to, size);
          overheads.push(blob - size);
          rows.push(
            `round ${round} ${dir} payload ${size} blob ${blob} overhead ${blob - size}`
          );
          if (size === CANDIDATE_GROUP_PLAINTEXT_MAX) {
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
    expect(CANDIDATE_GROUP_PLAINTEXT_MAX + max).toBeLessThanOrEqual(
      MESH_PAYLOAD_MAX
    );
  });
});
