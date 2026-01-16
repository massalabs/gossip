/**
 * MessageService Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageService } from '../src/services/message';
import {
  db,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../src/db';
import type { IMessageProtocol } from '../src/api/messageProtocol/types';
import type { SessionModule } from '../src/wasm/session';
import { encodeUserId } from '../src/utils/userId';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

function createMockProtocol(): IMessageProtocol {
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

function createMockSession(
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
    userIdEncoded: OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(11),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

const fakeSession = {} as SessionModule;

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
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker,
    });

    const service = new MessageService(db, createMockProtocol(), fakeSession);
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeDefined();
    expect(message?.content).toBe('Hello');
  });

  it('returns undefined for missing seeker', async () => {
    const seeker = new Uint8Array(32).fill(9);

    const service = new MessageService(db, createMockProtocol(), fakeSession);
    const message = await service.findMessageBySeeker(seeker, OWNER_USER_ID);

    expect(message).toBeUndefined();
  });

  describe('sendMessage with no active session (auto-renewal flow)', () => {
    beforeEach(async () => {
      // Create an active discussion
      await db.discussions.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });

    it('should queue message as WAITING_SESSION when session is NoSession', async () => {
      const mockSession = createMockSession(SessionStatus.NoSession);
      const service = new MessageService(db, createMockProtocol(), mockSession);

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      // Per spec: message is queued, not failed
      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(result.message?.id).toBeDefined();

      // Verify message was added to database with WAITING_SESSION status
      const dbMessage = await db.messages.get(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is UnknownPeer', async () => {
      const mockSession = createMockSession(SessionStatus.UnknownPeer);
      const service = new MessageService(db, createMockProtocol(), mockSession);

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      expect(result.success).toBe(true);
      expect(result.message).toBeDefined();

      // Verify message exists in database with WAITING_SESSION
      const messages = await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([OWNER_USER_ID, CONTACT_USER_ID])
        .toArray();
      expect(messages.length).toBe(1);
      expect(messages[0].status).toBe(MessageStatus.WAITING_SESSION);
    });

    it('should queue message as WAITING_SESSION when session is Killed', async () => {
      const mockSession = createMockSession(SessionStatus.Killed);
      const service = new MessageService(db, createMockProtocol(), mockSession);

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
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
      const mockSession = createMockSession(SessionStatus.NoSession);
      const service = new MessageService(db, createMockProtocol(), mockSession);

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      await service.sendMessage(message);

      // Per spec: discussion stays ACTIVE, auto-renewal will re-establish session
      const discussion = await db.getDiscussionByOwnerAndContact(
        OWNER_USER_ID,
        CONTACT_USER_ID
      );
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should emit onSessionRenewalNeeded event when session is lost', async () => {
      const mockSession = createMockSession(SessionStatus.NoSession);
      const onSessionRenewalNeeded = vi.fn();
      const service = new MessageService(
        db,
        createMockProtocol(),
        mockSession,
        { onSessionRenewalNeeded }
      );

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      await service.sendMessage(message);

      // Per spec: trigger auto-renewal via onSessionRenewalNeeded
      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(CONTACT_USER_ID);
    });

    it('should queue message as WAITING_SESSION and trigger accept when session is PeerRequested', async () => {
      const mockSession = createMockSession(SessionStatus.PeerRequested);
      const onSessionAcceptNeeded = vi.fn();
      const onSessionRenewalNeeded = vi.fn();
      const service = new MessageService(
        db,
        createMockProtocol(),
        mockSession,
        { onSessionAcceptNeeded, onSessionRenewalNeeded }
      );

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
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

      // Verify message was added to database
      const dbMessage = await db.messages.get(result.message!.id!);
      expect(dbMessage).toBeDefined();
      expect(dbMessage?.status).toBe(MessageStatus.WAITING_SESSION);

      // Verify onSessionAcceptNeeded was emitted (NOT renewal - peer sent us an announcement)
      expect(onSessionAcceptNeeded).toHaveBeenCalledWith(CONTACT_USER_ID);
      // Renewal should NOT be called for PeerRequested
      expect(onSessionRenewalNeeded).not.toHaveBeenCalled();
    });

    it('should queue message as WAITING_SESSION when session is SelfRequested', async () => {
      const mockSession = createMockSession(SessionStatus.SelfRequested);
      const service = new MessageService(db, createMockProtocol(), mockSession);

      const message = {
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
      };

      const result = await service.sendMessage(message);

      // SelfRequested means we're waiting for peer to accept - queue the message
      expect(result.success).toBe(true);
      expect(result.message?.status).toBe(MessageStatus.WAITING_SESSION);
    });
  });
});
