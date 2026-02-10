/**
 * RefreshService tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RefreshService } from '../../src/services/refresh';
import { MessageService } from '../../src/services/message';
import { db, MessageType, DiscussionDirection } from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/wasm/bindings';
import { DiscussionStatus } from '../../src/db';

const REFRESH_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const REFRESH_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

function createRefreshSession(
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
    userIdEncoded: REFRESH_OWNER_USER_ID,
    userIdRaw: new Uint8Array(32).fill(11),
    userId: new Uint8Array(32).fill(11),
    getMessageBoardReadKeys: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createRefreshMessageService(): MessageService {
  return {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as MessageService;
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
      const mockSession = createRefreshSession(SessionStatus.PeerRequested);
      const mockMessageService = createRefreshMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = {
        id: 1,
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await expect(
        refreshService.handleSessionRefresh([activeDiscussion])
      ).rejects.toThrow(
        /Unexpected PeerRequested status for active discussion/
      );
    });

    it('should trigger onSessionRenewalNeeded when session is Killed', async () => {
      const mockSession = createRefreshSession(SessionStatus.Killed);
      const mockMessageService = createRefreshMessageService();
      const onSessionRenewalNeeded = vi.fn();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession,
        { onSessionRenewalNeeded }
      );

      const activeDiscussion = {
        id: 1,
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(
        REFRESH_CONTACT_USER_ID
      );
    });

    it('should trigger onSessionRenewalNeeded when session is NoSession', async () => {
      const mockSession = createRefreshSession(SessionStatus.NoSession);
      const mockMessageService = createRefreshMessageService();
      const onSessionRenewalNeeded = vi.fn();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession,
        { onSessionRenewalNeeded }
      );

      const activeDiscussion = {
        id: 1,
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(onSessionRenewalNeeded).toHaveBeenCalledTimes(1);
      expect(onSessionRenewalNeeded).toHaveBeenCalledWith(
        REFRESH_CONTACT_USER_ID
      );
    });

    it('should send keep-alive message when session is Active and peer needs it', async () => {
      const mockSession = createRefreshSession(SessionStatus.Active);
      mockSession.refresh = vi
        .fn()
        .mockResolvedValue([decodeUserId(REFRESH_CONTACT_USER_ID)]);
      const mockMessageService = createRefreshMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = {
        id: 1,
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(mockMessageService.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockMessageService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerUserId: REFRESH_OWNER_USER_ID,
          contactUserId: REFRESH_CONTACT_USER_ID,
          type: MessageType.KEEP_ALIVE,
        })
      );
    });

    it('should not send keep-alive when session is Active but peer does not need it', async () => {
      const mockSession = createRefreshSession(SessionStatus.Active);
      mockSession.refresh = vi.fn().mockResolvedValue([]);
      const mockMessageService = createRefreshMessageService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockSession
      );

      const activeDiscussion = {
        id: 1,
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      await refreshService.handleSessionRefresh([activeDiscussion]);

      expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
    });
  });
});
