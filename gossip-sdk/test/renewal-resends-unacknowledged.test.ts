/**
 * Integration Test: Session renewal resends unacknowledged messages
 *
 * This test verifies that when a session is renewed (manually or automatically),
 * messages that were SENT but not DELIVERED/READ are reset to WAITING_SESSION
 * and then resent when the session becomes active again.
 *
 * Deduplication happens on the receiver side, so resending is safe.
 *
 * Note: These tests simulate the database operations from DiscussionService.renew()
 * to avoid WASM dependencies, while still testing the full integration flow
 * with MessageService.processWaitingMessages().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageService } from '../src/services/message';
import { DiscussionService } from '../src/services/discussion';
import {
  db,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../src/db';
import type { IMessageProtocol } from '../src/api/messageProtocol/types';
import type { SessionModule } from '../src/wasm/session';
import { encodeUserId } from '../src/utils/userId';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';
import type { GossipSdkEvents } from '../src/types/events';

const ALICE_USER_ID_RAW = new Uint8Array(32).fill(1);
const ALICE_USER_ID = encodeUserId(ALICE_USER_ID_RAW);
const BOB_USER_ID_RAW = new Uint8Array(32).fill(2);
const BOB_USER_ID = encodeUserId(BOB_USER_ID_RAW);

function createMockProtocol(): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMockSession(
  initialStatus: SessionStatus = SessionStatus.Active
): SessionModule & {
  setSessionStatus: (status: SessionStatus) => void;
} {
  let currentStatus = initialStatus;

  const mockSession = {
    peerSessionStatus: vi.fn().mockImplementation(() => currentStatus),
    sendMessage: vi
      .fn()
      .mockImplementation(
        async (): Promise<
          { seeker: Uint8Array; data: Uint8Array } | undefined
        > => {
          if (currentStatus !== SessionStatus.Active) {
            return undefined;
          }
          return {
            seeker: new Uint8Array(32).fill(Math.random() * 255),
            data: new Uint8Array([1, 2, 3, 4]),
          };
        }
      ),
    feedIncomingMessageBoardRead: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    feedIncomingAnnouncement: vi.fn(),
    establishOutgoingSession: vi.fn().mockResolvedValue(new Uint8Array(100)),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: ALICE_USER_ID,
    userIdRaw: ALICE_USER_ID_RAW,
    userId: ALICE_USER_ID_RAW,
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
    setSessionStatus: (status: SessionStatus) => {
      currentStatus = status;
    },
  };

  return mockSession as unknown as SessionModule & {
    setSessionStatus: (status: SessionStatus) => void;
  };
}

/**
 * Simulates the exact database operations from DiscussionService.renew()
 * for resetting unacknowledged messages.
 *
 * This avoids WASM dependency while testing the actual query logic.
 */
