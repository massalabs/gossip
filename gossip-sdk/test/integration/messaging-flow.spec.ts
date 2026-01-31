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
  db,
  MessageStatus,
  MessageDirection,
  MessageType,
  Contact,
} from '../../src/db';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdkImpl } from '../../src/gossipSdk';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageService } from '../../src/services/message';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';

describe('Messaging Flow', () => {
  let mockProtocol: MockMessageProtocol;

  let aliceSdk: GossipSdkImpl;
  let bobSdk: GossipSdkImpl;

  beforeAll(async () => {
    await ensureWasmInitialized();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
    mockProtocol.clearMockData();

    vi.clearAllMocks();

    // Generate mnemonics for SDK sessions
    const aliceMnemonic = generateMnemonic();
    const bobMnemonic = generateMnemonic();
    const aliceEncryptionKey = await generateEncryptionKey();
    const bobEncryptionKey = await generateEncryptionKey();

    // Create gossipSdk instances for Alice and Bob
    aliceSdk = new GossipSdkImpl();
    await aliceSdk.init({
      db,
    });
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

    bobSdk = new GossipSdkImpl();
    await bobSdk.init({
      db,
    });
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

      const bobAllMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobAllMessages.length).toBe(2);
      expect(bobAllMessages[0].status).toBe(MessageStatus.SENT);
      expect(bobAllMessages[1].status).toBe(MessageStatus.DELIVERED);
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
      await db.contacts.add(aliceBobContact);

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
      await db.contacts.add(bobAliceContact);

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
      const message = await db.messages.get(sendResult.message!.id!);
      expect(message?.status).toBe(MessageStatus.READY);
      expect(message?.whenToSend).toBeDefined();
      expect(message?.whenToSend?.getTime()).toBeGreaterThan(Date.now());
      expect(message?.encryptedMessage).toBeDefined();
      expect(message?.seeker).toBeDefined();

      // wait for delay
      await new Promise(resolve =>
        setTimeout(resolve, aliceSdk.config.messages.retryDelayMs)
      );

      // Trigger state update again (retry should succeed)
      await aliceSdk.updateState();

      // Restore original retry delay
      aliceSdk.config.messages.retryDelayMs = originalRetryDelay;

      // Check message status - should now be SENT
      const retriedMessage = await db.messages.get(sendResult.message!.id!);
      expect(retriedMessage?.status).toBe(MessageStatus.SENT);
      expect(retriedMessage?.whenToSend).toBeDefined();
      expect(retriedMessage?.encryptedMessage).toBeDefined();
      expect(retriedMessage?.seeker).toBeDefined();

      // Bob fetches messages to receive Alice's message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].content).toBe('Hello Bob!');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
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

      const aliceIncomingMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceSdk.userId, bobSdk.userId, MessageDirection.INCOMING])
        .toArray();
      const bobIncomingMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobSdk.userId, aliceSdk.userId, MessageDirection.INCOMING])
        .toArray();
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

      const bobAllMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobSentMessages = bobAllMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(bobSentMessages.length).toBe(2);
      expect(bobSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(bobSentMessages[1].status).toBe(MessageStatus.SENT);

      /* STEP 6: Bob and Alice fetch messages with success */
      await bobSdk.messages.fetch();

      const bobReceivedMessages = await bobSdk.messages.getMessages(
        aliceSdk.userId
      );

      expect(bobReceivedMessages.length).toBe(4);
      expect(bobReceivedMessages[2].content).toBe('Alice message 1');
      expect(bobReceivedMessages[3].content).toBe('Alice message 2');

      // Alice fetches Bob's messages
      await aliceSdk.messages.fetch();

      const aliceReceivedMessages = await aliceSdk.messages.getMessages(
        bobSdk.userId
      );

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

      // Bob renews session
      const bobRenewResult = await bobSdk.discussions.renew(aliceSdk.userId);
      expect(bobRenewResult.success).toBe(true);

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();
      // Check that Alice's message has status WAITING_SESSION and seeker, encryptedMessage, and when_send are undefined
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobMessages[0].seeker).toBeDefined();
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
      expect(aliceOutgoingAfterAck[0].content).toBe('Hello Bob!');
      expect(aliceOutgoingAfterAck[0].encryptedMessage).not.toBeDefined();
      expect(aliceOutgoingAfterAck[0].seeker).toBeDefined();
      expect(aliceOutgoingAfterAck[0].whenToSend).not.toBeDefined();

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
      expect(aliceOutgoingAfterRenew[0].encryptedMessage).not.toBeDefined();
      expect(aliceOutgoingAfterRenew[0].seeker).toBeDefined();
      expect(aliceOutgoingAfterRenew[0].whenToSend).not.toBeDefined();
    });

    it('Alice send msg, renew, resend, bob receive', async () => {
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
      expect(aliceMessagesBeforeRenew.length).toBe(1);
      expect(aliceMessagesBeforeRenew[0].status).toBe(MessageStatus.SENT);

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
      const aliceOutgoingAfter = aliceMessagesAfterRenew.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(aliceOutgoingAfter.length).toBe(1);
      expect(aliceOutgoingAfter[0].status).toBe(MessageStatus.SENT);
      expect(aliceOutgoingAfter[0].encryptedMessage).toBeDefined();
      expect(aliceOutgoingAfter[0].seeker).toBeDefined();
      expect(aliceOutgoingAfter[0].whenToSend).toBeDefined();

      // Bob fetches announcements (receives renewal)
      await bobSdk.announcements.fetch();

      // Bob fetches messages and should receive Alice's message
      await bobSdk.messages.fetch();
      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      expect(bobMessages.length).toBe(1);
      expect(bobMessages[0].content).toBe('Hello Bob!');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
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
      expect(bobIncomingAfter[0].content).toBe('Hello Bob!');
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

      const bobMessages = await bobSdk.messages.getMessages(aliceSdk.userId);
      const bobOutgoing = bobMessages.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(bobOutgoing.length).toBe(1);
      expect(bobOutgoing[0].status).toBe(MessageStatus.SENT);
    });
  });
});

