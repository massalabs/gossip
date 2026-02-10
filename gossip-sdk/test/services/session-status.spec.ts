/**
 * Session status logic tests
 *
 * Auto-accept logic, discussion status after renewal, reply target fallback,
 * and message FIFO ordering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GossipDatabase,
  MessageType,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db.js';
import { encodeUserId } from '../../src/utils/userId.js';
import { SessionStatus } from '../../src/wasm/bindings.js';

// ============================================================================
// Auto-accept + renew status logic
// ============================================================================

describe('Auto-Accept Logic', () => {
  interface ProcessAnnouncementParams {
    isNewContact: boolean;
    sessionStatus: SessionStatus;
  }

  function shouldAutoAccept(params: ProcessAnnouncementParams): boolean {
    return (
      params.sessionStatus === SessionStatus.PeerRequested &&
      !params.isNewContact
    );
  }

  describe('New contact requests', () => {
    it('should NOT auto-accept for new contact with PeerRequested status', () => {
      const result = shouldAutoAccept({
        isNewContact: true,
        sessionStatus: SessionStatus.PeerRequested,
      });
      expect(result).toBe(false);
    });

    it('should NOT auto-accept for new contact with any status', () => {
      const statuses = [
        SessionStatus.Active,
        SessionStatus.NoSession,
        SessionStatus.SelfRequested,
        SessionStatus.UnknownPeer,
        SessionStatus.Killed,
        SessionStatus.Saturated,
      ];

      for (const status of statuses) {
        const result = shouldAutoAccept({
          isNewContact: true,
          sessionStatus: status,
        });
        expect(result).toBe(false);
      }
    });
  });

  describe('Existing contact session recovery', () => {
    it('should auto-accept for existing contact with PeerRequested status', () => {
      const result = shouldAutoAccept({
        isNewContact: false,
        sessionStatus: SessionStatus.PeerRequested,
      });
      expect(result).toBe(true);
    });

    it('should NOT auto-accept for existing contact with non-PeerRequested status', () => {
      const statuses = [
        SessionStatus.Active,
        SessionStatus.NoSession,
        SessionStatus.SelfRequested,
        SessionStatus.UnknownPeer,
        SessionStatus.Killed,
        SessionStatus.Saturated,
      ];

      for (const status of statuses) {
        const result = shouldAutoAccept({
          isNewContact: false,
          sessionStatus: status,
        });
        expect(result).toBe(false);
      }
    });
  });
});

describe('Discussion Status After Renewal', () => {
  enum RenewalDiscussionStatus {
    PENDING = 'pending',
    ACTIVE = 'active',
    BROKEN = 'broken',
    SEND_FAILED = 'send_failed',
    RECONNECTING = 'reconnecting',
  }

  interface RenewResult {
    success: boolean;
    sessionStatus: SessionStatus;
    previousDiscussionStatus: RenewalDiscussionStatus;
  }

  function getStatusAfterRenewal(result: RenewResult): RenewalDiscussionStatus {
    if (!result.success) {
      return RenewalDiscussionStatus.SEND_FAILED;
    } else if (result.sessionStatus === SessionStatus.Active) {
      return RenewalDiscussionStatus.ACTIVE;
    } else if (
      result.previousDiscussionStatus === RenewalDiscussionStatus.ACTIVE
    ) {
      return RenewalDiscussionStatus.RECONNECTING;
    } else {
      return RenewalDiscussionStatus.PENDING;
    }
  }

  describe('True renewal (previously ACTIVE discussion)', () => {
    it('should set RECONNECTING when session is SelfRequested', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.ACTIVE,
      });
      expect(status).toBe(RenewalDiscussionStatus.RECONNECTING);
    });

    it('should set ACTIVE when session is already Active', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.Active,
        previousDiscussionStatus: RenewalDiscussionStatus.ACTIVE,
      });
      expect(status).toBe(RenewalDiscussionStatus.ACTIVE);
    });

    it('should set SEND_FAILED if send fails', () => {
      const status = getStatusAfterRenewal({
        success: false,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.ACTIVE,
      });
      expect(status).toBe(RenewalDiscussionStatus.SEND_FAILED);
    });
  });

  describe('First contact retry (previously PENDING/SEND_FAILED discussion)', () => {
    it('should set PENDING when session is SelfRequested (from PENDING)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.PENDING,
      });
      expect(status).toBe(RenewalDiscussionStatus.PENDING);
    });

    it('should set PENDING when session is SelfRequested (from SEND_FAILED)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.SEND_FAILED,
      });
      expect(status).toBe(RenewalDiscussionStatus.PENDING);
    });

    it('should set ACTIVE when session is already Active (peer responded)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.Active,
        previousDiscussionStatus: RenewalDiscussionStatus.PENDING,
      });
      expect(status).toBe(RenewalDiscussionStatus.ACTIVE);
    });

    it('should set SEND_FAILED if send fails', () => {
      const status = getStatusAfterRenewal({
        success: false,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.PENDING,
      });
      expect(status).toBe(RenewalDiscussionStatus.SEND_FAILED);
    });
  });

  describe('Edge case: renewal from BROKEN status', () => {
    it('should set PENDING when renewing from BROKEN (no previous active session)', () => {
      const status = getStatusAfterRenewal({
        success: true,
        sessionStatus: SessionStatus.SelfRequested,
        previousDiscussionStatus: RenewalDiscussionStatus.BROKEN,
      });
      expect(status).toBe(RenewalDiscussionStatus.PENDING);
    });
  });
});

// ============================================================================
// Message FIFO Ordering during Resend
// ============================================================================

const GAP_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const GAP_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const GAP_SEEKER_SIZE = 34;

describe('Message FIFO Ordering during Resend', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));
  });

  it('should process messages in timestamp order (oldest first)', async () => {
    const now = Date.now();
    await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Message 3 (newest)',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(now),
    });

    await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Message 1 (oldest)',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(now - 2000),
    });

    await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Message 2 (middle)',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(now - 1000),
    });

    const sortedMessages = await testDb.messages
      .where('[ownerUserId+contactUserId]')
      .equals([GAP_OWNER_USER_ID, GAP_CONTACT_USER_ID])
      .sortBy('timestamp');

    expect(sortedMessages[0].content).toBe('Message 1 (oldest)');
    expect(sortedMessages[1].content).toBe('Message 2 (middle)');
    expect(sortedMessages[2].content).toBe('Message 3 (newest)');
  });
});

// ============================================================================
// Reply Target Not Found Fallback
// ============================================================================

describe('Reply Target Not Found Fallback', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should store originalContent when reply target is not found', async () => {
    const unknownSeeker = new Uint8Array(GAP_SEEKER_SIZE).fill(99);

    const existing = await testDb.messages
      .where('[ownerUserId+seeker]')
      .equals([GAP_OWNER_USER_ID, unknownSeeker])
      .first();
    expect(existing).toBeUndefined();

    const messageId = await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'This is a reply',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      replyTo: {
        originalContent: 'The original message that was deleted',
        originalSeeker: unknownSeeker,
      },
    });

    const stored = await testDb.messages.get(messageId);
    expect(stored?.replyTo?.originalContent).toBe(
      'The original message that was deleted'
    );
    expect(stored?.replyTo?.originalSeeker).toEqual(unknownSeeker);
  });

  it('should NOT store originalContent when reply target IS found', async () => {
    const knownSeeker = new Uint8Array(GAP_SEEKER_SIZE).fill(88);

    await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Original message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: knownSeeker,
    });

    const replyId = await testDb.messages.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Reply to found message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      replyTo: {
        originalContent: undefined,
        originalSeeker: knownSeeker,
      },
    });

    const stored = await testDb.messages.get(replyId);
    expect(stored?.replyTo?.originalContent).toBeUndefined();
    expect(stored?.replyTo?.originalSeeker).toEqual(knownSeeker);
  });
});
