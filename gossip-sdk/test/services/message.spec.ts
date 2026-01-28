/**
 * MessageService tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscussionService } from '../../src/services/discussion';
import { MessageService } from '../../src/services/message';
import {
  GossipDatabase,
  db,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db';
import type { IMessageProtocol } from '../../src/api/messageProtocol/types';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { defaultSdkConfig } from '../../src/config/sdk';

const MESSAGE_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const MESSAGE_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

function createMessageProtocol(): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
  };
}

function createMessageSession(
  sessionStatus: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(sessionStatus),
    sendMessage: vi.fn(),
    receiveMessage: vi.fn(),
    refresh: vi.fn().mockReturnValue([]),
    receiveAnnouncement: vi.fn(),
    establishOutgoingSession: vi.fn(),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: MESSAGE_OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(11),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createDiscussionServiceMock(
  isStable: boolean = true
): DiscussionService {
  return {
    isStableState: vi.fn().mockResolvedValue(isStable),
  } as unknown as DiscussionService;
}

const messageFakeSession = {} as SessionModule;

describe('MessageService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('finds message by seeker', async () => {
    const seeker = new Uint8Array(32).fill(5);
    await db.messages.add({
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
      db,
      createMessageProtocol(),
      messageFakeSession,
      createDiscussionServiceMock()
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
      db,
      createMessageProtocol(),
      messageFakeSession,
      createDiscussionServiceMock()
    );
    const message = await service.findMessageBySeeker(
      seeker,
      MESSAGE_OWNER_USER_ID
    );

    expect(message).toBeUndefined();
  });

  describe('sendMessage with no active session (auto-renewal flow)', () => {
    beforeEach(async () => {
      await db.discussions.add({
        ownerUserId: MESSAGE_OWNER_USER_ID,
        contactUserId: MESSAGE_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('should queue message as WAITING_SESSION when session is NoSession', async () => {
      const mockSession = createMessageSession(SessionStatus.NoSession);
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock()
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

      const dbMessage = await db.messages.get(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is UnknownPeer', async () => {
      const mockSession = createMessageSession(SessionStatus.UnknownPeer);
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock()
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

      const messages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([MESSAGE_OWNER_USER_ID, MESSAGE_CONTACT_USER_ID])
        .toArray();
      expect(messages.length).toBe(1);
      expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is Killed', async () => {
      const mockSession = createMessageSession(SessionStatus.Killed);
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock()
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

    it('should NOT mark discussion as BROKEN when session is lost (auto-renewal)', async () => {
      const mockSession = createMessageSession(SessionStatus.NoSession);
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock()
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

      const discussion = await db.getDiscussionByOwnerAndContact(
        MESSAGE_OWNER_USER_ID,
        MESSAGE_CONTACT_USER_ID
      );
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should emit onSessionRenewalNeeded event when session is lost', async () => {
      const mockSession = createMessageSession(SessionStatus.NoSession);
      const onSessionRenewalNeeded = vi.fn();
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock(),
        { onSessionRenewalNeeded }
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

      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(
        MESSAGE_CONTACT_USER_ID
      );
    });

    it('should queue message as WAITING_SESSION and trigger accept when session is PeerRequested', async () => {
      const mockSession = createMessageSession(SessionStatus.PeerRequested);
      const onSessionAcceptNeeded = vi.fn();
      const onSessionRenewalNeeded = vi.fn();
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock(),
        { onSessionAcceptNeeded, onSessionRenewalNeeded }
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

      const dbMessage = await db.messages.get(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);

      expect(onSessionAcceptNeeded).toHaveBeenCalledWith(
        MESSAGE_CONTACT_USER_ID
      );
      expect(onSessionRenewalNeeded).not.toHaveBeenCalled();
    });

    it('should queue message as WAITING_SESSION when session is SelfRequested', async () => {
      const mockSession = createMessageSession(SessionStatus.SelfRequested);
      const service = new MessageService(
        db,
        createMessageProtocol(),
        mockSession,
        createDiscussionServiceMock()
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

function createEdgeDiscussionService(): DiscussionService {
  return {
    isStableState: vi.fn().mockResolvedValue(true),
    initialize: vi.fn(),
    accept: vi.fn(),
    renew: vi.fn(),
  } as unknown as DiscussionService;
}

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

    mockSession = createEdgeSession();
    mockProtocol = createEdgeMessageProtocol();
    mockDiscussionService = createEdgeDiscussionService();

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
    await testDb.contacts.add({
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
    await testDb.contacts.add({
      ownerUserId: EDGE_OWNER_USER_ID,
      userId: EDGE_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await testDb.discussions.add({
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
// Session Encryption Error and Network Error handling
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
    receiveMessage: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    receiveAnnouncement: vi.fn(),
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

function createGapDiscussionService(): DiscussionService {
  return {
    isStableState: vi.fn().mockResolvedValue(true),
    initialize: vi.fn(),
    accept: vi.fn(),
    renew: vi.fn(),
  } as unknown as DiscussionService;
}

describe('Session Encryption Error marks Discussion BROKEN', () => {
  let testDb: GossipDatabase;
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let mockDiscussionService: DiscussionService;
  let messageService: MessageService;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    mockSession = createGapSession();
    mockProtocol = createGapMessageProtocol();
    mockDiscussionService = createGapDiscussionService();

    await testDb.contacts.add({
      ownerUserId: GAP_OWNER_USER_ID,
      userId: GAP_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should mark discussion as BROKEN when encryption fails', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption failed: invalid session state');
      }
    );

    const onMessageFailed = vi.fn();

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      { onMessageFailed },
      defaultSdkConfig
    );

    const result = await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session error');

    const discussion = await testDb.getDiscussionByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );
    expect(discussion?.status).toBe(DiscussionStatus.BROKEN);

    expect(onMessageFailed).toHaveBeenCalled();
  });

  it('should mark message as FAILED when encryption fails', async () => {
    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        throw new Error('Encryption error');
      }
    );

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      {},
      defaultSdkConfig
    );

    const result = await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);
    expect(result.message?.status).toBe(MessageStatus.FAILED);
  });
});

describe('Network Error Preserves Encrypted Message', () => {
  let testDb: GossipDatabase;
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let mockDiscussionService: DiscussionService;
  let messageService: MessageService;

  const mockSeeker = new Uint8Array(GAP_SEEKER_SIZE).fill(123);
  const mockEncryptedData = new Uint8Array([10, 20, 30, 40, 50]);

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    mockSession = createGapSession();
    mockProtocol = createGapMessageProtocol();
    mockDiscussionService = createGapDiscussionService();

    (mockSession.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue({
      seeker: mockSeeker,
      data: mockEncryptedData,
    });

    await testDb.contacts.add({
      ownerUserId: GAP_OWNER_USER_ID,
      userId: GAP_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array(32),
      isOnline: true,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should preserve encryptedMessage when network send fails', async () => {
    (mockProtocol.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error: connection refused')
    );

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      {},
      defaultSdkConfig
    );

    const result = await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    expect(result.success).toBe(false);

    const messages = await testDb.messages
      .where('[ownerUserId+contactUserId]')
      .equals([GAP_OWNER_USER_ID, GAP_CONTACT_USER_ID])
      .toArray();

    expect(messages.length).toBe(1);
    const message = messages[0];

    expect(message.encryptedMessage).toEqual(mockEncryptedData);
    expect(message.seeker).toEqual(mockSeeker);
    expect(message.status).toBe(MessageStatus.FAILED);
  });

  it('should NOT mark discussion as BROKEN on network error', async () => {
    (mockProtocol.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network timeout')
    );

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      {},
      defaultSdkConfig
    );

    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    const discussion = await testDb.getDiscussionByOwnerAndContact(
      GAP_OWNER_USER_ID,
      GAP_CONTACT_USER_ID
    );
    expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
  });

  it('should allow resend without re-encryption when encrypted data preserved', async () => {
    (
      mockProtocol.sendMessage as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('Network error'));

    messageService = new MessageService(
      testDb,
      mockProtocol,
      mockSession,
      mockDiscussionService,
      {},
      defaultSdkConfig
    );

    await messageService.sendMessage({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    const messages = await testDb.messages.toArray();
    expect(messages.length).toBe(1);
    const failedMessage = messages[0];

    expect(failedMessage.encryptedMessage).toBeDefined();
    expect(failedMessage.seeker).toBeDefined();

    (
      mockProtocol.sendMessage as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce(undefined);

    const messageMap = new Map([[GAP_CONTACT_USER_ID, [failedMessage]]]);
    await messageService.resendMessages(messageMap);

    expect(mockProtocol.sendMessage).toHaveBeenLastCalledWith({
      seeker: failedMessage.seeker,
      ciphertext: failedMessage.encryptedMessage,
    });
    expect(mockSession.sendMessage).toHaveBeenCalledTimes(1);
  });
});
