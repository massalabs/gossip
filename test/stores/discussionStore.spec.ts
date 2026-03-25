/**
 * DiscussionStore Tests
 *
 * Tests for discussion store initialization, sorting, and DB integration.
 * Trivial Zustand setter tests (setFilter) are omitted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDiscussionStore } from '../../src/stores/discussionStore';
import {
  Discussion,
  DiscussionDirection,
  SessionStatus,
} from '@massalabs/gossip-sdk';
import { useAccountStore } from '../../src/stores/accountStore';

const defaultDiscussion: Discussion = {
  id: 0,
  ownerUserId: '',
  contactUserId: '',
  direction: DiscussionDirection.INITIATED,
  weAccepted: false,
  unreadCount: 0,
  sendAnnouncement: null,
  nextSeeker: null,
  initiationAnnouncement: null,
  announcementMessage: null,
  lastSyncTimestamp: null,
  customName: null,
  lastMessageId: null,
  lastMessageContent: null,
  lastMessageTimestamp: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  killedNextRetryAt: null,
  saturatedRetryAt: null,
  saturatedRetryDone: false,
  pinned: false,
  mutedNotifications: false,
};

// Mock sdkStore so getSdk() does not throw. The polling callback calls
// getSdk().discussions.list(), getSdk().contacts.list(), etc.
const mockSdk = {
  isSessionOpen: false,
  discussions: {
    getStatus: vi.fn(() => SessionStatus.NoSession),
    list: vi.fn(async () => [] as Discussion[]),
    get: vi.fn(async () => undefined),
  },
  contacts: {
    list: vi.fn(async () => []),
  },
  messages: {
    getMessages: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
  },
  on: vi.fn(),
  off: vi.fn(),
};
vi.mock('../../src/stores/sdkStore', () => ({
  useSdkStore: {
    getState: vi.fn(() => ({ sdk: mockSdk, setSdk: vi.fn() })),
    use: { sdk: () => mockSdk },
  },
  getSdk: () => mockSdk,
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => ({
      userProfile: { userId: 'test-user-id' },
    })),
  },
}));

/** Wait for async polling to propagate to the store. */
const waitForPolling = () => new Promise(resolve => setTimeout(resolve, 150));

