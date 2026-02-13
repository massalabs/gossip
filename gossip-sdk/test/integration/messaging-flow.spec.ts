/**
 * Messaging e2e-style tests
 *
 * Uses real WASM SessionModule with real crypto.
 * MockMessageProtocol provides in-memory message storage (no network).
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  beforeAll,
} from 'vitest';
import {
  DiscussionStatus,
  DiscussionDirection,
  MessageStatus,
  MessageDirection,
  MessageType,
  Contact,
} from '../../src/db';
import { MockMessageProtocol } from '../mocks';
import {
  setupSession,
  TestSessionData,
  createTestSession,
  cleanupTestSession,
} from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import { RefreshService } from '../../src/services/refresh';
import { SessionModule } from '../../src/wasm/session';
import { decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { eq, and } from 'drizzle-orm';
import {
  getSqliteDb,
  getLastInsertRowId,
  clearAllTables,
} from '../../src/sqlite';
import * as schema from '../../src/schema';

// Helper: insert a discussion into SQLite and return its id
async function addDiscussionToSqlite(
  data: typeof schema.discussions.$inferInsert
): Promise<number> {
  await getSqliteDb().insert(schema.discussions).values(data);
  return await getLastInsertRowId();
}

// Helper: get a discussion by id from SQLite
async function getDiscussionFromSqlite(id: number) {
  return getSqliteDb()
    .select()
    .from(schema.discussions)
    .where(eq(schema.discussions.id, id))
    .get();
}

// Helper: get a discussion by owner+contact from SQLite
async function getDiscussionByOwnerAndContact(
  ownerUserId: string,
  contactUserId: string
) {
  return getSqliteDb()
    .select()
    .from(schema.discussions)
    .where(
      and(
        eq(schema.discussions.ownerUserId, ownerUserId),
        eq(schema.discussions.contactUserId, contactUserId)
      )
    )
    .get();
}

// Helper: add a message to SQLite and return its id
async function addMessageToSqlite(
  data: typeof schema.messages.$inferInsert
): Promise<number> {
  await getSqliteDb().insert(schema.messages).values(data);
  return await getLastInsertRowId();
}

// Helper: get a message by id from SQLite
async function getMessageFromSqlite(id: number) {
  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, id))
    .get();
}

describe('Messaging Flow', () => {
  let mockProtocol: MockMessageProtocol;

  let aliceSdk: GossipSdk;
  let bobSdk: GossipSdk;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    await clearAllTables();
    mockProtocol.clearMockData();

    vi.clearAllMocks();

    // Generate mnemonics for SDK sessions
    const aliceMnemonic = generateMnemonic();
    const bobMnemonic = generateMnemonic();
    const aliceEncryptionKey = await generateEncryptionKey();
    const bobEncryptionKey = await generateEncryptionKey();

    // Create gossipSdk instances for Alice and Bob
    aliceSdk = new GossipSdk();
    await aliceSdk.init({});
    await aliceSdk.openSession({
      mnemonic: aliceMnemonic,
      onPersist: async () => {},
      persistEncryptionKey: aliceEncryptionKey,
    });
    // Replace protocol with mock for testing
    (
      aliceSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (aliceSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;

    bobSdk = new GossipSdk();
    await bobSdk.init({});
    await bobSdk.openSession({
      mnemonic: bobMnemonic,
      onPersist: async () => {},
      persistEncryptionKey: bobEncryptionKey,
    });
    // Replace protocol with mock for testing
    (
      bobSdk as unknown as { _announcement: AnnouncementService }
    )._announcement.setMessageProtocol(mockProtocol);
    (bobSdk as unknown as { _message: MessageService })._message[
      'messageProtocol'
    ] = mockProtocol;
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    await aliceSdk.closeSession();
    await bobSdk.closeSession();
  });

  describe('Happy path messaging flow', () => {
    it('Alice and Bob setup session, Alice send 2 message, Bob send another message, Alice resend another message ; the 3 first messages of discussion are ack but not the 4th', async () => {
      // Setup session between Alice and Bob
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Alice sends message 1
      const aliceMsg1Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Alice message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg1Result.success).toBe(true);

      // Alice sends message 2
      const aliceMsg2Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Alice message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg2Result.success).toBe(true);

      // Bob fetch messages
      const result = await bobSdk.messages.fetch();
      expect(result.success).toBe(true);
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(2);
      expect(bobMessages[0].content).toBe('Alice message 1');
      expect(bobMessages[1].content).toBe('Alice message 2');

      // Bob sends message 1
      const bobMsg1Result = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsg1Result.success).toBe(true);

      // Alice fetch bob message
      const resultAliceMsg = await aliceSdk.messages.fetch();
      expect(resultAliceMsg.success).toBe(true);
      const aliceReceivedMessage = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      expect(aliceReceivedMessage.length).toBe(3);
      expect(aliceReceivedMessage[2].content).toBe('Bob message 1');
      expect(aliceReceivedMessage[0].status).toBe(MessageStatus.DELIVERED);
      expect(aliceReceivedMessage[1].status).toBe(MessageStatus.DELIVERED);
      expect(aliceReceivedMessage[2].status).toBe(MessageStatus.DELIVERED);
      expect(aliceReceivedMessage[0].serializedContent).toBeUndefined();
      expect(aliceReceivedMessage[1].serializedContent).toBeUndefined();
      expect(aliceReceivedMessage[2].serializedContent).toBeUndefined();
      await aliceSdk.messages.markAsRead(aliceReceivedMessage[2].id!);
      // Re-fetch the message to get updated status
      const updatedMessage = await aliceSdk.messages.get(
        aliceReceivedMessage[2].id!
      );
      expect(updatedMessage?.status).toBe(MessageStatus.READ);

      // Alice sends message 3 (4th message overall) - after first 3 are acknowledged
      const aliceMsg3Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Alice message 3',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg3Result.success).toBe(true);

      // Bob fetch messages
      const resultBobMsg = await bobSdk.messages.fetch();
      expect(resultBobMsg.success).toBe(true);
      const bobReceivedMessage = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      expect(bobReceivedMessage.length).toBe(4);
      expect(bobReceivedMessage[3].content).toBe('Alice message 3');
      expect(bobReceivedMessage[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobReceivedMessage[1].status).toBe(MessageStatus.DELIVERED);
      expect(bobReceivedMessage[2].status).toBe(MessageStatus.DELIVERED);
      expect(bobReceivedMessage[0].serializedContent).toBeUndefined();
      expect(bobReceivedMessage[1].serializedContent).toBeUndefined();
      expect(bobReceivedMessage[2].serializedContent).toBeUndefined();
      await bobSdk.messages.markAsRead(bobReceivedMessage[3].id!);
      // Re-fetch the message to get updated status
      const updatedBobMessage = await bobSdk.messages.get(
        bobReceivedMessage[3].id!
      );
      expect(updatedBobMessage?.status).toBe(MessageStatus.READ);
    });

    it('Alice and Bob setup session, both send message at the same time, none should be ack', async () => {
      // Setup session between Alice and Bob
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      // Both send messages at the same time
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Hello Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Both fetch messages
      await aliceSdk.messages.fetch();
      await bobSdk.messages.fetch();

      // Check that messages are sent but not acknowledged yet
      // getMessages returns all messages (both directions), filter to outgoing only
      const aliceAllMessages = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      expect(aliceAllMessages.length).toBe(2);
      expect(aliceAllMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceAllMessages[1].status).toBe(MessageStatus.DELIVERED);
      expect(aliceAllMessages[0].encryptedMessage).toBeUndefined();
      expect(aliceAllMessages[0].seeker).toBeDefined();
      expect(aliceAllMessages[0].whenToSend).toBeUndefined();
      expect(aliceAllMessages[1].serializedContent).toBeUndefined();
      expect(aliceAllMessages[1].seeker).toBeUndefined();

      // Bob's view: sorted by timestamp, Alice's msg (sent first) is at index 0
      const bobAllMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobAllMessages.length).toBe(2);
      expect(bobAllMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobAllMessages[1].status).toBe(MessageStatus.SENT);
    });

    it('Alice send announcement and send 2 message before Bob accept, Bob accept and receive messages', async () => {
      // Create contacts
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await getSqliteDb().insert(schema.contacts).values({
        ownerUserId: aliceBobContact.ownerUserId,
        userId: aliceBobContact.userId,
        name: aliceBobContact.name,
        publicKeys: aliceBobContact.publicKeys,
        isOnline: aliceBobContact.isOnline,
        lastSeen: aliceBobContact.lastSeen,
        createdAt: aliceBobContact.createdAt,
      });

      const bobAliceContact: Omit<Contact, 'id'> = {
        ownerUserId: bobSdk.userId,
        userId: aliceSdk.userId,
        name: 'Alice',
        publicKeys: aliceSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await getSqliteDb().insert(schema.contacts).values({
        ownerUserId: bobAliceContact.ownerUserId,
        userId: bobAliceContact.userId,
        name: bobAliceContact.name,
        publicKeys: bobAliceContact.publicKeys,
        isOnline: bobAliceContact.isOnline,
        lastSeen: bobAliceContact.lastSeen,
        createdAt: bobAliceContact.createdAt,
      });

      // Alice initiates discussion with Bob
      const startResult = await aliceSdk.discussions.start(aliceBobContact);
      if (!startResult.success) throw startResult.error;

      // Alice sends 2 messages before Bob accepts (they will be queued)
      const aliceMsg1Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message 1 before accept',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg1Result.success).toBe(true);
      expect(aliceMsg1Result.message?.status).toBe(
        MessageStatus.WAITING_SESSION
      );

      const aliceMsg2Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Message 2 before accept',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg2Result.success).toBe(true);
      expect(aliceMsg2Result.message?.status).toBe(
        MessageStatus.WAITING_SESSION
      );

      // Bob fetches announcements and accepts
      await bobSdk.announcements.fetch();
      const bobDiscussion = await bobSdk.discussions.get(
        bobSdk.userId,
        aliceSdk.userId
      );
      if (!bobDiscussion) throw new Error('Bob discussion not found');
      await bobSdk.discussions.accept(bobDiscussion);

      // Alice's messages are still in WAITING_SESSION
      const aliceMessagesWaiting = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      expect(aliceMessagesWaiting.length).toBe(2);
      expect(aliceMessagesWaiting[0].status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect(aliceMessagesWaiting[1].status).toBe(
        MessageStatus.WAITING_SESSION
      );

      // Alice fetches Bob's acceptance
      await aliceSdk.announcements.fetch();

      // Alice's messages are now SENT
      const aliceMessagesSent = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      expect(aliceMessagesSent.length).toBe(2);
      expect(aliceMessagesSent[0].status).toBe(MessageStatus.SENT);
      expect(aliceMessagesSent[1].status).toBe(MessageStatus.SENT);
      expect(aliceMessagesSent[0].encryptedMessage).toBeUndefined();
      expect(aliceMessagesSent[0].seeker).toBeDefined();
      expect(aliceMessagesSent[0].whenToSend).toBeUndefined();
      expect(aliceMessagesSent[1].encryptedMessage).toBeUndefined();
      expect(aliceMessagesSent[1].seeker).toBeDefined();
      expect(aliceMessagesSent[1].whenToSend).toBeUndefined();

      // Bob fetches messages and should receive the 2 queued messages
      await bobSdk.messages.fetch();
      const bobReceivedMessages = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Message 1 before accept');
      expect(bobReceivedMessages[1].content).toBe('Message 2 before accept');
    });
  });

  describe('Messages failure flow', () => {
    beforeEach(async () => {
      // setup session between Alice and Bob
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');
    });

    it('Alice send msg but has network issues, resend', async () => {
      // Set short retry delay for this test
      const originalRetryDelay = aliceSdk.config.messages.retryDelayMs;
      aliceSdk.config.messages.retryDelayMs = 100;

      // Mock network failure for message sending
      const originalSendMessage = MockMessageProtocol.prototype.sendMessage;
      let sendAttempts = 0;
      vi.spyOn(mockProtocol, 'sendMessage').mockImplementation(
        async message => {
          sendAttempts++;
          if (sendAttempts === 1) {
            // First attempt fails
            throw new Error('Network error');
          }
          // Subsequent attempts succeed
          return originalSendMessage.call(mockProtocol, message);
        }
      );

      // Alice sends a message (will fail on first attempt)
      const sendResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(sendResult.success).toBe(true);

      // Check message status - should still be READY (will retry on next updateState)
      const messageRow = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, sendResult.message!.id!))
        .get();
      expect(messageRow?.status).toBe(MessageStatus.READY);
      expect(messageRow?.whenToSend).toBeDefined();
      expect(messageRow?.whenToSend!.getTime()).toBeGreaterThan(Date.now());
      expect(messageRow?.encryptedMessage).toBeDefined();
      expect(messageRow?.seeker).toBeDefined();

      // wait for delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.messages.retryDelayMs)
      );

      // Trigger state update again (retry should succeed)
      await aliceSdk.updateState();

      // Restore original retry delay
      aliceSdk.config.messages.retryDelayMs = originalRetryDelay;

      // Check message status - should now be SENT
      const retriedMessageRow = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, sendResult.message!.id!))
        .get();
      expect(retriedMessageRow?.status).toBe(MessageStatus.SENT);
      expect(retriedMessageRow?.whenToSend).toBeDefined();
      expect(retriedMessageRow?.encryptedMessage).toBeDefined();
      expect(retriedMessageRow?.seeker).toBeDefined();

      // Bob fetches messages to receive Alice's message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].content).toBe('Hello Bob!');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessages[0].serializedContent).toBeUndefined();
    });

    it('Both alice and bob fail sending messages because of transport issue. Messages are resent in order', async () => {
      // Set short retry delays for this test
      const originalAliceRetryDelay = aliceSdk.config.messages.retryDelayMs;
      const originalBobRetryDelay = bobSdk.config.messages.retryDelayMs;
      aliceSdk.config.messages.retryDelayMs = 100;
      bobSdk.config.messages.retryDelayMs = 100;

      // STEP 1: Mock transport failures for the next sends
      const originalSendMessage = MockMessageProtocol.prototype.sendMessage;
      let sendAttempts = 0;

      vi.spyOn(mockProtocol, 'sendMessage').mockImplementation(
        async message => {
          sendAttempts++;
          // First 4 sends (2 from Alice, 2 from Bob) should fail
          if (sendAttempts <= 4) {
            throw new Error('Transport failure');
          }
          // Subsequent sends succeed
          return originalSendMessage.call(mockProtocol, message);
        }
      );

      /* STEP 2: Alice sends 2 messages that will fail */
      const aliceMsg1Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Alice message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg1Result.success).toBe(true);

      const aliceMsg2Result = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Alice message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsg2Result.success).toBe(true);

      /* STEP 3: Bob sends 2 messages that will fail */
      const bobMsg1Result = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsg1Result.success).toBe(true);

      const bobMsg2Result = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Bob message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsg2Result.success).toBe(true);

      /* STEP 4: Alice and Bob fetch messages but nothing is received */
      await aliceSdk.messages.fetch();
      await bobSdk.messages.fetch();

      const aliceIncomingMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId),
            eq(schema.messages.direction, MessageDirection.INCOMING)
          )
        )
        .all();
      const bobIncomingMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, bobSdk.userId),
            eq(schema.messages.contactUserId, aliceSdk.userId),
            eq(schema.messages.direction, MessageDirection.INCOMING)
          )
        )
        .all();
      expect(aliceIncomingMessages.length).toBe(0);
      expect(bobIncomingMessages.length).toBe(0);

      /* STEP 5: Alice and Bob resend messages (retry will succeed now) */
      // Wait for retry delay to pass
      const retryDelay = Math.max(
        aliceSdk.config.messages.retryDelayMs,
        bobSdk.config.messages.retryDelayMs
      );
      await new Promise(resolve => setTimeout(resolve, retryDelay + 100));

      // Trigger state updates again - retries should succeed
      await aliceSdk.updateState();
      await bobSdk.updateState();

      // Verify all messages are now SENT (filter to outgoing only)
      const aliceAllMessages = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      const aliceSentMessages = aliceAllMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );

      expect(aliceSentMessages.length).toBe(2);
      expect(aliceSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceSentMessages[1].status).toBe(MessageStatus.SENT);
      expect(aliceSentMessages[0].encryptedMessage).toBeUndefined();
      expect(aliceSentMessages[0].seeker).toBeDefined();
      expect(aliceSentMessages[0].whenToSend).toBeUndefined();
      expect(aliceSentMessages[1].encryptedMessage).toBeUndefined();
      expect(aliceSentMessages[1].seeker).toBeDefined();
      expect(aliceSentMessages[1].whenToSend).toBeUndefined();

      const bobAllMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobSentMessages = bobAllMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(bobSentMessages.length).toBe(2);
      expect(bobSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(bobSentMessages[1].status).toBe(MessageStatus.SENT);
      expect(bobSentMessages[0].encryptedMessage).toBeUndefined();
      expect(bobSentMessages[0].seeker).toBeDefined();
      expect(bobSentMessages[0].whenToSend).toBeUndefined();
      expect(bobSentMessages[1].encryptedMessage).toBeUndefined();
      expect(bobSentMessages[1].seeker).toBeDefined();
      expect(bobSentMessages[1].whenToSend).toBeUndefined();

      /* STEP 6: Bob and Alice fetch messages with success */
      await bobSdk.messages.fetch();

      const bobReceivedMessages = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );

      // Sorted by timestamp: Alice sent first, so her messages come first
      expect(bobReceivedMessages.length).toBe(4);
      expect(bobReceivedMessages[0].content).toBe('Alice message 1');
      expect(bobReceivedMessages[1].content).toBe('Alice message 2');

      // Alice fetches Bob's messages
      await aliceSdk.messages.fetch();

      const aliceReceivedMessages = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );

      // Sorted by timestamp: Alice sent first, so her outgoing messages come first
      expect(aliceReceivedMessages.length).toBe(4);
      expect(aliceReceivedMessages[2].content).toBe('Bob message 1');
      expect(aliceReceivedMessages[3].content).toBe('Bob message 2');

      // Restore original retry delays
      aliceSdk.config.messages.retryDelayMs = originalAliceRetryDelay;
      bobSdk.config.messages.retryDelayMs = originalBobRetryDelay;
    });
  });

  describe('Renew session', () => {
    beforeEach(async () => {
      // setup session between Alice and Bob
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');
    });

    it('Alice renew the session. Bob receive new announcements', async () => {
      // Alice renews the session
      const renewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(renewResult.success).toBe(true);

      // Bob fetches announcements and receives Alice's renewal
      await bobSdk.announcements.fetch();

      // Check both sessions are active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );
    });

    it('Alice and Bob both renew the session at the same time', async () => {
      // Both renew at the same time
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(aliceRenewResult.success).toBe(true);
      expect(bobRenewResult.success).toBe(true);

      // Both fetch announcements
      await aliceSdk.announcements.fetch();
      await bobSdk.announcements.fetch();

      // Check both sessions are active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );
    });

    it('Alice send msg, Bob renew without fetching. Alice msg is resent and bob receive it', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Check message is SENT
      const aliceMessages = await aliceSdk.messages.getMessages(bobSdk.userId);
      const aliceOutgoing = aliceMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoing.length).toBe(1);
      expect(aliceOutgoing[0].status).toBe(MessageStatus.SENT);
      expect(aliceOutgoing[0].encryptedMessage).toBeUndefined();
      expect(aliceOutgoing[0].seeker).toBeDefined();
      expect(aliceOutgoing[0].whenToSend).toBeUndefined();

      // Bob renews session without fetching Alice's message first
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(bobRenewResult.success).toBe(true);

      // Alice fetches announcements (receives Bob's renewal announcement)
      // This will reset Alice's send queue for messages to Bob
      await aliceSdk.announcements.fetch();

      // Alice resent her message
      await aliceSdk.updateState();

      // Bob fetches messages and should receive Alice's message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobIncoming = bobMessages.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      expect(bobIncoming.length).toBe(1);
      expect(bobIncoming[0].content).toBe('Hello Bob!');
      expect(bobIncoming[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobIncoming[0].serializedContent).toBeUndefined();
      expect(bobIncoming[0].encryptedMessage).toBeUndefined();
      expect(bobIncoming[0].seeker).toBeUndefined();
      expect(bobIncoming[0].whenToSend).toBeUndefined();
    });

    it('Alice send msg, Bob fetch and renew. Alice msg is resent but no duplicata on bob side', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetches and receives the message
      await bobSdk.messages.fetch();
      const bobMessagesBeforeRenew = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      const bobIncomingBefore = bobMessagesBeforeRenew.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      expect(bobIncomingBefore.length).toBe(1);
      expect(bobIncomingBefore[0].content).toBe('Hello Bob!');
      expect(bobIncomingBefore[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobIncomingBefore[0].serializedContent).toBeUndefined();
      const bobIncomingBeforeMessageId = bobIncomingBefore[0].messageId;

      // Bob renews session
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(bobRenewResult.success).toBe(true);

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();
      // Check that Alice's message has status WAITING_SESSION and seeker, encryptedMessage, and when_send are undefined
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessages[0].serializedContent).toBeUndefined();
      expect(bobMessages[0].seeker).toBeUndefined();
      expect(bobMessages[0].encryptedMessage).toBeUndefined();
      expect(bobMessages[0].whenToSend).toBeUndefined();

      // Alice's message should be resent
      await aliceSdk.updateState();

      // Bob fetches messages again - should not have duplicates
      await bobSdk.messages.fetch();
      const bobMessagesAfterRenew = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      const bobIncomingAfter = bobMessagesAfterRenew.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      // Should still have only 1 message (no duplicate)
      expect(bobIncomingAfter.length).toBe(1);
      expect(bobIncomingAfter[0].content).toBe('Hello Bob!');
      expect(bobIncomingAfter[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobIncomingAfter[0].serializedContent).toBeUndefined();
      expect(bobIncomingAfter[0].messageId).toEqual(bobIncomingBeforeMessageId);
      expect(bobIncomingAfter[0].serializedContent).toBeUndefined();
    });

    it('Alice send msg, Bob answer. Alice msg is ack. then she renew -> her msg is not resent', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetches and receives the message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].content).toBe('Hello Bob!');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessages[0].serializedContent).toBeUndefined();
      expect(bobMessages[0].encryptedMessage).toBeUndefined();
      expect(bobMessages[0].seeker).toBeUndefined();
      expect(bobMessages[0].whenToSend).toBeUndefined();

      // Bob answers
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Hi Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // Alice fetches Bob's message (this acknowledges Alice's message)
      await aliceSdk.messages.fetch();
      const aliceMessagesAfterAck = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      const aliceOutgoingAfterAck = aliceMessagesAfterAck.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoingAfterAck.length).toBe(1);
      expect(aliceOutgoingAfterAck[0].status).toBe(MessageStatus.DELIVERED);
      expect(aliceOutgoingAfterAck[0].serializedContent).toBeUndefined();
      expect(aliceOutgoingAfterAck[0].content).toBe('Hello Bob!');
      expect(aliceOutgoingAfterAck[0].encryptedMessage).toBeUndefined();
      expect(aliceOutgoingAfterAck[0].seeker).toBeUndefined();
      expect(aliceOutgoingAfterAck[0].whenToSend).toBeUndefined();

      // Alice renews session
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(aliceRenewResult.success).toBe(true);

      // Check Alice's message is still DELIVERED (not reset to WAITING_SESSION)
      const aliceMessagesAfterRenew = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      const aliceOutgoingAfterRenew = aliceMessagesAfterRenew.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoingAfterRenew.length).toBe(1);
      expect(aliceOutgoingAfterRenew[0].status).toBe(MessageStatus.DELIVERED);
      expect(aliceOutgoingAfterRenew[0].serializedContent).toBeUndefined();
      expect(aliceOutgoingAfterRenew[0].encryptedMessage).toBeUndefined();
      expect(aliceOutgoingAfterRenew[0].seeker).toBeUndefined();
      expect(aliceOutgoingAfterRenew[0].whenToSend).toBeUndefined();
    });

    it('Alice send msg, renew, resend, bob receive (no duplicate msg)', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Check message is SENT
      const aliceMessagesBeforeRenew = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      console.log('aliceMessagesBeforeRenew', aliceMessagesBeforeRenew);
      expect(aliceMessagesBeforeRenew.length).toBe(1);
      expect(aliceMessagesBeforeRenew[0].status).toBe(MessageStatus.SENT);
      expect(aliceMessagesBeforeRenew[0].encryptedMessage).toBeUndefined();
      expect(aliceMessagesBeforeRenew[0].seeker).toBeDefined();
      expect(aliceMessagesBeforeRenew[0].whenToSend).toBeUndefined();

      // Alice renews session (this resets SENT messages to WAITING_SESSION)
      // Note: renew() triggers stateUpdate() internally, which may immediately
      // process and send the reset messages again
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(aliceRenewResult.success).toBe(true);

      // After renewal, messages are reset to WAITING_SESSION but
      // stateUpdate() called by renew() will process them to SENT if no issue.
      const aliceMessagesAfterRenew = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );
      console.log('aliceMessagesAfterRenew', aliceMessagesAfterRenew);
      const aliceOutgoingAfter = aliceMessagesAfterRenew.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoingAfter.length).toBe(1);
      expect(aliceOutgoingAfter[0].status).toBe(MessageStatus.SENT);
      expect(aliceOutgoingAfter[0].encryptedMessage).toBeUndefined();
      expect(aliceOutgoingAfter[0].seeker).toBeDefined();
      expect(aliceOutgoingAfter[0].whenToSend).toBeUndefined();

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages and should receive Alice's message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      console.log('bobMessages', bobMessages);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].content).toBe('Hello Bob!');
      expect(bobMessages[0].messageId).toEqual(aliceOutgoingAfter[0].messageId);
      expect(bobMessages[0].messageId).toEqual(aliceOutgoingAfter[0].messageId);
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessages[0].serializedContent).toBeUndefined();
      expect(bobMessages[0].encryptedMessage).toBeUndefined();
      expect(bobMessages[0].seeker).toBeUndefined();
      expect(bobMessages[0].whenToSend).toBeUndefined();
    });

    it('Alice send msg, bob receive, alice renew and resend. Bob receive without duplicata', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetches and receives the message
      await bobSdk.messages.fetch();
      const bobMessagesBeforeRenew = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      expect(bobMessagesBeforeRenew.length).toBe(1);
      expect(bobMessagesBeforeRenew[0].content).toBe('Hello Bob!');
      expect(bobMessagesBeforeRenew[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessagesBeforeRenew[0].serializedContent).toBeUndefined();
      const bobMessagesBeforeRenewId = bobMessagesBeforeRenew[0].messageId;

      // Alice renews session
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(aliceRenewResult.success).toBe(true);

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages again - should not have duplicates
      await bobSdk.messages.fetch();
      const bobMessagesAfterRenew = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );
      const bobIncomingAfter = bobMessagesAfterRenew.filter(
        m => m.direction === MessageDirection.INCOMING
      );
      // Should still have only 1 message (no duplicate)
      expect(bobIncomingAfter.length).toBe(1);
      expect(bobIncomingAfter[0].messageId).toEqual(
        aliceMsgResult.message!.messageId
      );
      expect(bobIncomingAfter[0].messageId).toEqual(
        aliceMsgResult.message!.messageId
      );
      expect(bobIncomingAfter[0].content).toBe('Hello Bob!');
      expect(bobIncomingAfter[0].serializedContent).toBeUndefined();
      expect(bobIncomingAfter[0].messageId).toEqual(bobMessagesBeforeRenewId);
    });

    it('Alice send msg and renew, bob send msg and renew', async () => {
      // Alice sends a message
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Alice renews session
      const aliceRenewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(aliceRenewResult.success).toBe(true);

      // Bob sends a message
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Hi Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);

      // bob renews session
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(bobRenewResult.success).toBe(true);

      // Both fetch announcements
      await aliceSdk.announcements.fetch();
      await bobSdk.announcements.fetch();

      // Check both sessions are active
      expect(aliceSdk.discussions.getStatus(bobSdk.userId)).toBe(
        SessionStatus.Active
      );
      expect(bobSdk.discussions.getStatus(aliceSdk.userId)).toBe(
        SessionStatus.Active
      );

      // After renewal, messages are reset to WAITING_SESSION but
      // stateUpdate() called by renew() will process them to SENT if no issue.
      const aliceMessages = await aliceSdk.messages.getMessages(bobSdk.userId);
      const aliceOutgoing = aliceMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoing.length).toBe(1);
      expect(aliceOutgoing[0].status).toBe(MessageStatus.SENT);
      expect(aliceOutgoing[0].encryptedMessage).toBeUndefined();
      expect(aliceOutgoing[0].seeker).toBeDefined();
      expect(aliceOutgoing[0].whenToSend).toBeUndefined();

      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobOutgoing = bobMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(bobOutgoing.length).toBe(1);
      expect(bobOutgoing[0].status).toBe(MessageStatus.SENT);
      expect(bobOutgoing[0].encryptedMessage).toBeUndefined();
      expect(bobOutgoing[0].seeker).toBeDefined();
      expect(bobOutgoing[0].whenToSend).toBeUndefined();
    });
  });

  describe('keep alive msg', () => {
    const getAliceServices = () =>
      aliceSdk as unknown as {
        _announcement: AnnouncementService;
        _discussion: DiscussionService;
        _message: MessageService;
        _refresh: RefreshService;
      };

    const getBobServices = () =>
      bobSdk as unknown as {
        _announcement: AnnouncementService;
        _discussion: DiscussionService;
        _message: MessageService;
        _refresh: RefreshService;
      };

    const getAliceSession = (): SessionModule =>
      (aliceSdk as unknown as { state: { session: SessionModule } }).state
        .session;
    const getBobSession = (): SessionModule =>
      (bobSdk as unknown as { state: { session: SessionModule } }).state
        .session;

    it('Alice send msg to bob. Bob send a keep alive. Alice msg is acknowledged', async () => {
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const bobServices = getBobServices();
      const bobSession = getBobSession();

      // Alice sends a message to Bob
      const aliceMsgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Hello Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(aliceMsgResult.success).toBe(true);

      // Bob fetches Alice's message
      await bobSdk.messages.fetch();

      const bobMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, bobSdk.userId),
            eq(schema.messages.contactUserId, aliceSdk.userId)
          )
        )
        .all();

      const bobReceived = bobMessages.find(
        m =>
          m.direction === MessageDirection.INCOMING &&
          m.content === 'Hello Bob!'
      );
      expect(bobReceived?.status).toBe(MessageStatus.DELIVERED);
      expect(bobReceived?.serializedContent).toBeNull();

      // Force Bob to send keep-alive
      vi.spyOn(bobSession, 'refresh').mockResolvedValue([
        decodeUserId(aliceSdk.userId),
      ]);

      await bobServices._refresh.stateUpdate();

      // Verify Bob sent keep-alive
      const bobKeepAliveRows = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, bobSdk.userId),
            eq(schema.messages.type, MessageType.KEEP_ALIVE),
            eq(schema.messages.direction, MessageDirection.OUTGOING)
          )
        )
        .all();
      const bobKeepAlive = bobKeepAliveRows[0];
      expect(bobKeepAlive).toBeDefined();
      expect(bobKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(bobKeepAlive?.encryptedMessage).toBeNull();
      expect(bobKeepAlive?.seeker).toBeDefined();
      expect(bobKeepAlive?.whenToSend).toBeNull();

      // Alice fetches Bob's keep-alive (which acknowledges her message)
      await aliceSdk.messages.fetch();

      const aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      const aliceSent = aliceMessages.find(
        m =>
          m.direction === MessageDirection.OUTGOING &&
          m.content === 'Hello Bob!'
      );
      expect(aliceSent?.status).toBe(MessageStatus.DELIVERED);
      expect(aliceSent?.serializedContent).toBeNull();

      // Check that there is no incoming keep-alive message in Alice's db
      const incomingKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.INCOMING
      );
      expect(incomingKeepAlive).toBeUndefined();

      // Alice sends a message back to acknowledge Bob's keep-alive
      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      vi.spyOn(aliceSession, 'refresh').mockResolvedValue([
        decodeUserId(bobSdk.userId),
      ]);

      await aliceServices._refresh.stateUpdate();

      // Bob fetches Alice's acknowledgment
      await bobSdk.messages.fetch();

      // Bob's keep-alive should now be removed from db
      const bobKeepAliveAfterRows = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, bobSdk.userId),
            eq(schema.messages.type, MessageType.KEEP_ALIVE)
          )
        )
        .all();
      expect(bobKeepAliveAfterRows.length).toBe(0);
    });

    it('No keep alive when session is not active', async () => {
      const aliceContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceSdk.userId,
        userId: bobSdk.userId,
        name: 'Bob',
        publicKeys: bobSdk.publicKeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await getSqliteDb().insert(schema.contacts).values({
        ownerUserId: aliceContact.ownerUserId,
        userId: aliceContact.userId,
        name: aliceContact.name,
        publicKeys: aliceContact.publicKeys,
        isOnline: aliceContact.isOnline,
        lastSeen: aliceContact.lastSeen,
        createdAt: aliceContact.createdAt,
      });

      const startResult = await aliceSdk.discussions.start(aliceContact);
      if (!startResult.success) throw startResult.error;

      await bobSdk.announcements.fetch();

      const aliceSession = getAliceSession();
      const bobSession = getBobSession();

      expect(aliceSession.peerSessionStatus(decodeUserId(bobSdk.userId))).toBe(
        SessionStatus.SelfRequested
      );
      expect(bobSession.peerSessionStatus(decodeUserId(aliceSdk.userId))).toBe(
        SessionStatus.PeerRequested
      );

      const aliceRefreshSpy = vi
        .spyOn(aliceSession, 'refresh')
        .mockResolvedValue([decodeUserId(bobSdk.userId)]);
      const bobRefreshSpy = vi
        .spyOn(bobSession, 'refresh')
        .mockResolvedValue([decodeUserId(aliceSdk.userId)]);

      await aliceSdk.updateState();
      await bobSdk.updateState();

      aliceRefreshSpy.mockRestore();
      bobRefreshSpy.mockRestore();

      const keepAlives = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.type, MessageType.KEEP_ALIVE))
        .all();
      expect(keepAlives.length).toBe(0);
    });

    it('No keep alive msg when already a pending msg', async () => {
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      // Mock sendMessage to fail, keeping message in READY state
      const sendSpy = vi
        .spyOn(aliceSession, 'sendMessage')
        .mockImplementation(async () => undefined);

      // Queue a pending outgoing message for Alice -> Bob
      const msgResult = await aliceSdk.messages.send({
        ownerUserId: aliceSdk.userId,
        contactUserId: bobSdk.userId,
        content: 'Pending',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(msgResult.success).toBe(true);

      // Verify message is in WAITING_SESSION (sendMessage failed)
      const pendingMsg = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, msgResult.message!.id!))
        .get();
      expect(pendingMsg?.status).toBe(MessageStatus.WAITING_SESSION);

      vi.spyOn(aliceSession, 'refresh').mockResolvedValue([
        decodeUserId(bobSdk.userId),
      ]);

      await aliceServices._refresh.stateUpdate();

      // Check that there is no outgoing keep-alive message in Alice's db
      const messages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();
      const keepAlive = messages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(keepAlive).toBeUndefined();

      sendSpy.mockRestore();
    });

    it('Alice send keep alive msg but session.sendMessage returns empty output. It is resent at next stateUpdate with success', async () => {
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Test',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);
      await aliceSdk.messages.fetch();

      vi.spyOn(aliceSession, 'refresh').mockResolvedValue([
        decodeUserId(bobSdk.userId),
      ]);

      // Mock sendMessage to return undefined
      const originalSend = aliceSession.sendMessage.bind(aliceSession);
      const sendSpy = vi
        .spyOn(aliceSession, 'sendMessage')
        .mockImplementationOnce(async () => undefined)
        .mockImplementation(originalSend);

      // First updateState: creates keep-alive but encryption fails, so it stays pending
      await aliceServices._refresh.stateUpdate();

      let aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      const ka = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(ka).toBeDefined();
      expect(ka?.status).toBe(MessageStatus.WAITING_SESSION);

      // Second updateState: resend with real sendMessage
      await aliceServices._refresh.stateUpdate();

      aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      const kaAfter = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      if (kaAfter) {
        expect(kaAfter.status).toBe(MessageStatus.SENT);
        expect(kaAfter.encryptedMessage).toBeNull();
        expect(kaAfter.seeker).toBeDefined();
        expect(kaAfter.whenToSend).toBeNull();
      }

      sendSpy.mockRestore();
    });

    it('Alice send keep alive msg then reset the session: keep alive is put in WAITING_SESSION then resent', async () => {
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Test',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);
      await aliceSdk.messages.fetch();

      // Force Alice to send keep-alive
      vi.spyOn(aliceSession, 'refresh').mockResolvedValue([
        decodeUserId(bobSdk.userId),
      ]);

      await aliceServices._refresh.stateUpdate();

      // Verify Alice sent keep-alive
      let aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      let aliceKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(aliceKeepAlive).toBeDefined();
      expect(aliceKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(aliceKeepAlive?.encryptedMessage).toBeNull();
      expect(aliceKeepAlive?.seeker).toBeDefined();
      expect(aliceKeepAlive?.whenToSend).toBeNull();

      // Alice renews the session (which resets messages to WAITING_SESSION)
      const renewResult = await aliceSdk.discussions.renew(bobSdk.userId);
      expect(renewResult.success).toBe(true);

      // Check keep-alive was reset to WAITING_SESSION and then resent
      aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      aliceKeepAlive = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      // After renew + stateUpdate, it should be SENT again
      expect(aliceKeepAlive?.status).toBe(MessageStatus.SENT);
      expect(aliceKeepAlive?.encryptedMessage).toBeNull();
      expect(aliceKeepAlive?.seeker).toBeDefined();
      expect(aliceKeepAlive?.whenToSend).toBeNull();
    });

    it('Alice send keep alive but got network issue. Resend with success', async () => {
      await setupSession(aliceSdk, bobSdk, 'Bob', 'Alice');

      const aliceServices = getAliceServices();
      const aliceSession = getAliceSession();
      const mockProtocol = (aliceSdk as unknown as { _message: MessageService })
        ._message['messageProtocol'];

      // Set short retry delay for this test
      const originalRetryDelay = aliceSdk.config.messages.retryDelayMs;
      aliceSdk.config.messages.retryDelayMs = 100;

      // Bob sends a message so Alice will later acknowledge via keep-alive
      const bobMsgResult = await bobSdk.messages.send({
        ownerUserId: bobSdk.userId,
        contactUserId: aliceSdk.userId,
        content: 'Test',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expect(bobMsgResult.success).toBe(true);
      await aliceSdk.messages.fetch();

      // Force Alice to send keep-alive
      vi.spyOn(aliceSession, 'refresh').mockResolvedValue([
        decodeUserId(bobSdk.userId),
      ]);

      // Mock network failure for sendMessage
      let sendAttempts = 0;
      const sendSpy = vi
        .spyOn(mockProtocol, 'sendMessage')
        .mockImplementation(async () => {
          sendAttempts++;
          if (sendAttempts === 1) {
            throw new Error('Network error');
          }
          // Return void on retry (success)
        });

      // First stateUpdate: keep-alive send fails
      await aliceServices._refresh.stateUpdate();

      let aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      const ka = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(ka).toBeDefined();
      expect(ka?.status).toBe(MessageStatus.READY);
      expect(ka?.whenToSend).toBeDefined();
      expect(ka?.whenToSend!.getTime()).toBeGreaterThan(Date.now());

      // Wait for retry delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.messages.retryDelayMs + 50)
      );

      // Second stateUpdate: retry should succeed
      await aliceServices._refresh.stateUpdate();

      aliceMessages = await getSqliteDb()
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.ownerUserId, aliceSdk.userId),
            eq(schema.messages.contactUserId, bobSdk.userId)
          )
        )
        .all();

      const kaAfter = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(kaAfter?.status).toBe(MessageStatus.SENT);
      expect(kaAfter?.encryptedMessage).toBeNull();
      expect(kaAfter?.seeker).toBeDefined();
      expect(kaAfter?.whenToSend).toBeNull();

      // Restore
      sendSpy.mockRestore();
      aliceSdk.config.messages.retryDelayMs = originalRetryDelay;
    });
  });
});

