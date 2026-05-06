/**
 * MessageService: control message emit suppression tests
 *
 * Tests that processSendQueueForContact skips MESSAGE_SENT for control messages.
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

describe('MessageService control message handling', () => {
  beforeEach(clearAllTables);

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
