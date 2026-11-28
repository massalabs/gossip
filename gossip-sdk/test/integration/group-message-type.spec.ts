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
import { MESSAGE_ID_SIZE } from '../../src/db';
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

  /** Bob's discussion with Alice, as stored. */
  async function discussion() {
    return queriesOf(bob).discussions.getByOwnerAndContact(
      bob.userId,
      alice.userId
    );
  }

  it('ignores a group plaintext carried by a text message, and the text', async () => {
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
    expect((await rows()).length).toBe(before);
    expect(received).toEqual([]);
  });

  /**
   * §2.1: a client of this protocol does not receive the earlier one-to-one
   * format. Every kind of it is ignored on receipt: no row, no event, no
   * change to the discussion.
   */
  it('ignores every kind of the earlier one-to-one format', async () => {
    const id = new Uint8Array(MESSAGE_ID_SIZE).fill(5);
    const cited = new Uint8Array(MESSAGE_ID_SIZE).fill(6);
    const events: string[] = [];
    for (const type of [
      SdkEventType.MESSAGE_RECEIVED,
      SdkEventType.MESSAGE_UPDATED,
      SdkEventType.MESSAGE_DELETED,
      SdkEventType.DISCUSSION_UPDATED,
    ]) {
      bob.on(type, () => events.push(type));
    }
    const before = await rows();
    const discussionBefore = await discussion();
    const legacy = [
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_REGULAR,
        messageId: id,
        content: 'a',
      },
      // A message without a type field is read as the default, regular.
      { messageId: id, content: 'b' },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_REPLY,
        messageId: id,
        content: 'c',
        citedMsgId: cited,
      },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_FORWARD,
        messageId: id,
        content: 'd',
        forwardedContent: 'e',
        citedContactId: new Uint8Array(32).fill(1),
      },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_EDIT,
        messageId: id,
        content: 'f',
        citedMsgId: cited,
      },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_DELETE,
        messageId: id,
        content: '',
        citedMsgId: cited,
      },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_REACTION,
        messageId: id,
        content: 'g',
        citedMsgId: cited,
      },
      {
        messageType: ProtoMessageType.MESSAGE_TYPE_RETENTION_POLICY,
        content: '3600',
      },
    ];
    for (const m of legacy) await sendRaw(ProtoMessage.encode(m));
    expect(handed).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(received).toEqual([]);
    expect(events).toEqual([]);
    const after = await discussion();
    expect(after?.messageRetentionDuration).toBe(
      discussionBefore?.messageRetentionDuration
    );
    expect(after?.unreadCount).toBe(discussionBefore?.unreadCount);
  });

  /** A type this release does not know is ignored and stores nothing. */
  it('ignores a session message of an unknown type', async () => {
    const before = await rows();
    for (const messageType of [9, 42, 1_000]) {
      await sendRaw(
        ProtoMessage.encode({
          messageType: messageType as ProtoMessageType,
          messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(4),
          content: 'from the future',
          groupPlaintext: plaintext,
        })
      );
    }
    expect(handed).toEqual([]);
    expect(await rows()).toEqual(before);
    expect(received).toEqual([]);
  });

  it('reads a group plaintext after ignored messages, in the same session', async () => {
    await sendRaw(
      ProtoMessage.encode({
        messageType: 77 as ProtoMessageType,
        content: 'unknown',
      })
    );
    await sendRaw(
      ProtoMessage.encode({
        messageType: ProtoMessageType.MESSAGE_TYPE_GROUP,
        groupPlaintext: plaintext,
      })
    );
    expect(handed).toHaveLength(1);
  });
});