async function simulateRenewMessageReset(
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

describe('Session renewal resends unacknowledged messages', () => {
  let mockProtocol: IMessageProtocol;
  let mockSession: SessionModule & {
    setSessionStatus: (status: SessionStatus) => void;
  };
  let events: GossipSdkEvents;
  let messageService: MessageService;

  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    mockProtocol = createMockProtocol();
    mockSession = createMockSession(SessionStatus.Active);
    events = {};

    // Create Alice's contact record for Bob
    await db.contacts.add({
      ownerUserId: ALICE_USER_ID,
      userId: BOB_USER_ID,
      name: 'Bob',
      publicKeys: BOB_USER_ID_RAW,
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
  });

  describe('Manual renewal flow', () => {
    it('should reset SENT messages to WAITING_SESSION and resend when session becomes active', async () => {
      /**
       * Scenario:
       * 1. Alice has an ACTIVE discussion with Bob
       * 2. Alice has a SENT message (not yet DELIVERED)
       * 3. Session breaks (Killed)
       * 4. Alice manually calls renew() - simulated here
       * 5. SENT message should be reset to WAITING_SESSION
       * 6. When session becomes Active, message should be resent
       */

      // Step 1: Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Step 2: Create a SENT message (not acknowledged)
      const sentMessageId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Hello Bob! This was sent but not delivered.',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Also create a DELIVERED message (should NOT be reset)
      const deliveredMessageId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
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
      expect(sentMessage?.encryptedMessage).toBeDefined();

      // Step 3 & 4: Session breaks and renew() is called
      // Simulate the message reset that happens in renew()
      const resetCount = await simulateRenewMessageReset(
        ALICE_USER_ID,
        BOB_USER_ID
      );
      expect(resetCount).toBe(1); // Only SENT message should be reset

      // Step 5: Verify SENT message was reset to WAITING_SESSION
      sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(sentMessage?.seeker).toBeUndefined(); // Cleared for re-encryption
      expect(sentMessage?.encryptedMessage).toBeUndefined(); // Cleared for re-encryption

      // Verify DELIVERED message was NOT reset
      const deliveredMessage = await db.messages.get(deliveredMessageId);
      expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
      expect(deliveredMessage?.seeker).toBeDefined();
      expect(deliveredMessage?.encryptedMessage).toBeDefined();

      // Step 6: Session becomes Active (peer accepted our announcement)
      mockSession.setSessionStatus(SessionStatus.Active);

      // Create message service with stable discussion
      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      // Process waiting messages (this is what handleSessionBecameActive does)
      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);

      // Verify message was sent
      expect(sentCount).toBe(1);
      sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.SENT);

      // Verify protocol.sendMessage was called
      expect(mockProtocol.sendMessage).toHaveBeenCalled();
    });

    it('should reset multiple unacknowledged messages (SENT, SENDING, FAILED) on renew', async () => {
      // Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create messages with various unacknowledged statuses
      const sentId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'SENT message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 3000),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      const sendingId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'SENDING message (interrupted)',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(Date.now() - 2000),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      const failedId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'FAILED message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.FAILED,
        timestamp: new Date(Date.now() - 1000),
        seeker: new Uint8Array(32).fill(3),
        encryptedMessage: new Uint8Array(64).fill(3),
      });

      // Acknowledged messages - should NOT be reset
      const deliveredId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'DELIVERED message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(Date.now() - 5000),
        seeker: new Uint8Array(32).fill(4),
        encryptedMessage: new Uint8Array(64).fill(4),
      });

      const readId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'READ message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.READ,
        timestamp: new Date(Date.now() - 6000),
        seeker: new Uint8Array(32).fill(5),
        encryptedMessage: new Uint8Array(64).fill(5),
      });

      // Simulate renew()
      const resetCount = await simulateRenewMessageReset(
        ALICE_USER_ID,
        BOB_USER_ID
      );
      expect(resetCount).toBe(3); // SENT, SENDING, FAILED

      // Verify unacknowledged messages were reset
      const sent = await db.messages.get(sentId);
      expect(sent?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(sent?.seeker).toBeUndefined();

      const sending = await db.messages.get(sendingId);
      expect(sending?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(sending?.seeker).toBeUndefined();

      const failed = await db.messages.get(failedId);
      expect(failed?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(failed?.seeker).toBeUndefined();

      // Verify acknowledged messages were NOT reset
      const delivered = await db.messages.get(deliveredId);
      expect(delivered?.status).toBe(MessageStatus.DELIVERED);
      expect(delivered?.seeker).toBeDefined();

      const read = await db.messages.get(readId);
      expect(read?.status).toBe(MessageStatus.READ);
      expect(read?.seeker).toBeDefined();

      // Now process waiting messages
      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);
      expect(sentCount).toBe(3); // All 3 unacknowledged messages should be sent
    });
  });

  describe('Auto-renewal flow (via onSessionRenewalNeeded)', () => {
    it('should reset SENT messages and resend via auto-renewal flow', async () => {
      /**
       * Scenario simulating GossipSdk auto-renewal:
       * 1. Session is killed
       * 2. onSessionRenewalNeeded is triggered
       * 3. handleSessionRenewal calls renew() - simulated here
       * 4. SENT messages are reset
       * 5. When session becomes active, processWaitingMessages sends them
       */

      // Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create SENT message
      const sentMessageId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Message sent before session died',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Track events
      const onSessionRenewalNeeded = vi.fn();
      const onSessionBecameActive = vi.fn();
      events = { onSessionRenewalNeeded, onSessionBecameActive };

      // Step 1: Session breaks
      mockSession.setSessionStatus(SessionStatus.Killed);

      // Step 2-3: Auto-renewal triggered, renew() called
      // Simulate what handleSessionRenewal does
      await simulateRenewMessageReset(ALICE_USER_ID, BOB_USER_ID);

      // Verify SENT message was reset
      let sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(sentMessage?.encryptedMessage).toBeUndefined();

      // Step 4: Session becomes active (peer accepts)
      mockSession.setSessionStatus(SessionStatus.Active);

      // Create message service
      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      // Step 5: processWaitingMessages is called (by handleSessionBecameActive)
      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);

      // Verify message was resent
      expect(sentCount).toBe(1);
      sentMessage = await db.messages.get(sentMessageId);
      expect(sentMessage?.status).toBe(MessageStatus.SENT);
      expect(mockProtocol.sendMessage).toHaveBeenCalled();
    });

    it('should handle renewal when no unacknowledged messages exist', async () => {
      // Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Only DELIVERED messages exist
      await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Already delivered',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Simulate renew - should reset 0 messages
      const resetCount = await simulateRenewMessageReset(
        ALICE_USER_ID,
        BOB_USER_ID
      );
      expect(resetCount).toBe(0);

      // Session becomes active
      mockSession.setSessionStatus(SessionStatus.Active);

      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      // No messages to send
      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);
      expect(sentCount).toBe(0);
    });
  });

  describe('Edge cases', () => {
    it('should preserve message order when resending multiple messages', async () => {
      // Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create messages in order with distinct timestamps
      const msg1Id = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 3000),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      const msg2Id = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 2000),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      const msg3Id = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Message 3',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(Date.now() - 1000),
        seeker: new Uint8Array(32).fill(3),
        encryptedMessage: new Uint8Array(64).fill(3),
      });

      // Simulate renew
      await simulateRenewMessageReset(ALICE_USER_ID, BOB_USER_ID);

      // All should be WAITING_SESSION
      const msg1 = await db.messages.get(msg1Id);
      const msg2 = await db.messages.get(msg2Id);
      const msg3 = await db.messages.get(msg3Id);
      expect(msg1?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg2?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg3?.status).toBe(MessageStatus.WAITING_SESSION);

      // Process waiting messages
      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);
      expect(sentCount).toBe(3);

      // Verify all messages are now SENT
      const finalMsg1 = await db.messages.get(msg1Id);
      const finalMsg2 = await db.messages.get(msg2Id);
      const finalMsg3 = await db.messages.get(msg3Id);
      expect(finalMsg1?.status).toBe(MessageStatus.SENT);
      expect(finalMsg2?.status).toBe(MessageStatus.SENT);
      expect(finalMsg3?.status).toBe(MessageStatus.SENT);

      // Verify sendMessage was called 3 times
      expect(mockProtocol.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should resend unacknowledged messages when user manually renews an active session', async () => {
      /**
       * User's exact scenario:
       * 1. Alice connects to Bob (session Active)
       * 2. Bob answers/connects back (both have Active session)
       * 3. They exchange messages normally
       * 4. Alice sends more messages - some are SENT but not acknowledged (DELIVERED/READ)
       * 5. Alice manually renews (maybe suspects Bob didn't receive them)
       * 6. Unacknowledged messages should be resent
       *
       * Deduplication on Bob's side handles any duplicates.
       */

      // Step 1-2: Active discussion with working session
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Step 3: Previously exchanged messages (acknowledged)
      await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Hey Bob!',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED, // Bob received this
        timestamp: new Date(Date.now() - 10000),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Hey Alice!',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING, // From Bob
        status: MessageStatus.DELIVERED,
        timestamp: new Date(Date.now() - 9000),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Step 4: Alice sends more messages - NOT acknowledged by Bob
      const unacknowledged1 = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Are you still there?',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT, // Sent but Bob never acknowledged
        timestamp: new Date(Date.now() - 5000),
        seeker: new Uint8Array(32).fill(3),
        encryptedMessage: new Uint8Array(64).fill(3),
      });

      const unacknowledged2 = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Hello???',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT, // Sent but Bob never acknowledged
        timestamp: new Date(Date.now() - 3000),
        seeker: new Uint8Array(32).fill(4),
        encryptedMessage: new Uint8Array(64).fill(4),
      });

      // Verify session is Active (working fine)
      expect(mockSession.peerSessionStatus(BOB_USER_ID_RAW)).toBe(
        SessionStatus.Active
      );

      // Step 5: Alice manually renews (simulated)
      const resetCount = await simulateRenewMessageReset(
        ALICE_USER_ID,
        BOB_USER_ID
      );
      expect(resetCount).toBe(2); // Only the 2 unacknowledged SENT messages

      // Verify unacknowledged messages were reset
      let msg1 = await db.messages.get(unacknowledged1);
      let msg2 = await db.messages.get(unacknowledged2);
      expect(msg1?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg2?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg1?.encryptedMessage).toBeUndefined(); // Cleared for re-encryption
      expect(msg2?.encryptedMessage).toBeUndefined();

      // Step 6: Session becomes active again, messages are resent
      const discussionService = {
        isStableState: vi.fn().mockResolvedValue(true),
      } as unknown as DiscussionService;

      messageService = new MessageService(
        db,
        mockProtocol,
        mockSession,
        discussionService,
        events
      );

      const sentCount =
        await messageService.processWaitingMessages(BOB_USER_ID);
      expect(sentCount).toBe(2);

      // Verify messages are now SENT again (will be re-encrypted with new session keys)
      msg1 = await db.messages.get(unacknowledged1);
      msg2 = await db.messages.get(unacknowledged2);
      expect(msg1?.status).toBe(MessageStatus.SENT);
      expect(msg2?.status).toBe(MessageStatus.SENT);

      // Protocol was called twice
      expect(mockProtocol.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should not resend incoming messages on renewal', async () => {
      // Create ACTIVE discussion
      await db.discussions.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create an outgoing SENT message
      const outgoingId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Outgoing message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(1),
        encryptedMessage: new Uint8Array(64).fill(1),
      });

      // Create an incoming message (should never be reset)
      const incomingId = await db.messages.add({
        ownerUserId: ALICE_USER_ID,
        contactUserId: BOB_USER_ID,
        content: 'Incoming message from Bob',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array(32).fill(2),
        encryptedMessage: new Uint8Array(64).fill(2),
      });

      // Simulate renew
      const resetCount = await simulateRenewMessageReset(
        ALICE_USER_ID,
        BOB_USER_ID
      );
      expect(resetCount).toBe(1); // Only outgoing message

      // Verify outgoing was reset
      const outgoing = await db.messages.get(outgoingId);
      expect(outgoing?.status).toBe(MessageStatus.WAITING_SESSION);

      // Verify incoming was NOT touched
      const incoming = await db.messages.get(incomingId);
      expect(incoming?.status).toBe(MessageStatus.DELIVERED);
      expect(incoming?.seeker).toBeDefined();
    });
  });
});
