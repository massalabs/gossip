/**
 * DiscussionStore Filter Tests
 *
 * Tests for the discussion store filter functionality including:
 * - Filter state management (setFilter, initial state)
 * - Filter counts calculation logic
 * - Filtering behavior
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useDiscussionStore } from '../../src/stores/discussionStore';
import {
  gossipDb,
  DiscussionDirection,
  SessionStatus,
} from '@massalabs/gossip-sdk';
import { useAccountStore } from '../../src/stores/accountStore';

// Mock sdkStore so getSdk() does not throw. The liveQuery callback calls
// getSdk().db.discussions and getSdk().isSessionOpen — without this mock it throws.
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

// Mock the account store
vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => ({
      userProfile: { userId: 'test-user-id' },
    })),
  },
}));

describe('DiscussionStore Filter', () => {
  const ownerUserId = 'test-user-id';

  beforeEach(async () => {
    const db = gossipDb();
    await db.delete();
    await db.open();

    // Reset store state
    useDiscussionStore.setState({
      discussions: [],
      contacts: [],
      lastMessages: new Map(),
      filter: 'all',
      isInitializing: false,
      subscriptionDiscussions: null,
      subscriptionContacts: null,
    });

    // Mock account store
    vi.mocked(useAccountStore.getState).mockReturnValue({
      userProfile: { userId: ownerUserId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  describe('Initial State', () => {
    it('should initialize with filter set to "all"', () => {
      const filter = useDiscussionStore.getState().filter;
      expect(filter).toBe('all');
    });
  });

  describe('setFilter', () => {
    it('should update filter to "unread"', () => {
      const setFilter = useDiscussionStore.getState().setFilter;
      setFilter('unread');

      const filter = useDiscussionStore.getState().filter;
      expect(filter).toBe('unread');
    });

    it('should update filter to "pending"', () => {
      const setFilter = useDiscussionStore.getState().setFilter;
      setFilter('pending');

      const filter = useDiscussionStore.getState().filter;
      expect(filter).toBe('pending');
    });

    it('should update filter back to "all"', () => {
      const setFilter = useDiscussionStore.getState().setFilter;
      setFilter('unread');
      setFilter('all');

      const filter = useDiscussionStore.getState().filter;
      expect(filter).toBe('all');
    });
  });

  describe('Filter Counts Calculation', () => {
    it('should load discussions without throwing even when SDK session is not open', async () => {
      // Create test discussions (minimal fields required by store sorting)
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-1',
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: new Date(now.getTime() - 1000),
          lastMessageTimestamp: new Date(now.getTime() - 1000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-2',
          direction: DiscussionDirection.INITIATED,
          unreadCount: 5,
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: new Date(now.getTime() - 2000),
          lastMessageTimestamp: new Date(now.getTime() - 2000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-3',
          direction: DiscussionDirection.RECEIVED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 3000),
          updatedAt: new Date(now.getTime() - 3000),
        },
      ];

      const db = gossipDb();
      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      expect(() => useDiscussionStore.getState().init()).not.toThrow();

      // Wait for store to update (liveQuery is async)
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;
      expect(storeDiscussions.length).toBe(3);
    });

    // Legacy unread/closed counting tests removed: the app now derives "pending/unread"
    // from `gossipSdk.discussions.getStatus()` (SessionStatus), which requires a session.
  });

  describe('Store Sorting', () => {
    it('should sort by lastMessageTimestamp when SDK session is not open (fallback behavior)', async () => {
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-active-1',
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: new Date(now.getTime() - 1000),
          lastMessageTimestamp: new Date(now.getTime() - 1000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-pending-1',
          direction: DiscussionDirection.RECEIVED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: new Date(now.getTime() - 2000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-active-2',
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 500),
          updatedAt: new Date(now.getTime() - 500),
          lastMessageTimestamp: new Date(now.getTime() - 500),
        },
      ];

      const db = gossipDb();
      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      useDiscussionStore.getState().init();
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;

      // With no session open, store can't classify "pending" via SessionStatus.
      // Also note: `src/db` has a Dexie "creating" hook that overwrites `createdAt/updatedAt`
      // to "now" for all inserted discussions, so a discussion *without* `lastMessageTimestamp`
      // can still bubble to the top via `createdAt`.
      expect(storeDiscussions[0].contactUserId).toBe('contact-pending-1');
      expect(storeDiscussions[1].contactUserId).toBe('contact-active-2');
      expect(storeDiscussions[2].contactUserId).toBe('contact-active-1');
    });
  });
});
