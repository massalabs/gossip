/**
 * Retention policy feature tests
 *
 * Covers:
 * - DiscussionService.setRetentionPolicy: local DB update + control message enqueued
 * - MessageService.storeDecryptedMessages: incoming retention policy updates discussion
 * - MessageService.deleteExpiredMessages: applies retention cleanup rules
 * - getVisibleMessages: RETENTION_POLICY control rows are hidden from the UI
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import {
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionDirection,
} from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/wasm/bindings';
import { defaultSdkConfig } from '../../src/config/sdk';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { clearAllTables, getTestQueries } from '../testDb';
import { MockMessageProtocol } from '../mocks';
import { AnnouncementService } from '../../src/services/announcement';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const SEEKER_SIZE = 34;

function createMockSession(
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  const ownerBytes = decodeUserId(OWNER_USER_ID);
  return {
    peerSessionStatus: vi.fn().mockReturnValue(status),
    sendMessage: vi.fn().mockReturnValue({
      seeker: new Uint8Array(SEEKER_SIZE).fill(1),
      data: new Uint8Array([1, 2, 3, 4]),
    }),
    feedIncomingMessageBoardRead: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    feedIncomingAnnouncement: vi.fn(),
    establishOutgoingSession: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: OWNER_USER_ID,
    userIdRaw: ownerBytes,
    userId: ownerBytes,
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
    peerList: vi.fn().mockReturnValue([]),
    peerDiscard: vi.fn(),
  } as unknown as SessionModule;
}

function createMockAnnouncementService(): AnnouncementService {
  return {
    processOutgoingAnnouncements: vi.fn().mockResolvedValue(undefined),
    fetchAndProcessAnnouncements: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnnouncementService;
}

async function insertTestContactAndDiscussion(
  ownerUserId: string = OWNER_USER_ID,
  contactUserId: string = CONTACT_USER_ID,
  retentionDuration?: number | null
) {
  await getTestQueries().contacts.insert({
    ownerUserId,
    userId: contactUserId,
    name: 'Test Contact',
    publicKeys: new Uint8Array(32),
    isOnline: true,
    lastSeen: new Date(),
    createdAt: new Date(),
  });

  await getTestQueries().discussions.insert({
    ownerUserId,
    contactUserId,
    direction: DiscussionDirection.INITIATED,
    weAccepted: true,
    unreadCount: 0,
    messageRetentionDuration: retentionDuration ?? null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// setRetentionPolicy
// ─────────────────────────────────────────────────────────────────────────────

describe('DiscussionService.setRetentionPolicy', () => {
  beforeEach(clearAllTables);

  it('updates messageRetentionDuration in the local DB', async () => {
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();
    const mockSession = createMockSession();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      mockSession,
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, 86400);

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.messageRetentionDuration).toBe(86400);
  });

  it('sets messageRetentionDuration to null when disabled', async () => {
    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, 86400);
    const testQueries = getTestQueries();
    const mockSession = createMockSession();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      mockSession,
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, null);

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.messageRetentionDuration).toBeNull();
  });

  it('enqueues a RETENTION_POLICY control message for the peer', async () => {
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();
    const mockSession = createMockSession();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      mockSession,
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, 604800);

    // Active session triggers the fast path — the control message is sent
    // immediately (status SENT) rather than staying in the send queue.
    const allMessages = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = allMessages.find(
      m => m.type === MessageType.RETENTION_POLICY
    );
    expect(controlMsg).toBeDefined();
    expect(controlMsg?.content).toBe('604800');
    expect(controlMsg?.direction).toBe(MessageDirection.OUTGOING);
  });

  it('enqueues duration 0 when retention is disabled (null)', async () => {
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();
    const mockSession = createMockSession();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      mockSession,
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, null);

    const allMessages = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = allMessages.find(
      m => m.type === MessageType.RETENTION_POLICY
    );
    expect(controlMsg?.content).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Incoming retention policy control message
// ─────────────────────────────────────────────────────────────────────────────

describe('DiscussionQueries.updateByOwnerAndContact (retention)', () => {
  beforeEach(clearAllTables);

  it('updates messageRetentionDuration via updateByOwnerAndContact', async () => {
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();

    const before = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(before?.messageRetentionDuration).toBeNull();

    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { messageRetentionDuration: 28800 }
    );

    const after = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(after?.messageRetentionDuration).toBe(28800);
  });

  it('clears messageRetentionDuration to null', async () => {
    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, 86400);
    const testQueries = getTestQueries();

    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { messageRetentionDuration: null }
    );

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.messageRetentionDuration).toBeNull();
  });

  it('stores retentionPolicySetAt when an incoming RETENTION_POLICY is applied', async () => {
    // This mirrors what storeDecryptedMessages() does when it receives a
    // RETENTION_POLICY control message from a peer.
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();
    const before = Date.now();

    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      {
        messageRetentionDuration: 86400,
        retentionPolicySetAt: Date.now(),
      }
    );

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.messageRetentionDuration).toBe(86400);
    expect(row?.retentionPolicySetAt).not.toBeNull();
    expect(row?.retentionPolicySetAt).toBeGreaterThanOrEqual(before);
  });

  it('clears retentionPolicySetAt when an incoming RETENTION_POLICY disables the policy', async () => {
    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, 3600);
    const testQueries = getTestQueries();
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: Date.now() - 60_000 }
    );

    // Peer sends duration=0 → disable
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { messageRetentionDuration: null, retentionPolicySetAt: null }
    );

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.messageRetentionDuration).toBeNull();
    expect(row?.retentionPolicySetAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retentionPolicySetAt tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('retentionPolicySetAt is stored when policy changes', () => {
  beforeEach(clearAllTables);

  it('setRetentionPolicy stores a non-null retentionPolicySetAt', async () => {
    await insertTestContactAndDiscussion();
    const testQueries = getTestQueries();
    const mockSession = createMockSession();
    const before = Date.now();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );
    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      mockSession,
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, 3600);

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(row?.retentionPolicySetAt).not.toBeNull();
    expect(row?.retentionPolicySetAt).toBeGreaterThanOrEqual(before);
    expect(row?.retentionPolicySetAt).toBeLessThanOrEqual(Date.now());
  });

  it('setRetentionPolicy(null) keeps retentionPolicySetAt as a timestamp', async () => {
    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, 3600);
    const testQueries = getTestQueries();
    // Pre-set retentionPolicySetAt to simulate a previously enabled policy
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: Date.now() - 60_000 }
    );

    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );
    const discussionService = new DiscussionService(
      createMockAnnouncementService(),
      createMockSession(),
      new SdkEventEmitter(),
      testQueries
    );
    discussionService.setMessageService(messageService);

    await discussionService.setRetentionPolicy(CONTACT_USER_ID, null);

    const row = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    // retentionPolicySetAt stays as a timestamp so the default-policy
    // useEffect in Discussion.tsx doesn't re-apply a default.
    expect(row?.retentionPolicySetAt).toBeGreaterThan(0);
    expect(row?.messageRetentionDuration).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteExpiredMessages (MessageService method)
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// RETENTION_POLICY messages hidden from UI
// ─────────────────────────────────────────────────────────────────────────────

describe('getVisibleMessages filters out RETENTION_POLICY control rows', () => {
  beforeEach(clearAllTables);

  it('excludes outgoing RETENTION_POLICY rows from the visible list', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const visibleId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:00:00Z'),
    });

    // Outgoing RETENTION_POLICY control row — should be hidden
    await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '86400',
      type: MessageType.RETENTION_POLICY,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date('2024-01-02T00:00:00Z'),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const visible = await service.getVisibleMessages(CONTACT_USER_ID);
    expect(visible.map(m => m.id)).toEqual([visibleId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteExpiredMessages (MessageService method)
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageService.deleteExpiredMessages', () => {
  beforeEach(clearAllTables);

  const sendAndGetMessage = async (
    messageService: MessageService,
    message: Parameters<MessageService['sendMessage']>[0]
  ) => {
    const sendResult = await messageService.sendMessage(message);
    expect(sendResult.success).toBe(true);
    expect(sendResult.message?.id).toBeDefined();
    return sendResult.message!;
  };

  it('deletes expired message and removes related reaction/reply references', async () => {
    // Verify that deleting an expired parent message also cleans dependent rows.
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const expiredMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Expired',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    expect(expiredMessage.id).toBeDefined();
    expect(expiredMessage.messageId).toBeDefined();

    await testQueries.messages.updateById(expiredMessage.id!, {
      timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
    });

    await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Future reply',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      replyTo: { originalMsgId: expiredMessage.messageId! },
    });

    await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      reactionOf: { originalMsgId: expiredMessage.messageId! },
    });

    const beforeDeleteMessages =
      await messageService.getMessages(CONTACT_USER_ID);
    const replyMessage = beforeDeleteMessages.find(
      m => m.content === 'Future reply'
    );
    const reactionMessage = beforeDeleteMessages.find(
      m => m.type === MessageType.REACTION
    );
    expect(replyMessage?.id).toBeDefined();
    expect(reactionMessage?.id).toBeDefined();

    await testQueries.messages.updateById(replyMessage!.id!, {
      timestamp: new Date(Date.now() + 60_000),
    });
    await testQueries.messages.updateById(reactionMessage!.id!, {
      timestamp: new Date(Date.now() + 60_000),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const expiredAfter = await messageService.get(expiredMessage.id!);
    const replyAfter = await messageService.get(replyMessage!.id!);
    const reactionAfter = await messageService.get(reactionMessage!.id!);
    const replyAfterRaw = await testQueries.messages.getById(replyMessage!.id!);

    expect(expiredAfter?.type).toBe(MessageType.DELETED);
    expect(expiredAfter?.content).toBe('[Message deleted]');
    expect(reactionAfter).toBeUndefined();
    expect(replyAfter?.replyTo).toBeUndefined();
    expect(replyAfterRaw?.replyTo).toBeNull();
  });

  it('3 discussions with retention policy: delete all expired messages', async () => {
    // Ensure expiration is evaluated independently for each retained discussion.
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const contactIds = [
      CONTACT_USER_ID,
      encodeUserId(new Uint8Array(32).fill(3)),
      encodeUserId(new Uint8Array(32).fill(4)),
    ];
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    for (const contactId of contactIds) {
      await insertTestContactAndDiscussion(
        OWNER_USER_ID,
        contactId,
        retentionSeconds
      );
    }

    const expiredIds: number[] = [];
    const freshIds: number[] = [];

    for (const contactId of contactIds) {
      const expired = await sendAndGetMessage(messageService, {
        ownerUserId: OWNER_USER_ID,
        contactUserId: contactId,
        content: `Expired ${contactId}`,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      const fresh = await sendAndGetMessage(messageService, {
        ownerUserId: OWNER_USER_ID,
        contactUserId: contactId,
        content: `Fresh ${contactId}`,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      expiredIds.push(expired.id!);
      freshIds.push(fresh.id!);
      await testQueries.messages.updateById(expired.id!, {
        timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
      });
    }

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    for (const id of expiredIds) {
      const message = await messageService.get(id);
      expect(message?.type).toBe(MessageType.DELETED);
      expect(message?.content).toBe('[Message deleted]');
    }

    for (const id of freshIds) {
      const message = await messageService.get(id);
      expect(message?.type).toBe(MessageType.TEXT);
    }
  });

  it('nothing happens when no message is expired yet', async () => {
    // Guard against accidental deletion while messages are still within retention.
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const msg1 = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Not expired 1',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    const msg2 = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Not expired 2',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const msg1After = await messageService.get(msg1.id!);
    const msg2After = await messageService.get(msg2.id!);

    expect(msg1After?.type).toBe(MessageType.TEXT);
    expect(msg1After?.content).toBe('Not expired 1');
    expect(msg2After?.type).toBe(MessageType.TEXT);
    expect(msg2After?.content).toBe('Not expired 2');
  });

  it("If last message has expired, discussion's lastMessage is empty", async () => {
    // When the only visible message expires, the discussion preview must reset.
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const onlyMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Only message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await testQueries.messages.updateById(onlyMessage.id!, {
      timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const discussion = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const onlyMessageAfter = await messageService.get(onlyMessage.id!);

    expect(onlyMessageAfter?.type).toBe(MessageType.DELETED);
    expect(discussion?.lastMessageId).toBeNull();
    expect(discussion?.lastMessageContent).toBeNull();
    expect(discussion?.lastMessageTimestamp).toBeNull();
  });

  it('is a no-op when no discussion has a retention policy', async () => {
    const testQueries = getTestQueries();
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, null);

    const msg = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Should survive',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    await testQueries.messages.updateById(msg.id!, {
      timestamp: new Date(0), // epoch — extremely old
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    expect(await messageService.get(msg.id!)).toBeDefined();
  });

  it('marks expired text messages as DELETED and keeps non-expired messages', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const oldMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Old message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
    });
    const recentMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Recent message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - (retentionSeconds / 2) * 1000),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const oldAfter = await messageService.get(oldMessage.id!);
    const recentAfter = await messageService.get(recentMessage.id!);
    expect(oldAfter?.type).toBe(MessageType.DELETED);
    expect(oldAfter?.content).toBe('[Message deleted]');
    expect(recentAfter?.type).toBe(MessageType.TEXT);
    expect(recentAfter?.content).toBe('Recent message');
  });

  it('preserves KEEP_ALIVE and ANNOUNCEMENT messages regardless of age', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 60;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const veryOld = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const keepAliveMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: veryOld,
    });
    const announcementMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'announcement',
      type: MessageType.ANNOUNCEMENT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: veryOld,
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    expect(await messageService.get(keepAliveMessage.id!)).toBeDefined();
    expect(await messageService.get(announcementMessage.id!)).toBeDefined();
  });

  it('preserves messages that were sent before retentionPolicySetAt', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const policySetAt = Date.now();
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );
    // Mark the policy as set right now
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: policySetAt }
    );

    // An old message that predates the policy — must NOT be deleted even though it
    // is past the retention window (it existed before the user turned on auto-delete)
    const prePolicyMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Pre-policy message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(policySetAt - 2 * retentionSeconds * 1000), // 2 hours before policy
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);
    const prePolicy = await messageService.get(prePolicyMessage.id!);
    expect(prePolicy?.type).toBe(MessageType.TEXT);
  });

  it('deletes messages sent after retentionPolicySetAt once they expire', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const policySetAt = Date.now() - 2 * retentionSeconds * 1000;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: policySetAt }
    );

    // A message sent 90 minutes ago — after policySetAt, past the 1h retention window
    const expiredPostPolicyMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Post-policy expired message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(policySetAt + 30 * 60 * 1000),
    });
    const recentPostPolicyMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Post-policy recent message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 10 * 60 * 1000),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const expiredAfter = await messageService.get(expiredPostPolicyMessage.id!);
    const recentAfter = await messageService.get(recentPostPolicyMessage.id!);
    expect(expiredAfter?.type).toBe(MessageType.DELETED);
    expect(expiredAfter?.content).toBe('[Message deleted]');
    expect(recentAfter?.type).toBe(MessageType.TEXT);
  });

  it('only deletes messages from the correct discussion', async () => {
    const testQueries = getTestQueries();
    const contactUserId2 = encodeUserId(new Uint8Array(32).fill(9));
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );
    await insertTestContactAndDiscussion(OWNER_USER_ID, contactUserId2, null);

    const oldTimestamp = new Date(Date.now() - 2 * retentionSeconds * 1000);
    const expiredMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Expired in discussion 1',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: oldTimestamp,
    });
    const safeMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: contactUserId2,
      content: 'Old but safe in discussion 2',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: oldTimestamp,
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);

    const expiredAfter = await messageService.get(expiredMessage.id!);
    const safeAfter = await messageService.get(safeMessage.id!);
    expect(expiredAfter?.type).toBe(MessageType.DELETED);
    expect(safeAfter?.type).toBe(MessageType.TEXT);
  });

  it('does not delete messages created before retention policy activation', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: Date.now() - 30 * 60 * 1000 }
    );

    const oldBeforePolicyMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Older than retention but sent before policy activation',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);
    const oldBeforePolicy = await messageService.get(
      oldBeforePolicyMessage.id!
    );
    expect(oldBeforePolicy?.type).toBe(MessageType.TEXT);
  });

  it('deletes edited and reaction messages when they exceed retention after policy activation', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;
    const messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );
    await testQueries.discussions.updateByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      { retentionPolicySetAt: Date.now() - 3 * 3600 * 1000 }
    );

    const expiredTimestamp = new Date(Date.now() - 2 * retentionSeconds * 1000);
    const editedMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Edited message content',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: expiredTimestamp,
      metadata: { edited: true },
    });
    const reactionMessage = await sendAndGetMessage(messageService, {
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: expiredTimestamp,
      reactionOf: { originalMsgId: editedMessage.messageId! },
    });

    await messageService.deleteExpiredMessages(OWNER_USER_ID);
    const editedAfter = await messageService.get(editedMessage.id!);
    const reactionAfter = await messageService.get(reactionMessage.id!);
    expect(editedAfter?.type).toBe(MessageType.DELETED);
    expect(reactionAfter).toBeUndefined();
  });
});
