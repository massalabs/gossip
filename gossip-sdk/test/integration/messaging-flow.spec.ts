/**
 * Messaging e2e-style tests
 *
 * Uses real WASM SessionModule with real crypto.
 * MockMessageProtocol provides in-memory message storage (no network).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AnnouncementService } from '../../src/services/announcement.js';
import { DiscussionService } from '../../src/services/discussion.js';
import { MessageService } from '../../src/services/message.js';
import {
  db,
  DiscussionStatus,
  DiscussionDirection,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '../../src/db.js';
import { SessionStatus } from '../../src/wasm/bindings.js';
import { MockMessageProtocol } from '../mocks/index.js';
import {
  createTestSession,
  cleanupTestSession,
  TestSessionData,
} from '../utils.js';
import type { GossipSdkEvents } from '../../src/types/events.js';

// ============================================================================
// Session renewal resends unacknowledged messages
// ============================================================================

describe('Session renewal resends unacknowledged messages', () => {
  let alice: TestSessionData;
  let bob: TestSessionData;
  let mockProtocol: MockMessageProtocol;
  let events: GossipSdkEvents;
  let messageService: MessageService;
  let discussionService: DiscussionService;
  let announcementService: AnnouncementService;

  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    // Create real WASM sessions
    alice = await createTestSession(`alice-renew-${Date.now()}`);
    bob = await createTestSession(`bob-renew-${Date.now()}`);

    mockProtocol = new MockMessageProtocol();
    events = {};

    // Add Bob as Alice's contact
    await db.contacts.add({
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

  /**
   * Helper to reset unacknowledged messages to WAITING_SESSION
   * (simulates what happens when session needs renewal)
   */
  async function simulateRenewReset(
    ownerUserId: string,
    contactUserId: string
  ): Promise<number> {
    return await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .and(
        message =>
          message.direction === MessageDirection.OUTGOING &&
          (message.status === MessageStatus.SENDING ||
            message.status === MessageStatus.FAILED ||
            message.status === MessageStatus.SENT)
      )
      .modify({
        status: MessageStatus.WAITING_SESSION,
        encryptedMessage: undefined,
        seeker: undefined,
      });
  }

  describe('Manual renewal flow', () => {
    it('should reset SENT messages to WAITING_SESSION and resend when session becomes active', async () => {
      // Establish a real session between Alice and Bob
      const aliceAnnouncement = await alice.session.establishOutgoingSession(
        bob.session.ourPk
      );
      await bob.session.feedIncomingAnnouncement(aliceAnnouncement);
      const bobAnnouncement = await bob.session.establishOutgoingSession(
        alice.session.ourPk
      );
      await alice.session.feedIncomingAnnouncement(bobAnnouncement);

      // Verify session is active
      expect(alice.session.peerSessionStatus(bob.session.userId)).toBe(
        SessionStatus.Active
      );

      // Create active discussion
      await db.discussions.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Add a SENT message (simulates message sent but not acknowledged)
      const sentMessageId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Hello Bob! This was sent but not delivered.',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Add a DELIVERED message (should not be reset)
      const deliveredMessageId = await db.messages.add({
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
      let sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.SENT);
      expect(sentMessage?.seeker).toBeDefined();

      // Simulate renewal reset
      const resetCount = await simulateRenewReset(
        alice.session.userIdEncoded,
        bob.session.userIdEncoded
      );
      expect(resetCount).toBe(1);

      // Verify reset state
      sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(sentMessage?.seeker).toBeUndefined();

      // DELIVERED should be unchanged
      const deliveredMessage = await db.messages.get(deliveredMessageId);
      expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
      expect(deliveredMessage?.seeker).toBeDefined();

      // Process waiting messages (session is still active)
      const sentCount = await messageService.processWaitingMessages(
        bob.session.userIdEncoded
      );

      expect(sentCount).toBe(1);
      sentMessage = await db.messages.get(sentMessageId);
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

      await db.discussions.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Add messages with different statuses
      const sentId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'SENT message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 3000),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      const sendingId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'SENDING message (interrupted)',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(Date.now() - 2000),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      const failedId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'FAILED message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.FAILED,
        timestamp: new Date(Date.now() - 1000),
        seeker: new Uint8Array(32).fill(3),
        encryptedMessage: new Uint8Array(64).fill(3),
      });

      const deliveredId = await db.messages.add({
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
      expect((await db.messages.get(sentId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await db.messages.get(sendingId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await db.messages.get(failedId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await db.messages.get(deliveredId))?.status).toBe(
        MessageStatus.DELIVERED
      );

      // Process waiting messages
      const sentCount = await messageService.processWaitingMessages(
        bob.session.userIdEncoded
      );
      expect(sentCount).toBe(3);
    });
  });

  describe('Edge cases', () => {
    it('should preserve message order when resending multiple messages', async () => {
      // Establish session
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

      // Add 3 messages in order
      const msg1Id = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 3000),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      const msg2Id = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 2000),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      const msg3Id = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Message 3',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 1000),
        seeker: new Uint8Array(32).fill(3),
        encryptedMessage: new Uint8Array(64).fill(3),
      });

      await simulateRenewReset(
        alice.session.userIdEncoded,
        bob.session.userIdEncoded
      );

      const sentCount = await messageService.processWaitingMessages(
        bob.session.userIdEncoded
      );
      expect(sentCount).toBe(3);

      // All should be SENT now
      expect((await db.messages.get(msg1Id))?.status).toBe(MessageStatus.SENT);
      expect((await db.messages.get(msg2Id))?.status).toBe(MessageStatus.SENT);
      expect((await db.messages.get(msg3Id))?.status).toBe(MessageStatus.SENT);
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

      await db.discussions.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const outgoingId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Outgoing message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      const incomingId = await db.messages.add({
        ownerUserId: alice.session.userIdEncoded,
        contactUserId: bob.session.userIdEncoded,
        content: 'Incoming message from Bob',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      const resetCount = await simulateRenewReset(
        alice.session.userIdEncoded,
        bob.session.userIdEncoded
      );
      expect(resetCount).toBe(1); // Only outgoing

      expect((await db.messages.get(outgoingId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await db.messages.get(incomingId))?.status).toBe(
        MessageStatus.DELIVERED
      );
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
    const { discussionId } =
      await discussionService.initialize(aliceBobContact);

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
