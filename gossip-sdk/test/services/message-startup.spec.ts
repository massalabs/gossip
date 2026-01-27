/**
 * Message startup behavior tests
 *
 * SENDING reset on startup, messages from unknown peers, seeker stabilization.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GossipDatabase,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { defaultSdkConfig } from '../../src/config/sdk';

// ============================================================================
// SENDING reset on startup
// ============================================================================

const RESET_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const RESET_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));

describe('SENDING Reset on Startup', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    if (!testDb.isOpen()) {
      await testDb.open();
    }
    await Promise.all(testDb.tables.map(table => table.clear()));
  });

  describe('resetStuckSendingMessages behavior', () => {
    async function resetStuckSendingMessages(): Promise<number> {
      return await testDb.messages
        .where('status')
        .equals(MessageStatus.SENDING)
        .modify({
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: undefined,
          seeker: undefined,
        });
    }

    it('should reset SENDING messages to WAITING_SESSION', async () => {
      const messageId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        encryptedMessage: new Uint8Array([1, 2, 3]),
        seeker: new Uint8Array([4, 5, 6]),
      });

      const count = await resetStuckSendingMessages();

      expect(count).toBe(1);

      const message = await testDb.messages.get(messageId);
      expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(message?.encryptedMessage).toBeUndefined();
      expect(message?.seeker).toBeUndefined();
    });

    it('should clear encryptedMessage and seeker for re-encryption', async () => {
      const originalEncrypted = new Uint8Array([10, 20, 30, 40]);
      const originalSeeker = new Uint8Array([50, 60, 70, 80]);

      const messageId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Message with encryption data',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        encryptedMessage: originalEncrypted,
        seeker: originalSeeker,
      });

      await resetStuckSendingMessages();

      const message = await testDb.messages.get(messageId);

      expect(message?.encryptedMessage).toBeUndefined();
      expect(message?.seeker).toBeUndefined();
      expect(message?.content).toBe('Message with encryption data');
    });

    it('should NOT affect messages in other statuses', async () => {
      const waitingId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Waiting',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });

      const sentId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Sent',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array([1, 2, 3]),
      });

      const deliveredId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Delivered',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array([4, 5, 6]),
      });

      const failedId = await testDb.messages.add({
        ownerUserId: RESET_OWNER_USER_ID,
        contactUserId: RESET_CONTACT_USER_ID,
        content: 'Failed',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.FAILED,
        timestamp: new Date(),
      });

      const count = await resetStuckSendingMessages();

      expect(count).toBe(0);
      expect((await testDb.messages.get(waitingId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await testDb.messages.get(sentId))?.status).toBe(
        MessageStatus.SENT
      );
      expect((await testDb.messages.get(deliveredId))?.status).toBe(
        MessageStatus.DELIVERED
      );
      expect((await testDb.messages.get(failedId))?.status).toBe(
        MessageStatus.FAILED
      );
    });

    it('should reset multiple SENDING messages', async () => {
      await testDb.messages.bulkAdd([
        {
          ownerUserId: RESET_OWNER_USER_ID,
          contactUserId: RESET_CONTACT_USER_ID,
          content: 'Message 1',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([1]),
          seeker: new Uint8Array([1]),
        },
        {
          ownerUserId: RESET_OWNER_USER_ID,
          contactUserId: RESET_CONTACT_USER_ID,
          content: 'Message 2',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([2]),
          seeker: new Uint8Array([2]),
        },
        {
          ownerUserId: RESET_OWNER_USER_ID,
          contactUserId: RESET_CONTACT_USER_ID,
          content: 'Message 3',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([3]),
          seeker: new Uint8Array([3]),
        },
      ]);

      const count = await resetStuckSendingMessages();

      expect(count).toBe(3);

      const messages = await testDb.messages.toArray();
      expect(
        messages.every(m => m.status === MessageStatus.WAITING_SESSION)
      ).toBe(true);
      expect(messages.every(m => m.encryptedMessage === undefined)).toBe(true);
      expect(messages.every(m => m.seeker === undefined)).toBe(true);
    });

    it('should handle empty database gracefully', async () => {
      const count = await resetStuckSendingMessages();
      expect(count).toBe(0);
    });
  });
});

// ============================================================================
// Messages from Unknown Peer
// ============================================================================

const EDGE_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const EDGE_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const EDGE_UNKNOWN_USER_ID = encodeUserId(new Uint8Array(32).fill(99));

describe('Messages from Unknown Peer', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    await testDb.discussions.add({
      ownerUserId: EDGE_OWNER_USER_ID,
      contactUserId: EDGE_CONTACT_USER_ID,
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should not have discussion for unknown peer', async () => {
    const discussion = await testDb.getDiscussionByOwnerAndContact(
      EDGE_OWNER_USER_ID,
      EDGE_UNKNOWN_USER_ID
    );

    expect(discussion).toBeUndefined();
  });

  it('should have discussion for known peer', async () => {
    const discussion = await testDb.getDiscussionByOwnerAndContact(
      EDGE_OWNER_USER_ID,
      EDGE_CONTACT_USER_ID
    );

    expect(discussion).toBeDefined();
    expect(discussion?.contactUserId).toBe(EDGE_CONTACT_USER_ID);
  });
});

// ============================================================================
// Seeker Stabilization Logic
// ============================================================================

describe('Seeker Stabilization Logic', () => {
  it('should detect when seekers are the same (stabilized)', () => {
    const seekers1 = new Set(['seeker1', 'seeker2', 'seeker3']);
    const seekers2 = new Set(['seeker1', 'seeker2', 'seeker3']);

    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(true);
  });

  it('should detect when seekers changed (not stabilized)', () => {
    const seekers1 = new Set(['seeker1', 'seeker2']);
    const seekers2 = new Set(['seeker1', 'seeker2', 'seeker3']);

    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(false);
  });

  it('should detect when seekers reduced', () => {
    const seekers1 = new Set(['seeker1', 'seeker2', 'seeker3']);
    const seekers2 = new Set(['seeker1', 'seeker2']);

    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(false);
  });

  it('should handle empty seeker sets', () => {
    const seekers1 = new Set<string>();
    const seekers2 = new Set<string>();

    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(true);
  });

  it('should respect maxFetchIterations limit', () => {
    const maxIterations = defaultSdkConfig.messages.maxFetchIterations;
    let iterations = 0;
    const seekersNeverStabilize = () => new Set([`seeker${iterations++}`]);

    let previousSeekers = new Set<string>();
    let loopCount = 0;

    while (loopCount < maxIterations) {
      const currentSeekers = seekersNeverStabilize();
      const stabilized =
        previousSeekers.size === currentSeekers.size &&
        [...previousSeekers].every(s => currentSeekers.has(s));

      if (stabilized) break;

      previousSeekers = currentSeekers;
      loopCount++;
    }

    expect(loopCount).toBe(maxIterations);
  });
});

// ============================================================================
// Decryption Failure Handling
// ============================================================================

const EDGE_SEEKER_SIZE = 34;

function createEdgeSession(
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(status),
    sendMessage: vi.fn().mockResolvedValue({
      seeker: new Uint8Array(EDGE_SEEKER_SIZE).fill(1),
      data: new Uint8Array([1, 2, 3, 4]),
    }),
    feedIncomingMessageBoardRead: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    feedIncomingAnnouncement: vi.fn(),
    establishOutgoingSession: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: EDGE_OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(1),
    userId: new Uint8Array(32).fill(1),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

describe('Decryption Failure Handling', () => {
  it('should handle undefined return from feedIncomingMessageBoardRead gracefully', async () => {
    const mockSession = createEdgeSession();

    (
      mockSession.feedIncomingMessageBoardRead as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    const result = await mockSession.feedIncomingMessageBoardRead(
      new Uint8Array(32),
      new Uint8Array(100)
    );

    expect(result).toBeUndefined();
  });

  it('should handle feedIncomingMessageBoardRead throwing error', async () => {
    const mockSession = createEdgeSession();

    (
      mockSession.feedIncomingMessageBoardRead as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('Decryption failed: invalid ciphertext'));

    await expect(
      mockSession.feedIncomingMessageBoardRead(
        new Uint8Array(32),
        new Uint8Array(100)
      )
    ).rejects.toThrow('Decryption failed');
  });
});
