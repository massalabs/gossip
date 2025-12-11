/**
 * Message Service Browser Tests
 *
 * These tests use the REAL WASM session manager in a browser environment
 * via Playwright. This provides end-to-end testing of the cryptographic
 * message handling without mocking the session layer.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  db,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  Message,
  Contact,
} from '../../src/db';
import { initializeWasm } from '../../src/wasm/loader';
import { generateUserKeys } from '../../src/wasm/userKeys';
import { SessionModule } from '../../src/wasm/session';
import {
  UserPublicKeys,
  UserSecretKeys,
  UserKeys,
  SessionStatus,
} from '../../src/assets/generated/wasm/gossip_wasm';
import { encodeUserId } from '../../src/utils/userId';
import { MockMessageProtocol } from '../../src/api/messageProtocol/mock';
import {
  acceptDiscussionRequest,
  initializeDiscussion,
  renewDiscussion,
} from '../../src/services/discussion';
import {
  announcementService,
  EstablishSessionError,
} from '../../src/services/announcement';
import { messageService } from '../../src/services/message';
import { createMessageProtocol } from '../../src/api/messageProtocol';
import { MessageProtocolType } from '../../src/config/protocol';

// Mock the message protocol factory to always return mock protocol
vi.mock('../src/api/messageProtocol', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/api/messageProtocol')>();
  return {
    ...actual,
    createMessageProtocol: vi.fn(() =>
      actual.createMessageProtocol(MessageProtocolType.MOCK)
    ),
  };
});

function getFailedOutgoingMessagesForContact(
  ownerUserId: string,
  contactUserId: string
): Promise<Message[]> {
  return db.messages
    .where('[ownerUserId+contactUserId]')
    .equals([ownerUserId, contactUserId])
    .and(
      m =>
        m.direction === MessageDirection.OUTGOING &&
        m.status === MessageStatus.FAILED
    )
    .sortBy('id');
}

async function resendFailedMessagesForContact(
  ownerUserId: string,
  contactUserId: string,
  session: SessionModule
): Promise<void> {
  const failedMessages = await getFailedOutgoingMessagesForContact(
    ownerUserId,
    contactUserId
  );
  await messageService.resendMessages(
    new Map([[contactUserId, failedMessages]]),
    session
  );
}

async function fetchMessagesFromContact(
  ownerUserId: string,
  contactUserId: string,
  ourSk: UserSecretKeys,
  session: SessionModule
): Promise<Message[]> {
  await messageService.fetchMessages(ownerUserId, ourSk, session);

  const messages = await db.messages
    .where('[ownerUserId+contactUserId+direction]')
    .equals([ownerUserId, contactUserId, MessageDirection.INCOMING])
    .toArray();
  return messages;
}

async function getMessagesToContact(
  contactUserId: string,
  ownerUserId: string,
  status?: MessageStatus
): Promise<Message[]> {
  const req = db.messages
    .where('[ownerUserId+contactUserId+direction]')
    .equals([contactUserId, ownerUserId, MessageDirection.OUTGOING]);
  if (status) {
    req.and(m => m.status === status);
  }
  return await req.toArray();
}

describe('Message Service (Browser with Real WASM)', () => {
  // Shared mock protocol for all tests
  let mockProtocol: MockMessageProtocol;

  // Alice's test data
  let aliceUserId: string;
  let aliceSession: SessionModule;
  let alicePk: UserPublicKeys;
  let aliceSk: UserSecretKeys;
  let aliceKeys: UserKeys;

  // Bob's test data
  let bobUserId: string;
  let bobSession: SessionModule;
  let bobPk: UserPublicKeys;
  let bobSk: UserSecretKeys;
  let bobKeys: UserKeys;

  // Initialize WASM before all tests
  beforeAll(async () => {
    await initializeWasm();
    mockProtocol = createMessageProtocol(
      MessageProtocolType.MOCK
    ) as MockMessageProtocol;
    announcementService.setMessageProtocol(mockProtocol);
    messageService.setMessageProtocol(mockProtocol);
  });

  beforeEach(async () => {
    // Clean up database
    if (db.isOpen()) {
      await db.delete();
    }
    await db.open();

    // Generate Alice's keys using real WASM
    aliceKeys = await generateUserKeys('alice-test-passphrase-' + Date.now());
    alicePk = aliceKeys.public_keys();
    aliceSk = aliceKeys.secret_keys();
    aliceUserId = encodeUserId(alicePk.derive_id());
    aliceSession = new SessionModule();

    // Generate Bob's keys using real WASM
    bobKeys = await generateUserKeys('bob-test-passphrase-' + Date.now());
    bobPk = bobKeys.public_keys();
    bobSk = bobKeys.secret_keys();
    bobUserId = encodeUserId(bobPk.derive_id());
    bobSession = new SessionModule();
  });

  /**
   * Helper to initialize a bidirectional session between Alice and Bob.
   * This simulates the announcement exchange that establishes an active session.
   */
  async function initSession(): Promise<{
    aliceDiscussionId: number;
    bobDiscussionId: number;
  }> {
    // Create reciprocal contacts
    const aliceBobContact: Omit<Contact, 'id'> = {
      ownerUserId: aliceUserId,
      userId: bobUserId,
      name: 'Bob',
      publicKeys: bobPk.to_bytes(),
      avatar: undefined,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    const bobAliceContact: Omit<Contact, 'id'> = {
      ownerUserId: bobUserId,
      userId: aliceUserId,
      name: 'Alice',
      publicKeys: alicePk.to_bytes(),
      avatar: undefined,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    await db.contacts.add(aliceBobContact);
    await db.contacts.add(bobAliceContact);

    // Alice initiates session with Bob (establishes outgoing session)
    const { discussionId: aliceDiscussionId } = await initializeDiscussion(
      aliceBobContact,
      alicePk,
      aliceSk,
      aliceSession,
      aliceUserId
    );

    // Bob fetches Alice's announcement and discussion is ACTIVE
    await announcementService.fetchAndProcessAnnouncements(
      bobPk,
      bobSk,
      bobSession
    );

    // Bob accepts the discussion request
    const bobDiscussion = await db.getDiscussionByOwnerAndContact(
      bobUserId,
      aliceUserId
    );
    if (!bobDiscussion)
      throw new Error('alice discussion not found on bob side');

    await acceptDiscussionRequest(bobDiscussion, bobSession, bobPk, bobSk);

    // Alice fetches Bob's announcement and discussion is ACTIVE
    await announcementService.fetchAndProcessAnnouncements(
      alicePk,
      aliceSk,
      aliceSession
    );

    return { aliceDiscussionId, bobDiscussionId: bobDiscussion.id! };
  }

  describe('send messages happy path', () => {
    beforeEach(async () => {
      // Initialize active discussion
      await initSession();
    });

    it('Alice sends several messages. Bob fetches them all at once and answers.', async () => {
      // STEP 1: Alice sends several messages quickly
      const aliceMessages = [
        'Hello Bob!',
        'How are you?',
        'I have a question for you.',
      ];

      const aliceMessageIds: number[] = [];

      for (const content of aliceMessages) {
        const message: Omit<Message, 'id'> = {
          ownerUserId: aliceUserId,
          contactUserId: bobUserId,
          content,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        };

        const res = await messageService.sendMessage(
          message as Message,
          aliceSession
        );
        expect(res.success).toBe(true);
        aliceMessageIds.push(res.message!.id!);
      }

      // Verify all Alice's messages are sent
      for (const messageId of aliceMessageIds) {
        const msg = await db.messages.get(messageId);
        expect(msg?.status).toBe(MessageStatus.SENT);
      }

      // STEP 2: Bob fetches all messages at once
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Verify Bob received all messages
      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .toArray();

      expect(bobReceivedMessages.length).toBe(3);
      expect(bobReceivedMessages[0].content).toBe(aliceMessages[0]);
      expect(bobReceivedMessages[1].content).toBe(aliceMessages[1]);
      expect(bobReceivedMessages[2].content).toBe(aliceMessages[2]);

      // STEP 3: Bob answers with several messages
      const bobMessages = ['Hi Alice!', 'I am doing great!', 'What is it?'];
      const bobMessageIds: number[] = [];

      for (const content of bobMessages) {
        const message: Omit<Message, 'id'> = {
          ownerUserId: bobUserId,
          contactUserId: aliceUserId,
          content,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        };

        const res = await messageService.sendMessage(
          message as Message,
          bobSession
        );
        expect(res.success).toBe(true);
        bobMessageIds.push(res.message!.id!);
      }

      // STEP 4: Alice receives Bob's messages
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Verify Alice received all Bob's messages
      const aliceReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .toArray();

      expect(aliceReceivedMessages.length).toBe(3);
      expect(aliceReceivedMessages[0].content).toBe(bobMessages[0]);
      expect(aliceReceivedMessages[1].content).toBe(bobMessages[1]);
      expect(aliceReceivedMessages[2].content).toBe(bobMessages[2]);

      // STEP 5: Alice's messages are set to delivered
      for (const messageId of aliceMessageIds) {
        const msg = await db.messages.get(messageId);
        expect(msg?.status).toBe(MessageStatus.DELIVERED);
      }
    });

    it('Both send messages to each other at the same time', async () => {
      // Alice sends a message
      const aliceMessageData: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Hey Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const aliceResult = await messageService.sendMessage(
        aliceMessageData as Message,
        aliceSession
      );
      expect(aliceResult.success).toBe(true);
      const aliceMessageId = aliceResult.message!.id!;

      // Bob sends a message at the same time
      const bobMessageData: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Hey Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const bobResult = await messageService.sendMessage(
        bobMessageData as Message,
        bobSession
      );
      expect(bobResult.success).toBe(true);
      const bobMessageId = bobResult.message!.id!;

      // Both messages are sent
      expect((await db.messages.get(aliceMessageId))?.status).toBe(
        MessageStatus.SENT
      );
      expect((await db.messages.get(bobMessageId))?.status).toBe(
        MessageStatus.SENT
      );

      // Alice fetches Bob's message
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Bob fetches Alice's message
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Verify both received each other's messages
      const aliceReceived = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .first();
      expect(aliceReceived?.content).toBe('Hey Alice!');

      const bobReceived = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .first();
      expect(bobReceived?.content).toBe('Hey Bob!');

      // In real WASM, delivery confirmation requires acknowledgment in a subsequent message
      // Both parties need to send another message for the first messages to be marked delivered
      // Bob sends a follow-up to acknowledge Alice's message
      const bobFollowUp: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Got your message!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobFollowUp as Message, bobSession);

      // Alice fetches Bob's follow-up which contains acknowledgment for her message
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Now Alice's first message should be delivered
      expect((await db.messages.get(aliceMessageId))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Alice sends a follow-up to acknowledge Bob's message
      const aliceFollowUp: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Got yours too!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(aliceFollowUp as Message, aliceSession);

      // Bob fetches Alice's follow-up which contains acknowledgment for his message
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Now Bob's first message should be delivered
      expect((await db.messages.get(bobMessageId))?.status).toBe(
        MessageStatus.DELIVERED
      );
    });

    it('Alice and Bob send each other several messages async', async () => {
      // Alice sends message 1
      const alice1Data: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 1 from Alice',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const alice1Result = await messageService.sendMessage(
        alice1Data as Message,
        aliceSession
      );
      const alice1Id = alice1Result.message!.id!;

      // Bob receives Alice's first message
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Verify Bob received Alice's message
      const bobReceivedFirst = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .first();
      expect(bobReceivedFirst?.content).toBe('Message 1 from Alice');

      // Bob sends response
      const bob1Data: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Response from Bob',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const bob1Result = await messageService.sendMessage(
        bob1Data as Message,
        bobSession
      );
      const bob1Id = bob1Result.message!.id!;

      // Alice receives Bob's response - this should acknowledge Alice's first message
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Alice's first message should now be delivered (acknowledged by Bob's response)
      expect((await db.messages.get(alice1Id))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Alice sends message 2
      const alice2Data: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 2 from Alice',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const alice2Result = await messageService.sendMessage(
        alice2Data as Message,
        aliceSession
      );
      const alice2Id = alice2Result.message!.id!;

      // Bob receives Alice's second message - this acknowledges Bob's response
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Bob's message should now be delivered
      expect((await db.messages.get(bob1Id))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Bob sends another response to acknowledge Alice's second message
      const bob2Data: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Got your second message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bob2Data as Message, bobSession);

      // Alice fetches Bob's second response
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Alice's second message should now be delivered
      expect((await db.messages.get(alice2Id))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Verify all messages are received
      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .toArray();

      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Message 1 from Alice');
      expect(bobReceivedMessages[1].content).toBe('Message 2 from Alice');
    });
  });

  describe('retry messages', () => {
    it('Alice sends messages after session is established, Bob receives them after accepting', async () => {
      // This test verifies the full session establishment flow where:
      // 1. Alice initiates session with Bob
      // 2. Bob accepts by processing Alice's announcement and sending his own
      // 3. Alice processes Bob's announcement (session now Active)
      // 4. Alice can now send messages
      // 5. Bob receives the messages

      /* STEP 1: Alice initiates session with Bob */
      // Alice creates Bob as a contact
      const aliceBobContact: Omit<Contact, 'id'> = {
        ownerUserId: aliceUserId,
        userId: bobUserId,
        name: 'Bob',
        publicKeys: bobPk.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      };
      await db.contacts.add(aliceBobContact);

      // Alice initiates session (SelfRequested state)
      await initializeDiscussion(
        aliceBobContact,
        alicePk,
        aliceSk,
        aliceSession,
        aliceUserId
      );

      // Verify Alice's session is in SelfRequested state
      expect(aliceSession.peerSessionStatus(bobPk.derive_id())).toBe(
        SessionStatus.SelfRequested
      );

      /* STEP 2: Alice send 2 messages while the discussion is still pending */
      const aliceMessages = ['First message', 'Second message'];
      const aliceMessageData: Omit<Message, 'id'>[] = [];
      for (let i = 0; i < aliceMessages.length; i++) {
        const content = aliceMessages[i];
        aliceMessageData.push({
          ownerUserId: aliceUserId,
          contactUserId: bobUserId,
          content: content,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        });
        const res = await messageService.sendMessage(
          aliceMessageData[i],
          aliceSession
        );
        /* It's not possible to send message while the discussion is still in pending state waiting for peer acceptance
        But the message should be added to the database as failed and will be resent later when the discussion is accepted by the peer*/
        expect(res.success).toBe(false);
        expect(res.message?.status).toBe(MessageStatus.FAILED);
      }

      /* STEP 3: Bob fetches Alice's announcement and accept it */
      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession
      );

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      if (!bobDiscussion)
        throw new Error('alice discussion not found on bob side');
      await acceptDiscussionRequest(bobDiscussion, bobSession, bobPk, bobSk);

      // Verify Bob's session is now Active
      expect(bobSession.peerSessionStatus(alicePk.derive_id())).toBe(
        SessionStatus.Active
      );

      /* STEP 4: Alice receive Bob's announcement and resends her messages */
      await announcementService.fetchAndProcessAnnouncements(
        alicePk,
        aliceSk,
        aliceSession
      );

      // Verify Alice's session is now Active
      expect(aliceSession.peerSessionStatus(bobPk.derive_id())).toBe(
        SessionStatus.Active
      );

      // resend messages
      const messagesDb = await getFailedOutgoingMessagesForContact(
        aliceUserId,
        bobUserId
      );
      await messageService.resendMessages(
        new Map([[bobUserId, messagesDb]]),
        aliceSession
      );

      // Verify Alice's messages are resent
      const aliceFailedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();

      expect(aliceFailedMessages.length).toBe(2);
      expect(aliceFailedMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceFailedMessages[1].status).toBe(MessageStatus.SENT);

      /* STEP 5: Bob receives Alice's messages */
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Verify Bob received both messages
      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .toArray();
      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe(aliceMessages[0]);
      expect(bobReceivedMessages[1].content).toBe(aliceMessages[1]);

      /* STEP 6: Bob send a message to Alice */
      const bobMessageData: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Hello Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      const bobMessageResult = await messageService.sendMessage(
        bobMessageData as Message,
        bobSession
      );
      expect(bobMessageResult.success).toBe(true);

      /* STEP 7: Alice fetch bob message and her message is acknowledged*/
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // Verify Alice received Bob's message
      const aliceReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();
      expect(aliceReceivedMessages.length).toBe(3);
      expect(aliceReceivedMessages[0].content).toBe(aliceMessages[0]);
      expect(aliceReceivedMessages[1].content).toBe(aliceMessages[1]);
      expect(aliceReceivedMessages[2].content).toBe('Hello Alice!');
      expect(aliceReceivedMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(aliceReceivedMessages[1].status).toBe(MessageStatus.DELIVERED);
      expect(aliceReceivedMessages[2].status).toBe(MessageStatus.DELIVERED);
    });

    it('Both alice and bob fail sending messages because of transport issue. Messages are resent in order', async () => {
      /* STEP 1: Initialize active discussion between Alice and Bob */
      await initSession();

      // Mock transport failures for the next sends
      const originalSendMessage = mockProtocol.sendMessage.bind(mockProtocol);
      let sendAttempts = 0;

      mockProtocol.sendMessage = vi.fn(async message => {
        sendAttempts++;
        // First 4 sends (2 from Alice, 2 from Bob) should fail
        if (sendAttempts <= 4) {
          throw new Error('Transport failure');
        }
        // Subsequent sends succeed
        return originalSendMessage(message);
      });

      /* STEP 2: Alice sends 2 messages that will fail */
      const aliceMessage1: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Alice message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const aliceMessage2: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Alice message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const aliceResult1 = await messageService.sendMessage(
        aliceMessage1 as Message,
        aliceSession
      );
      expect(aliceResult1.success).toBe(false);
      expect(aliceResult1.message?.status).toBe(MessageStatus.FAILED);

      const aliceResult2 = await messageService.sendMessage(
        aliceMessage2 as Message,
        aliceSession
      );
      expect(aliceResult2.success).toBe(false);
      expect(aliceResult2.message?.status).toBe(MessageStatus.FAILED);

      /* STEP 3: Bob sends 2 messages that will fail */
      const bobMessage1: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Bob message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const bobMessage2: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Bob message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const bobResult1 = await messageService.sendMessage(
        bobMessage1 as Message,
        bobSession
      );
      expect(bobResult1.success).toBe(false);
      expect(bobResult1.message?.status).toBe(MessageStatus.FAILED);

      const bobResult2 = await messageService.sendMessage(
        bobMessage2 as Message,
        bobSession
      );
      expect(bobResult2.success).toBe(false);
      expect(bobResult2.message?.status).toBe(MessageStatus.FAILED);

      /* STEP 4: Alice and Bob fetch messages but nothing is received */
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);
      const aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .toArray();
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .toArray();
      expect(aliceMessages.length).toBe(0);
      expect(bobMessages.length).toBe(0);

      /* STEP 5: Alice and Bob resend messages */
      // Get failed messages for resending
      const aliceFailedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            m.status === MessageStatus.FAILED
        )
        .sortBy('id');

      const bobFailedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .and(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            m.status === MessageStatus.FAILED
        )
        .sortBy('id');

      expect(aliceFailedMessages.length).toBe(2);
      expect(bobFailedMessages.length).toBe(2);

      // Resend Alice's messages in order
      const aliceMessagesToResend = new Map<string, Message[]>();
      aliceMessagesToResend.set(bobUserId, aliceFailedMessages);
      await messageService.resendMessages(aliceMessagesToResend, aliceSession);

      // Resend Bob's messages in order
      const bobMessagesToResend = new Map<string, Message[]>();
      bobMessagesToResend.set(aliceUserId, bobFailedMessages);
      await messageService.resendMessages(bobMessagesToResend, bobSession);

      // Verify all messages are now SENT
      const aliceSentMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      expect(aliceSentMessages.length).toBe(2);
      expect(aliceSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceSentMessages[1].status).toBe(MessageStatus.SENT);

      const bobSentMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      expect(bobSentMessages.length).toBe(2);
      expect(bobSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(bobSentMessages[1].status).toBe(MessageStatus.SENT);

      /* STEP 6: Bob and Alice fetch messages with success */
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Alice message 1');
      expect(bobReceivedMessages[1].content).toBe('Alice message 2');

      // Alice fetches Bob's messages
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      const aliceReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      expect(aliceReceivedMessages.length).toBe(2);
      expect(aliceReceivedMessages[0].content).toBe('Bob message 1');
      expect(aliceReceivedMessages[1].content).toBe('Bob message 2');

      // Restore original mock
      // mockProtocol.sendMessage = originalSendMessage;
    });

    it('Both alice and bob fail sending messages because of transport issue. Messages are resent in disorder because of transport issue', async () => {
      /* STEP 1: Initialize active discussion between Alice and Bob */
      await initSession();

      // Get mock protocol instance
      // const mockProtocol = messageService.messageProtocol as MockMessageProtocol;

      // Mock transport failures
      const originalSendMessage = mockProtocol.sendMessage.bind(mockProtocol);
      let sendAttempts = 0;

      mockProtocol.sendMessage = vi.fn(async message => {
        sendAttempts++;
        // First 8 sends (4 from Alice, 4 from Bob) should fail
        if (sendAttempts <= 8) {
          throw new Error('Transport failure');
        }
        // Subsequent sends succeed
        return originalSendMessage(message);
      });

      /* STEP 2: Alice and Bob send messages that will fail */
      // Alice sends 4 messages that will fail
      const aliceMessages: Message[] = [];
      for (let i = 1; i <= 4; i++) {
        const message: Omit<Message, 'id'> = {
          ownerUserId: aliceUserId,
          contactUserId: bobUserId,
          content: `Alice message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        };

        const result = await messageService.sendMessage(
          message as Message,
          aliceSession
        );
        expect(result.success).toBe(false);
        aliceMessages.push(result.message!);
      }

      // Bob sends 4 messages that will fail
      const bobMessages: Message[] = [];
      for (let i = 1; i <= 4; i++) {
        const message: Omit<Message, 'id'> = {
          ownerUserId: bobUserId,
          contactUserId: aliceUserId,
          content: `Bob message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
        };

        const result = await messageService.sendMessage(
          message as Message,
          bobSession
        );
        expect(result.success).toBe(false);
        bobMessages.push(result.message!);
      }

      /* STEP 3: Alice and Bob messages are resent in disorder ( [4, 1, 3, 2] and [3, 4, 1, 2] respectively) because of transport issue */
      let counter = 0;
      const attemptToFail = [
        1,
        2,
        3, // Alice 1st attempt
        5,
        6, // Bob 1st attempt
        10, // Alice 2nd attempt
      ];
      mockProtocol.sendMessage = vi.fn(async message => {
        counter++;
        if (attemptToFail.includes(counter)) {
          throw new Error('Transport failure');
        }
        return originalSendMessage(message);
      });

      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // Bob fetch messages but nothing is received
      let bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobSk,
        bobSession
      );
      expect(bobMsg.length).toBe(0);

      // Bob 1st resend
      await resendFailedMessagesForContact(bobUserId, aliceUserId, bobSession);

      // Alice fetch messages but nothing is received
      let aliceMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobSk,
        bobSession
      );
      expect(aliceMsg.length).toBe(0);

      // Alice 2nd resend
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // Bob received message 1 but not 3 and 4
      bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobSk,
        bobSession
      );
      expect(bobMsg.length).toBe(1);
      expect(bobMsg[0].content).toBe('Alice message 1');

      // Bob 2nd resend
      await resendFailedMessagesForContact(bobUserId, aliceUserId, bobSession);

      // Alice received all messages in ordeencodeToBase64r
      aliceMsg = await fetchMessagesFromContact(
        aliceUserId,
        bobUserId,
        aliceSk,
        aliceSession
      );
      expect(aliceMsg.length).toEqual(4);
      expect(aliceMsg[0].content).toBe('Bob message 1');
      expect(aliceMsg[1].content).toBe('Bob message 2');
      expect(aliceMsg[2].content).toBe('Bob message 3');
      expect(aliceMsg[3].content).toBe('Bob message 4');

      // Alice 3rd resend
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // Bob received all messages in order
      bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobSk,
        bobSession
      );
      expect(bobMsg.length).toBe(4);
      expect(bobMsg[0].content).toBe('Alice message 1');
      expect(bobMsg[1].content).toBe('Alice message 2');
      expect(bobMsg[2].content).toBe('Alice message 3');
      expect(bobMsg[3].content).toBe('Alice message 4');

      // Verify all messages are SENT
      // no message should be DELIVERED because no message acknowledge any message
      const alice2BobMessages = await getMessagesToContact(
        aliceUserId,
        bobUserId
      );
      const bob2AliceMessages = await getMessagesToContact(
        bobUserId,
        aliceUserId
      );
      expect(alice2BobMessages.length).toBe(4);
      expect(bob2AliceMessages.length).toBe(4);

      // Restore original mock
      mockProtocol.sendMessage = originalSendMessage;
    });

    it('Alice session break and reinitiate it by resending all messages', async () => {
      /**
     * Test: Alice session break and reinitiate it by resending all messages
     * 
     * This test verifies the complete flow of session recovery and message resending when a session breaks:
     * 
     * 1. Initial Setup: Alice and Bob establish an active discussion and exchange messages successfully
     * 
     * 2. Message Failure Sequence:
     *    - Alice sends message 1 → succeeds and gets DELIVERED after Bob acknowledges
     *    - Alice sends message 2 → succeeds (SENT status)
     *    - Alice sends message 3 → transport fails, message marked FAILED with encryptedMessage
     *    - Session breaks (SessionStatus.Killed)
     *    - Alice tries to send message 4 → fails without encryptedMessage (session broken)
     *    - Discussion status changes to BROKEN
     * 
     * 3. Session Renewal:
     *    - First renewal attempt fails (establishSession returns empty announcement)
     *    - Second renewal attempt succeeds, discussion becomes ACTIVE
     *    - Failed messages (2, 3, 4) are marked FAILED with encryptedMessage cleared
     * 
     * 4. Message Resending with Partial Failures:
     *    - Alice resends all failed messages
     *    - Message 2 succeeds
     *    - Message 3 fails during transport (but keeps encryptedMessage)
     *    - Message 4 succeeds
     *    - Bob fetches and receives messages 2 and 4, but not 3
     * 
     * 5. Final Successful Resend:
     *    - Alice resends all failed messages again
     *    - All messages succeed this time
     *    - Bob fetches and receives all messages (1, 2, 3, 4)
     *    - Bob sends reply, Alice fetches
     *    - All Alice's messages are marked as DELIVERED
 
     */

      /* STEP 1: Initialize active discussion between Alice and Bob */
      await initSession();

      // Get mock protocol instance
      // const mockProtocol = messageService.messageProtocol as MockMessageProtocol;

      /* STEP 2: initiate message configuration: 
      
      - Alice sends first message - succeeds and will be delivered
      - Bob fetches and acknowledges message 1
      - Alice fetches Bob's message - this marks message 1 as DELIVERED
      - Alice sends second message - succeeds, message is SENT
      - Mock transport failure for next send
      - Alice sends third message - transport fails, FAILED with encryptedMessage
      - Session breaks
      - Alice tries to send message 4 while session is broken - FAILED without encryptedMessage
      */
      // Alice sends first message - succeeds and will be delivered
      const message1: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result1 = await messageService.sendMessage(
        message1 as Message,
        aliceSession
      );
      console.log(' result1:', result1);
      expect(result1.success).toBe(true);
      const message1Id = result1.message!.id!;

      // Bob fetches and acknowledges message 1
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      // Bob sends acknowledgment
      const bobAck: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Got it',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobAck as Message, bobSession);

      // Alice fetches Bob's message - this marks message 1 as DELIVERED
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      expect((await db.messages.get(message1Id))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Alice sends second message - succeeds, message is SENT
      const message2: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result2 = await messageService.sendMessage(
        message2 as Message,
        aliceSession
      );
      expect(result2.success).toBe(true);
      const message2Id = result2.message!.id!;

      // Mock transport failure for next send
      const originalSendMessage = mockProtocol.sendMessage.bind(mockProtocol);
      vi.spyOn(mockProtocol, 'sendMessage').mockRejectedValueOnce(
        new Error('Transport failure')
      );

      // Alice sends third message - transport fails, FAILED with encryptedMessage
      const message3: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 3',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result3 = await messageService.sendMessage(
        message3 as Message,
        aliceSession
      );
      mockProtocol.sendMessage = originalSendMessage;

      expect(result3.success).toBe(false);
      expect(result3.message?.status).toBe(MessageStatus.FAILED);
      const message3Id = result3.message!.id!;

      // Verify message 3 has encryptedMessage
      const msg3 = await db.messages.get(message3Id);
      expect(msg3?.encryptedMessage).toBeDefined();
      expect(msg3?.seeker).toBeDefined();

      // Mock session status to simulate a broken session (SessionStatus.Killed)
      const peerSessionStatusSpy = vi
        .spyOn(aliceSession, 'peerSessionStatus')
        .mockReturnValue(SessionStatus.Killed);

      // Alice tries to send message 4 while session is broken - FAILED without encryptedMessage
      const message4: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 4',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result4 = await messageService.sendMessage(
        message4 as Message,
        aliceSession
      );
      expect(result4.success).toBe(false);
      const message4Id = result4.message!.id!;

      // Verify discussion is BROKEN
      const discussion = await db.getDiscussionByOwnerAndContact(
        aliceUserId,
        bobUserId
      );
      expect(discussion?.status).toBe(DiscussionStatus.BROKEN);

      // Bob sends a message to Alice while broken
      const bobMessage: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Bob message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobMessage as Message, bobSession);

      /* STEP 3: Alice attempts to renew session but establishSession fails */
      const originalEstablishOutgoingSession =
        aliceSession.establishOutgoingSession;
      aliceSession.establishOutgoingSession = vi.fn(() => new Uint8Array(0));

      // First renewal attempt - fails
      await expect(
        renewDiscussion(aliceUserId, bobUserId, aliceSession, alicePk, aliceSk)
      ).rejects.toThrow(EstablishSessionError);
      aliceSession.establishOutgoingSession = originalEstablishOutgoingSession;

      // Verify discussion is BROKEN
      const discussionAfterFailedRenew =
        await db.getDiscussionByOwnerAndContact(aliceUserId, bobUserId);
      expect(discussionAfterFailedRenew?.status).toBe(DiscussionStatus.BROKEN);

      /* STEP 4: Second renewal attempt - succeeds */
      // Second renewal attempt - succeeds
      peerSessionStatusSpy.mockRestore();
      console.log('Second renewal attempt aliceSession:', aliceSession);
      await renewDiscussion(
        aliceUserId,
        bobUserId,
        aliceSession,
        alicePk,
        aliceSk
      );

      // Verify discussion is ACTIVE
      const discussionAfterRenew = await db.getDiscussionByOwnerAndContact(
        aliceUserId,
        bobUserId
      );
      expect(discussionAfterRenew?.status).toBe(DiscussionStatus.ACTIVE);

      // Verify messages 2, 3, 4 are FAILED with undefined encryptedMessage and seeker
      const msg2AfterRenew = await db.messages.get(message2Id);
      expect(msg2AfterRenew?.status).toBe(MessageStatus.FAILED);
      expect(msg2AfterRenew?.encryptedMessage).toBeUndefined();
      // Note: seeker may still exist after renewal (it's only cleared for messages that haven't been encrypted yet)

      const msg3AfterRenew = await db.messages.get(message3Id);
      expect(msg3AfterRenew?.status).toBe(MessageStatus.FAILED);
      expect(msg3AfterRenew?.encryptedMessage).toBeUndefined();

      const msg4AfterRenew = await db.messages.get(message4Id);
      expect(msg4AfterRenew?.status).toBe(MessageStatus.FAILED);
      expect(msg4AfterRenew?.encryptedMessage).toBeUndefined();

      // Bob fetches and processes Alice's new announcement
      await announcementService.fetchAndProcessAnnouncements(
        bobPk,
        bobSk,
        bobSession
      );

      // Bob's discussion with Alice should be still ACTIVE
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      /* STEP 5: Mock partial transport failures for resend */
      let resendAttempts = 0;
      mockProtocol.sendMessage = vi.fn(async message => {
        resendAttempts++;
        if (resendAttempts === 2) {
          // Second resend attempt (message 3) fails during transport
          // The message was encrypted but couldn't be sent
          throw new Error('Transport failure');
        }
        // Other attempts succeed
        return originalSendMessage(message);
      });

      // Resend failed messages (2, 3, 4)
      const failedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            m.status === MessageStatus.FAILED
        )
        .sortBy('id');

      expect(failedMessages.length).toBe(3);

      const messagesToResend = new Map<string, Message[]>();
      messagesToResend.set(bobUserId, failedMessages);
      await messageService.resendMessages(messagesToResend, aliceSession);

      // Verify statuses after first resend attempt:
      // - Message 2: success
      // - Message 3: FAILED (transport failed, but encryptedMessage was stored)
      // - Message 4: success
      const msg2AfterResend = await db.messages.get(message2Id);
      expect(msg2AfterResend?.status).toBe(MessageStatus.SENT);

      const msg3AfterResend = await db.messages.get(message3Id);
      expect(msg3AfterResend?.status).toBe(MessageStatus.FAILED); // Still FAILED, not attempted
      expect(msg3AfterResend?.encryptedMessage).toBeDefined(); // Was encrypted before transport failure
      console.log('message3Id:', message3Id);
      console.log('message4Id:', message4Id);
      const msg4AfterResend = await db.messages.get(message4Id);
      console.log('msg4AfterResend :', msg4AfterResend);

      expect(msg4AfterResend?.status).toBe(MessageStatus.SENT);

      // Bob tries to fetch - should get messages 2 but not 4
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      let bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      // Bob should have no new messages yet
      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Message 1');
      expect(bobReceivedMessages[1].content).toBe('Message 2');

      // Restore mocks for successful resend
      mockProtocol.sendMessage = originalSendMessage;

      /* STEP 6: Alice resends all failed messages again - now all succeed */
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // Bob fetches all messages
      await messageService.fetchMessages(bobUserId, bobSk, bobSession);

      bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      // Bob should have received messages all messages
      expect(bobReceivedMessages.length).toBe(4);
      expect(bobReceivedMessages[0].content).toBe('Message 1');
      expect(bobReceivedMessages[1].content).toBe('Message 2');
      expect(bobReceivedMessages[2].content).toBe('Message 3');
      expect(bobReceivedMessages[3].content).toBe('Message 4');

      // Bob sends a message back
      const bobReply: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Reply from Bob',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobReply as Message, bobSession);

      // Alice fetches messages
      await messageService.fetchMessages(aliceUserId, aliceSk, aliceSession);

      // All Alice's messages should now be DELIVERED
      const allAliceMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      expect(
        allAliceMessages.every(m => m.status === MessageStatus.DELIVERED)
      ).toBe(true);
    });
  });
});
