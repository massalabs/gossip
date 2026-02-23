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
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/wasm/bindings';
import { defaultSdkConfig } from '../../src/config/sdk';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { clearAllTables } from '../../src/db';
import {
  insertMessage,
  getMessageById,
  getMessagesByOwnerAndContact,
} from '../../src/db';
import { insertDiscussion, getDiscussionByOwnerAndContact } from '../../src/db';
import { insertContact } from '../../src/db';
import { MockMessageProtocol } from '../mocks';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const SEEKER_SIZE = 34;

function createMockSession(
  ownerUserId: string = OWNER_USER_ID,
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  const ownerBytes = decodeUserId(ownerUserId);
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
    userIdEncoded: ownerUserId,
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
  }> = {}
) {
  return {
    ownerUserId: overrides.ownerUserId ?? OWNER_USER_ID,
    contactUserId: overrides.contactUserId ?? CONTACT_USER_ID,
    content: overrides.content ?? 'Test message',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENDING,
    timestamp: new Date(),
  };
}

async function insertTestContactAndDiscussion(
  ownerUserId: string = OWNER_USER_ID,
  contactUserId: string = CONTACT_USER_ID
) {
  await insertContact({
    ownerUserId,
    userId: contactUserId,
    name: 'Test Contact',
    publicKeys: new Uint8Array(32),
    isOnline: true,
    lastSeen: new Date(),
    createdAt: new Date(),
  });

  await insertDiscussion({
    ownerUserId,
    contactUserId,
    direction: DiscussionDirection.INITIATED,
    status: DiscussionStatus.ACTIVE,
    weAccepted: true,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('MessageService', () => {
  beforeEach(clearAllTables);

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await insertMessage({
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
      new SdkEventEmitter()
    );
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const service = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter()
    );
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeUndefined();
  });

  describe('sendMessage queues as WAITING_SESSION', () => {
    beforeEach(async () => {
      await insertDiscussion({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
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
        const service = new MessageService(
          new MockMessageProtocol(),
          createMockSession(OWNER_USER_ID, status),
          new SdkEventEmitter()
        );

        const result = await service.sendMessage(createTestMessage());

        expect(result.success).toBe(true);
        expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);

        const dbMessage = await getMessageById(result.message!.id!);
        expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
      }
    );

    it('should NOT mark discussion as BROKEN when session is lost', async () => {
      const service = new MessageService(
        new MockMessageProtocol(),
        createMockSession(OWNER_USER_ID, SessionStatus.NoSession),
        new SdkEventEmitter()
      );

      await service.sendMessage(createTestMessage());

      const discussion = await getDiscussionByOwnerAndContact(
        OWNER_USER_ID,
        CONTACT_USER_ID
      );
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
    });
  });
});

describe('sendMessage: missing contact or discussion', () => {
  let messageService: MessageService;

  beforeEach(async () => {
    await clearAllTables();
    messageService = new MessageService(
      new MockMessageProtocol(),
      createMockSession(),
      new SdkEventEmitter(),
      defaultSdkConfig
    );
  });

  it('should fail when no contact or discussion exists', async () => {
    const result = await messageService.sendMessage(createTestMessage());

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should fail when discussion not found', async () => {
    await insertContact({
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

  it('should succeed when both contact and discussion exist', async () => {
    await insertTestContactAndDiscussion();

    const result = await messageService.sendMessage(createTestMessage());

    expect(result.success).toBe(true);
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

  it('should propagate error when encryption fails', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption failed: invalid session state');
      }
    );

    messageService = new MessageService(
      new MockMessageProtocol(),
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    await messageService.sendMessage(createTestMessage());

    const processResult = await messageService
      .processSendQueueForContact(CONTACT_USER_ID)
      .catch((e: Error) => ({ success: false, error: e }));

    expect(processResult.success).toBe(false);
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
      defaultSdkConfig
    );

    const sendResult = await messageService.sendMessage(createTestMessage());
    expect(sendResult.success).toBe(true);

    await messageService
      .processSendQueueForContact(CONTACT_USER_ID)
      .catch(() => {});

    const messages = await getMessagesByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );

    expect(messages.length).toBe(1);
    expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
  });
});
