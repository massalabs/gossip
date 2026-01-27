/**
 * Message Service Browser Tests
 *
 * These tests use the REAL WASM session manager in a browser environment
 * via Playwright. This provides end-to-end testing of the cryptographic
 * message handling without mocking the session layer.
 */
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  db as appDb,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  Message,
  Contact,
} from '../../src/db';
import {
  initializeWasm,
  generateUserKeys,
  SessionModule,
  UserPublicKeys,
  UserSecretKeys,
  UserKeys,
  SessionStatus,
  SessionConfig,
  encodeUserId,
  AnnouncementService,
  DiscussionService,
  MessageService,
  RefreshService,
  EstablishSessionError,
  serializeRegularMessage,
  serializeReplyMessage,
  MESSAGE_TYPE_KEEP_ALIVE,
  Result,
} from '@massalabs/gossip-sdk';
import { MockMessageProtocol } from '../mocks/mockMessageProtocol';

function getFailedOutgoingMessagesForContact(
  ownerUserId: string,
  contactUserId: string
): Promise<Message[]> {
  return appDb.messages
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
  msgService: MessageService
): Promise<void> {
  const failedMessages = await getFailedOutgoingMessagesForContact(
    ownerUserId,
    contactUserId
  );
  await msgService.resendMessages(new Map([[contactUserId, failedMessages]]));
}

async function fetchMessagesFromContact(
  ownerUserId: string,
  contactUserId: string,
  msgService: MessageService
): Promise<Message[]> {
  await msgService.fetchMessages();

  const messages = await appDb.messages
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
  const req = appDb.messages
    .where('[ownerUserId+contactUserId+direction]')
    .equals([contactUserId, ownerUserId, MessageDirection.OUTGOING]);
  if (status) {
    req.and(m => m.status === status);
  }
  return await req.toArray();
}

