/**
 * DiscussionStore Tests
 *
 * Tests for discussion store initialization, sorting, and DB integration.
 * Trivial Zustand setter tests (setFilter) are omitted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useDiscussionStore } from '../../src/stores/discussionStore';
import {
  gossipDb,
  DiscussionDirection,
  SessionStatus,
} from '@massalabs/gossip-sdk';
import { useAccountStore } from '../../src/stores/accountStore';

// Mock sdkStore so getSdk() does not throw. The liveQuery callback calls
// getSdk().db and getSdk().isSessionOpen.
const mockSdk = {
  isSessionOpen: false,
  db: gossipDb(),
  discussions: { getStatus: vi.fn(() => SessionStatus.NoSession) },
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

/** Wait for Dexie liveQuery to propagate to the store. */
const waitForLiveQuery = () => new Promise(resolve => setTimeout(resolve, 150));

describe('DiscussionStore', () => {
  const ownerUserId = 'test-user-id';

  beforeEach(async () => {
    const db = gossipDb();
    await db.delete();
    await db.open();

    mockSdk.isSessionOpen = false;
    mockSdk.discussions.getStatus.mockReturnValue(SessionStatus.NoSession);

    useDiscussionStore.setState({
      discussions: [],
      contacts: [],
      lastMessages: new Map(),
      filter: 'all',
      isInitializing: false,
      subscriptionDiscussions: null,
      subscriptionContacts: null,
    });

    vi.mocked(useAccountStore.getState).mockReturnValue({
      userProfile: { userId: ownerUserId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  afterEach(() => {
    useDiscussionStore.getState().cleanup();
  });

  it('loads discussions from DB via liveQuery', async () => {
    const db = gossipDb();
    await db.discussions.add({
      ownerUserId,
      contactUserId: 'contact-1',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await db.discussions.add({
      ownerUserId,
      contactUserId: 'contact-2',
      direction: DiscussionDirection.RECEIVED,
      weAccepted: false,
      sendAnnouncement: null,
      unreadCount: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    useDiscussionStore.getState().init();
    await waitForLiveQuery();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions).toHaveLength(2);
  });

  it('sorts by lastMessageTimestamp (most recent first) when session is closed', async () => {
    const db = gossipDb();

    // Dexie creating hook overwrites createdAt/updatedAt to new Date(),
    // so we set lastMessageTimestamp after insertion to get deterministic order.
    const idOld = await db.discussions.add({
      ownerUserId,
      contactUserId: 'old-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const idNew = await db.discussions.add({
      ownerUserId,
      contactUserId: 'new-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await db.discussions.update(idOld, {
      lastMessageTimestamp: new Date('2024-01-01'),
    });
    await db.discussions.update(idNew, {
      lastMessageTimestamp: new Date('2024-06-01'),
    });

    useDiscussionStore.getState().init();
    await waitForLiveQuery();

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

    const db = gossipDb();
    const idActive = await db.discussions.add({
      ownerUserId,
      contactUserId: 'active-contact',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const idPending = await db.discussions.add({
      ownerUserId,
      contactUserId: 'pending-contact',
      direction: DiscussionDirection.RECEIVED,
      weAccepted: false,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // Give active a more recent message to verify status priority overrides time
    await db.discussions.update(idActive, {
      lastMessageTimestamp: new Date('2024-06-01'),
    });
    await db.discussions.update(idPending, {
      lastMessageTimestamp: new Date('2024-01-01'),
    });

    useDiscussionStore.getState().init();
    await waitForLiveQuery();

    const discussions = useDiscussionStore.getState().discussions;
    expect(discussions[0].contactUserId).toBe('pending-contact');
    expect(discussions[1].contactUserId).toBe('active-contact');
  });

  it('derives lastMessages map from discussions with message content', async () => {
    const db = gossipDb();
    const idWithMsg = await db.discussions.add({
      ownerUserId,
      contactUserId: 'contact-with-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await db.discussions.add({
      ownerUserId,
      contactUserId: 'contact-no-msg',
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const msgTimestamp = new Date('2024-03-15');
    await db.discussions.update(idWithMsg, {
      lastMessageContent: 'Hello!',
      lastMessageTimestamp: msgTimestamp,
    });

    useDiscussionStore.getState().init();
    await waitForLiveQuery();

    const lastMessages = useDiscussionStore.getState().lastMessages;
    expect(lastMessages.size).toBe(1);
    expect(lastMessages.get('contact-with-msg')).toEqual({
      content: 'Hello!',
      timestamp: msgTimestamp,
    });
    expect(lastMessages.has('contact-no-msg')).toBe(false);
  });
});
