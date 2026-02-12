/**
 * RefreshService tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RefreshService } from '../../src/services/refresh';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import { AnnouncementService } from '../../src/services/announcement';
import { gossipDb, MessageType, DiscussionDirection } from '../../src/db';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { SdkEventEmitter } from '../../src/core/SdkEventEmitter';

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
    peerList: vi.fn().mockReturnValue([]),
    peerDiscard: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  } as unknown as SessionModule;
}

function createRefreshMessageService(): MessageService {
  return {
    sendMessage: vi.fn().mockResolvedValue({ success: true }),
    getPendingSendCount: vi.fn().mockResolvedValue(0),
    processSendQueueForContact: vi.fn().mockResolvedValue({ success: true }),
  } as unknown as MessageService;
}

function createRefreshDiscussionService(): DiscussionService {
  return {
    createSessionForContact: vi.fn().mockResolvedValue({
      success: true,
      data: new Uint8Array(0),
    }),
  } as unknown as DiscussionService;
}

function createRefreshAnnouncementService(): AnnouncementService {
  return {
    processOutgoingAnnouncements: vi.fn().mockResolvedValue(undefined),
  } as unknown as AnnouncementService;
}

describe('RefreshService', () => {
  let eventEmitter: SdkEventEmitter;
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
    eventEmitter = new SdkEventEmitter();
  });

  describe('stateUpdate', () => {
    it('should create session for contact when session is Killed', async () => {
      const mockSession = createRefreshSession(SessionStatus.Killed);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter
      );

      // Create a discussion in the database
      await db.discussions.add({
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await refreshService.stateUpdate();

      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledTimes(1);
      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID, new Uint8Array(0));
    });

    it('should create session for contact when session is NoSession', async () => {
      const mockSession = createRefreshSession(SessionStatus.NoSession);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter
      );

      // Create a discussion in the database
      await db.discussions.add({
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await refreshService.stateUpdate();

      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledTimes(1);
    });

    it('should send keep-alive message when session is Active and peer needs it', async () => {
      const mockSession = createRefreshSession(SessionStatus.Active);
      mockSession.refresh = vi
        .fn()
        .mockResolvedValue([decodeUserId(REFRESH_CONTACT_USER_ID)]);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter
      );

      // Create a discussion in the database
      await db.discussions.add({
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await refreshService.stateUpdate();

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
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter
      );

      // Create a discussion in the database
      await db.discussions.add({
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await refreshService.stateUpdate();

      expect(mockMessageService.sendMessage).not.toHaveBeenCalled();
    });

    it('should process send queue for active discussions', async () => {
      const mockSession = createRefreshSession(SessionStatus.Active);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter
      );

      // Create a discussion in the database
      await db.discussions.add({
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await refreshService.stateUpdate();

      expect(
        mockMessageService.processSendQueueForContact
      ).toHaveBeenCalledTimes(1);
      expect(
        mockMessageService.processSendQueueForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID);
    });
  });
});