// ============================================================================
// WAITING_SESSION after accept
// ============================================================================

describe('WAITING_SESSION messages after peer acceptance', () => {
  let alice: TestSessionData;
  let bob: TestSessionData;
  let mockProtocol: MockMessageProtocol;
  let events: GossipSdkEvents;
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
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    alice = await createTestSession(`alice-waiting-${Date.now()}`);
    bob = await createTestSession(`bob-waiting-${Date.now()}`);

    mockProtocol = new MockMessageProtocol();
    events = {};

    await db.contacts.add({
      ownerUserId: alice.session.userIdEncoded,
      userId: bob.session.userIdEncoded,
      name: 'Bob',
      publicKeys: bob.session.ourPk.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await db.userProfile.put(createUserProfile(alice.session.userIdEncoded));

    announcementService = new AnnouncementService(
      db,
      mockProtocol,
      alice.session,
      events
    );
    discussionService = new DiscussionService(
      db,
      announcementService,
      alice.session
    );
    messageService = new MessageService(
      db,
      mockProtocol,
      alice.session,
      discussionService,
      events
    );
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
    await db.discussions.add({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
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
    let dbMessage = await db.messages.get(queuedMessageId);
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
    const discussion = await db.getDiscussionByOwnerAndContact(
      alice.session.userIdEncoded,
      bob.session.userIdEncoded
    );
    await db.discussions.update(discussion!.id!, {
      status: DiscussionStatus.ACTIVE,
      updatedAt: new Date(),
    });

    // Process waiting messages
    const sentCount = await messageService.processWaitingMessages(
      bob.session.userIdEncoded
    );

    expect(sentCount).toBe(1);
    dbMessage = await db.messages.get(queuedMessageId);
    expect(dbMessage?.status).toBe(MessageStatus.SENT);
  });

  it('processWaitingMessages correctly sends messages when called manually', async () => {
    // Establish full session
    const aliceAnnouncement = await alice.session.establishOutgoingSession(
      bob.session.ourPk
    );
    await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
    const bobAnnouncement = await bob.session.establishOutgoingSession(
      alice.session.ourPk
    );
    await alice.session.feedIncomingAnnouncement(bobAnnouncement);

    await db.discussions.add({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Add a WAITING_SESSION message directly
    const messageId = await db.messages.add({
      ownerUserId: alice.session.userIdEncoded,
      contactUserId: bob.session.userIdEncoded,
      content: 'Stuck message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    let dbMessage = await db.messages.get(messageId);
    expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);

    const sentCount = await messageService.processWaitingMessages(
      bob.session.userIdEncoded
    );

    expect(sentCount).toBe(1);
    dbMessage = await db.messages.get(messageId);
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
    const { discussionId } = await discussionService.initialize(
      aliceBobContact,
      {
        username: undefined,
        message: 'Hello Bob!',
      }
    );

    const discussion = await db.discussions.get(discussionId);
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
    await db.discussions.update(discussionId, {
      status: DiscussionStatus.ACTIVE,
    });

    // Process waiting messages
    const sentCount = await messageService.processWaitingMessages(
      bob.session.userIdEncoded
    );

    expect(sentCount).toBe(1);

    const finalMessage = await db.messages.get(sendResult.message!.id!);
    expect(finalMessage?.status).toBe(MessageStatus.SENT);
  });
});