// ============================================================================
// Renew session — SQLite-level tests
// ============================================================================

describe('Renew session — SQLite-level tests', () => {
  let alice: TestSessionData;
  let bob: TestSessionData;
  let mockProtocol: MockMessageProtocol;
  let events: SdkEventEmitter;
  let messageService: MessageService;
  let discussionService: DiscussionService;
  let announcementService: AnnouncementService;
  let refreshService: RefreshService;

  /**
   * Helper to reset unacknowledged messages to WAITING_SESSION
   * (simulates what happens when session needs renewal)
   */
  async function simulateRenewReset(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    const sqliteDb = getSqliteDb();
    const toReset = await sqliteDb
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.ownerUserId, ownerUserId),
          eq(schema.messages.contactUserId, contactUserId),
          eq(schema.messages.direction, MessageDirection.OUTGOING)
        )
      )
      .all();
    const filtered: number[] = [];
    for (const m of toReset) {
      const full = await getMessageFromSqlite(m.id);
      if (
        full &&
        (full.status === MessageStatus.SENDING ||
          full.status === MessageStatus.FAILED ||
          full.status === MessageStatus.SENT)
      ) {
        filtered.push(m.id);
      }
    }
    for (const id of filtered) {
      await sqliteDb
        .update(schema.messages)
        .set({
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: null,
          seeker: null,
        })
        .where(eq(schema.messages.id, id));
    }
    return filtered.length;
  }

  beforeEach(async () => {
    await clearAllTables();

    // Create real WASM sessions
    alice = await createTestSession(`alice-renew-${Date.now()}`);
    bob = await createTestSession(`bob-renew-${Date.now()}`);

    mockProtocol = new MockMessageProtocol();
    events = new SdkEventEmitter();

    // Add Bob as Alice's contact
    await getSqliteDb().insert(schema.contacts).values({
      ownerUserId: alice.session.userIdEncoded,
      userId: bob.session.userIdEncoded,
      name: 'Bob',
      publicKeys: bob.session.ourPk.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    // Set up services
    announcementService = new AnnouncementService(
      mockProtocol,
      alice.session,
      events
    );
    refreshService = new RefreshService(
      messageService,
      discussionService,
      announcementService,
      alice.session,
      events
    );
    discussionService = new DiscussionService(
      announcementService,
      alice.session,
      events,
      refreshService
    );
    messageService = new MessageService(mockProtocol, alice.session, events);
  });

  afterEach(() => {
    cleanupTestSession(alice);
    cleanupTestSession(bob);
  });

  it('should reset SENT messages to WAITING_SESSION on renew and resend them', async () => {
    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    // Create active discussion
    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add a SENT message (simulates message sent but not acknowledged)
    const sentMessageId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Hello Bob! This was sent but not delivered.',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    // Add a DELIVERED message (should not be reset)
    const deliveredMessageId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'This was delivered already.',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    // Verify initial state
    let sentMessage = await getMessageFromSqlite(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.SENT);
    expect(sentMessage?.seeker).toBeDefined();

    // Simulate renewal reset
    const resetCount = await simulateRenewReset(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    expect(resetCount).toBe(1);

    // Verify reset state
    sentMessage = await getMessageFromSqlite(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sentMessage?.seeker).toBeNull();

    // DELIVERED should be unchanged
    const deliveredMessage = await getMessageFromSqlite(deliveredMessageId);
    expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
    expect(deliveredMessage?.seeker).toBeDefined();

    // Process waiting messages (session is still active)
    const sendResult = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );

    expect(sendResult.success).toBe(true);
    if (!sendResult.success) throw sendResult.error;
    expect(sendResult.data).toBe(1);
    sentMessage = await getMessageFromSqlite(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.SENT);
  });

  it('should reset multiple unacknowledged messages (SENT, SENDING, FAILED) on renew', async () => {
    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add messages with different statuses
    const sentId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'SENT message',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(Date.now() - 3000),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
    });

    const sendingId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'SENDING message (interrupted)',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(Date.now() - 2000),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    const failedId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'FAILED message',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(Date.now() - 1000),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(3),
    });

    const deliveredId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'DELIVERED message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 5000),
      seeker: new Uint8Array(32).fill(4),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    // Simulate renewal
    const resetCount = await simulateRenewReset(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    expect(resetCount).toBe(3); // SENT, SENDING, FAILED

    // Verify reset
    expect((await getMessageFromSqlite(sentId))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    expect((await getMessageFromSqlite(sendingId))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    expect((await getMessageFromSqlite(failedId))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    expect((await getMessageFromSqlite(deliveredId))?.status).toBe(
      MessageStatus.DELIVERED
    );

    // Process waiting messages
    const sendResult2 = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );
    expect(sendResult2.success).toBe(true);
    if (!sendResult2.success) throw sendResult2.error;
    expect(sendResult2.data).toBe(3);
  });

  it('should process waiting messages in order after renewal', async () => {
    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add 3 messages in order
    const msg1Id = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Message 1',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    const msg2Id = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Message 2',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(Date.now() - 2000),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    const msg3Id = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Message 3',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(Date.now() - 1000),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(3),
    });

    // Simulate renewal reset for SENT messages
    await simulateRenewReset(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );

    // Process waiting messages
    const sendResult3 = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );
    expect(sendResult3.success).toBe(true);
    if (!sendResult3.success) throw sendResult3.error;
    expect(sendResult3.data).toBe(3);

    // All should be SENT now
    expect((await getMessageFromSqlite(msg1Id))?.status).toBe(
      MessageStatus.SENT
    );
    expect((await getMessageFromSqlite(msg2Id))?.status).toBe(
      MessageStatus.SENT
    );
    expect((await getMessageFromSqlite(msg3Id))?.status).toBe(
      MessageStatus.SENT
    );
  });

  it('should not resend incoming messages on renewal', async () => {
    // Establish session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const outgoingId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Outgoing message',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
    });

    const incomingId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Incoming message from Bob',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    // Simulate renewal — only outgoing SENT should be reset
    const resetCount = await simulateRenewReset(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    expect(resetCount).toBe(1);

    // Outgoing should be reset to WAITING_SESSION
    expect((await getMessageFromSqlite(outgoingId))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    // Incoming should remain DELIVERED
    expect((await getMessageFromSqlite(incomingId))?.status).toBe(
      MessageStatus.DELIVERED
    );
  });
});

