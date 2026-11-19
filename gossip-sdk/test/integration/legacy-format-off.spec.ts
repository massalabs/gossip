/**
 * §2.1: a client of this protocol does not send the earlier one-to-one
 * format. Only the session's keep-alives go through the one-to-one queue; a
 * row of the earlier format that was never encrypted stays unsent in its
 * archive, while one already encrypted is delivered as stored (the session
 * moved for it). Two in-process SDKs, real sessions, an in-memory transport;
 * no backend is used.
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
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../../src/db';
import type { Queries } from '../../src/db/queries';
import type { EncryptedMessage } from '../../src/api/messageProtocol/types';
import { LEGACY_FORMAT_NOT_SENT } from '../../src/services/message';
import { serializeRegularMessage } from '../../src/utils/messageSerialization';
import type { SessionModule } from '../../src/wasm/session';

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

const queriesOf = (sdk: GossipSdk) =>
  (sdk as unknown as { _queries: Queries })._queries;
const sessionOf = (sdk: GossipSdk) =>
  (sdk as unknown as { state: { session: SessionModule } }).state.session;

describe(
  'The earlier one-to-one format is not sent',
  { timeout: 120_000 },
  () => {
    let net: MockMessageProtocol;
    let alice: GossipSdk;
    let bob: GossipSdk;
    let posted: EncryptedMessage[];

    beforeAll(async () => {
      await ensureWasmInitialized();
    });

    beforeEach(async () => {
      net = new MockMessageProtocol();
      alice = await openPeer(net);
      bob = await openPeer(net);
      await setupSession(alice, bob, 'Bob', 'Alice');
      posted = [];
      const send = net.sendMessage.bind(net);
      vi.spyOn(net, 'sendMessage').mockImplementation(async m => {
        posted.push(m);
        await send(m);
      });
    }, 120_000);

    afterEach(async () => {
      await alice.closeSession();
      await bob.closeSession();
    });

    it('refuses every send of the earlier format and posts nothing', async () => {
      const before = await queriesOf(alice).messages.getByOwnerAndContact(
        alice.userId,
        bob.userId
      );
      const text = await alice.messages.sendText(bob.userId, 'hello');
      expect(text).toEqual({ success: false, error: LEGACY_FORMAT_NOT_SENT });
      const reaction = await alice.messages.sendReaction(
        bob.userId,
        '+1',
        new Uint8Array(MESSAGE_ID_SIZE)
      );
      expect(reaction.success).toBe(false);
      await alice.discussions.setRetentionPolicy(bob.userId, 3600);
      expect(await alice.messages.editMessage(1, 'x')).toBe(false);
      expect(await alice.messages.deleteMessage(1)).toBe(false);
      expect(
        await queriesOf(alice).messages.getByOwnerAndContact(
          alice.userId,
          bob.userId
        )
      ).toEqual(before);
      expect(posted).toEqual([]);
      // The retention policy still applies on this device.
      expect(
        (await alice.discussions.get(bob.userId))?.messageRetentionDuration
      ).toBe(3600);
    });

    it('leaves a pending row of the earlier format unsent, and still sends keep-alives', async () => {
      const id = await queriesOf(alice).messages.insert({
        ownerUserId: alice.userId,
        contactUserId: bob.userId,
        content: 'written before the upgrade',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(3),
        timestamp: new Date(),
      });
      await alice.messages.processSendQueueForContact(bob.userId);
      expect(posted).toEqual([]);
      expect((await queriesOf(alice).messages.getById(id))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );

      // A keep-alive is queued and sent as before.
      const keepAlive = await alice.messages.sendMessage({
        ownerUserId: alice.userId,
        contactUserId: bob.userId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(keepAlive.success).toBe(true);
      expect(posted).toHaveLength(1);
      expect((await queriesOf(alice).messages.getById(id))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
    });

    it('delivers as stored a row of the earlier format encrypted before the upgrade', async () => {
      const sent = await sessionOf(alice).sendMessage(
        bob.userIdBytes,
        serializeRegularMessage(
          'encrypted before',
          new Uint8Array(MESSAGE_ID_SIZE).fill(4)
        )
      );
      const id = await queriesOf(alice).messages.insert({
        ownerUserId: alice.userId,
        contactUserId: bob.userId,
        content: 'encrypted before',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.READY,
        messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(4),
        encryptedMessage: sent!.data,
        seeker: sent!.seeker,
        whenToSend: new Date(0),
        timestamp: new Date(),
      });
      await alice.messages.processSendQueueForContact(bob.userId);
      expect(posted).toHaveLength(1);
      expect(posted[0].ciphertext).toEqual(sent!.data);
      expect((await queriesOf(alice).messages.getById(id))?.status).toBe(
        MessageStatus.SENT
      );
      // The peer ignores its content.
      const bobRows = async () =>
        queriesOf(bob).messages.getByOwnerAndContact(bob.userId, alice.userId);
      const rowsBefore = await bobRows();
      await bob.messages.fetch();
      expect(await bobRows()).toEqual(rowsBefore);
    });
  }
);
