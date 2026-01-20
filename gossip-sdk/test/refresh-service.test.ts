/**
 * RefreshService Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RefreshService } from '../src/services/refresh';
import { MessageService } from '../src/services/message';
import {
  db,
  DiscussionStatus,
  DiscussionDirection,
  MessageType,
  type Discussion,
} from '../src/db';
import type { SessionModule } from '../src/wasm/session';
import { encodeUserId, decodeUserId } from '../src/utils/userId';
import { SessionStatus } from '../src/assets/generated/wasm/gossip_wasm';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

function createMockSession(
  sessionStatus: SessionStatus = SessionStatus.Active
): SessionModule {
  return {
    peerSessionStatus: vi.fn().mockReturnValue(sessionStatus),
    sendMessage: vi.fn(),
    receiveMessage: vi.fn(),
    refresh: vi.fn().mockResolvedValue([]),
    receiveAnnouncement: vi.fn(),
    establishOutgoingSession: vi.fn(),
    toEncryptedBlob: vi.fn(),
    userIdEncoded: OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(11),
    userId: new Uint8Array(32).fill(11),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createMockMessageService(): MessageService {
  return {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as MessageService;
}

function createActiveDiscussion(
  contactUserId: string = CONTACT_USER_ID
): Discussion {
  return {
    id: 1,
    ownerUserId: OWNER_USER_ID,
    contactUserId,
    direction: DiscussionDirection.INITIATED,
    status: DiscussionStatus.ACTIVE,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RefreshService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  describe('handleSessionRefresh', () => {
    it('should throw error when active discussion has PeerRequested status', async () => {
      // PeerRequested for an active discussion is a state inconsistency
      const mockSession = createMockSession(SessionStatus.PeerRequested);
      const mockMessageService = createMockMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = createActiveDiscussion();

      await expect(
        refreshService.handleSessionRefresh([activeDiscussion])
      ).rejects.toThrow(
        /Unexpected PeerRequested status for active discussion/
      );
    });

    it('should trigger onSessionRenewalNeeded when session is Killed', async () => {
      const mockSession = createMockSession(SessionStatus.Killed);
      const mockMessageService = createMockMessageService();
      const onSessionRenewalNeeded = vi.fn();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession,
        { onSessionRenewalNeeded }
      );

      const activeDiscussion = createActiveDiscussion();

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(CONTACT_USER_ID);
    });

    it('should trigger onSessionRenewalNeeded when session is NoSession', async () => {
      const mockSession = createMockSession(SessionStatus.NoSession);
      const mockMessageService = createMockMessageService();
      const onSessionRenewalNeeded = vi.fn();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession,
        { onSessionRenewalNeeded }
      );

      const activeDiscussion = createActiveDiscussion();

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(CONTACT_USER_ID);
    });

    it('should send keep-alive message when session is Active and peer needs it', async () => {
      const mockSession = createMockSession(SessionStatus.Active);
      // Mock refresh to return the contact peer ID (indicating keep-alive needed)
      mockSession.refresh = vi
        .fn()
        .mockResolvedValue([decodeUserId(CONTACT_USER_ID)]);
      const mockMessageService = createMockMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = createActiveDiscussion();

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(mockMessageService.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: OWNER_USER_ID,
          contactUserId: CONTACT_USER_ID,
          type: MessageType.KEEP_ALIVE,
        })
      );
    });

    it('should not send keep-alive when session is Active but peer does not need it', async () => {
      const mockSession = createMockSession(SessionStatus.Active);
      // Mock refresh to return empty array (no keep-alive needed)
      mockSession.refresh = vi.fn().mockResolvedValue([]);
      const mockMessageService = createMockMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = createActiveDiscussion();

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
    });
  });
});
