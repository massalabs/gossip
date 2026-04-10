/**
 * RefreshService tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RefreshService } from '../../src/services/refresh';
import { MessageService } from '../../src/services/message';
import { DiscussionService } from '../../src/services/discussion';
import { AnnouncementService } from '../../src/services/announcement';
import { MessageType, DiscussionDirection } from '../../src/db';
import type { Discussion } from '../../src/db';
import type {
  DiscussionInsert,
  DiscussionRow,
} from '../../src/db/queries/discussions';
import { clearAllTables, getTestQueries } from '../testDb';
import { defaultSdkConfig } from '../../src/config/sdk';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId, decodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { SdkEventEmitter, SdkEventType } from '../../src/core/SdkEventEmitter';
import { toDiscussion } from '../../src/utils/discussions';

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

  beforeEach(async () => {
    await clearAllTables();
    eventEmitter = new SdkEventEmitter();
  });

  afterEach(() => {
    // Ensure timers are restored after each test
    vi.useRealTimers();
  });

  describe('refreshSessionsStatusEvent', () => {
    let mockSession: SessionModule;
    let mockMessageService: MessageService;
    let mockDiscussionService: DiscussionService;
    let mockAnnouncementService: AnnouncementService;
    let queries: ReturnType<typeof getTestQueries>;
    let refreshService: RefreshService;
    let emitSpy: ReturnType<typeof vi.spyOn>;
    let getByOwnerSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockSession = createRefreshSession(SessionStatus.Active);
      mockMessageService = createRefreshMessageService();
      mockDiscussionService = createRefreshDiscussionService();
      mockAnnouncementService = createRefreshAnnouncementService();

      queries = getTestQueries();
      getByOwnerSpy = vi
        .spyOn(queries.discussions, 'getByOwner')
        .mockResolvedValue([
          {
            ownerUserId: REFRESH_OWNER_USER_ID,
            contactUserId: REFRESH_CONTACT_USER_ID,
            sendAnnouncement: null,
            announcementMessage: null,
            createdAt: new Date(),
            lastMessageTimestamp: null,
          } as DiscussionRow,
        ]);

      refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        queries,
        defaultSdkConfig
      );

      emitSpy = vi.spyOn(eventEmitter, 'emit');
    });

    afterEach(() => {
      emitSpy.mockRestore();
      getByOwnerSpy.mockRestore();
    });

    it('emits SESSION_STATUS_CHANGED when status changes for a session', async () => {
      await refreshService.refreshSessionsStatusEvent();

      expect(getByOwnerSpy).toHaveBeenCalledWith(REFRESH_OWNER_USER_ID);
      expect(emitSpy).toHaveBeenCalledWith(
        SdkEventType.SESSION_STATUS_CHANGED,
        { contactUserId: REFRESH_CONTACT_USER_ID, status: SessionStatus.Active }
      );
    });

    it('does not emit SESSION_STATUS_CHANGED when status has not changed', async () => {
      // First call populates the internal map and emits once
      await refreshService.refreshSessionsStatusEvent();
      // Second call sees the same status and should not emit again
      await refreshService.refreshSessionsStatusEvent();

      expect(emitSpy).toHaveBeenCalledTimes(1);
      expect(emitSpy).toHaveBeenCalledWith(
        SdkEventType.SESSION_STATUS_CHANGED,
        { contactUserId: REFRESH_CONTACT_USER_ID, status: SessionStatus.Active }
      );
    });

    it('emits SESSION_STATUS_CHANGED again when status changes between calls', async () => {
      // First call: status is Active
      await refreshService.refreshSessionsStatusEvent();

      // Change the mocked session status and call again
      vi.mocked(mockSession.peerSessionStatus).mockReturnValue(
        SessionStatus.Killed
      );
      await refreshService.refreshSessionsStatusEvent();

      // Should have emitted once for Active and once for Killed
      expect(emitSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy).toHaveBeenNthCalledWith(
        1,
        SdkEventType.SESSION_STATUS_CHANGED,
        { contactUserId: REFRESH_CONTACT_USER_ID, status: SessionStatus.Active }
      );
      expect(emitSpy).toHaveBeenNthCalledWith(
        2,
        SdkEventType.SESSION_STATUS_CHANGED,
        { contactUserId: REFRESH_CONTACT_USER_ID, status: SessionStatus.Killed }
      );
    });
  });

  describe('stateUpdate', () => {
    it('should create session for contact when session is Killed', async () => {
      const mockSession = createRefreshSession(SessionStatus.Killed);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      // Create a discussion in the database
      await getTestQueries().discussions.insert({
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      // Create a discussion in the database
      await getTestQueries().discussions.insert({
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      // Create a discussion in the database
      await getTestQueries().discussions.insert({
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      // Create a discussion in the database
      await getTestQueries().discussions.insert({
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      // Create a discussion in the database
      await getTestQueries().discussions.insert({
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

    it('should not process send queue for self requested discussions', async () => {
      const mockSession = createRefreshSession(SessionStatus.SelfRequested);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();

      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );

      await getTestQueries().discussions.insert({
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
      ).not.toHaveBeenCalled();
    });
  });

  describe('handleSessionStatus', () => {
    const createDiscussion = async (
      overrides: Partial<Discussion> = {}
    ): Promise<Discussion> => {
      const baseDiscussion = {
        ownerUserId: REFRESH_OWNER_USER_ID,
        contactUserId: REFRESH_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        initiationAnnouncement: null,
        announcementMessage: null,
        lastSyncTimestamp: null,
        customName: null,
        lastMessageId: null,
        lastMessageContent: null,
        lastMessageTimestamp: null,
        killedNextRetryAt: undefined,
        saturatedRetryAt: undefined,
        saturatedRetryDone: false,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const insertData = {
        ...baseDiscussion,
        ...overrides,
      } as DiscussionInsert;
      await getTestQueries().discussions.insert(insertData);
      const row = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      if (!row) {
        throw new Error('Expected discussion to exist');
      }
      return toDiscussion(row);
    };

    it('clears recovery state when session is Active', async () => {
      const mockSession = createRefreshSession(SessionStatus.Active);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        killedNextRetryAt: new Date(Date.now() + 60 * 1000),
        saturatedRetryAt: new Date(Date.now() + 60 * 1000),
        saturatedRetryDone: true,
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Active);

      const updatedRow =
        await getTestQueries().discussions.getByOwnerAndContact(
          REFRESH_OWNER_USER_ID,
          REFRESH_CONTACT_USER_ID
        );
      const updated = updatedRow ? toDiscussion(updatedRow) : null;
      expect(updated?.killedNextRetryAt).toBeNull();
      expect(updated?.saturatedRetryAt).toBeNull();
      expect(updated?.saturatedRetryDone).toBe(false);
    });

    it('returns early for SelfRequested status', async () => {
      const mockSession = createRefreshSession(SessionStatus.SelfRequested);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
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

      const updatedRow =
        await getTestQueries().discussions.getByOwnerAndContact(
          REFRESH_OWNER_USER_ID,
          REFRESH_CONTACT_USER_ID
        );
      const updated = updatedRow ? toDiscussion(updatedRow) : null;
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.killedNextRetryAt).toBeNull();
      expect(updated?.saturatedRetryAt).toBeNull();
      expect(updated?.saturatedRetryDone).toBe(false);
    });

    it('returns early for PeerRequested status', async () => {
      const mockSession = createRefreshSession(SessionStatus.PeerRequested);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        killedNextRetryAt: new Date(now),
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.PeerRequested);

      const updated = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.killedNextRetryAt?.getTime()).toBe(now);
    });

    it('returns early when discussion is not accepted', async () => {
      const mockSession = createRefreshSession(SessionStatus.Killed);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
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
      ).handleSessionStatus(discussion, SessionStatus.Killed);

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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
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
      ).handleSessionStatus(discussion, SessionStatus.NoSession);

      const updatedRow =
        await getTestQueries().discussions.getByOwnerAndContact(
          REFRESH_OWNER_USER_ID,
          REFRESH_CONTACT_USER_ID
        );
      const updated = updatedRow ? toDiscussion(updatedRow) : null;
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.killedNextRetryAt).toBeNull();
      expect(updated?.saturatedRetryAt).toBeNull();
      expect(updated?.saturatedRetryDone).toBe(false);
    });

    it('does nothing for UnknownPeer status', async () => {
      const mockSession = createRefreshSession(SessionStatus.UnknownPeer);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        killedNextRetryAt: new Date(now),
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.UnknownPeer);

      const updated = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.killedNextRetryAt?.getTime()).toBe(now);
    });

    it('retries killed session and schedules next retry', async () => {
      // Mock the random function to return a fixed value -> jitter is 0
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

      const mockSession = createRefreshSession(SessionStatus.Killed);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
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

      const updated = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID, new Uint8Array(0));
      expect(updated?.killedNextRetryAt?.getTime()).toBeGreaterThanOrEqual(
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const now = Date.now();
      const discussion = await createDiscussion({
        killedNextRetryAt: new Date(now + 60 * 1000), // Future time
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Killed);

      const discussionAfter =
        await getTestQueries().discussions.getByOwnerAndContact(
          REFRESH_OWNER_USER_ID,
          REFRESH_CONTACT_USER_ID
        );

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(discussionAfter?.killedNextRetryAt?.getTime()).toEqual(
        now + 60 * 1000
      );
    });

    it('schedules saturated retry when no retry exists', async () => {
      // jitter will be 2s
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);

      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
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

      const updated = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(updated?.saturatedRetryAt?.getTime()).toBeGreaterThanOrEqual(
        now + defaultSdkConfig.sessionRecovery.saturatedRetryDelayMs + 2 * 1000
      );
      expect(updated?.saturatedRetryDone).toBe(false);

      randomSpy.mockRestore();
    });

    it('skips saturated retry when already done', async () => {
      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        saturatedRetryAt: new Date(Date.now() - 1000),
        saturatedRetryDone: true,
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
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const now = new Date();
      const discussion = await createDiscussion({
        saturatedRetryAt: new Date(now.getTime() + 60 * 1000),
        saturatedRetryDone: false,
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      const discussionAfter =
        await getTestQueries().discussions.getByOwnerAndContact(
          REFRESH_OWNER_USER_ID,
          REFRESH_CONTACT_USER_ID
        );

      expect(
        mockDiscussionService.createSessionForContact
      ).not.toHaveBeenCalled();
      expect(discussionAfter?.saturatedRetryAt?.getTime()).toEqual(
        now.getTime() + 60 * 1000
      );
    });

    it('retries saturated session when retry time has passed', async () => {
      const mockSession = createRefreshSession(SessionStatus.Saturated);
      const mockMessageService = createRefreshMessageService();
      const mockDiscussionService = createRefreshDiscussionService();
      const mockAnnouncementService = createRefreshAnnouncementService();
      const refreshService = new RefreshService(
        mockMessageService,
        mockDiscussionService,
        mockAnnouncementService,
        mockSession,
        eventEmitter,
        getTestQueries(),
        defaultSdkConfig
      );
      const discussion = await createDiscussion({
        saturatedRetryAt: new Date(Date.now() - 1000),
        saturatedRetryDone: false,
      });

      await (
        refreshService as unknown as {
          handleSessionStatus: (
            discussion: Discussion,
            status: SessionStatus
          ) => Promise<void>;
        }
      ).handleSessionStatus(discussion, SessionStatus.Saturated);

      const updated = await getTestQueries().discussions.getByOwnerAndContact(
        REFRESH_OWNER_USER_ID,
        REFRESH_CONTACT_USER_ID
      );
      expect(
        mockDiscussionService.createSessionForContact
      ).toHaveBeenCalledWith(REFRESH_CONTACT_USER_ID, new Uint8Array(0));
      expect(updated?.saturatedRetryDone).toBe(true);
    });
  });
});
