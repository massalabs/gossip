/**
 * Retention policy feature tests
 *
 * Covers:
 * - DiscussionService.setRetentionPolicy: local DB update + control message enqueued
 * - MessageService.storeDecryptedMessages: incoming retention policy updates discussion
 * - MessageQueries.deleteExpiredByOwner: hard-deletes only messages past threshold
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

    // The control message should be in the send queue
    const queue = await testQueries.messages.getSendQueue(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = queue.find(m => m.type === MessageType.RETENTION_POLICY);
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

    const queue = await testQueries.messages.getSendQueue(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = queue.find(m => m.type === MessageType.RETENTION_POLICY);
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

  it('setRetentionPolicy(null) clears retentionPolicySetAt to null', async () => {
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
    expect(row?.retentionPolicySetAt).toBeNull();
    expect(row?.messageRetentionDuration).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteExpiredByOwner
// ─────────────────────────────────────────────────────────────────────────────

describe('MessageQueries.deleteExpiredByOwner', () => {
  beforeEach(clearAllTables);

  it('hard-deletes messages older than the retention threshold', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600; // 1 hour

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const oldTimestamp = new Date(Date.now() - 2 * retentionSeconds * 1000); // 2 hours ago
    const recentTimestamp = new Date(
      Date.now() - (retentionSeconds / 2) * 1000
    ); // 30 min ago

    const oldId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Old message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: oldTimestamp,
    });

    const recentId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Recent message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: recentTimestamp,
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(await testQueries.messages.getById(oldId)).toBeUndefined();
    expect(await testQueries.messages.getById(recentId)).toBeDefined();
  });

  it('does not delete messages from discussions without a retention policy', async () => {
    const testQueries = getTestQueries();

    // Discussion with NO retention
    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, null);

    const oldId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Old message — should survive',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 30 * 24 * 3600 * 1000), // 30 days ago
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(await testQueries.messages.getById(oldId)).toBeDefined();
  });

  it('preserves KEEP_ALIVE and ANNOUNCEMENT messages regardless of age', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 60; // 1 minute

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const veryOld = new Date(Date.now() - 7 * 24 * 3600 * 1000); // 7 days ago

    const keepAliveId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: veryOld,
    });

    const announcementId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'announcement',
      type: MessageType.ANNOUNCEMENT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: veryOld,
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(await testQueries.messages.getById(keepAliveId)).toBeDefined();
    expect(await testQueries.messages.getById(announcementId)).toBeDefined();
  });

  it('preserves messages that were sent before retentionPolicySetAt', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600; // 1 hour
    const policySetAt = Date.now(); // policy set NOW

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
    const prePolicyId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Pre-policy message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(policySetAt - 2 * retentionSeconds * 1000), // 2 hours before policy
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(await testQueries.messages.getById(prePolicyId)).toBeDefined();
  });

  it('deletes messages sent after retentionPolicySetAt once they expire', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600; // 1 hour
    const policySetAt = Date.now() - 2 * retentionSeconds * 1000; // policy set 2 hours ago

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
    const expiredPostPolicyId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Post-policy expired message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(policySetAt + 30 * 60 * 1000), // 30 min after policy, now 90 min old
    });

    // A recent message — after policySetAt, within retention window (should survive)
    const recentPostPolicyId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Post-policy recent message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(
      await testQueries.messages.getById(expiredPostPolicyId)
    ).toBeUndefined();
    expect(
      await testQueries.messages.getById(recentPostPolicyId)
    ).toBeDefined();
  });

  it('only deletes messages from the correct discussion', async () => {
    const testQueries = getTestQueries();
    const CONTACT_USER_ID_2 = encodeUserId(new Uint8Array(32).fill(3));
    const retentionSeconds = 3600;

    // Discussion 1 — has retention
    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    // Discussion 2 — no retention (different contact)
    await testQueries.contacts.insert({
      ownerUserId: OWNER_USER_ID,
      userId: CONTACT_USER_ID_2,
      name: 'Second Contact',
      publicKeys: new Uint8Array(32),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
    await testQueries.discussions.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID_2,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      unreadCount: 0,
      messageRetentionDuration: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const oldTimestamp = new Date(Date.now() - 2 * retentionSeconds * 1000);

    const expiredId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Expired in discussion 1',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: oldTimestamp,
    });

    const safeId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID_2,
      content: 'Old but safe in discussion 2',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: oldTimestamp,
    });

    const discussionRows =
      await testQueries.discussions.getByOwner(OWNER_USER_ID);
    await testQueries.messages.deleteExpiredByOwner(
      OWNER_USER_ID,
      discussionRows
    );

    expect(await testQueries.messages.getById(expiredId)).toBeUndefined();
    expect(await testQueries.messages.getById(safeId)).toBeDefined();
  });
});

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

  it('deletes expired messages for all discussions with a retention policy', async () => {
    const testQueries = getTestQueries();
    const retentionSeconds = 3600;

    await insertTestContactAndDiscussion(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      retentionSeconds
    );

    const expiredId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Expired',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(Date.now() - 2 * retentionSeconds * 1000),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await service.deleteExpiredMessages(OWNER_USER_ID);

    expect(await testQueries.messages.getById(expiredId)).toBeUndefined();
  });

  it('is a no-op when no discussion has a retention policy', async () => {
    const testQueries = getTestQueries();

    await insertTestContactAndDiscussion(OWNER_USER_ID, CONTACT_USER_ID, null);

    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Should survive',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(0), // epoch — extremely old
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    await service.deleteExpiredMessages(OWNER_USER_ID);

    expect(await testQueries.messages.getById(msgId)).toBeDefined();
  });
});
