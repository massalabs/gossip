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
  SessionConfig,
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
import { handleSessionRefresh } from '../../src/services/refresh';
import {
  serializeRegularMessage,
  serializeReplyMessage,
  MESSAGE_TYPE_KEEP_ALIVE,
} from '../../src/utils/messageSerialization';
import { Result } from '../../src/utils/type';

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
  await messageService.fetchMessages(session);

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

    // Reset mock protocol state to prevent test interference
    mockProtocol.clearMockData();

    // Generate Alice's keys using real WASM
    aliceKeys = await generateUserKeys('alice-test-passphrase-' + Date.now());
    alicePk = aliceKeys.public_keys();
    aliceSk = aliceKeys.secret_keys();
    aliceUserId = encodeUserId(alicePk.derive_id());
    aliceSession = new SessionModule(aliceKeys);

    // Generate Bob's keys using real WASM
    bobKeys = await generateUserKeys('bob-test-passphrase-' + Date.now());
    bobPk = bobKeys.public_keys();
    bobSk = bobKeys.secret_keys();
    bobUserId = encodeUserId(bobPk.derive_id());
    bobSession = new SessionModule(bobKeys);
  });

  /**
   * Helper to initialize a bidirectional session between Alice and Bob.
   * This simulates the announcement exchange that establishes an active session.
   */
  async function initAliceBobSession(): Promise<{
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
      aliceSession,
      aliceUserId
    );

    // Bob fetches Alice's announcement and discussion is ACTIVE
    await announcementService.fetchAndProcessAnnouncements(bobSession);

    // Bob accepts the discussion request
    const bobDiscussion = await db.getDiscussionByOwnerAndContact(
      bobUserId,
      aliceUserId
    );
    if (!bobDiscussion)
      throw new Error('alice discussion not found on bob side');

    await acceptDiscussionRequest(bobDiscussion, bobSession);

    // Alice fetches Bob's announcement and discussion is ACTIVE
    await announcementService.fetchAndProcessAnnouncements(aliceSession);

    return { aliceDiscussionId, bobDiscussionId: bobDiscussion.id! };
  }

  /**
   * Generic helper to initialize a bidirectional session between any two peers.
   * @param peer1Sk - First peer's secret keys
   * @param peer1Pk - First peer's public keys
   * @param peer1Session - First peer's session module
   * @param peer2Sk - Second peer's secret keys
   * @param peer2Pk - Second peer's public keys
   * @param peer2Session - Second peer's session module
   * @returns Discussion IDs for both peers
   */
  async function initSession(
    peer1Sk: UserSecretKeys,
    peer1Pk: UserPublicKeys,
    peer1Session: SessionModule,
    peer2Sk: UserSecretKeys,
    peer2Pk: UserPublicKeys,
    peer2Session: SessionModule
  ): Promise<{
    peer1DiscussionId: number;
    peer2DiscussionId: number;
  }> {
    const peer1UserId = encodeUserId(peer1Pk.derive_id());
    const peer2UserId = encodeUserId(peer2Pk.derive_id());

    // Create reciprocal contacts
    const peer1Peer2Contact: Omit<Contact, 'id'> = {
      ownerUserId: peer1UserId,
      userId: peer2UserId,
      name: 'Peer2',
      publicKeys: peer2Pk.to_bytes(),
      avatar: undefined,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    const peer2Peer1Contact: Omit<Contact, 'id'> = {
      ownerUserId: peer2UserId,
      userId: peer1UserId,
      name: 'Peer1',
      publicKeys: peer1Pk.to_bytes(),
      avatar: undefined,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    await db.contacts.add(peer1Peer2Contact);
    await db.contacts.add(peer2Peer1Contact);

    // Peer1 initiates session with Peer2
    const { discussionId: peer1DiscussionId } = await initializeDiscussion(
      peer1Peer2Contact,
      peer1Session,
      peer1UserId
    );

    // Peer2 fetches Peer1's announcement
    await announcementService.fetchAndProcessAnnouncements(peer2Session);

    // Peer2 accepts the discussion request
    const peer2Discussion = await db.getDiscussionByOwnerAndContact(
      peer2UserId,
      peer1UserId
    );
    if (!peer2Discussion)
      throw new Error('peer1 discussion not found on peer2 side');

    await acceptDiscussionRequest(peer2Discussion, peer2Session);

    // Peer1 fetches Peer2's announcement and discussion is ACTIVE
    await announcementService.fetchAndProcessAnnouncements(peer1Session);

    return { peer1DiscussionId, peer2DiscussionId: peer2Discussion.id! };
  }

  describe('send messages happy path', () => {
    beforeEach(async () => {
      // Initialize active discussion
      await initAliceBobSession();
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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await messageService.fetchMessages(aliceSession);

      // Bob fetches Alice's message
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await initializeDiscussion(aliceBobContact, aliceSession, aliceUserId);

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
      await announcementService.fetchAndProcessAnnouncements(bobSession);

      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      if (!bobDiscussion)
        throw new Error('alice discussion not found on bob side');
      await acceptDiscussionRequest(bobDiscussion, bobSession);

      // Verify Bob's session is now Active
      expect(bobSession.peerSessionStatus(alicePk.derive_id())).toBe(
        SessionStatus.Active
      );

      /* STEP 4: Alice receive Bob's announcement and resends her messages */
      await announcementService.fetchAndProcessAnnouncements(aliceSession);

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await initAliceBobSession();

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
      await messageService.fetchMessages(aliceSession);
      await messageService.fetchMessages(bobSession);
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
      await messageService.fetchMessages(bobSession);

      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Alice message 1');
      expect(bobReceivedMessages[1].content).toBe('Alice message 2');

      // Alice fetches Bob's messages
      await messageService.fetchMessages(aliceSession);

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
      await initAliceBobSession();

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

      // Alice received all messages in order
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
      await initAliceBobSession();

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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
      await expect(renewDiscussion(bobUserId, aliceSession)).rejects.toThrow(
        EstablishSessionError
      );
      aliceSession.establishOutgoingSession = originalEstablishOutgoingSession;

      // Verify discussion is BROKEN
      const discussionAfterFailedRenew =
        await db.getDiscussionByOwnerAndContact(aliceUserId, bobUserId);
      expect(discussionAfterFailedRenew?.status).toBe(DiscussionStatus.BROKEN);

      /* STEP 4: Second renewal attempt - succeeds */
      // Second renewal attempt - succeeds
      peerSessionStatusSpy.mockRestore();
      console.log('Second renewal attempt aliceSession:', aliceSession);
      await renewDiscussion(bobUserId, aliceSession);

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
      await announcementService.fetchAndProcessAnnouncements(bobSession);

      // Bob's discussion with Alice should be still ACTIVE
      const bobDiscussion = await db.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      /* STEP 5: Mock partial transport failures for resend */
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
      // message3Id should be the middle message (2nd in the array, index 1)
      const message3InArray = failedMessages.find(m => m.id === message3Id);
      expect(message3InArray).toBeDefined();

      let resendAttempts = 0;
      mockProtocol.sendMessage = vi.fn(async message => {
        resendAttempts++;
        // Fail on the 2nd attempt, which should be message 3
        if (resendAttempts === 2) {
          // Second resend attempt (message 3) fails during transport
          // The message was encrypted but couldn't be sent
          throw new Error('Transport failure');
        }
        // Other attempts succeed
        return originalSendMessage(message);
      });

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(bobSession);

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
      await messageService.fetchMessages(aliceSession);

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

  describe('session refresh function and keep alive', () => {
    // Custom session config for faster testing (using factory function)
    // Create test config helper function - each session needs its own config instance
    const createTestConfig = () =>
      new SessionConfig(
        7 * 24 * 60 * 60 * 1000, // max_incoming_announcement_age_millis: 1 week
        60 * 1000, // max_incoming_announcement_future_millis: 1 minute
        7 * 24 * 60 * 60 * 1000, // max_incoming_message_age_millis: 1 week
        60 * 1000, // max_incoming_message_future_millis: 1 minute
        MAX_SESSION_INACTIVITY_MILLIS,
        KEEP_ALIVE_INTERVAL_MILLIS,
        10000n // max_session_lag_length: 10000 messages
      );

    let carolKeys: UserKeys;
    let carolPk: UserPublicKeys;
    let carolSk: UserSecretKeys;
    let carolUserId: string;
    let carolSession: SessionModule;
    let daveKeys: UserKeys;
    let davePk: UserPublicKeys;
    let daveSk: UserSecretKeys;
    let daveUserId: string;
    let daveSession: SessionModule;

    const MAX_SESSION_INACTIVITY_MILLIS = 4000;
    const KEEP_ALIVE_INTERVAL_MILLIS = 2000;

    beforeEach(async () => {
      // Create custom config with shorter intervals for testing
      // Constructor params: max_incoming_announcement_age_millis, max_incoming_announcement_future_millis,
      //                     max_incoming_message_age_millis, max_incoming_message_future_millis,
      //                     max_session_inactivity_millis, keep_alive_interval_millis, max_session_lag_length

      // Ensure Alice and Bob keys are initialized (from parent beforeEach)
      if (!aliceKeys || !bobKeys) {
        throw new Error(
          'Alice or Bob keys not initialized. Parent beforeEach may have failed.'
        );
      }

      // Recreate Alice and Bob sessions with test config
      aliceSession.cleanup();
      aliceSession = new SessionModule(aliceKeys, () => {}, createTestConfig());
      bobSession.cleanup();
      bobSession = new SessionModule(bobKeys, () => {}, createTestConfig());

      // Generate Carol's keys
      carolKeys = await generateUserKeys('carol-test-passphrase-' + Date.now());
      carolPk = carolKeys.public_keys();
      carolSk = carolKeys.secret_keys();
      carolUserId = encodeUserId(carolPk.derive_id());
      carolSession = new SessionModule(carolKeys, () => {}, createTestConfig());

      // Generate Dave's keys
      daveKeys = await generateUserKeys('dave-test-passphrase-' + Date.now());
      davePk = daveKeys.public_keys();
      daveSk = daveKeys.secret_keys();
      daveUserId = encodeUserId(davePk.derive_id());
      daveSession = new SessionModule(daveKeys, () => {}, createTestConfig());
    });

    it('No active discussions', async () => {
      // Call handleSessionRefresh with no active discussions
      let error: Error | undefined;
      try {
        await handleSessionRefresh(aliceUserId, aliceSession, []);
      } catch (e) {
        error = e as Error;
      }

      // Should complete without errors
      expect(error).toBeUndefined();
    });

    it('Alice-Bob discussion is killed by alice session because last incoming message too old. Renew discussion', async () => {
      // STEP 1: Initialize active discussion between Alice and Bob
      const { aliceDiscussionId, bobDiscussionId } =
        await initAliceBobSession();

      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 2: Wait for session inactivity timeout and call refresh
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      ); // Wait > MAX_SESSION_INACTIVITY_MILLIS

      // Get active discussions before refresh
      const activeDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // Call handleSessionRefresh - should mark discussion as BROKEN
      await handleSessionRefresh(aliceUserId, aliceSession, activeDiscussions);

      // STEP 3: Verify discussion is now BROKEN
      aliceDiscussion = await db.discussions.get(aliceDiscussionId)!;
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // STEP 4: Renew the discussion
      await renewDiscussion(bobUserId, aliceSession);

      // Bob fetches and accepts the renewal
      await announcementService.fetchAndProcessAnnouncements(bobSession);
      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');

      await acceptDiscussionRequest(bobDiscussion, bobSession);

      // Alice fetches Bob's acceptance
      await announcementService.fetchAndProcessAnnouncements(aliceSession);

      // STEP 5: Verify discussion is now ACTIVE again
      aliceDiscussion = await db.getDiscussionByOwnerAndContact(
        aliceUserId,
        bobUserId
      );
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('Alice-Bob discussion killed by both session. Renew discussion', async () => {
      // STEP 1: Initialize active discussion
      const { aliceDiscussionId, bobDiscussionId } =
        await initAliceBobSession();

      // STEP 2: Wait for session timeout on both sides
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      );

      // Get active discussions for both
      const aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      const bobActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(bobUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // Refresh both sessions - should kill discussions
      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );
      await handleSessionRefresh(bobUserId, bobSession, bobActiveDiscussions);

      // STEP 3: Verify both discussions are BROKEN
      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      if (!aliceDiscussion) throw new Error('alice discussion not found');
      let bobDiscussion = await db.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // STEP 4: Alice renews the discussion
      await renewDiscussion(bobUserId, aliceSession);

      await announcementService.resendAnnouncements(
        [aliceDiscussion],
        aliceSession
      );

      // Bob fetches and accepts
      await announcementService.fetchAndProcessAnnouncements(bobSession);
      bobDiscussion = await db.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');
      await acceptDiscussionRequest(bobDiscussion, bobSession);

      // Alice fetches Bob's acceptance
      await announcementService.fetchAndProcessAnnouncements(aliceSession);

      // STEP 5: Verify both discussions are ACTIVE
      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('Alice send keep alive msg to Bob. Bob messages are acknowledged', async () => {
      // STEP 1: Initialize active discussion
      await initAliceBobSession();

      // STEP 2: Bob sends a message to Alice
      const bobMessage: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Hello Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobMessage as Message, bobSession);

      // alice fetch Bob's message
      await messageService.fetchMessages(aliceSession);

      // STEP 3: Wait for keep-alive interval
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      ); // Wait > KEEP_ALIVE_INTERVAL_MILLIS

      // Get active discussions
      const aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Alice calls refresh - should send keep-alive
      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );

      // STEP 5: Verify keep-alive message was created
      const aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .toArray();

      const keepAliveMsg = aliceMessages.find(
        m => m.type === MessageType.KEEP_ALIVE
      );
      expect(keepAliveMsg).toBeDefined();
      expect(keepAliveMsg?.content).toBe('');

      // STEP 6: Bob fetches messages (including keep-alive)
      await messageService.fetchMessages(bobSession);

      // Bob's message should now be DELIVERED (acknowledged by Alice's keep-alive)
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();

      const bobSentMessage = bobMessages.find(
        m =>
          m.direction === MessageDirection.OUTGOING &&
          m.content === 'Hello Alice!'
      );
      const bobKeepAliveMessage = bobMessages.find(
        m =>
          m.direction === MessageDirection.INCOMING &&
          m.type === MessageType.KEEP_ALIVE
      );
      expect(bobKeepAliveMessage).toBeUndefined(); // Once acknowledged, keep-alive messages are deleted from database
      expect(bobSentMessage?.status).toBe(MessageStatus.DELIVERED);
    });

    it('Alice send keep alive message but fails because of network issue. Alice send normal message then keep alive one is resent', async () => {
      // STEP 1: Initialize active discussion
      await initAliceBobSession();

      // STEP 2: Bob sends a message
      const bobMessage: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobMessage as Message, bobSession);

      // alice fetch Bob's message
      await messageService.fetchMessages(aliceSession);

      // STEP 3: Mock transport failure for the first keep-alive attempt
      const originalSendMessage = mockProtocol.sendMessage.bind(mockProtocol);
      mockProtocol.sendMessage = vi.fn(async () => {
        throw new Error('Network error');
      });

      // Wait for keep-alive interval
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      // Get active discussions
      const aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Alice calls refresh - keep-alive should fail
      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );

      // STEP 5: Verify keep-alive message exists but failed
      let aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();

      let keepAliveMsg = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(keepAliveMsg).toBeDefined();
      expect(keepAliveMsg?.status).toBe(MessageStatus.FAILED);

      // STEP 6: Restore mock and send a normal message
      mockProtocol.sendMessage = originalSendMessage;

      const aliceMessage: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Normal message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(aliceMessage as Message, aliceSession);

      // check message is SENT
      aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();
      expect(aliceMessages.length).toBe(3);
      expect(aliceMessages[1].status).toBe(MessageStatus.FAILED);
      expect(aliceMessages[1].type).toBe(MessageType.KEEP_ALIVE);
      expect(aliceMessages[2].status).toBe(MessageStatus.SENT);
      expect(aliceMessages[2].type).toBe(MessageType.TEXT);

      // STEP 7: Resend failed messages (including keep-alive)
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // STEP 8: Verify keep-alive was resent successfully
      aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();

      keepAliveMsg = aliceMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(keepAliveMsg?.status).toBe(MessageStatus.SENT);

      // STEP 9: Bob fetches messages (including keep-alive)
      await messageService.fetchMessages(bobSession);

      // Bob's message should now be DELIVERED (acknowledged by Alice's keep-alive)
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();
      expect(bobMessages.length).toBe(2); // incoming keep-alive message are not stored in database
      expect(bobMessages[0].content).toBe('Test message');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
    });

    it.skip('Alice send keep alive msg but fails because of session error. Discussion connection reset, normal msg sent, keep alive msg resent', async () => {
      // STEP 1: Initialize active discussion
      const { aliceDiscussionId } = await initAliceBobSession();

      // bob send a message
      const bobMsg: Omit<Message, 'id'> = {
        ownerUserId: bobUserId,
        contactUserId: aliceUserId,
        content: 'Bob message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(bobMsg as Message, bobSession);

      // alice fetch Bob's message
      await messageService.fetchMessages(aliceSession);

      // STEP 2: Wait for keep-alive interval
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      // STEP 3: Alice calls refresh - session should be killed, keep-alive fails
      // Get active discussions
      let aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // session should return killed status
      const aliceSessionStatusSpy = vi
        .spyOn(aliceSession, 'peerSessionStatus')
        .mockReturnValueOnce(SessionStatus.Active) // session should still be active after session.refresh function is called
        .mockReturnValue(SessionStatus.Killed); // session should be killed when sending keep alive msg

      // call refresh function
      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );

      // restore spy
      aliceSessionStatusSpy.mockRestore();

      // verify discussion is broken
      let aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // step 4: Alice sends a normal message which fails
      const aliceMsg: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Normal message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(aliceMsg as Message, aliceSession);

      // verify message is failed
      const aliceMsgList = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(m => m.direction === MessageDirection.OUTGOING)
        .toArray();

      expect(aliceMsgList.length).toBe(2);
      expect(aliceMsgList[0].status).toBe(MessageStatus.FAILED);
      expect(aliceMsgList[0].type).toBe(MessageType.KEEP_ALIVE);
      expect(aliceMsgList[1].status).toBe(MessageStatus.FAILED);
      expect(aliceMsgList[1].type).toBe(MessageType.TEXT);

      // Step 5 : renew discussion
      await renewDiscussion(bobUserId, aliceSession);
      aliceDiscussion = await db.discussions.get(aliceDiscussionId);
      if (!aliceDiscussion) throw new Error('alice discussion not found');
      await announcementService.resendAnnouncements(
        [aliceDiscussion],
        aliceSession
      );
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceSession
      );

      // Bob fetch new announcement and messages
      await announcementService.fetchAndProcessAnnouncements(bobSession);
      await messageService.fetchMessages(bobSession);

      // check bob received alice msg
      const bobReceivedMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .and(m => m.direction === MessageDirection.INCOMING)
        .toArray();
      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('');
      expect(bobReceivedMessages[0].type).toBe(MessageType.KEEP_ALIVE);
      expect(bobReceivedMessages[0].status).toBe(MessageStatus.DELIVERED);
      expect(bobReceivedMessages[1].type).toBe(MessageType.TEXT);
      expect(bobReceivedMessages[1].content).toBe('Normal message');
      expect(bobReceivedMessages[1].status).toBe(MessageStatus.DELIVERED);

      // STEP 6: Bob's message is delivered
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();
      expect(bobMessages.length).toBe(3);
      expect(bobMessages[0].content).toBe('Bob message');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);

      // STEP 7: Wait and trigger keep-alive again
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );

      // STEP 9: Verify new keep-alive was sent successfully
      const aliceMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();

      const keepAliveMessages = aliceMessages.filter(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );

      // Should have at least one successful keep-alive
      const successfulKeepAlive = keepAliveMessages.find(
        m =>
          m.status === MessageStatus.SENT ||
          m.status === MessageStatus.DELIVERED
      );
      expect(successfulKeepAlive).toBeDefined();
    });

    it('Bob need keep alive but the discussion is killed', async () => {
      // STEP 1: Initialize active discussion
      const { bobDiscussionId } = await initAliceBobSession();

      // STEP 2: Alice sends a message
      const aliceMessage: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Test',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(aliceMessage as Message, aliceSession);

      // alice fetch Bob's message
      await messageService.fetchMessages(aliceSession);

      // STEP 3: Wait for session timeout (should kill session and require keep-alive)
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      );

      // Get active discussions
      const bobActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(bobUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Bob calls refresh - should mark discussion as BROKEN (can't send keep-alive to killed session)
      await handleSessionRefresh(bobUserId, bobSession, bobActiveDiscussions);

      // STEP 5: Verify discussion is BROKEN
      const bobDiscussion = await db.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // STEP 6: Verify no keep-alive was sent (or if sent, it failed)
      const bobMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();

      const keepAliveMsg = bobMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );

      expect(keepAliveMsg).toBeUndefined();
    });

    it('Alice has discussion with Bob, Carol and Dave. Bob discussion killed, Carol need keep alive and Dave is ok.', async () => {
      // STEP 1: Initialize discussions with all three peers
      const { peer1DiscussionId: aliceBobDiscussionId } = await initSession(
        aliceSk,
        alicePk,
        aliceSession,
        bobSk,
        bobPk,
        bobSession
      );

      // wait for Bob's session to timeout
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      );

      // alice init session with carol
      await initSession(
        aliceSk,
        alicePk,
        aliceSession,
        carolSk,
        carolPk,
        carolSession
      );

      // wait for Carol's session to need keep-alive
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      // alice init session with dave
      const { peer1DiscussionId: aliceDaveDiscussionId } = await initSession(
        aliceSk,
        alicePk,
        aliceSession,
        daveSk,
        davePk,
        daveSession
      );

      // step 2: Carol and Dave sends a message
      // Carol sends a message
      const carolMessage: Omit<Message, 'id'> = {
        ownerUserId: carolUserId,
        contactUserId: aliceUserId,
        content: 'Hi Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(carolMessage as Message, carolSession);

      // Dave sends a message recently (keeps session active)
      const daveMessage: Omit<Message, 'id'> = {
        ownerUserId: daveUserId,
        contactUserId: aliceUserId,
        content: 'Hey Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await messageService.sendMessage(daveMessage as Message, daveSession);

      // Alice fetches messages
      await messageService.fetchMessages(aliceSession);

      // STEP 3: Alice call refresh function
      const aliceActiveDiscussions = await db.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      expect(aliceActiveDiscussions.length).toBe(3);

      await handleSessionRefresh(
        aliceUserId,
        aliceSession,
        aliceActiveDiscussions
      );

      // STEP 4: Verify Bob's discussion is BROKEN
      const aliceBobDiscussion = await db.discussions.get(aliceBobDiscussionId);
      expect(aliceBobDiscussion?.status).toBe(DiscussionStatus.BROKEN);

      // STEP 5: Verify Carol received keep-alive
      const aliceCarolMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, carolUserId])
        .toArray();

      const carolKeepAlive = aliceCarolMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      expect(carolKeepAlive).toBeDefined();

      // STEP 6: Verify Dave's discussion is still ACTIVE and no keep-alive was sent
      const aliceDaveDiscussion = await db.discussions.get(
        aliceDaveDiscussionId
      );
      expect(aliceDaveDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      const aliceDaveMessages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, daveUserId])
        .toArray();

      const daveKeepAlive = aliceDaveMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );
      // Dave should not receive keep-alive since session is fresh
      expect(daveKeepAlive).toBeUndefined();
    });
  });

  describe('serializeMessage', () => {
    // Type helper to access private serializeMessage method in tests
    type MessageServiceWithSerialize = {
      serializeMessage: (
        message: Message
      ) => Promise<Result<Uint8Array, string>>;
    };

    it('should serialize a regular text message', async () => {
      const message: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Hello, world!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      // Access the private method via type assertion
      const result = await (
        messageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(message);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      expect(result.data).toBeDefined();

      // Verify it matches the expected serialization
      const expected = serializeRegularMessage('Hello, world!');
      expect(result.data).toEqual(expected);
    });

    it('should serialize a keep-alive message', async () => {
      const message: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await (
        messageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(message);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      expect(result.data).toBeDefined();

      // Verify it matches the expected serialization
      const expected = new Uint8Array([MESSAGE_TYPE_KEEP_ALIVE]);
      expect(result.data).toEqual(expected);
    });

    it('should serialize a reply message when original message exists', async () => {
      // Create a seeker for the original message (34 bytes: 1 byte length + 32 bytes hash + 1 byte key)
      const originalSeeker = new Uint8Array(34);
      originalSeeker[0] = 32; // hash length
      crypto.getRandomValues(originalSeeker.slice(1, 33)); // hash bytes
      originalSeeker[33] = 0; // key

      // Create the original message in the database
      // In browser tests, real IndexedDB supports Uint8Array in compound indexes
      const originalMessage: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Original message',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: originalSeeker,
      };

      await db.messages.add(originalMessage);

      // Create a reply message
      const replyMessage: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'This is a reply',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        replyTo: {
          originalSeeker,
        },
      };

      const result = await (
        messageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(replyMessage);

      expect(result.success).toBe(true);
      if (!result.success) throw new Error('Expected success');
      expect(result.data).toBeDefined();

      // Verify it matches the expected serialization
      const expected = serializeReplyMessage(
        'This is a reply',
        'Original message',
        originalSeeker
      );
      expect(result.data).toEqual(expected);
    });

    it('should return error when original message not found for reply', async () => {
      // Create a seeker that doesn't exist in the database
      const nonExistentSeeker = new Uint8Array(34);
      nonExistentSeeker[0] = 32;
      crypto.getRandomValues(nonExistentSeeker.slice(1, 33));
      nonExistentSeeker[33] = 0;

      const replyMessage: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'This is a reply',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        replyTo: {
          originalSeeker: nonExistentSeeker,
        },
      };

      const result = await (
        messageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(replyMessage);

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error).toBe('Original message not found for reply');
    });

    it('should handle reply message with originalContent fallback when original message not found by seeker', async () => {
      // This test verifies that if the original message is not found by seeker,
      // the function should still fail (as per current implementation)
      // Note: The current implementation requires the original message to exist in DB

      const originalSeeker = new Uint8Array(34);
      originalSeeker[0] = 32;
      crypto.getRandomValues(originalSeeker.slice(1, 33));
      originalSeeker[33] = 0;

      const replyMessage: Message = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'This is a reply',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        replyTo: {
          originalSeeker,
          originalContent: 'Original content fallback',
        },
      };

      const result = await (
        messageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(replyMessage);

      // Current implementation requires original message to exist in DB
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error).toBe('Original message not found for reply');
    });
  });
});
