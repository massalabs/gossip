/**
 * MessageService unit tests
 *
 * Tests message lookup helpers, send-queue behavior under various session
 * states, contact/discussion validation, and encryption error handling.
 *
 * Integration flows (send/receive with real WASM) are covered in:
 * - test/integration/messaging-flow.spec.ts
 * - test/integration/discussion-flow.spec.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageService } from '../../src/services/message';
import {
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionDirection,
} from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { encodeToBase64 } from '../../src/utils/base64';
import { SessionStatus } from '../../src/wasm/bindings';
import { defaultSdkConfig } from '../../src/config/sdk';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { clearAllTables, getTestQueries } from '../testDb';
import { MockMessageProtocol } from '../mocks';
import { Queries } from '../../src/db/queries';

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
  } as unknown as SessionModule;
}

function createTestMessage(
  overrides: Partial<{
    ownerUserId: string;
    contactUserId: string;
    content: string;
    type: MessageType;
  }> = {}
) {
  return {
    ownerUserId: overrides.ownerUserId ?? OWNER_USER_ID,
    contactUserId: overrides.contactUserId ?? CONTACT_USER_ID,
    content: overrides.content ?? 'Test message',
    type: overrides.type ?? MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENDING,
    timestamp: new Date(),
  };
}

async function insertTestContactAndDiscussion(
  ownerUserId: string = OWNER_USER_ID,
  contactUserId: string = CONTACT_USER_ID
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
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('MessageService', () => {
  beforeEach(clearAllTables);

  it('getMessages returns all rows while getVisibleMessages filters to user-visible subset', async () => {
    const testQueries = getTestQueries();

    // Insert a mix of messages for the same owner/contact
    const visibleId1 = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'First visible',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-02T00:00:00Z'),
    });

    // KEEP_ALIVE should be filtered out
    const keepAliveId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-03T00:00:00Z'),
    });

    // Outgoing delete control with empty content should be filtered out
    const deleteControlId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '',
      type: MessageType.DELETED,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-04T00:00:00Z'),
    });

    // Outgoing deleted message with non-empty content should remain visible
    const visibleDeletedId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '[Message deleted]',
      type: MessageType.DELETED,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-05T00:00:00Z'),
    });

    const visibleId2 = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Second visible',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:00:00Z'), // Earlier timestamp than first visible
    });

    // Reaction row should be hidden from visible messages
    const reactionId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-06T00:00:00Z'),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    // Deleted reaction row should also be hidden from visible messages
    const deletedReactionId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '[Message deleted]',
      type: MessageType.DELETED,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-07T00:00:00Z'),
      // Deleted reactions are stored as DELETED rows that still carry reactionOf,
      // so the UI query can exclude them from chat bubbles.
      reactionOf: JSON.stringify({
        originalMsgId: Buffer.from(new Uint8Array(12).fill(99)).toString(
          'base64'
        ),
      }),
    });

    // Raw messages should include all 7 rows, ordered by timestamp then id
    const allMessages = await service.getMessages(CONTACT_USER_ID);
    const allIds = allMessages.map(m => m.id);
    expect(allIds).toEqual([
      visibleId2, // 2024-01-01
      visibleId1, // 2024-01-02
      keepAliveId, // 2024-01-03
      deleteControlId, // 2024-01-04
      visibleDeletedId, // 2024-01-05
      reactionId, // 2024-01-06
      deletedReactionId, // 2024-01-07
    ]);

    // Visible messages should filter out KEEP_ALIVE, delete control rows, reactions,
    // and deleted reaction rows
    const visibleMessages = await service.getVisibleMessages(CONTACT_USER_ID);
    const visibleIds = visibleMessages.map(m => m.id);

    // Only the three visible messages should be returned
    expect(visibleIds).toEqual([visibleId1, visibleDeletedId, visibleId2]);

    // Sanity-check types and contents
    expect(visibleMessages.map(m => m.type)).toEqual([
      MessageType.TEXT,
      MessageType.DELETED,
      MessageType.TEXT,
    ]);
    expect(visibleMessages.map(m => m.content)).toEqual([
      'First visible',
      '[Message deleted]',
      'Second visible',
    ]);
  });

  it('editMessage updates outgoing message content and marks as edited', async () => {
    const testQueries = getTestQueries();

    await insertTestContactAndDiscussion();

    // Insert an outgoing text message with a messageId
    const msgIdBytes = new Uint8Array(12).fill(7);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Original content',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      messageId: msgIdBytes,
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const result = await service.editMessage(msgId, 'Edited content');
    expect(result).toBe(true);

    const updated = await testQueries.messages.getById(msgId);
    expect(updated?.content).toBe('Edited content');
    expect(updated?.timestamp?.getTime()).toBe(
      new Date('2024-01-01T00:00:00Z').getTime()
    );

    const parsedMetadata = updated?.metadata
      ? JSON.parse(updated.metadata)
      : {};
    expect(parsedMetadata.edited).toBe(true);

    // Control row must persist editOf so send queue serializes MESSAGE_TYPE_EDIT
    const all = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlRow = all.find(
      r => r.metadata && r.metadata.includes('"control":"edit"')
    );
    expect(controlRow).toBeDefined();
    expect(controlRow!.editOf).toBeTruthy();
    const editOfParsed = JSON.parse(controlRow!.editOf!);
    expect(editOfParsed.originalMsgId).toBeDefined();
    expect(Buffer.from(new Uint8Array(12).fill(7))).toEqual(
      Buffer.from(
        Uint8Array.from(Buffer.from(editOfParsed.originalMsgId, 'base64'))
      )
    );
  });

  it('editMessage returns false for incoming messages and does not modify the row', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(9);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'From peer',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-06-01T12:00:00Z'),
      messageId: msgIdBytes,
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    expect(await service.editMessage(msgId, 'Hacked')).toBe(false);

    const row = await testQueries.messages.getById(msgId);
    expect(row?.content).toBe('From peer');
    expect(row?.direction).toBe(MessageDirection.INCOMING);
    expect(row?.metadata).toBeFalsy();
    const rows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(
      rows.filter(r => r.metadata?.includes?.('"control":"edit"'))
    ).toHaveLength(0);
  });

  it('deleteMessage marks an incoming message as deleted and enqueues a control message', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(8);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'From peer',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-06-01T12:00:00Z'),
      messageId: msgIdBytes,
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    expect(await service.deleteMessage(msgId)).toBe(true);

    const row = await testQueries.messages.getById(msgId);
    expect(row?.content).toBe('[Message deleted]');
    expect(row?.type).toBe(MessageType.DELETED);
    const rows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    // A delete control message should have been enqueued
    expect(
      rows.filter(r => r.type === MessageType.DELETED && r.content === '')
    ).toHaveLength(1);
  });

  it('deleteMessage on a reaction only deletes the reaction row and keeps original message visible', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    // Original text message that will be reacted to
    const originalMsgIdBytes = new Uint8Array(12).fill(11);
    const originalRowId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Original message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-07-01T10:00:00Z'),
      messageId: originalMsgIdBytes,
    });

    // Outgoing reaction row
    const reactionMsgIdBytes = new Uint8Array(12).fill(12);
    const reactionRowId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-07-01T10:01:00Z'),
      messageId: reactionMsgIdBytes,
      reactionOf: JSON.stringify({
        originalMsgId: Buffer.from(originalMsgIdBytes).toString('base64'),
      }),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    // Simulate tapping on own reaction chip → delete the reaction message
    const deleted = await service.deleteMessage(reactionRowId);
    expect(deleted).toBe(true);

    const allRows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const originalRow = allRows.find(r => r.id === originalRowId);
    const reactionRow = allRows.find(r => r.id === reactionRowId);

    // Original message content/type must be unchanged
    expect(originalRow?.content).toBe('Original message');
    expect(originalRow?.type).toBe(MessageType.TEXT);

    // Reaction row should now be marked DELETED with "[Message deleted]"
    expect(reactionRow?.type).toBe(MessageType.DELETED);
    expect(reactionRow?.content).toBe('[Message deleted]');

    // getVisibleMessages must not surface the deleted reaction as a bubble
    const visible = await service.getVisibleMessages(CONTACT_USER_ID);
    const visibleIds = visible.map(m => m.id);
    expect(visibleIds).toEqual([originalRowId]);
    expect(visible[0].content).toBe('Original message');
  });

  it('sendReaction inserts reaction rows without updating discussion last message, even with multiple reactions', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    // Insert a base text message with a messageId to react to
    const originalMessageIdBytes = new Uint8Array(12).fill(5);
    const baseMsgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Base message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-07-01T12:00:00Z'),
      messageId: originalMessageIdBytes,
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const discussionBefore = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    const result = await service.sendReaction(
      CONTACT_USER_ID,
      '😀',
      originalMessageIdBytes
    );
    expect(result.success).toBe(true);

    // Send a second reaction that "overrides" the first one at the UI level
    const result2 = await service.sendReaction(
      CONTACT_USER_ID,
      '😂',
      originalMessageIdBytes
    );
    expect(result2.success).toBe(true);

    const allRows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const baseRow = allRows.find(r => r.id === baseMsgId);
    const reactionRows = allRows.filter(r => r.type === MessageType.REACTION);
    expect(baseRow).toBeDefined();
    expect(reactionRows).toHaveLength(2);
    expect(reactionRows.map(r => r.content).sort()).toEqual(['😀', '😂']);
    reactionRows.forEach(r => {
      expect(r.direction).toBe(MessageDirection.OUTGOING);
      // Active session triggers the fast path: reactions go directly to SENT
      expect(r.status).toBe(MessageStatus.SENT);
      expect(r.reactionOf).toBeTruthy();
      const parsed = JSON.parse(r.reactionOf!);
      expect(parsed.originalMsgId).toBeDefined();
    });

    const discussionAfter = await testQueries.discussions.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    // lastMessage* should still reference the base message, not the reaction
    expect(discussionAfter?.lastMessageId).toBe(
      discussionBefore?.lastMessageId
    );
    expect(discussionAfter?.lastMessageContent).toBe(
      discussionBefore?.lastMessageContent
    );
  });

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await getTestQueries().messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker,
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('getReactions returns only reaction rows for a contact', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    // Non-reaction row
    await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    // Reaction rows
    const reaction1Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-08-01T00:00:00Z'),
    });

    const reaction2Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-08-01T00:01:00Z'),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const reactions = await service.getReactions(CONTACT_USER_ID);
    const ids = reactions.map(r => r.id);
    expect(ids).toEqual([reaction1Id, reaction2Id]);
    expect(reactions.every(r => r.type === MessageType.REACTION)).toBe(true);
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeUndefined();
  });

  describe('sendMessage', () => {
    let testQueries: Queries;
    let messageService: MessageService;

    beforeEach(async () => {
      testQueries = getTestQueries();
      messageService = new MessageService(
        new MockMessageProtocol(),
        createMockSession(),
        new SdkEventEmitter(),
        defaultSdkConfig,
        testQueries
      );
    });

    it.each([
      SessionStatus.NoSession,
      SessionStatus.UnknownPeer,
      SessionStatus.Killed,
      SessionStatus.PeerRequested,
      SessionStatus.SelfRequested,
    ])(
      'should queue message as WAITING_SESSION when session is %s',
      async status => {
        await testQueries.discussions.insert({
          ownerUserId: OWNER_USER_ID,
          contactUserId: CONTACT_USER_ID,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        messageService = new MessageService(
          new MockMessageProtocol(),
          createMockSession(status),
          new SdkEventEmitter(),
          defaultSdkConfig,
          testQueries
        );

        const result = await messageService.sendMessage(createTestMessage());

        expect(result.success).toBe(true);
        expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);

        const dbMessage = await testQueries.messages.getById(
          result.message!.id!
        );
        const discussion = await testQueries.discussions.getByOwnerAndContact(
          OWNER_USER_ID,
          CONTACT_USER_ID
        );

        expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
        expect(discussion?.unreadCount).toBe(0);
        expect(discussion?.lastMessageTimestamp).toBeDefined();
        expect(discussion?.lastMessageContent).toBe(dbMessage?.content);
        expect(discussion?.lastMessageId).toBe(dbMessage?.id);
      }
    );

    it('discussion should not be updated when sending keep-alive message', async () => {
      await insertTestContactAndDiscussion();
      const result = await messageService.sendMessage(
        createTestMessage({ type: MessageType.KEEP_ALIVE })
      );
      expect(result.success).toBe(true);
      const discussion = await testQueries.discussions.getByOwnerAndContact(
        OWNER_USER_ID,
        CONTACT_USER_ID
      );
      expect(discussion?.unreadCount).toBe(0);
      expect(discussion?.lastMessageTimestamp).toBeNull();
      expect(discussion?.lastMessageContent).toBeNull();
      expect(discussion?.lastMessageId).toBeNull();
    });

    it('should fail when no contact or discussion exists', async () => {
      const result = await messageService.sendMessage(createTestMessage());

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should fail when discussion not found', async () => {
      await getTestQueries().contacts.insert({
        ownerUserId: OWNER_USER_ID,
        userId: CONTACT_USER_ID,
        name: 'Test Contact',
        publicKeys: new Uint8Array(32),
        isOnline: true,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      const result = await messageService.sendMessage(createTestMessage());

      expect(result.success).toBe(false);
      expect(result.error).toContain('Discussion not found');
    });
  });
});

describe('processSendQueueForContact: Encryption Error', () => {
  let mockSession: SessionModule;
  let messageService: MessageService;

  beforeEach(async () => {
    await clearAllTables();
    mockSession = createMockSession();
    await insertTestContactAndDiscussion();
  });

  it('should fall back to slow path when encryption fails', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption failed: invalid session state');
      }
    );

    messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );

    // Fast path catches the encrypt error and bails gracefully —
    // the message is inserted via the slow path as WAITING_SESSION.
    const result = await messageService.sendMessage(createTestMessage());
    expect(result.success).toBe(true);
    expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should leave message as WAITING_SESSION when encryption fails', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption error');
      }
    );

    messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );

    // Fast path catches the encrypt error and bails — slow path inserts
    // the message as WAITING_SESSION for retry on the next stateUpdate.
    const result = await messageService.sendMessage(createTestMessage());
    expect(result.success).toBe(true);

    const messages = await getTestQueries().messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    expect(messages.length).toBe(1);
    expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
  });
});

describe('deleteReactionsForMessage query', () => {
  beforeEach(clearAllTables);

  it('removes only reactions referencing the deleted message', async () => {
    const testQueries = getTestQueries();

    const originalMsgIdBytes = new Uint8Array(12).fill(42);
    const originalMsgIdBase64 = encodeToBase64(originalMsgIdBytes);

    const unrelatedMsgIdBytes = new Uint8Array(12).fill(99);
    const unrelatedMsgIdBase64 = encodeToBase64(unrelatedMsgIdBytes);

    // Insert the original message
    const originalMsgRowId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Original message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      messageId: originalMsgIdBytes,
    });

    // Insert reactions referencing the original message
    const reaction1Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:01:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    const reaction2Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:02:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    // Insert an unrelated reaction referencing a different message
    const unrelatedReactionId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '😂',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:03:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: unrelatedMsgIdBase64 }),
    });

    // Delete reactions for the original message
    await testQueries.messages.deleteReactionsForMessage(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      originalMsgIdBase64
    );

    const allRows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    // Original message should still exist
    expect(allRows.find(r => r.id === originalMsgRowId)).toBeDefined();
    expect(allRows.find(r => r.id === originalMsgRowId)?.content).toBe(
      'Original message'
    );

    // Reactions referencing the original message should be deleted
    expect(allRows.find(r => r.id === reaction1Id)).toBeUndefined();
    expect(allRows.find(r => r.id === reaction2Id)).toBeUndefined();

    // Unrelated reaction should still exist
    expect(allRows.find(r => r.id === unrelatedReactionId)).toBeDefined();
    expect(allRows.find(r => r.id === unrelatedReactionId)?.content).toBe('😂');
  });
});

describe('deleteMessage also removes associated reactions', () => {
  beforeEach(clearAllTables);

  it('deleteMessage deletes reactions for the message from the DB', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const originalMsgIdBytes = new Uint8Array(12).fill(50);
    const originalMsgIdBase64 = encodeToBase64(originalMsgIdBytes);

    // Insert the outgoing message that will be deleted
    const msgDbId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Message to delete',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      messageId: originalMsgIdBytes,
    });

    // Insert reactions referencing this message
    const reaction1Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:01:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    const reaction2Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:02:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    // Insert an unrelated message with its own reaction
    const unrelatedMsgIdBytes = new Uint8Array(12).fill(60);
    const unrelatedMsgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Unrelated message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:03:00Z'),
      messageId: unrelatedMsgIdBytes,
    });

    const unrelatedReactionId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '😂',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:04:00Z'),
      reactionOf: JSON.stringify({
        originalMsgId: encodeToBase64(unrelatedMsgIdBytes),
      }),
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig,
      testQueries
    );

    const result = await service.deleteMessage(msgDbId);
    expect(result).toBe(true);

    const allRows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    // The deleted message should be marked as DELETED
    const deletedMsg = allRows.find(r => r.id === msgDbId);
    expect(deletedMsg?.type).toBe(MessageType.DELETED);
    expect(deletedMsg?.content).toBe('[Message deleted]');

    // Reactions for the deleted message should be removed
    expect(allRows.find(r => r.id === reaction1Id)).toBeUndefined();
    expect(allRows.find(r => r.id === reaction2Id)).toBeUndefined();

    // Unrelated message and its reaction should remain
    expect(allRows.find(r => r.id === unrelatedMsgId)).toBeDefined();
    expect(allRows.find(r => r.id === unrelatedReactionId)).toBeDefined();
    expect(allRows.find(r => r.id === unrelatedReactionId)?.content).toBe('😂');
  });
});

describe('incoming delete path also removes reactions', () => {
  beforeEach(clearAllTables);

  it('deleteReactionsForMessage is called correctly for incoming deletes', async () => {
    const testQueries = getTestQueries();

    const originalMsgIdBytes = new Uint8Array(12).fill(70);
    const originalMsgIdBase64 = encodeToBase64(originalMsgIdBytes);

    // Insert the original incoming message (sent by contact, received by owner)
    const msgRowId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Incoming message to delete',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:00:00Z'),
      messageId: originalMsgIdBytes,
    });

    // Insert reactions referencing this message
    const reaction1Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T00:01:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    const reaction2Id = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T00:02:00Z'),
      reactionOf: JSON.stringify({ originalMsgId: originalMsgIdBase64 }),
    });

    // Simulate what the incoming delete path does:
    // 1. Mark the message as deleted
    await testQueries.messages.updateById(msgRowId, {
      content: '[Message deleted]',
      type: MessageType.DELETED,
    });

    // 2. Delete reactions for that message (this is the new behavior)
    await testQueries.messages.deleteReactionsForMessage(
      OWNER_USER_ID,
      CONTACT_USER_ID,
      originalMsgIdBase64
    );

    const allRows = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    // The original message should be marked as deleted
    const deletedMsg = allRows.find(r => r.id === msgRowId);
    expect(deletedMsg?.type).toBe(MessageType.DELETED);
    expect(deletedMsg?.content).toBe('[Message deleted]');

    // All reactions for that message should be deleted
    expect(allRows.find(r => r.id === reaction1Id)).toBeUndefined();
    expect(allRows.find(r => r.id === reaction2Id)).toBeUndefined();
  });
});

describe('processSendQueueForContact: Session Not Active', () => {
  it('should send error if SelfRequested session and keep message queued', async () => {
    await clearAllTables();
    const mockSession = createMockSession(SessionStatus.SelfRequested);
    await insertTestContactAndDiscussion();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );

    const sendResult = await messageService.sendMessage(createTestMessage());
    expect(sendResult.success).toBe(true);

    const processResult =
      await messageService.processSendQueueForContact(CONTACT_USER_ID);

    expect(processResult.success).toBe(false);

    expect(mockSession.sendMessage).not.toHaveBeenCalled();

    const messages = await getTestQueries().messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should skip processing if Saturated session and keep message queued', async () => {
    await clearAllTables();
    const mockSession = createMockSession(SessionStatus.Saturated);
    await insertTestContactAndDiscussion();

    const messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig,
      getTestQueries()
    );

    const sendResult = await messageService.sendMessage(createTestMessage());
    expect(sendResult.success).toBe(true);

    const processResult =
      await messageService.processSendQueueForContact(CONTACT_USER_ID);
    expect(processResult.success).toBe(true);

    expect(mockSession.sendMessage).not.toHaveBeenCalled();

    const messages = await getTestQueries().messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
  });
});
