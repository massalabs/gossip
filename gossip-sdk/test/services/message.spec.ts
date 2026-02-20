/**
 * MessageService unit tests
 *
 * Legacy tests that depended on removed DiscussionStatus and old callbacks were
 * removed. Their behavior is now covered by integration flows in:
 * - test/integration/messaging-flow.spec.ts
 * - test/integration/discussion-flow.spec.ts
 *
 * Here we only validate the public SDK wrapper for message lookup helpers.
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
import type { IMessageProtocol } from '../../src/api/messageProtocol/types';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/wasm/bindings';
import { defaultSdkConfig } from '../../src/config/sdk';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';
import { clearAllTables } from '../../src/sqlite';
import {
  insertMessage,
  getMessageById,
  getMessagesByOwnerAndContact,
} from '../../src/queries/messages';
import {
  insertDiscussion,
  getDiscussionByOwnerAndContact,
} from '../../src/queries/discussions';
import { insertContact } from '../../src/queries/contacts';

const MESSAGE_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const MESSAGE_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

const MESSAGE_SEEKER_SIZE = 34;

function createMessageProtocol(): IMessageProtocol {
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

function createMessageSession(
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(status),
    sendMessage: vi.fn().mockReturnValue({
      seeker: new Uint8Array(MESSAGE_SEEKER_SIZE).fill(1),
      data: new Uint8Array([1, 2, 3, 4]),
    }),
    feedIncomingMessageBoardRead: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    feedIncomingAnnouncement: vi.fn(),
    establishOutgoingSession: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: MESSAGE_OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(11),
    userId: new Uint8Array(32).fill(11),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

const messageFakeSession = createMessageSession();

describe('MessageService', () => {
  beforeEach(clearAllTables);

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await insertMessage({
      ownerUserId: MESSAGE_OWNER_USER_ID,
      contactUserId: MESSAGE_CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker,
    });

    const service = new MessageService(
      createMessageProtocol(),
      messageFakeSession,
      new SdkEventEmitter()
    );
    const message = await service.findMessageBySeeker(
      seeker,
      MESSAGE_OWNER_USER_ID
    );

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const service = new MessageService(
      createMessageProtocol(),
      messageFakeSession,
      new SdkEventEmitter()
    );
    const message = await service.findMessageBySeeker(
      seeker,
      MESSAGE_OWNER_USER_ID
    );

    expect(message).toBeUndefined();
  });

  describe('sendMessage queues as WAITING_SESSION', () => {
    beforeEach(async () => {
      await insertDiscussion({
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('should queue message as WAITING_SESSION regardless of session status', async () => {
      const mockSession = createMessageSession(SessionStatus.NoSession);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(result.message?.id).toBeDefined();

      const dbMessage = await getMessageById(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is UnknownPeer', async () => {
      const mockSession = createMessageSession(SessionStatus.UnknownPeer);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();

      const messages = await getMessagesByOwnerAndContact(
        MESSAGE_OWNER_USER_ID,
        MESSAGE_CONTACT_USER_ID
      );
      expect(messages.length).toBe(1);
      expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is Killed', async () => {
      const mockSession = createMessageSession(SessionStatus.Killed);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should NOT mark discussion as BROKEN when session is lost', async () => {
      const mockSession = createMessageSession(SessionStatus.NoSession);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      await service.sendMessage(message);

      const discussion = await getDiscussionByOwnerAndContact(
        MESSAGE_OWNER_USER_ID,
        MESSAGE_CONTACT_USER_ID
      );
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should queue message as WAITING_SESSION when session is PeerRequested', async () => {
      const mockSession = createMessageSession(SessionStatus.PeerRequested);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);

      const dbMessage = await getMessageById(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is SelfRequested', async () => {
      const mockSession = createMessageSession(SessionStatus.SelfRequested);
      const service = new MessageService(
        createMessageProtocol(),
        mockSession,
        new SdkEventEmitter()
      );

      const message = {
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
    });
  });
});

// ============================================================================
// Invalid contactUserId Validation
// ============================================================================

const EDGE_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const EDGE_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
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

function createEdgeMessageProtocol(): IMessageProtocol {
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

describe('Invalid contactUserId Validation', () => {
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let messageService: MessageService;

  beforeEach(async () => {
    await clearAllTables();
    mockSession = createEdgeSession();
    mockProtocol = createEdgeMessageProtocol();

    messageService = new MessageService(
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );
  });

  it('should fail when no contact or discussion exists', async () => {
    const result = await messageService.sendMessage({
      ownerUserId: EDGE_OWNER_USER_ID,
      contactUserId: EDGE_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should fail when discussion not found', async () => {
    await insertContact({
      ownerUserId: EDGE_OWNER_USER_ID,
      userId: EDGE_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    const result = await messageService.sendMessage({
      ownerUserId: EDGE_OWNER_USER_ID,
      contactUserId: EDGE_CONTACT_USER_ID,
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
    await insertContact({
      ownerUserId: EDGE_OWNER_USER_ID,
      userId: EDGE_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await insertDiscussion({
      ownerUserId: EDGE_OWNER_USER_ID,
      contactUserId: EDGE_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await messageService.sendMessage({
      ownerUserId: EDGE_OWNER_USER_ID,
      contactUserId: EDGE_CONTACT_USER_ID,
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
// processSendQueueForContact: Encryption Error and Network Error handling
// ============================================================================

const GAP_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const GAP_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const GAP_SEEKER_SIZE = 34;

function createGapSession(
  status: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(status),
    sendMessage: vi.fn().mockReturnValue({
      seeker: new Uint8Array(GAP_SEEKER_SIZE).fill(1),
      data: new Uint8Array([1, 2, 3, 4]),
    }),
    feedIncomingMessageBoardRead: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    feedIncomingAnnouncement: vi.fn(),
    establishOutgoingSession: vi
      .fn()
      .mockResolvedValue(new Uint8Array([1, 2, 3])),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: GAP_OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(1),
    userId: new Uint8Array(32).fill(1),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createGapMessageProtocol(): IMessageProtocol {
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

describe('processSendQueueForContact: Encryption Error', () => {
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let messageService: MessageService;

  beforeEach(async () => {
    mockSession = createGapSession();
    mockProtocol = createGapMessageProtocol();

    await clearAllTables();

    await insertContact({
      ownerUserId: GAP_OWNER_USER_ID,
      userId: GAP_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await insertDiscussion({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should propagate error when encryption fails in processSendQueueForContact', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption failed: invalid session state');
      }
    );

    messageService = new MessageService(
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    // First queue a message via sendMessage
    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    // Then try to process the send queue — encryption will fail
    const processResult = await messageService
      .processSendQueueForContact(GAP_CONTACT_USER_ID)
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
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    // Queue a message
    const sendResult = await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(sendResult.success).toBe(true);

    // Process the queue — encryption will fail
    await messageService
      .processSendQueueForContact(GAP_CONTACT_USER_ID)
      .catch(() => {});

    // Message should remain WAITING_SESSION since encryption failed before
    // the status could be updated to READY
    const messages = await getMessagesByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );

    expect(messages.length).toBe(1);
    expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
  });
});

describe('processSendQueueForContact: Network Error', () => {
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let messageService: MessageService;

  const mockSeeker = new Uint8Array(GAP_SEEKER_SIZE).fill(123);
  const mockEncryptedData = new Uint8Array([10, 20, 30, 40, 50]);

  beforeEach(async () => {
    mockSession = createGapSession();
    mockProtocol = createGapMessageProtocol();

    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue({
      seeker: mockSeeker,
      data: mockEncryptedData,
    });

    await clearAllTables();

    await insertContact({
      ownerUserId: GAP_OWNER_USER_ID,
      userId: GAP_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await insertDiscussion({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should preserve encryptedMessage and keep READY when network send fails', async () => {
    (mockProtocol.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error: connection refused')
    );

    messageService = new MessageService(
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    // Queue message
    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    // Process queue — encryption succeeds, network send fails
    await messageService.processSendQueueForContact(GAP_CONTACT_USER_ID);

    const messages = await getMessagesByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );

    expect(messages.length).toBe(1);
    const message = messages[0];

    // Message stays READY with encrypted data preserved and a future whenToSend (retry)
    expect(message.encryptedMessage).toEqual(mockEncryptedData);
    expect(message.seeker).toEqual(mockSeeker);
    expect(message.status).toBe(MessageStatus.READY);
    expect(message.whenToSend).toBeDefined();
  });

  it('should NOT mark discussion as BROKEN on network error', async () => {
    (mockProtocol.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network timeout')
    );

    messageService = new MessageService(
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    // Queue and process
    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await messageService.processSendQueueForContact(GAP_CONTACT_USER_ID);

    const discussion = await getDiscussionByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );
    expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
  });

  it('should allow resend after network failure via resendMessages', async () => {
    (
      mockProtocol.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('Network error'));

    messageService = new MessageService(
      mockProtocol,
      mockSession,
      new SdkEventEmitter(),
      defaultSdkConfig
    );

    // Queue and process — first attempt fails on network
    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await messageService.processSendQueueForContact(GAP_CONTACT_USER_ID);

    const allMsgs = await getMessagesByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );
    expect(allMsgs.length).toBe(1);
    const failedRow = allMsgs[0];

    expect(failedRow.encryptedMessage).toBeDefined();
    expect(failedRow.seeker).toBeDefined();

    // Convert to Message shape for resendMessages
    const failedMessage = {
      id: failedRow.id,
      ownerUserId: failedRow.ownerUserId,
      contactUserId: failedRow.contactUserId,
      content: failedRow.content,
      type: failedRow.type as MessageType,
      direction: failedRow.direction as MessageDirection,
      status: failedRow.status as MessageStatus,
      timestamp: failedRow.timestamp,
      seeker: failedRow.seeker ?? undefined,
      encryptedMessage: failedRow.encryptedMessage ?? undefined,
    };

    // Next network send will succeed
    (
      mockProtocol.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(undefined);

    const messageMap = new Map([[GAP_CONTACT_USER_ID, [failedMessage]]]);
    await messageService.resendMessages(messageMap);

    // resendMessages resets to WAITING_SESSION and re-encrypts via processSendQueueForContact
    // The session.sendMessage should be called again for re-encryption
    expect(mockSession.sendMessage).toHaveBeenCalledTimes(2); // once for initial, once for resend
  });
});
