/**
 * MessageService optimistic event tests (TDD — RED phase)
 *
 * Tests that deleteMessage/editMessage emit semantic optimistic events,
 * and that processSendQueueForContact skips MESSAGE_SENT for control messages.
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
import { SessionStatus } from '../../src/wasm/bindings';
import { defaultSdkConfig } from '../../src/config/sdk';
import { SdkEventEmitter, SdkEventType } from '../../src/core/SdkEventEmitter';
import { clearAllTables, getTestQueries } from '../testDb';
import { MockMessageProtocol } from '../mocks';

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

async function insertTestContactAndDiscussion() {
  await getTestQueries().contacts.insert({
    ownerUserId: OWNER_USER_ID,
    userId: CONTACT_USER_ID,
    name: 'Test Contact',
    publicKeys: new Uint8Array(32),
    isOnline: true,
    lastSeen: new Date(),
    createdAt: new Date(),
  });

  await getTestQueries().discussions.insert({
    ownerUserId: OWNER_USER_ID,
    contactUserId: CONTACT_USER_ID,
    direction: DiscussionDirection.INITIATED,
    weAccepted: true,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('MessageService optimistic events', () => {
  beforeEach(clearAllTables);

  // -------------------------------------------------------------------------
  // deleteMessage
  // -------------------------------------------------------------------------

  it('deleteMessage emits MESSAGE_DELETED_OPTIMISTIC before DB write', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'To be deleted',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(5),
    });

    const eventEmitter = new SdkEventEmitter();
    const emitted: unknown[] = [];
    eventEmitter.on(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, payload => {
      emitted.push(payload);
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    const result = await service.deleteMessage(msgId);
    expect(result).toBe(true);

    // Event was emitted
    expect(emitted).toHaveLength(1);
    const event = emitted[0] as {
      contactUserId: string;
      messageDbId: number;
      originalMsgId: Uint8Array;
    };
    expect(event.contactUserId).toBe(CONTACT_USER_ID);
    expect(event.messageDbId).toBe(msgId);

    // DB was updated
    const row = await testQueries.messages.getById(msgId);
    expect(row?.type).toBe(MessageType.DELETED);
    expect(row?.content).toBe('[Message deleted]');
  });

  it('deleteMessage emits MESSAGE_DELETE_FAILED on DB error', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Will fail',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(6),
    });

    const eventEmitter = new SdkEventEmitter();
    const optimisticEvents: unknown[] = [];
    const failedEvents: unknown[] = [];

    eventEmitter.on(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, payload => {
      optimisticEvents.push(payload);
    });
    eventEmitter.on(SdkEventType.MESSAGE_DELETE_FAILED, payload => {
      failedEvents.push(payload);
    });

    // Create service with a spy on updateById to force an error
    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    // Sabotage the DB update to simulate failure
    const originalUpdateById = testQueries.messages.updateById.bind(
      testQueries.messages
    );
    let callCount = 0;
    vi.spyOn(testQueries.messages, 'updateById').mockImplementation(
      async (...args) => {
        callCount++;
        if (callCount === 1) throw new Error('DB write failed');
        return originalUpdateById(...args);
      }
    );

    await expect(service.deleteMessage(msgId)).rejects.toThrow();

    // Optimistic event was emitted
    expect(optimisticEvents).toHaveLength(1);

    // Failure event was emitted with original message
    expect(failedEvents).toHaveLength(1);
    const failEvent = failedEvents[0] as {
      contactUserId: string;
      messageDbId: number;
      original: { content: string; type: string };
    };
    expect(failEvent.original.content).toBe('Will fail');
    expect(failEvent.original.type).toBe(MessageType.TEXT);
  });

  it('deleteMessage does NOT emit MESSAGE_DELETED_OPTIMISTIC for REACTION rows', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(8),
    });

    const eventEmitter = new SdkEventEmitter();
    const emitted: unknown[] = [];
    eventEmitter.on(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, payload => {
      emitted.push(payload);
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    await service.deleteMessage(msgId);

    // No optimistic event for reactions
    expect(emitted).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // editMessage
  // -------------------------------------------------------------------------

  it('editMessage emits MESSAGE_EDITED_OPTIMISTIC before DB write', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Original',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(10),
    });

    const eventEmitter = new SdkEventEmitter();
    const emitted: unknown[] = [];
    eventEmitter.on(SdkEventType.MESSAGE_EDITED_OPTIMISTIC, payload => {
      emitted.push(payload);
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    const result = await service.editMessage(msgId, 'Edited');
    expect(result).toBe(true);

    // Event was emitted
    expect(emitted).toHaveLength(1);
    const event = emitted[0] as {
      contactUserId: string;
      messageDbId: number;
      newContent: string;
      metadata: Record<string, unknown>;
    };
    expect(event.contactUserId).toBe(CONTACT_USER_ID);
    expect(event.messageDbId).toBe(msgId);
    expect(event.newContent).toBe('Edited');
    expect(event.metadata.edited).toBe(true);

    // DB was updated
    const row = await testQueries.messages.getById(msgId);
    expect(row?.content).toBe('Edited');
  });

  // -------------------------------------------------------------------------
  // processSendQueueForContact: skip MESSAGE_SENT for control messages
  // -------------------------------------------------------------------------

  it('processSendQueueForContact does NOT emit MESSAGE_SENT for control messages', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    // Insert a delete control message in the send queue (READY state with encrypted data)
    await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '',
      type: MessageType.DELETED,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(20),
      deleteOf: JSON.stringify({
        originalMsgId: Buffer.from(new Uint8Array(12).fill(1)).toString(
          'base64'
        ),
      }),
      encryptedMessage: new Uint8Array([1, 2, 3, 4]),
      seeker: new Uint8Array(SEEKER_SIZE).fill(1),
      whenToSend: new Date(Date.now() - 1000), // ready to send
    });

    // Also insert a regular message in READY state
    await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Regular message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
      messageId: new Uint8Array(12).fill(21),
      encryptedMessage: new Uint8Array([5, 6, 7, 8]),
      seeker: new Uint8Array(SEEKER_SIZE).fill(2),
      whenToSend: new Date(Date.now() - 1000),
    });

    const eventEmitter = new SdkEventEmitter();
    const sentEvents: unknown[] = [];
    eventEmitter.on(SdkEventType.MESSAGE_SENT, payload => {
      sentEvents.push(payload);
    });

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    await service.processSendQueueForContact(CONTACT_USER_ID);

    // Only the regular message should emit MESSAGE_SENT, not the control message
    expect(sentEvents).toHaveLength(1);
    const sentEvent = sentEvents[0] as { content: string; type: string };
    expect(sentEvent.content).toBe('Regular message');
    expect(sentEvent.type).toBe(MessageType.TEXT);
  });
});
