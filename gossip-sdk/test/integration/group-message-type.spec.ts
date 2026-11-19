/**
 * Group traffic has its own session message type (§2.1, §13.1): a group
 * plaintext is handed to the group engine only when it comes under the group
 * type, and a keep-alive carries nothing. Two in-process SDKs, real sessions,
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
import { SdkEventType } from '../../src/core/SdkEventEmitter';
import { MessageType, MESSAGE_ID_SIZE } from '../../src/db';
import type { Queries } from '../../src/db/queries';
import { serializeKeepAliveMessage } from '../../src/utils/messageSerialization';
import {
  Message as ProtoMessage,
  MessageType as ProtoMessageType,
} from '../../src/proto/generated/message';

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
  return sdk;
}

/** The session the group service sends through. */
interface Internals {
  session: {
    sendMessage: (
      peer: Uint8Array,
      message: Uint8Array
    ) => Promise<{ seeker: Uint8Array; data: Uint8Array } | undefined>;
  };
}

const queriesOf = (sdk: GossipSdk) =>
  (sdk as unknown as { _queries: Queries })._queries;

describe('Group session message type', { timeout: 120_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let received: unknown[];
  let handed: [Uint8Array, Uint8Array][];

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  beforeEach(async () => {
    net = new MockMessageProtocol();
    alice = await openPeer(net);
    bob = await openPeer(net);
    await setupSession(alice, bob, 'Bob', 'Alice');
    received = [];
    bob.on(SdkEventType.MESSAGE_RECEIVED, m => received.push(m));
    handed = [];
    vi.spyOn(bob.groups, 'handlePlaintext').mockImplementation(
      async (from, plaintext) => {
        handed.push([from, plaintext]);
      }
    );
  }, 120_000);

  afterEach(async () => {
    await alice.closeSession();
    await bob.closeSession();
  });

  /** Encrypts `bytes` in Alice's session with Bob, posts it, Bob fetches. */
  async function sendRaw(bytes: Uint8Array): Promise<void> {
    const session = (alice.groups as unknown as Internals).session;
    const sent = await session.sendMessage(bob.userIdBytes, bytes);
    if (!sent) throw new Error('the session did not encrypt');
    await net.sendMessage({ seeker: sent.seeker, ciphertext: sent.data });
    await bob.messages.fetch();
  }

  /** Bob's one-to-one rows with Alice. */
  async function rows() {
    return queriesOf(bob).messages.getByOwnerAndContact(
      bob.userId,
      alice.userId
    );
  }

  const plaintext = new Uint8Array([1, 2, 3, 4]);

  it('hands a group plaintext under the group type to the engine, and nothing else', async () => {
    const before = (await rows()).length;
    await sendRaw(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_GROUP,
        groupPlaintext: plaintext,
      })
    );
    expect(handed).toHaveLength(1);
    expect(handed[0][0]).toEqual(alice.userIdBytes);
    expect(handed[0][1]).toEqual(plaintext);
    expect((await rows()).length).toBe(before);
    expect(received).toEqual([]);
  });

  it('ignores a group message without a plaintext', async () => {
    const before = (await rows()).length;
    await sendRaw(
      ProtoMessage.encode({ messageType: ProtoMessageType.MESSAGE_TYPE_GROUP })
    );
    expect(handed).toEqual([]);
    expect((await rows()).length).toBe(before);
    expect(received).toEqual([]);
  });

  it('does not read a group plaintext carried by a keep-alive', async () => {
    const before = (await rows()).length;
    await sendRaw(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_KEEP_ALIVE,
        content: '',
        groupPlaintext: plaintext,
      })
    );
    expect(handed).toEqual([]);
    expect((await rows()).length).toBe(before);
    expect(received).toEqual([]);
  });

  it('stores nothing and emits nothing for a keep-alive', async () => {
    const before = (await rows()).length;
    await sendRaw(serializeKeepAliveMessage());
    expect(handed).toEqual([]);
    expect((await rows()).length).toBe(before);
    expect(received).toEqual([]);
  });

  it('ignores a group plaintext carried by a text message', async () => {
    const before = (await rows()).length;
    await sendRaw(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_REGULAR,
        messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(9),
        content: 'hello',
        groupPlaintext: plaintext,
      })
    );
    expect(handed).toEqual([]);
    const after = await rows();
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]).toMatchObject({
      type: MessageType.TEXT,
      content: 'hello',
    });
    expect(received).toHaveLength(1);
  });
});
