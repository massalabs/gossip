/**
 * RefreshService tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefreshService } from '../../src/services/refresh';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import { AnnouncementService } from '../../src/services/announcement';
import {
  gossipDb,
  GossipDatabase,
  MessageType,
  DiscussionDirection,
  type Discussion,
} from '../../src/db';
import { defaultSdkConfig } from '../../src/config/sdk';
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
  let db: GossipDatabase;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
    eventEmitter = new SdkEventEmitter();
  });

  afterEach(() => {
    // Ensure timers are restored after each test
    vi.useRealTimers();
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
        eventEmitter,
        defaultSdkConfig
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

    it('should not create session for contact when session is NoSession', async () => {
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
        eventEmitter,
        defaultSdkConfig
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
      ).not.toHaveBeenCalled();
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
        eventEmitter,
        defaultSdkConfig
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
        eventEmitter,
        defaultSdkConfig
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
        eventEmitter,
        defaultSdkConfig
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

  describe('handleSessionStatus', () => {
    const createDiscussion = async (
      overrides: Partial<Discussion> = {}
    ): Promise<Discussion> => {
      const baseDiscussion: Discussion = {
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        sendAnnouncement: null,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await db.discussions.add({ ...baseDiscussion, ...overrides });
      const discussion = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      if (!discussion) {
        throw new Error('Expected discussion to exist');
      }
      return discussion;
    };

    it('clears recovery state when session is Active', async () => {
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
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        sessionRecovery: {
          killedNextRetryAt: new Date(Date.now() + 60 * 1000),
          saturatedRetryAt: new Date(Date.now() + 60 * 1000),
          saturatedRetryDone: true,
        },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Active);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(updated?.sessionRecovery?.killedNextRetryAt).toBeUndefined();
      expect(updated?.sessionRecovery?.saturatedRetryAt).toBeUndefined();
      expect(updated?.sessionRecovery?.saturatedRetryDone).toBeUndefined();
    });

    it('returns early for SelfRequested status', async () => {
      const mockSession = createRefreshSession(SessionStatus.SelfRequested);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion();

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.SelfRequested);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.sessionRecovery).toBeUndefined();
    });

    it('returns early for PeerRequested status', async () => {
      const mockSession = createRefreshSession(SessionStatus.PeerRequested);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        sessionRecovery: { killedNextRetryAt: new Date(now) },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.PeerRequested);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.sessionRecovery?.killedNextRetryAt?.getTime()).toBe(now);
    });

    it('returns early when discussion is not accepted', async () => {
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
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion({ weAccepted: false });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Killed, new Date());

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
    });

    it('does nothing for NoSession status', async () => {
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
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion();

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.NoSession, new Date());

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.sessionRecovery).toBeUndefined();
    });

    it('does nothing for UnknownPeer status', async () => {
      const mockSession = createRefreshSession(SessionStatus.UnknownPeer);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        sessionRecovery: { killedNextRetryAt: new Date(now) },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.UnknownPeer);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.sessionRecovery?.killedNextRetryAt?.getTime()).toBe(now);
    });

    it('retries killed session and schedules next retry', async () => {
      // Mock the random function to return a fixed value -> jitter is 0
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

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
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion();
      const now = Date.now();

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Killed);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID, new Uint8Array(0));
      expect(
        updated?.sessionRecovery?.killedNextRetryAt?.getTime()
      ).toBeGreaterThanOrEqual(
        now + defaultSdkConfig.sessionRecovery.killedRetryDelayMs
      );

      randomSpy.mockRestore();
    });

    it('skips killed retry when next retry time has not arrived', async () => {
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
        eventEmitter,
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        sessionRecovery: {
          killedNextRetryAt: new Date(now + 60 * 1000), // Future time
        },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Killed);

      const discussionAfter = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(
        discussionAfter?.sessionRecovery?.killedNextRetryAt?.getTime()
      ).toEqual(now + 60 * 1000);
    });

    it('schedules saturated retry when no retry exists', async () => {
      // jitter will be 2s
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion();
      const now = Date.now();

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(
        updated?.sessionRecovery?.saturatedRetryAt?.getTime()
      ).toBeGreaterThanOrEqual(
        now + defaultSdkConfig.sessionRecovery.saturatedRetryDelayMs + 2 * 1000
      );
      expect(updated?.sessionRecovery?.saturatedRetryDone).toBe(false);

      randomSpy.mockRestore();
    });

    it('skips saturated retry when already done', async () => {
      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        sessionRecovery: {
          saturatedRetryAt: new Date(Date.now() - 1000),
          saturatedRetryDone: true,
        },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
    });

    it('skips saturated retry when retry time has not arrived', async () => {
      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const now = new Date();
      const discussion = await createDiscussion({
        sessionRecovery: {
          saturatedRetryAt: new Date(now.getTime() + 60 * 1000),
          saturatedRetryDone: false,
        },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      const discussionAfter = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(
        discussionAfter?.sessionRecovery?.saturatedRetryAt?.getTime()
      ).toEqual(now.getTime() + 60 * 1000);
    });

    it('retries saturated session when retry time has passed', async () => {
      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        db,
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        sessionRecovery: {
          saturatedRetryAt: new Date(Date.now() - 1000),
          saturatedRetryDone: false,
        },
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      const updated = await db.getDiscussionByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID, new Uint8Array(0));
      expect(updated?.sessionRecovery?.saturatedRetryDone).toBe(true);
    });
  });
});
