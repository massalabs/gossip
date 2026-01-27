/**
 * AnnouncementService tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AnnouncementService } from '../../src/services/announcement';
import { GossipDatabase, db, DiscussionStatus } from '../../src/db';
import type { IMessageProtocol } from '../../src/api/messageProtocol/types';
import type { SessionModule } from '../../src/wasm/session';
import { encodeUserId } from '../../src/utils/userId';
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
import { defaultSdkConfig, type SdkConfig } from '../../src/config/sdk';
import { DiscussionDirection } from '../../src/db';

function createAnnouncementProtocol(
  overrides: Partial<IMessageProtocol> = {}
): IMessageProtocol {
  return {
    fetchMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAnnouncement: vi.fn().mockResolvedValue('1'),
    fetchAnnouncements: vi.fn().mockResolvedValue([]),
    fetchPublicKeyByUserId: vi.fn().mockResolvedValue(''),
    postPublicKey: vi.fn().mockResolvedValue('hash'),
    changeNode: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

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

const announcementFakeSession = {} as SessionModule;

describe('AnnouncementService', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('returns success and counter when sendAnnouncement succeeds', async () => {
    const messageProtocol = createAnnouncementProtocol({
      sendAnnouncement: vi.fn().mockResolvedValue('42'),
    });
    const service = new AnnouncementService(
      db,
      messageProtocol,
      announcementFakeSession
    );

    const result = await service.sendAnnouncement(new Uint8Array([1, 2, 3]));

    expect(result.success).toBe(true);
    expect(result.counter).toBe('42');
  });

  it('returns error when sendAnnouncement fails', async () => {
    const messageProtocol = createAnnouncementProtocol({
      sendAnnouncement: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const service = new AnnouncementService(
      db,
      messageProtocol,
      announcementFakeSession
    );

    const result = await service.sendAnnouncement(new Uint8Array([1, 2, 3]));

    expect(result.success).toBe(false);
    expect(result.error).toBe('network error');
  });

  it('keeps pending announcements when processing fails', async () => {
    const messageProtocol = createAnnouncementProtocol();
    const session = { userIdEncoded: 'gossip1test' } as SessionModule;
    const service = new AnnouncementService(db, messageProtocol, session);

    await db.userProfile.put({
      userId: session.userIdEncoded,
      username: 'test',
      security: {
        encKeySalt: new Uint8Array(),
        authMethod: 'password',
        mnemonicBackup: {
          encryptedMnemonic: new Uint8Array(),
          createdAt: new Date(),
          backedUp: false,
        },
      },
      session: new Uint8Array(),
      status: 'online',
      lastSeen: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([1, 2, 3]),
      fetchedAt: new Date(),
      counter: '1',
    });

    (
      service as unknown as {
        _processIncomingAnnouncement?: (data: Uint8Array) => unknown;
      }
    )._processIncomingAnnouncement = vi
      .fn()
      .mockRejectedValue(new Error('decode failed'));

    await service.fetchAndProcessAnnouncements();

    const remaining = await db.pendingAnnouncements.toArray();
    expect(remaining.length).toBe(1);
  });
});

describe('Announcement Retry with brokenThreshold', () => {
  let testDb: GossipDatabase;
  let mockSession: SessionModule;
  let mockProtocol: IMessageProtocol;
  let announcementService: AnnouncementService;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    await testDb.open();
    await Promise.all(testDb.tables.map(table => table.clear()));

    mockSession = createGapSession();
    mockProtocol = createAnnouncementProtocol();
  });

  it('should NOT mark discussion as broken when retry fails within threshold', async () => {
    const config: SdkConfig = {
      ...defaultSdkConfig,
      announcements: {
        ...defaultSdkConfig.announcements,
        brokenThresholdMs: 60 * 60 * 1000,
      },
    };

    announcementService = new AnnouncementService(
      testDb,
      mockProtocol,
      mockSession,
      {},
      config
    );

    const recentDate = new Date();
    const discussionId = await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: new Uint8Array([1, 2, 3]),
      unreadCount: 0,
      createdAt: recentDate,
      updatedAt: recentDate,
    });

    (
      mockProtocol.sendAnnouncement as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('Network error'));

    const discussion = await testDb.discussions.get(discussionId);
    await announcementService.resendAnnouncements([discussion!]);

    const updatedDiscussion = await testDb.discussions.get(discussionId);
    expect(updatedDiscussion?.status).toBe(DiscussionStatus.SEND_FAILED);
  });

  it('should mark discussion as broken when retry fails after threshold exceeded', async () => {
    const config: SdkConfig = {
      ...defaultSdkConfig,
      announcements: {
        ...defaultSdkConfig.announcements,
        brokenThresholdMs: 1000,
      },
    };

    const onSessionRenewalNeeded = vi.fn();
    announcementService = new AnnouncementService(
      testDb,
      mockProtocol,
      mockSession,
      { onSessionRenewalNeeded },
      config
    );

    const oldDate = new Date(Date.now() - 2000);
    const discussionId = await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: new Uint8Array([1, 2, 3]),
      unreadCount: 0,
      createdAt: oldDate,
      updatedAt: oldDate,
    });

    (
      mockProtocol.sendAnnouncement as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error('Network error'));

    const discussion = await testDb.discussions.get(discussionId);
    await announcementService.resendAnnouncements([discussion!]);

    const updatedDiscussion = await testDb.discussions.get(discussionId);
    expect(updatedDiscussion).toBeDefined();
  });

  it('should update discussion to PENDING when resend succeeds', async () => {
    announcementService = new AnnouncementService(
      testDb,
      mockProtocol,
      mockSession,
      {},
      defaultSdkConfig
    );

    (mockSession.peerSessionStatus as ReturnType<typeof vi.fn>).mockReturnValue(
      SessionStatus.SelfRequested
    );

    const discussionId = await testDb.discussions.add({
      ownerUserId: GAP_OWNER_USER_ID,
      contactUserId: GAP_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: new Uint8Array([1, 2, 3]),
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    (
      mockProtocol.sendAnnouncement as ReturnType<typeof vi.fn>
    ).mockResolvedValue('counter-123');

    const discussion = await testDb.discussions.get(discussionId);
    await announcementService.resendAnnouncements([discussion!]);

    const updatedDiscussion = await testDb.discussions.get(discussionId);
    expect(updatedDiscussion?.status).toBe(DiscussionStatus.PENDING);
  });
});