// ============================================================================
// WAITING_SESSION after accept
// ============================================================================

describe('WAITING_SESSION messages after peer acceptance', () => {
  let alice: TestSessionData;
  let bob: TestSessionData;
  let mockProtocol: MockMessageProtocol;
  let events: SdkEventEmitter;
  let messageService: MessageService;
  let discussionService: DiscussionService;
  let announcementService: AnnouncementService;

  function createUserProfile(userId: string) {
    return {
      userId,
      username: 'test',
      security: {
        encKeySalt: new Uint8Array(),
        authMethod: 'password' as const,
        mnemonicBackup: {
          encryptedMnemonic: new Uint8Array(),
          createdAt: new Date(),
          backedUp: false,
        },
      },
      session: new Uint8Array(),
      status: 'online' as const,
      lastSeen: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  beforeEach(async () => {
    await clearAllTables();

    alice = await createTestSession(`alice-waiting-${Date.now()}`);
    bob = await createTestSession(`bob-waiting-${Date.now()}`);

    mockProtocol = new MockMessageProtocol();
    events = new SdkEventEmitter();

    await getSqliteDb().insert(schema.contacts).values({
      ownerUserId: alice.session.userIdEncoded,
      userId: bob.session.userIdEncoded,
      name: 'Bob',
      publicKeys: bob.session.ourPk.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    const profile = createUserProfile(alice.session.userIdEncoded);
    await getSqliteDb()
      .insert(schema.userProfile)
      .values({
        userId: profile.userId,
        username: profile.username,
        security: JSON.stringify(profile.security),
        session: new Uint8Array([0]), // placeholder — empty Uint8Array fails NOT NULL
        status: profile.status,
        lastSeen: profile.lastSeen,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      });

    announcementService = new AnnouncementService(
      mockProtocol,
      alice.session,
      events
    );
    discussionService = new DiscussionService(
      announcementService,
      alice.session,
      events
    );
    messageService = new MessageService(mockProtocol, alice.session, events);

    // Wire up RefreshService so stateUpdate() inside services works
    const refreshService = new RefreshService(
      messageService,
      discussionService,
      announcementService,
      alice.session,
      events
    );
    discussionService.setRefreshService(refreshService);
    messageService.setRefreshService(refreshService);
    announcementService.setRefreshService(refreshService);
  });

  afterEach(() => {
    cleanupTestSession(alice);
    cleanupTestSession(bob);
  });

  it('messages queued before acceptance should send after session becomes Active', async () => {
    // Alice initiates session to Bob (SelfRequested state)
    await alice.session.establishOutgoingSession(bob.session.ourPk);

    expect(alice.session.peerSessionStatus(bob.session.userId)).toBe(
      SessionStatus.SelfRequested
    );

    // Create pending discussion
    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.PENDING,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Alice tries to send a message before Bob accepts
    const message = {
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Hello Bob! (sent before you accepted)',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    };

    const sendResult = await messageService.sendMessage(message);

    // Message should be queued as WAITING_SESSION
    expect(sendResult.success).toBe(true);
    expect(sendResult.message?.status).toBe(MessageStatus.WAITING_SESSION);

    const queuedMessageId = sendResult.message!.id!;
    let dbMessage = await getMessageFromSqlite(queuedMessageId);
    expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);

    // Now Bob accepts - establish the full handshake
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    // Session should now be active
    expect(alice.session.peerSessionStatus(bob.session.userId)).toBe(
      SessionStatus.Active
    );

    // Update discussion to active
    const discussion = await getDiscussionByOwnerAndContact(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    await getSqliteDb()
      .update(schema.discussions)
      .set({ status: DiscussionStatus.ACTIVE, updatedAt: new Date() })
      .where(eq(schema.discussions.id, discussion!.id!));

    // Process waiting messages
    const processResult = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );

    expect(processResult.success).toBe(true);
    if (!processResult.success) throw processResult.error;
    expect(processResult.data).toBe(1);
    dbMessage = await getMessageFromSqlite(queuedMessageId);
    expect(dbMessage?.status).toBe(MessageStatus.SENT);
  });

  it('processSendQueueForContact correctly sends messages when called manually', async () => {
    // Establish full session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await addDiscussionToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      weAccepted: true,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add a WAITING_SESSION message directly
    const messageId = await addMessageToSqlite({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Stuck message',
      messageId: crypto.getRandomValues(new Uint8Array(12)),
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    let dbMessage = await getMessageFromSqlite(messageId);
    expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);

    const processResult = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );

    expect(processResult.success).toBe(true);
    if (!processResult.success) throw processResult.error;
    expect(processResult.data).toBe(1);
    dbMessage = await getMessageFromSqlite(messageId);
    expect(dbMessage?.status).toBe(MessageStatus.SENT);
  });

  it('full flow: Alice initiates, sends message, Bob accepts, message delivered', async () => {
    // Create pending discussion
    const aliceBobContact = {
      ownerUserId: alice.session.userIdEncoded,
      userId: bob.session.userIdEncoded,
      name: 'Bob',
      publicKeys: bob.session.ourPk.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    // Alice initiates discussion
    const result = await discussionService.initialize(aliceBobContact);

    if (!result.success) throw result.error;

    const discussion = await getDiscussionFromSqlite(result.data.discussionId);
    expect(discussion?.status).toBe(DiscussionStatus.PENDING);

    // Alice sends a message (will be queued)
    const sendResult = await messageService.sendMessage({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Hello Bob!',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(sendResult.success).toBe(true);
    expect(sendResult.message?.status).toBe(MessageStatus.WAITING_SESSION);

    // Bob receives Alice's announcement and accepts
    const storedAnnouncements = mockProtocol.getStoredAnnouncements();
    expect(storedAnnouncements.length).toBe(1);

    // Bob processes the announcement
    await bob.session.feedIncomingAnnouncement(storedAnnouncements[0].data);

    // Bob sends acceptance
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );

    // Alice receives Bob's acceptance
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    // Session should now be active
    expect(alice.session.peerSessionStatus(bob.session.userId)).toBe(
      SessionStatus.Active
    );

    // Update discussion status
    await getSqliteDb()
      .update(schema.discussions)
      .set({ status: DiscussionStatus.ACTIVE })
      .where(eq(schema.discussions.id, result.data.discussionId));

    // Process waiting messages
    const processResult = await messageService.processSendQueueForContact(
      bob.session.userIdEncoded
    );

    expect(processResult.success).toBe(true);
    if (!processResult.success) throw processResult.error;
    expect(processResult.data).toBe(1);

    const finalMessage = await getMessageFromSqlite(sendResult.message!.id!);
    expect(finalMessage?.status).toBe(MessageStatus.SENT);
  });
});