describe('DiscussionStore', () => {
  const ownerUserId = 'test-user-id';

  beforeEach(async () => {
    mockSdk.isSessionOpen = false;
    mockSdk.discussions.getStatus.mockReturnValue(SessionStatus.NoSession);
    mockSdk.discussions.list.mockResolvedValue([] as Discussion[]);
    mockSdk.contacts.list.mockResolvedValue([]);

    useDiscussionStore.setState({
      discussions: [],
      contacts: [],
      lastMessages: new Map(),
      filter: 'all',
      isInitializing: false,
      pollTimer: null,
      eventHandler: null,
    });

    vi.mocked(useAccountStore.getState).mockReturnValue({
      userProfile: { userId: ownerUserId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    useDiscussionStore.getState().cleanup();
    mockSdk.discussions.getStatus.mockClear();
    mockSdk.discussions.list.mockClear();
  });

  it('loads discussions from DB via polling', async () => {
    const d1 = {
      ...defaultDiscussion,
      ownerUserId,
      contactUserId: 'contact-1',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const d2 = {
      ...defaultDiscussion,
      ownerUserId,
      contactUserId: 'contact-2',
      direction: DiscussionDirection.RECEIVED,
      weAccepted: false,
      unreadCount: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Mock discussions.list to return these discussions
    mockSdk.isSessionOpen = true;
    mockSdk.discussions.list.mockResolvedValue([
      { ...d1, id: 1 },
      { ...d2, id: 2 },
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions).toHaveLength(2);
  });

  it('sorts by lastMessageTimestamp (most recent first) when session is closed', async () => {
    const oldDiscussion = {
      ...defaultDiscussion,
      id: 1,
      ownerUserId,
      contactUserId: 'old-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageTimestamp: new Date('2024-01-01'),
      lastMessageContent: 'old',
    };

    const newDiscussion = {
      ...defaultDiscussion,
      id: 2,
      ownerUserId,
      contactUserId: 'new-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageTimestamp: new Date('2024-06-01'),
      lastMessageContent: 'new',
    };

    // Return in wrong order, store should sort
    mockSdk.isSessionOpen = true;
    mockSdk.discussions.list.mockResolvedValue([
      oldDiscussion,
      newDiscussion,
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions[0].contactUserId).toBe('new-msg');
    expect(discussions[1].contactUserId).toBe('old-msg');
  });

  it('sorts pending discussions before active when session is open', async () => {
    mockSdk.isSessionOpen = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockSdk.discussions.getStatus as any).mockImplementation(
      (contactUserId: string) => {
        if (contactUserId === 'pending-contact')
          return SessionStatus.PeerRequested;
        if (contactUserId === 'active-contact') return SessionStatus.Active;
        return SessionStatus.NoSession;
      }
    );

    const activeDiscussion = {
      ...defaultDiscussion,
      id: 1,
      ownerUserId,
      contactUserId: 'active-contact',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      unreadCount: 0,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageTimestamp: new Date('2024-06-01'),
    };

    const pendingDiscussion = {
      ...defaultDiscussion,
      id: 2,
      ownerUserId,
      contactUserId: 'pending-contact',
      direction: DiscussionDirection.RECEIVED,
      weAccepted: false,
      unreadCount: 0,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastMessageTimestamp: new Date('2024-01-01'),
    };

    mockSdk.discussions.list.mockResolvedValue([
      activeDiscussion,
      pendingDiscussion,
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const discussions = useDiscussionStore.getState().discussions;
    console.log(discussions);
    expect(discussions[0].contactUserId).toBe('pending-contact');
    expect(discussions[1].contactUserId).toBe('active-contact');
  });

  it('derives lastMessages map from discussions with message content', async () => {
    mockSdk.isSessionOpen = true;

    const msgTimestamp = new Date('2024-03-15');
    mockSdk.discussions.list.mockResolvedValue([
      {
        id: 1,
        ownerUserId,
        contactUserId: 'contact-with-msg',
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastMessageContent: 'Hello!',
        lastMessageTimestamp: msgTimestamp,
      },
      {
        id: 2,
        ownerUserId,
        contactUserId: 'contact-no-msg',
        direction: DiscussionDirection.INITIATED,
        weAccepted: true,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const lastMessages = useDiscussionStore.getState().lastMessages;
    expect(lastMessages.size).toBe(1);
    expect(lastMessages.get('contact-with-msg')).toEqual({
      content: 'Hello!',
      timestamp: msgTimestamp,
    });
    expect(lastMessages.has('contact-no-msg')).toBe(false);
  });

  it('places pinned discussions before unpinned regardless of recency', async () => {
    mockSdk.isSessionOpen = true;

    const recentUnpinned = {
      ...defaultDiscussion,
      id: 1,
      ownerUserId,
      contactUserId: 'recent-unpinned',
      pinned: false,
      lastMessageTimestamp: new Date('2024-06-01'),
    };

    const olderPinned = {
      ...defaultDiscussion,
      id: 2,
      ownerUserId,
      contactUserId: 'older-pinned',
      pinned: true,
      lastMessageTimestamp: new Date('2024-01-01'),
    };

    mockSdk.discussions.list.mockResolvedValue([
      recentUnpinned,
      olderPinned,
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions).toHaveLength(2);
    expect(discussions[0].contactUserId).toBe('older-pinned');
    expect(discussions[1].contactUserId).toBe('recent-unpinned');
  });

  it('keeps multiple pinned discussions on top and sorts them by recency', async () => {
    mockSdk.isSessionOpen = true;

    const olderPinned = {
      ...defaultDiscussion,
      id: 1,
      ownerUserId,
      contactUserId: 'older-pinned',
      pinned: true,
      lastMessageTimestamp: new Date('2024-01-01'),
    };

    const newerPinned = {
      ...defaultDiscussion,
      id: 2,
      ownerUserId,
      contactUserId: 'newer-pinned',
      pinned: true,
      lastMessageTimestamp: new Date('2024-06-01'),
    };

    const unpinned = {
      ...defaultDiscussion,
      id: 3,
      ownerUserId,
      contactUserId: 'unpinned',
      pinned: false,
      lastMessageTimestamp: new Date('2024-07-01'),
    };

    mockSdk.discussions.list.mockResolvedValue([
      unpinned,
      olderPinned,
      newerPinned,
    ] as Discussion[]);

    useDiscussionStore.getState().init();
    await waitForPolling();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions.map(d => d.contactUserId)).toEqual([
      'newer-pinned',
      'older-pinned',
      'unpinned',
    ]);
  });
});