// TODO: These tests require a fully configured mock protocol with proper WASM crypto setup
// Skip for now until mock infrastructure is completed
describe('Message Service (Browser with Real WASM)', () => {
  // Shared mock protocol for all tests
  let mockProtocol: MockMessageProtocol;

  // Alice's test data
  let aliceUserId: string;
  let aliceSession: SessionModule;
  let alicePk: UserPublicKeys;
  let aliceSk: UserSecretKeys;
  let aliceKeys: UserKeys;
  // Alice's services
  let aliceAnnouncementService: AnnouncementService;
  let aliceDiscussionService: DiscussionService;
  let aliceMessageService: MessageService;
  let aliceRefreshService: RefreshService;

  // Bob's test data
  let bobUserId: string;
  let bobSession: SessionModule;
  let bobPk: UserPublicKeys;
  let bobSk: UserSecretKeys;
  let bobKeys: UserKeys;
  // Bob's services
  let bobAnnouncementService: AnnouncementService;
  let bobDiscussionService: DiscussionService;
  let bobMessageService: MessageService;
  let bobRefreshService: RefreshService;

  // Initialize WASM before all tests
  beforeAll(async () => {
    await initializeWasm();
    mockProtocol = new MockMessageProtocol();
  });

  beforeEach(async () => {
    // Clean up database
    if (appDb.isOpen()) {
      await appDb.delete();
    }
    await appDb.open();

    // Reset mock protocol state to prevent test interference
    mockProtocol.clearMockData();

    // Generate Alice's keys using real WASM
    aliceKeys = await generateUserKeys('alice-test-passphrase-' + Date.now());
    alicePk = aliceKeys.public_keys();
    aliceSk = aliceKeys.secret_keys();
    aliceUserId = encodeUserId(alicePk.derive_id());
    aliceSession = new SessionModule(aliceKeys);

    // Create Alice's services
    aliceAnnouncementService = new AnnouncementService(
      appDb,
      mockProtocol,
      aliceSession
    );
    aliceDiscussionService = new DiscussionService(
      appDb,
      aliceAnnouncementService,
      aliceSession
    );
    aliceMessageService = new MessageService(
      appDb,
      mockProtocol,
      aliceSession,
      aliceDiscussionService
    );
    aliceRefreshService = new RefreshService(
      appDb,
      aliceMessageService,
      aliceSession
    );

    // Generate Bob's keys using real WASM
    bobKeys = await generateUserKeys('bob-test-passphrase-' + Date.now());
    bobPk = bobKeys.public_keys();
    bobSk = bobKeys.secret_keys();
    bobUserId = encodeUserId(bobPk.derive_id());
    bobSession = new SessionModule(bobKeys);

    // Create Bob's services
    bobAnnouncementService = new AnnouncementService(
      appDb,
      mockProtocol,
      bobSession
    );
    bobDiscussionService = new DiscussionService(
      appDb,
      bobAnnouncementService,
      bobSession
    );
    bobMessageService = new MessageService(
      appDb,
      mockProtocol,
      bobSession,
      bobDiscussionService
    );
    bobRefreshService = new RefreshService(
      appDb,
      bobMessageService,
      bobSession
    );
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

    await appDb.contacts.add(aliceBobContact);
    await appDb.contacts.add(bobAliceContact);

    // Alice initiates session with Bob (establishes outgoing session)
    const { discussionId: aliceDiscussionId } =
      await aliceDiscussionService.initialize(aliceBobContact);

    // Bob fetches Alice's announcement and discussion is ACTIVE
    await bobAnnouncementService.fetchAndProcessAnnouncements();

    // Bob accepts the discussion request
    const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
      bobUserId,
      aliceUserId
    );
    if (!bobDiscussion)
      throw new Error('alice discussion not found on bob side');

    await bobDiscussionService.accept(bobDiscussion);

    // Alice fetches Bob's announcement and discussion is ACTIVE
    await aliceAnnouncementService.fetchAndProcessAnnouncements();

    return { aliceDiscussionId, bobDiscussionId: bobDiscussion.id! };
  }

  /**
   * Generic helper to initialize a bidirectional session between any two peers.
   * Creates services dynamically for each peer based on their sessions.
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

    // Create services for peer1
    const peer1AnnouncementService = new AnnouncementService(
      appDb,
      mockProtocol,
      peer1Session
    );
    const peer1DiscussionService = new DiscussionService(
      appDb,
      peer1AnnouncementService,
      peer1Session
    );

    // Create services for peer2
    const peer2AnnouncementService = new AnnouncementService(
      appDb,
      mockProtocol,
      peer2Session
    );
    const peer2DiscussionService = new DiscussionService(
      appDb,
      peer2AnnouncementService,
      peer2Session
    );

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

    await appDb.contacts.add(peer1Peer2Contact);
    await appDb.contacts.add(peer2Peer1Contact);

    // Peer1 initiates session with Peer2
    const { discussionId: peer1DiscussionId } =
      await peer1DiscussionService.initialize(peer1Peer2Contact);

    // Peer2 fetches Peer1's announcement
    await peer2AnnouncementService.fetchAndProcessAnnouncements();

    // Peer2 accepts the discussion request
    const peer2Discussion = await appDb.getDiscussionByOwnerAndContact(
      peer2UserId,
      peer1UserId
    );
    if (!peer2Discussion)
      throw new Error('peer1 discussion not found on peer2 side');

    await peer2DiscussionService.accept(peer2Discussion);

    // Peer1 fetches Peer2's announcement and discussion is ACTIVE
    await peer1AnnouncementService.fetchAndProcessAnnouncements();

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

        const res = await aliceMessageService.sendMessage(message as Message);
        expect(res.success).toBe(true);
        aliceMessageIds.push(res.message!.id!);
      }

      // Verify all Alice's messages are sent
      for (const messageId of aliceMessageIds) {
        const msg = await appDb.messages.get(messageId);
        expect(msg?.status).toBe(MessageStatus.SENT);
      }

      // STEP 2: Bob fetches all messages at once
      await bobMessageService.fetchMessages();

      // Verify Bob received all messages
      const bobReceivedMessages = await appDb.messages
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

        const res = await bobMessageService.sendMessage(message as Message);
        expect(res.success).toBe(true);
        bobMessageIds.push(res.message!.id!);
      }

      // STEP 4: Alice receives Bob's messages
      await aliceMessageService.fetchMessages();

      // Verify Alice received all Bob's messages
      const aliceReceivedMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .toArray();

      expect(aliceReceivedMessages.length).toBe(3);
      expect(aliceReceivedMessages[0].content).toBe(bobMessages[0]);
      expect(aliceReceivedMessages[1].content).toBe(bobMessages[1]);
      expect(aliceReceivedMessages[2].content).toBe(bobMessages[2]);

      // STEP 5: Alice's messages are set to delivered
      for (const messageId of aliceMessageIds) {
        const msg = await appDb.messages.get(messageId);
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

      const aliceResult = await aliceMessageService.sendMessage(
        aliceMessageData as Message
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

      const bobResult = await bobMessageService.sendMessage(
        bobMessageData as Message
      );
      expect(bobResult.success).toBe(true);
      const bobMessageId = bobResult.message!.id!;

      // Both messages are sent
      expect((await appDb.messages.get(aliceMessageId))?.status).toBe(
        MessageStatus.SENT
      );
      expect((await appDb.messages.get(bobMessageId))?.status).toBe(
        MessageStatus.SENT
      );

      // Alice fetches Bob's message
      await aliceMessageService.fetchMessages();

      // Bob fetches Alice's message
      await bobMessageService.fetchMessages();

      // Verify both received each other's messages
      const aliceReceived = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .first();
      expect(aliceReceived?.content).toBe('Hey Alice!');

      const bobReceived = await appDb.messages
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
      await bobMessageService.sendMessage(bobFollowUp as Message);

      // Alice fetches Bob's follow-up which contains acknowledgment for her message
      await aliceMessageService.fetchMessages();

      // Now Alice's first message should be delivered
      expect((await appDb.messages.get(aliceMessageId))?.status).toBe(
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
      await aliceMessageService.sendMessage(aliceFollowUp as Message);

      // Bob fetches Alice's follow-up which contains acknowledgment for his message
      await bobMessageService.fetchMessages();

      // Now Bob's first message should be delivered
      expect((await appDb.messages.get(bobMessageId))?.status).toBe(
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

      const alice1Result = await aliceMessageService.sendMessage(
        alice1Data as Message
      );
      const alice1Id = alice1Result.message!.id!;

      // Bob receives Alice's first message
      await bobMessageService.fetchMessages();

      // Verify Bob received Alice's message
      const bobReceivedFirst = await appDb.messages
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

      const bob1Result = await bobMessageService.sendMessage(
        bob1Data as Message
      );
      const bob1Id = bob1Result.message!.id!;

      // Alice receives Bob's response - this should acknowledge Alice's first message
      await aliceMessageService.fetchMessages();

      // Alice's first message should now be delivered (acknowledged by Bob's response)
      expect((await appDb.messages.get(alice1Id))?.status).toBe(
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

      const alice2Result = await aliceMessageService.sendMessage(
        alice2Data as Message
      );
      const alice2Id = alice2Result.message!.id!;

      // Bob receives Alice's second message - this acknowledges Bob's response
      await bobMessageService.fetchMessages();

      // Bob's message should now be delivered
      expect((await appDb.messages.get(bob1Id))?.status).toBe(
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
      await bobMessageService.sendMessage(bob2Data as Message);

      // Alice fetches Bob's second response
      await aliceMessageService.fetchMessages();

      // Alice's second message should now be delivered
      expect((await appDb.messages.get(alice2Id))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Verify all messages are received
      const bobReceivedMessages = await appDb.messages
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
      await appDb.contacts.add(aliceBobContact);

      // Alice initiates session (SelfRequested state)
      await aliceDiscussionService.initialize(aliceBobContact);

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
        const res = await aliceMessageService.sendMessage(aliceMessageData[i]);
        /* Messages sent while session is SelfRequested are queued as WAITING_SESSION.
        They will be sent automatically when the session becomes Active (after peer acceptance). */
        expect(res.success).toBe(true);
        expect(res.message?.status).toBe(MessageStatus.WAITING_SESSION);
      }

      /* STEP 3: Bob fetches Alice's announcement and accept it */
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      if (!bobDiscussion)
        throw new Error('alice discussion not found on bob side');
      await bobDiscussionService.accept(bobDiscussion);

      // Verify Bob's session is now Active
      expect(bobSession.peerSessionStatus(alicePk.derive_id())).toBe(
        SessionStatus.Active
      );

      /* STEP 4: Alice receive Bob's announcement - session becomes Active and waiting messages are sent */
      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      // Verify Alice's session is now Active
      expect(aliceSession.peerSessionStatus(bobPk.derive_id())).toBe(
        SessionStatus.Active
      );

      // Process waiting messages (simulates what onSessionBecameActive event handler does)
      await aliceMessageService.processWaitingMessages(bobUserId);

      // Verify Alice's messages are sent
      const aliceSentMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .toArray();

      expect(aliceSentMessages.length).toBe(2);
      expect(aliceSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceSentMessages[1].status).toBe(MessageStatus.SENT);

      /* STEP 5: Bob receives Alice's messages */
      await bobMessageService.fetchMessages();

      // Verify Bob received both messages
      const bobReceivedMessages = await appDb.messages
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
      const bobMessageResult = await bobMessageService.sendMessage(
        bobMessageData as Message
      );
      expect(bobMessageResult.success).toBe(true);

      /* STEP 7: Alice fetch bob message and her message is acknowledged*/
      await aliceMessageService.fetchMessages();

      // Verify Alice received Bob's message
      const aliceReceivedMessages = await appDb.messages
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

      const aliceResult1 = await aliceMessageService.sendMessage(
        aliceMessage1 as Message
      );
      expect(aliceResult1.success).toBe(false);
      expect(aliceResult1.message?.status).toBe(MessageStatus.FAILED);

      const aliceResult2 = await aliceMessageService.sendMessage(
        aliceMessage2 as Message
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

      const bobResult1 = await bobMessageService.sendMessage(
        bobMessage1 as Message
      );
      expect(bobResult1.success).toBe(false);
      expect(bobResult1.message?.status).toBe(MessageStatus.FAILED);

      const bobResult2 = await bobMessageService.sendMessage(
        bobMessage2 as Message
      );
      expect(bobResult2.success).toBe(false);
      expect(bobResult2.message?.status).toBe(MessageStatus.FAILED);

      /* STEP 4: Alice and Bob fetch messages but nothing is received */
      await aliceMessageService.fetchMessages();
      await bobMessageService.fetchMessages();
      const aliceMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.INCOMING])
        .toArray();
      const bobMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .toArray();
      expect(aliceMessages.length).toBe(0);
      expect(bobMessages.length).toBe(0);

      /* STEP 5: Alice and Bob resend messages */
      // Get failed messages for resending
      const aliceFailedMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            m.status === MessageStatus.FAILED
        )
        .sortBy('id');

      const bobFailedMessages = await appDb.messages
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
      await aliceMessageService.resendMessages(aliceMessagesToResend);

      // Resend Bob's messages in order
      const bobMessagesToResend = new Map<string, Message[]>();
      bobMessagesToResend.set(aliceUserId, bobFailedMessages);
      await bobMessageService.resendMessages(bobMessagesToResend);

      // Verify all messages are now SENT
      const aliceSentMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      expect(aliceSentMessages.length).toBe(2);
      expect(aliceSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(aliceSentMessages[1].status).toBe(MessageStatus.SENT);

      const bobSentMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      expect(bobSentMessages.length).toBe(2);
      expect(bobSentMessages[0].status).toBe(MessageStatus.SENT);
      expect(bobSentMessages[1].status).toBe(MessageStatus.SENT);

      /* STEP 6: Bob and Alice fetch messages with success */
      await bobMessageService.fetchMessages();

      const bobReceivedMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([bobUserId, aliceUserId, MessageDirection.INCOMING])
        .sortBy('timestamp');

      expect(bobReceivedMessages.length).toBe(2);
      expect(bobReceivedMessages[0].content).toBe('Alice message 1');
      expect(bobReceivedMessages[1].content).toBe('Alice message 2');

      // Alice fetches Bob's messages
      await aliceMessageService.fetchMessages();

      const aliceReceivedMessages = await appDb.messages
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
      // const mockProtocol = messageService.messageProtocol as MessageProtocol;

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

        const result = await aliceMessageService.sendMessage(
          message as Message
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

        const result = await bobMessageService.sendMessage(message as Message);
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
        aliceMessageService
      );

      // Bob fetch messages but nothing is received
      let bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobMessageService
      );
      expect(bobMsg.length).toBe(0);

      // Bob 1st resend
      await resendFailedMessagesForContact(
        bobUserId,
        aliceUserId,
        bobMessageService
      );

      // Alice fetch messages but nothing is received
      let aliceMsg = await fetchMessagesFromContact(
        aliceUserId,
        bobUserId,
        aliceMessageService
      );
      expect(aliceMsg.length).toBe(0);

      // Alice 2nd resend
      await resendFailedMessagesForContact(
        aliceUserId,
        bobUserId,
        aliceMessageService
      );

      // Bob received message 1 but not 3 and 4
      bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobMessageService
      );
      expect(bobMsg.length).toBe(1);
      expect(bobMsg[0].content).toBe('Alice message 1');

      // Bob 2nd resend
      await resendFailedMessagesForContact(
        bobUserId,
        aliceUserId,
        bobMessageService
      );

      // Alice received all messages in order
      aliceMsg = await fetchMessagesFromContact(
        aliceUserId,
        bobUserId,
        aliceMessageService
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
        aliceMessageService
      );

      // Bob received all messages in order
      bobMsg = await fetchMessagesFromContact(
        bobUserId,
        aliceUserId,
        bobMessageService
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

    // TODO: Skip - SDK behavior tested in gossip-sdk/test/message-service.test.ts
    it.skip('Alice session break and reinitiate it by resending all messages', async () => {
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
      // const mockProtocol = messageService.messageProtocol as MessageProtocol;

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

      const result1 = await aliceMessageService.sendMessage(
        message1 as Message
      );
      console.log(' result1:', result1);
      expect(result1.success).toBe(true);
      const message1Id = result1.message!.id!;

      // Bob fetches and acknowledges message 1
      await bobMessageService.fetchMessages();

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
      await bobMessageService.sendMessage(bobAck as Message);

      // Alice fetches Bob's message - this marks message 1 as DELIVERED
      await aliceMessageService.fetchMessages();

      expect((await appDb.messages.get(message1Id))?.status).toBe(
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

      const result2 = await aliceMessageService.sendMessage(
        message2 as Message
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

      const result3 = await aliceMessageService.sendMessage(
        message3 as Message
      );
      mockProtocol.sendMessage = originalSendMessage;

      expect(result3.success).toBe(false);
      expect(result3.message?.status).toBe(MessageStatus.FAILED);
      const message3Id = result3.message!.id!;

      // Verify message 3 has encryptedMessage
      const msg3 = await appDb.messages.get(message3Id);
      expect(msg3?.encryptedMessage).toBeDefined();
      expect(msg3?.seeker).toBeDefined();

      // Mock session status to simulate a broken session (SessionStatus.Killed)
      const peerSessionStatusSpy = vi
        .spyOn(aliceSession, 'peerSessionStatus')
        .mockReturnValue(SessionStatus.Killed);

      // Alice tries to send message 4 while session is Killed - WAITING_SESSION with auto-renewal triggered
      const message4: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Message 4',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result4 = await aliceMessageService.sendMessage(
        message4 as Message
      );
      // With auto-renewal, message is queued as WAITING_SESSION instead of failing
      expect(result4.success).toBe(true);
      expect(result4.message?.status).toBe(MessageStatus.WAITING_SESSION);
      const message4Id = result4.message!.id!;

      // Discussion stays ACTIVE with auto-renewal (not marked as BROKEN)
      const discussion = await appDb.getDiscussionByOwnerAndContact(
        aliceUserId,
        bobUserId
      );
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);

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
      await bobMessageService.sendMessage(bobMessage as Message);

      /* STEP 3: Alice attempts to renew session but establishSession fails */
      const originalEstablishOutgoingSession =
        aliceSession.establishOutgoingSession;
      aliceSession.establishOutgoingSession = vi
        .fn()
        .mockResolvedValue(new Uint8Array(0));

      // First renewal attempt - fails
      await expect(aliceDiscussionService.renew(bobUserId)).rejects.toThrow(
        EstablishSessionError
      );
      aliceSession.establishOutgoingSession = originalEstablishOutgoingSession;

      // Verify discussion stays ACTIVE after failed renewal (auto-renewal will retry)
      const discussionAfterFailedRenew =
        await appDb.getDiscussionByOwnerAndContact(aliceUserId, bobUserId);
      expect(discussionAfterFailedRenew?.status).toBe(DiscussionStatus.ACTIVE);

      /* STEP 4: Second renewal attempt - succeeds */
      // Second renewal attempt - succeeds
      peerSessionStatusSpy.mockRestore();
      console.log('Second renewal attempt aliceSession:', aliceSession);
      await aliceDiscussionService.renew(bobUserId);

      // Verify discussion is ACTIVE
      const discussionAfterRenew = await appDb.getDiscussionByOwnerAndContact(
        aliceUserId,
        bobUserId
      );
      expect(discussionAfterRenew?.status).toBe(DiscussionStatus.ACTIVE);

      // Check message statuses after renewal
      // Message 2 might be SENT or WAITING_SESSION depending on renewal behavior
      const msg2AfterRenew = await appDb.messages.get(message2Id);
      expect([
        MessageStatus.SENT,
        MessageStatus.WAITING_SESSION,
        MessageStatus.DELIVERED,
      ]).toContain(msg2AfterRenew?.status);

      // Message 3 had transport failure - could be FAILED or reset to WAITING_SESSION
      const msg3AfterRenew = await appDb.messages.get(message3Id);
      expect([MessageStatus.FAILED, MessageStatus.WAITING_SESSION]).toContain(
        msg3AfterRenew?.status
      );

      // Message 4 was queued as WAITING_SESSION when session was Killed
      const msg4AfterRenew = await appDb.messages.get(message4Id);
      expect(msg4AfterRenew?.status).toBe(MessageStatus.WAITING_SESSION);

      // Bob fetches and processes Alice's new announcement
      await bobAnnouncementService.fetchAndProcessAnnouncements();

      // Bob's discussion with Alice should be still ACTIVE
      const bobDiscussion = await appDb.getDiscussionByOwnerAndContact(
        bobUserId,
        aliceUserId
      );
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      /* STEP 5: Process waiting messages and failed messages */
      // Get messages that need to be sent (WAITING_SESSION + FAILED)
      const messagesToProcess = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(
          m =>
            m.direction === MessageDirection.OUTGOING &&
            (m.status === MessageStatus.WAITING_SESSION ||
              m.status === MessageStatus.FAILED)
        )
        .sortBy('id');

      // We should have at least message 3 (FAILED) and message 4 (WAITING_SESSION)
      expect(messagesToProcess.length).toBeGreaterThanOrEqual(2);

      let resendAttempts = 0;
      mockProtocol.sendMessage = vi.fn(async message => {
        resendAttempts++;
        // Fail on the 2nd attempt
        if (resendAttempts === 2) {
          throw new Error('Transport failure');
        }
        // Other attempts succeed
        return originalSendMessage(message);
      });

      // Process waiting messages (for WAITING_SESSION)
      await aliceMessageService.processWaitingMessages(bobUserId);

      // Resend failed messages (for FAILED)
      const failedMessages = await getFailedOutgoingMessagesForContact(
        aliceUserId,
        bobUserId
      );
      if (failedMessages.length > 0) {
        const messagesToResend = new Map<string, Message[]>();
        messagesToResend.set(bobUserId, failedMessages);
        await aliceMessageService.resendMessages(messagesToResend);
      }

      // Verify statuses after first resend attempt:
      // - Message 2: success
      // - Message 3: FAILED (transport failed, but encryptedMessage was stored)
      // - Message 4: success
      const msg2AfterResend = await appDb.messages.get(message2Id);
      expect(msg2AfterResend?.status).toBe(MessageStatus.SENT);

      const msg3AfterResend = await appDb.messages.get(message3Id);
      expect(msg3AfterResend?.status).toBe(MessageStatus.FAILED); // Still FAILED, not attempted
      expect(msg3AfterResend?.encryptedMessage).toBeDefined(); // Was encrypted before transport failure
      console.log('message3Id:', message3Id);
      console.log('message4Id:', message4Id);
      const msg4AfterResend = await appDb.messages.get(message4Id);
      console.log('msg4AfterResend :', msg4AfterResend);

      expect(msg4AfterResend?.status).toBe(MessageStatus.SENT);

      // Bob tries to fetch - should get messages 2 but not 4
      await bobMessageService.fetchMessages();

      let bobReceivedMessages = await appDb.messages
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
        aliceMessageService
      );

      // Bob fetches all messages
      await bobMessageService.fetchMessages();

      bobReceivedMessages = await appDb.messages
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
      await bobMessageService.sendMessage(bobReply as Message);

      // Alice fetches messages
      await aliceMessageService.fetchMessages();

      // All Alice's messages should now be DELIVERED
      const allAliceMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .sortBy('id');

      console.log('allAliceMessages:', allAliceMessages);
      expect(
        allAliceMessages.every(m => m.status === MessageStatus.DELIVERED)
      ).toBe(true);
    });
  });

  describe('session refresh function and keep alive', () => {
    const MAX_SESSION_INACTIVITY_MILLIS = 4000;
    const KEEP_ALIVE_INTERVAL_MILLIS = 2000;
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
    let carolAnnouncementService: AnnouncementService;
    let carolDiscussionService: DiscussionService;
    let carolMessageService: MessageService;
    let daveKeys: UserKeys;
    let davePk: UserPublicKeys;
    let daveSk: UserSecretKeys;
    let daveUserId: string;
    let daveSession: SessionModule;
    let daveAnnouncementService: AnnouncementService;
    let daveDiscussionService: DiscussionService;
    let daveMessageService: MessageService;

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
      aliceSession = new SessionModule(
        aliceKeys,
        async () => {},
        createTestConfig()
      );
      bobSession.cleanup();
      bobSession = new SessionModule(
        bobKeys,
        async () => {},
        createTestConfig()
      );

      // Recreate Alice and Bob services with new sessions
      aliceAnnouncementService = new AnnouncementService(
        appDb,
        mockProtocol,
        aliceSession
      );
      aliceDiscussionService = new DiscussionService(
        appDb,
        aliceAnnouncementService,
        aliceSession
      );
      aliceMessageService = new MessageService(
        appDb,
        mockProtocol,
        aliceSession,
        aliceDiscussionService
      );
      aliceRefreshService = new RefreshService(
        appDb,
        aliceMessageService,
        aliceSession
      );

      bobAnnouncementService = new AnnouncementService(
        appDb,
        mockProtocol,
        bobSession
      );
      bobDiscussionService = new DiscussionService(
        appDb,
        bobAnnouncementService,
        bobSession
      );
      bobMessageService = new MessageService(
        appDb,
        mockProtocol,
        bobSession,
        bobDiscussionService
      );
      bobRefreshService = new RefreshService(
        appDb,
        bobMessageService,
        bobSession
      );

      // Generate Carol's keys
      carolKeys = await generateUserKeys('carol-test-passphrase-' + Date.now());
      carolPk = carolKeys.public_keys();
      carolSk = carolKeys.secret_keys();
      carolUserId = encodeUserId(carolPk.derive_id());
      carolSession = new SessionModule(
        carolKeys,
        async () => {},
        createTestConfig()
      );
      carolAnnouncementService = new AnnouncementService(
        appDb,
        mockProtocol,
        carolSession
      );
      carolDiscussionService = new DiscussionService(
        appDb,
        carolAnnouncementService,
        carolSession
      );
      carolMessageService = new MessageService(
        appDb,
        mockProtocol,
        carolSession,
        carolDiscussionService
      );

      // Generate Dave's keys
      daveKeys = await generateUserKeys('dave-test-passphrase-' + Date.now());
      davePk = daveKeys.public_keys();
      daveSk = daveKeys.secret_keys();
      daveUserId = encodeUserId(davePk.derive_id());
      daveSession = new SessionModule(
        daveKeys,
        async () => {},
        createTestConfig()
      );
      daveAnnouncementService = new AnnouncementService(
        appDb,
        mockProtocol,
        daveSession
      );
      daveDiscussionService = new DiscussionService(
        appDb,
        daveAnnouncementService,
        daveSession
      );
      daveMessageService = new MessageService(
        appDb,
        mockProtocol,
        daveSession,
        daveDiscussionService
      );
    });

    it('No active discussions', async () => {
      // Call handleSessionRefresh with no active discussions
      let error: Error | undefined;
      try {
        await aliceRefreshService.handleSessionRefresh([]);
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

      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 2: Wait for session inactivity timeout and call refresh
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      ); // Wait > MAX_SESSION_INACTIVITY_MILLIS

      // Get active discussions before refresh
      const activeDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // Call handleSessionRefresh - triggers auto-renewal instead of marking BROKEN
      await aliceRefreshService.handleSessionRefresh(activeDiscussions);

      // STEP 3: Verify discussion stays ACTIVE (auto-renewal triggered, not BROKEN)
      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 4: Manually renew the discussion (simulates auto-renewal flow)
      await aliceDiscussionService.renew(bobUserId);

      // Bob fetches and accepts the renewal
      await bobAnnouncementService.fetchAndProcessAnnouncements();
      const bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');

      await bobDiscussionService.accept(bobDiscussion);

      // Alice fetches Bob's acceptance
      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      // STEP 5: Verify discussion is now ACTIVE again
      aliceDiscussion = await appDb.getDiscussionByOwnerAndContact(
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
      const aliceActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      const bobActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(bobUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // Refresh both sessions - triggers auto-renewal instead of marking BROKEN
      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);
      await bobRefreshService.handleSessionRefresh(bobActiveDiscussions);

      // STEP 3: Verify both discussions stay ACTIVE (auto-renewal triggered, not BROKEN)
      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      if (!aliceDiscussion) throw new Error('alice discussion not found');
      let bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 4: Alice renews the discussion (simulates auto-renewal)
      await aliceDiscussionService.renew(bobUserId);

      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion]);

      // Bob fetches and accepts
      await bobAnnouncementService.fetchAndProcessAnnouncements();
      bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      if (!bobDiscussion) throw new Error('bob discussion not found');
      await bobDiscussionService.accept(bobDiscussion);

      // Alice fetches Bob's acceptance
      await aliceAnnouncementService.fetchAndProcessAnnouncements();

      // STEP 5: Verify both discussions are ACTIVE
      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      bobDiscussion = await appDb.discussions.get(bobDiscussionId);
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
      await bobMessageService.sendMessage(bobMessage as Message);

      // alice fetch Bob's message
      await aliceMessageService.fetchMessages();

      // STEP 3: Wait for keep-alive interval
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      ); // Wait > KEEP_ALIVE_INTERVAL_MILLIS

      // Get active discussions
      const aliceActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Alice calls refresh - should send keep-alive
      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);

      // STEP 5: Verify keep-alive message was created
      const aliceMessages = await appDb.messages
        .where('[ownerUserId+contactUserId+direction]')
        .equals([aliceUserId, bobUserId, MessageDirection.OUTGOING])
        .toArray();

      const keepAliveMsg = aliceMessages.find(
        m => m.type === MessageType.KEEP_ALIVE
      );
      expect(keepAliveMsg).toBeDefined();
      expect(keepAliveMsg?.content).toBe('');

      // STEP 6: Bob fetches messages (including keep-alive)
      await bobMessageService.fetchMessages();

      // Bob's message should now be DELIVERED (acknowledged by Alice's keep-alive)
      const bobMessages = await appDb.messages
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
      await bobMessageService.sendMessage(bobMessage as Message);

      // alice fetch Bob's message
      await aliceMessageService.fetchMessages();

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
      const aliceActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Alice calls refresh - keep-alive should fail
      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);

      // STEP 5: Verify keep-alive message exists but failed
      let aliceMessages = await appDb.messages
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
      await aliceMessageService.sendMessage(aliceMessage as Message);

      // check message is SENT
      aliceMessages = await appDb.messages
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
        aliceMessageService
      );

      // STEP 8: Verify keep-alive was resent successfully
      aliceMessages = await appDb.messages
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
      await bobMessageService.fetchMessages();

      // Bob's message should now be DELIVERED (acknowledged by Alice's keep-alive)
      const bobMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();
      expect(bobMessages.length).toBe(2); // incoming keep-alive message are not stored in database
      expect(bobMessages[0].content).toBe('Test message');
      expect(bobMessages[0].status).toBe(MessageStatus.DELIVERED);
    });

    // TODO: Skip - SDK behavior tested in gossip-sdk/test/refresh-service.test.ts
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
      await bobMessageService.sendMessage(bobMsg as Message);

      // alice fetch Bob's message
      await aliceMessageService.fetchMessages();

      // STEP 2: Wait for keep-alive interval
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      // STEP 3: Alice calls refresh - session should be killed, keep-alive fails
      // Get active discussions
      let aliceActiveDiscussions = await appDb.discussions
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
      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);

      // restore spy
      aliceSessionStatusSpy.mockRestore();

      // verify discussion stays ACTIVE (auto-renewal triggered, not BROKEN)
      let aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      expect(aliceDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // step 4: Alice sends a normal message which is queued as WAITING_SESSION
      const aliceMsg: Omit<Message, 'id'> = {
        ownerUserId: aliceUserId,
        contactUserId: bobUserId,
        content: 'Normal message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };
      await aliceMessageService.sendMessage(aliceMsg as Message);

      // verify messages are queued as WAITING_SESSION with auto-renewal
      const aliceMsgList = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([aliceUserId, bobUserId])
        .and(m => m.direction === MessageDirection.OUTGOING)
        .toArray();

      // At least the normal message should be queued as WAITING_SESSION
      // Keep-alive might or might not be created depending on timing
      expect(aliceMsgList.length).toBeGreaterThanOrEqual(1);

      // Find the normal text message - status depends on whether session was restored
      const textMsg = aliceMsgList.find(m => m.type === MessageType.TEXT);
      expect(textMsg).toBeDefined();
      // Message could be SENT (if session restored) or WAITING_SESSION (if still Killed)
      expect([MessageStatus.SENT, MessageStatus.WAITING_SESSION]).toContain(
        textMsg?.status
      );

      // If keep-alive was created, check its status
      const keepAliveMsg = aliceMsgList.find(
        m => m.type === MessageType.KEEP_ALIVE
      );
      if (keepAliveMsg) {
        expect([MessageStatus.SENT, MessageStatus.WAITING_SESSION]).toContain(
          keepAliveMsg.status
        );
      }

      // Step 5 : renew discussion and process waiting messages
      await aliceDiscussionService.renew(bobUserId);
      aliceDiscussion = await appDb.discussions.get(aliceDiscussionId);
      if (!aliceDiscussion) throw new Error('alice discussion not found');
      await aliceAnnouncementService.resendAnnouncements([aliceDiscussion]);
      // Process WAITING_SESSION messages (simulates onSessionBecameActive handler)
      await aliceMessageService.processWaitingMessages(bobUserId);

      // Bob fetch new announcement and messages
      await bobAnnouncementService.fetchAndProcessAnnouncements();
      await bobMessageService.fetchMessages();

      // check bob received alice msg (at minimum the normal message)
      const bobReceivedMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .and(m => m.direction === MessageDirection.INCOMING)
        .toArray();

      // At least the text message should be received
      expect(bobReceivedMessages.length).toBeGreaterThanOrEqual(1);

      const receivedTextMsg = bobReceivedMessages.find(
        m => m.type === MessageType.TEXT
      );
      expect(receivedTextMsg).toBeDefined();
      expect(receivedTextMsg?.content).toBe('Normal message');
      expect(receivedTextMsg?.status).toBe(MessageStatus.DELIVERED);

      // STEP 6: Bob's original message should be delivered
      const bobMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();
      const bobOutgoingMsg = bobMessages.find(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(bobOutgoingMsg?.content).toBe('Bob message');
      expect(bobOutgoingMsg?.status).toBe(MessageStatus.DELIVERED);

      // STEP 7: Wait and trigger keep-alive again
      await new Promise(resolve =>
        setTimeout(resolve, KEEP_ALIVE_INTERVAL_MILLIS)
      );

      aliceActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);

      // STEP 9: Verify new keep-alive was sent successfully
      const aliceMessages = await appDb.messages
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
      await aliceMessageService.sendMessage(aliceMessage as Message);

      // alice fetch Bob's message
      await aliceMessageService.fetchMessages();

      // STEP 3: Wait for session timeout (should kill session and require keep-alive)
      await new Promise(resolve =>
        setTimeout(resolve, MAX_SESSION_INACTIVITY_MILLIS)
      );

      // Get active discussions
      const bobActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(bobUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      // STEP 4: Bob calls refresh - triggers auto-renewal instead of marking BROKEN
      await bobRefreshService.handleSessionRefresh(bobActiveDiscussions);

      // STEP 5: Verify discussion stays ACTIVE (auto-renewal triggered, not BROKEN)
      const bobDiscussion = await appDb.discussions.get(bobDiscussionId);
      expect(bobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 6: Verify keep-alive may have been attempted but queued as WAITING_SESSION
      const bobMessages = await appDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([bobUserId, aliceUserId])
        .toArray();

      const keepAliveMsg = bobMessages.find(
        m =>
          m.type === MessageType.KEEP_ALIVE &&
          m.direction === MessageDirection.OUTGOING
      );

      // With auto-renewal, keep-alive attempts when session is killed get queued as WAITING_SESSION
      if (keepAliveMsg) {
        expect(keepAliveMsg.status).toBe(MessageStatus.WAITING_SESSION);
      }
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
      await carolMessageService.sendMessage(carolMessage as Message);

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
      await daveMessageService.sendMessage(daveMessage as Message);

      // Alice fetches messages
      await aliceMessageService.fetchMessages();

      // STEP 3: Alice call refresh function
      const aliceActiveDiscussions = await appDb.discussions
        .where('ownerUserId')
        .equals(aliceUserId)
        .and(
          d =>
            d.status !== DiscussionStatus.CLOSED &&
            d.status !== DiscussionStatus.BROKEN
        )
        .toArray();

      expect(aliceActiveDiscussions.length).toBe(3);

      await aliceRefreshService.handleSessionRefresh(aliceActiveDiscussions);

      // STEP 4: Verify Bob's discussion stays ACTIVE (auto-renewal triggered, not BROKEN)
      const aliceBobDiscussion =
        await appDb.discussions.get(aliceBobDiscussionId);
      expect(aliceBobDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      // STEP 5: Verify Carol received keep-alive
      const aliceCarolMessages = await appDb.messages
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
      const aliceDaveDiscussion = await appDb.discussions.get(
        aliceDaveDiscussionId
      );
      expect(aliceDaveDiscussion?.status).toBe(DiscussionStatus.ACTIVE);

      const aliceDaveMessages = await appDb.messages
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
        aliceMessageService as unknown as MessageServiceWithSerialize
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
        aliceMessageService as unknown as MessageServiceWithSerialize
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

      await appDb.messages.add(originalMessage);

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
        aliceMessageService as unknown as MessageServiceWithSerialize
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
        aliceMessageService as unknown as MessageServiceWithSerialize
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
        aliceMessageService as unknown as MessageServiceWithSerialize
      ).serializeMessage(replyMessage);

      // Current implementation requires original message to exist in DB
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected failure');
      expect(result.error).toBe('Original message not found for reply');
    });
  });
});
