/**
 * MessageService delete/edit + control-message tests
 *
 * Tests that deleteMessage/editMessage update the DB and enqueue control
 * messages, and that processSendQueueForContact skips MESSAGE_SENT for
 * control messages.
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

describe('MessageService delete/edit and control messages', () => {
  beforeEach(clearAllTables);

  // -------------------------------------------------------------------------
  // deleteMessage
  // -------------------------------------------------------------------------

  it('deleteMessage updates the DB row to DELETED type and sends a control message', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(5);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'To be deleted',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: msgIdBytes,
    });

    const eventEmitter = new SdkEventEmitter();
    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    const result = await service.deleteMessage(msgId);
    expect(result).toBe(true);

    // DB row was updated to DELETED
    const row = await testQueries.messages.getById(msgId);
    expect(row?.type).toBe(MessageType.DELETED);
    expect(row?.content).toBe('[Message deleted]');

    // A control message was enqueued in the DB
    const allMessages = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = allMessages.find(
      m => m.id !== msgId && m.type === MessageType.DELETED
    );
    expect(controlMsg).toBeDefined();
    expect(controlMsg?.direction).toBe(MessageDirection.OUTGOING);
  });

  it('deleteMessage throws on DB error without emitting events', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(6);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Will fail',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: msgIdBytes,
    });

    const eventEmitter = new SdkEventEmitter();

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    // Sabotage the DB update to simulate failure
    vi.spyOn(testQueries.messages, 'updateById').mockRejectedValueOnce(
      new Error('DB write failed')
    );

    await expect(service.deleteMessage(msgId)).rejects.toThrow(
      'DB write failed'
    );
  });

  it('deleteMessage on a REACTION row still works', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(8);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: '\u{1F44D}',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: msgIdBytes,
    });

    const eventEmitter = new SdkEventEmitter();
    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    const result = await service.deleteMessage(msgId);
    expect(result).toBe(true);

    // DB row was updated to DELETED
    const row = await testQueries.messages.getById(msgId);
    expect(row?.type).toBe(MessageType.DELETED);
  });

  // -------------------------------------------------------------------------
  // editMessage
  // -------------------------------------------------------------------------

  it('editMessage updates DB content and sends a control message', async () => {
    const testQueries = getTestQueries();
    await insertTestContactAndDiscussion();

    const msgIdBytes = new Uint8Array(12).fill(10);
    const msgId = await testQueries.messages.insert({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Original',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      messageId: msgIdBytes,
    });

    const eventEmitter = new SdkEventEmitter();
    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      eventEmitter,
      defaultSdkConfig,
      testQueries
    );

    const result = await service.editMessage(msgId, 'Edited');
    expect(result).toBe(true);

    // DB was updated with new content
    const row = await testQueries.messages.getById(msgId);
    expect(row?.content).toBe('Edited');

    // A control message (edit) was enqueued
    const allMessages = await testQueries.messages.getByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    const controlMsg = allMessages.find(
      m => m.id !== msgId && m.editOf != null
    );
    expect(controlMsg).toBeDefined();
    expect(controlMsg?.content).toBe('Edited');
    expect(controlMsg?.direction).toBe(MessageDirection.OUTGOING);
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
