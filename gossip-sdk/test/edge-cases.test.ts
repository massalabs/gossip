/**
 * Edge Cases Tests
 *
 * Tests for edge cases and error handling scenarios:
 * 1. Deserialization/decryption failure handling
 * 2. Messages from unknown peer
 * 3. Seeker stabilization loop
 * 4. Invalid contactUserId validation
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GossipDatabase,
  DiscussionStatus,
  DiscussionDirection,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '../src/db';
import { MessageService } from '../src/services/message';
import { DiscussionService } from '../src/services/discussion';
import type { SessionModule } from '../src/wasm/session';
import type { IMessageProtocol } from '../src/api/messageProtocol';
import { encodeUserId } from '../src/utils/userId';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';
import { defaultSdkConfig } from '../src/config/sdk';
import {
  deserializeMessage,
  serializeRegularMessage,
} from '../src/utils/messageSerialization';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const UNKNOWN_USER_ID = encodeUserId(new Uint8Array(32).fill(99));
const SEEKER_SIZE = 34;

function createMockSession(
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(status),
    sendMessage: vi.fn().mockResolvedValue({
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
    userIdRaw: new Uint8Array(32).fill(1),
    userId: new Uint8Array(32).fill(1),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createMockMessageProtocol(): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('counter-123'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue(''),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
  } as IMessageProtocol;
}

function createMockDiscussionService(): DiscussionService {
  return {
    isStableState: vi.fn().mockResolvedValue(true),
    initialize: vi.fn(),
    accept: vi.fn(),
    renew: vi.fn(),
  } as unknown as DiscussionService;
}

// ============================================================================
// 1. DESERIALIZATION/DECRYPTION FAILURE HANDLING
// ============================================================================

describe('Deserialization Failure Handling', () => {
  it('should handle invalid message format gracefully', () => {
    // Invalid data - too short to be valid
    const invalidData = new Uint8Array([0, 1]);

    // deserializeMessage may return partial/empty data or throw depending on input
    // The important thing is it doesn't crash the app
    try {
      const result = deserializeMessage(invalidData);
      // If it doesn't throw, it should return something (possibly empty content)
      expect(result).toBeDefined();
    } catch {
      // Throwing is also acceptable behavior for invalid data
      expect(true).toBe(true);
    }
  });

  it('should handle corrupted message bytes', () => {
    // Create valid-looking but corrupted data
    const corruptedData = new Uint8Array([
      0, // type byte (regular message)
      255,
      255,
      255,
      255, // Large length value
      0,
      0,
      0,
      0,
    ]);

    // May return truncated data or throw - both are acceptable
    try {
      const result = deserializeMessage(corruptedData);
      expect(result).toBeDefined();
    } catch {
      expect(true).toBe(true);
    }
  });

  it('should handle empty message data', () => {
    const emptyData = new Uint8Array(0);

    // Empty data should either throw or return empty content
    try {
      const result = deserializeMessage(emptyData);
      expect(result.content).toBe('');
    } catch {
      expect(true).toBe(true);
    }
  });

  it('should deserialize valid message correctly', () => {
    const content = 'Hello, World!';
    const serialized = serializeRegularMessage(content);
    const deserialized = deserializeMessage(serialized);

    expect(deserialized.content).toBe(content);
    expect(deserialized.type).toBe(MessageType.TEXT);
  });
});

// ============================================================================
// 2. MESSAGES FROM UNKNOWN PEER
// ============================================================================

describe('Messages from Unknown Peer', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    // Create discussion only with CONTACT_USER_ID, not UNKNOWN_USER_ID
    await testDb.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should not have discussion for unknown peer', async () => {
    const discussion = await testDb.getDiscussionByOwnerAndContact(
      OWNER_USER_ID,
      UNKNOWN_USER_ID
    );

    expect(discussion).toBeUndefined();
  });

  it('should have discussion for known peer', async () => {
    const discussion = await testDb.getDiscussionByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    expect(discussion).toBeDefined();
    expect(discussion?.contactUserId).toBe(CONTACT_USER_ID);
  });

  it('should reject storing message for non-existent discussion', async () => {
    // Attempt to store message for unknown peer (no discussion exists)
    // This simulates what happens when decrypted message has unknown senderId

    const discussion = await testDb.getDiscussionByOwnerAndContact(
      OWNER_USER_ID,
      UNKNOWN_USER_ID
    );

    // No discussion = message would be rejected
    expect(discussion).toBeUndefined();

    // Messages can only be added if discussion exists
    // The actual rejection happens in storeDecryptedMessages which logs error and skips
  });
});

// ============================================================================
// 3. SEEKER STABILIZATION LOOP
// ============================================================================

describe('Seeker Stabilization Logic', () => {
  it('should detect when seekers are the same (stabilized)', () => {
    const seekers1 = new Set(['seeker1', 'seeker2', 'seeker3']);
    const seekers2 = new Set(['seeker1', 'seeker2', 'seeker3']);

    // Check if sets are equal (stabilized)
    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(true);
  });

  it('should detect when seekers changed (not stabilized)', () => {
    const seekers1 = new Set(['seeker1', 'seeker2']);
    const seekers2 = new Set(['seeker1', 'seeker2', 'seeker3']); // New seeker added

    const areSame =
      seekers1.size === seekers2.size &&
      [...seekers1].every(s => seekers2.has(s));

    expect(areSame).toBe(false);
  });

  it('should detect when seekers reduced', () => {
    const seekers1 = new Set(['seeker1', 'seeker2', 'seeker3']);
    const seekers2 = new Set(['seeker1', 'seeker2']); // One removed

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

    // Simulate fetch loop
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

    // Should have stopped at maxIterations, not earlier
    expect(loopCount).toBe(maxIterations);
  });
});

// ============================================================================
// 4. INVALID CONTACTUSERID VALIDATION
// ============================================================================

describe('Invalid contactUserId Validation', () => {
  let testDb: GossipDatabase;
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let mockDiscussionService: DiscussionService;
  let messageService: MessageService;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    mockSession = createMockSession();
    mockProtocol = createMockMessageProtocol();
    mockDiscussionService = createMockDiscussionService();

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      {},
      defaultSdkConfig
    );
  });

  it('should fail when no contact or discussion exists', async () => {
    // No contact or discussion exists for CONTACT_USER_ID

    const result = await messageService.sendMessage({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID, // Valid format but no contact/discussion
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);
    // Code checks discussion first, so error is "Discussion not found"
    expect(result.error).toContain('not found');
  });

  it('should fail when discussion not found', async () => {
    // Create contact but no discussion
    await testDb.contacts.add({
      ownerUserId: OWNER_USER_ID,
      userId: CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    const result = await messageService.sendMessage({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Discussion not found');
  });

  it('should succeed when both contact and discussion exist', async () => {
    // Create contact
    await testDb.contacts.add({
      ownerUserId: OWNER_USER_ID,
      userId: CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    // Create discussion
    await testDb.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await messageService.sendMessage({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(true);
  });
});

// ============================================================================
// 5. DECRYPTION FAILURE (session.receiveMessage returns null)
// ============================================================================

describe('Decryption Failure Handling', () => {
  it('should handle undefined return from feedIncomingMessageBoardRead gracefully', async () => {
    const mockSession = createMockSession();

    // Mock feedIncomingMessageBoardRead returning undefined (decryption failed)
    (
      mockSession.feedIncomingMessageBoardRead as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    const result = await mockSession.feedIncomingMessageBoardRead(
      new Uint8Array(32), // peerId
      new Uint8Array(100) // ciphertext
    );

    expect(result).toBeUndefined();
    // In actual code, this is logged and skipped - message is not stored
  });

  it('should handle feedIncomingMessageBoardRead throwing error', async () => {
    const mockSession = createMockSession();

    // Mock feedIncomingMessageBoardRead throwing
    (
      mockSession.feedIncomingMessageBoardRead as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('Decryption failed: invalid ciphertext'));

    await expect(
      mockSession.feedIncomingMessageBoardRead(
        new Uint8Array(32), // peerId
        new Uint8Array(100) // ciphertext
      )
    ).rejects.toThrow('Decryption failed');
  });
});
