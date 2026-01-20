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
import { db, DiscussionStatus, DiscussionDirection } from '../../src/db';
import { useAccountStore } from '../../src/stores/accountStore';

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
    // Clean up database
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
    it('should calculate correct filter counts for all discussions', async () => {
      // Create test discussions
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-1',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: new Date(now.getTime() - 1000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-2',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 5,
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: new Date(now.getTime() - 2000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-3',
          status: DiscussionStatus.PENDING,
          direction: DiscussionDirection.RECEIVED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 3000),
          updatedAt: new Date(now.getTime() - 3000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-4',
          status: DiscussionStatus.CLOSED,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 4000),
          updatedAt: new Date(now.getTime() - 4000),
        },
      ];

      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      // Initialize store to load discussions
      useDiscussionStore.getState().init();

      // Wait for store to update (liveQuery is async)
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;

      // Calculate filter counts (same logic as in Discussions.tsx)
      const allCount = storeDiscussions.filter(
        d => d.status !== DiscussionStatus.CLOSED
      ).length;
      const unreadCount = storeDiscussions.filter(
        d => d.status === DiscussionStatus.ACTIVE && d.unreadCount > 0
      ).length;
      const pendingCount = storeDiscussions.filter(
        d => d.status === DiscussionStatus.PENDING
      ).length;

      expect(allCount).toBe(3); // 3 non-closed discussions
      expect(unreadCount).toBe(1); // 1 active discussion with unread messages
      expect(pendingCount).toBe(1); // 1 pending discussion
    });

    it('should handle empty discussions list', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const discussions: any[] = [];

      const allCount = discussions.filter(
        d => d.status !== DiscussionStatus.CLOSED
      ).length;
      const unreadCount = discussions.filter(
        d => d.status === DiscussionStatus.ACTIVE && d.unreadCount > 0
      ).length;
      const pendingCount = discussions.filter(
        d => d.status === DiscussionStatus.PENDING
      ).length;

      expect(allCount).toBe(0);
      expect(unreadCount).toBe(0);
      expect(pendingCount).toBe(0);
    });

    it('should correctly count unread discussions', async () => {
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-1',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 3,
          createdAt: now,
          updatedAt: now,
        },
        {
          ownerUserId,
          contactUserId: 'contact-2',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0, // No unread messages
          createdAt: now,
          updatedAt: now,
        },
        {
          ownerUserId,
          contactUserId: 'contact-3',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 1,
          createdAt: now,
          updatedAt: now,
        },
      ];

      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      useDiscussionStore.getState().init();
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;
      const unreadCount = storeDiscussions.filter(
        d => d.status === DiscussionStatus.ACTIVE && d.unreadCount > 0
      ).length;

      expect(unreadCount).toBe(2); // 2 active discussions with unread messages
    });

    it('should exclude closed discussions from all count', async () => {
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-1',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          ownerUserId,
          contactUserId: 'contact-2',
          status: DiscussionStatus.CLOSED,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          ownerUserId,
          contactUserId: 'contact-3',
          status: DiscussionStatus.PENDING,
          direction: DiscussionDirection.RECEIVED,
          unreadCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      ];

      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      useDiscussionStore.getState().init();
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allCount = (storeDiscussions as any[]).filter(
        d => d.status !== DiscussionStatus.CLOSED
      ).length;

      expect(allCount).toBe(2); // Only 2 non-closed discussions
    });
  });

  describe('Store Sorting', () => {
    it('should sort discussions with PENDING first, then ACTIVE', async () => {
      const now = new Date();
      const discussions = [
        {
          ownerUserId,
          contactUserId: 'contact-active-1',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 1000),
          updatedAt: new Date(now.getTime() - 1000),
          lastMessageTimestamp: new Date(now.getTime() - 1000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-pending-1',
          status: DiscussionStatus.PENDING,
          direction: DiscussionDirection.RECEIVED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 2000),
          updatedAt: new Date(now.getTime() - 2000),
        },
        {
          ownerUserId,
          contactUserId: 'contact-active-2',
          status: DiscussionStatus.ACTIVE,
          direction: DiscussionDirection.INITIATED,
          unreadCount: 0,
          createdAt: new Date(now.getTime() - 500),
          updatedAt: new Date(now.getTime() - 500),
          lastMessageTimestamp: new Date(now.getTime() - 500),
        },
      ];

      for (const discussion of discussions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.discussions.add(discussion as any);
      }

      useDiscussionStore.getState().init();
      await new Promise(resolve => setTimeout(resolve, 100));

      const storeDiscussions = useDiscussionStore.getState().discussions;

      // PENDING should come first
      expect(storeDiscussions[0].status).toBe(DiscussionStatus.PENDING);
      expect(storeDiscussions[0].contactUserId).toBe('contact-pending-1');

      // Then ACTIVE discussions
      expect(storeDiscussions[1].status).toBe(DiscussionStatus.ACTIVE);
      expect(storeDiscussions[2].status).toBe(DiscussionStatus.ACTIVE);
    });
  });
});
