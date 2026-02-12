import { create } from 'zustand';
import { Subscription } from 'dexie';
import { liveQuery } from 'dexie';
import {
  Contact,
  SessionStatus,
} from '@massalabs/gossip-sdk';
import { db, type Discussion } from '../db';
import { getSdk } from './sdkStore';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';

export type DiscussionFilter = 'all' | 'unread' | 'pending';

interface DiscussionStoreState {
  discussions: Discussion[];
  contacts: Contact[];
  lastMessages: Map<string, { content: string; timestamp: Date }>;
  openNameModals: Set<number>;
  subscriptionDiscussions: Subscription | null;
  subscriptionContacts: Subscription | null;
  isInitializing: boolean;
  filter: DiscussionFilter;

  init: () => void;
  getDiscussionsForContact: (contactUserId: string) => Discussion[];
  getDiscussionsByStatus: (status: SessionStatus[]) => Discussion[];
  cleanup: () => void;
  setModalOpen: (discussionId: number, isOpen: boolean) => void;
  isModalOpen: (discussionId: number) => boolean;
  setFilter: (filter: DiscussionFilter) => void;
}

const useDiscussionStoreBase = create<DiscussionStoreState>((set, get) => ({
  discussions: [],
  contacts: [],
  lastMessages: new Map(),
  openNameModals: new Set<number>(),
  subscriptionDiscussions: null,
  subscriptionContacts: null,
  isInitializing: false,
  filter: 'all',

  init: () => {
    const ownerUserId = useAccountStore.getState().userProfile?.userId;

    if (
      !ownerUserId ||
      (get().subscriptionDiscussions && get().subscriptionContacts) ||
      get().isInitializing
    )
      return;

    set({ isInitializing: true });

    // Set up liveQuery for discussions
    const discussionsQuery = liveQuery(() =>
      db.discussions.where('ownerUserId').equals(ownerUserId).toArray()
    );

    const subscriptionDiscussions = discussionsQuery.subscribe({
      next: async discussionsList => {
        // Check if SDK session is open before attempting to get status
        const isSessionOpen = getSdk().isSessionOpen;

        // Sort discussions: new requests (PENDING) first, then active discussions
        // Within each group, sort by most recent activity
        const getActivityTime = (discussion: Discussion): number => {
          // New messages always bubble to top within their group
          if (discussion.lastMessageTimestamp) {
            return discussion.lastMessageTimestamp.getTime();
          }

          // For pending requests, use updatedAt (only if session is open)
          if (isSessionOpen) {
            const status = getSdk().discussions.getStatus(
              discussion.contactUserId
            );
            if (
              [
                SessionStatus.SelfRequested,
                SessionStatus.PeerRequested,
              ].includes(status) &&
              discussion.updatedAt
            ) {
              return discussion.updatedAt.getTime();
            }
          }

          // Fallback to creation time for all other cases
          return discussion.createdAt.getTime();
        };

        const getStatusPriority = (status: SessionStatus): number => {
          // PENDING (new requests) = highest priority (0)
          if (
            [SessionStatus.SelfRequested, SessionStatus.PeerRequested].includes(
              status
            )
          )
            return 0;
          // ACTIVE (ongoing discussions) = medium priority (1)
          if (status === SessionStatus.Active) return 1;
          // All other statuses = lowest priority (2)
          return 2;
        };

        const sortedDiscussions = discussionsList.sort((a, b) => {
          // If session is open, separate by status: PENDING first, then ACTIVE, then others
          if (isSessionOpen) {
            const aStatus = getSdk().discussions.getStatus(a.contactUserId);
            const bStatus = getSdk().discussions.getStatus(b.contactUserId);
            const statusDiff =
              getStatusPriority(aStatus) - getStatusPriority(bStatus);
            if (statusDiff !== 0) return statusDiff;
          }

          // Within the same status group (or when session is closed), sort by activity time
          return getActivityTime(b) - getActivityTime(a);
        });

        // Derive lastMessages
        const messagesMap = new Map<
          string,
          { content: string; timestamp: Date }
        >();
        sortedDiscussions.forEach(discussion => {
          if (
            discussion.lastMessageContent &&
            discussion.lastMessageTimestamp
          ) {
            messagesMap.set(discussion.contactUserId, {
              content: discussion.lastMessageContent,
              timestamp: discussion.lastMessageTimestamp,
            });
          }
        });

        set({ discussions: sortedDiscussions, lastMessages: messagesMap });
      },
      error: error => {
        console.error('Discussions live query error:', error);
      },
    });

    // Set up liveQuery for contacts
    const contactsQuery = liveQuery(() =>
      db.contacts.where('ownerUserId').equals(ownerUserId).toArray()
    );

    const subscriptionContacts = contactsQuery.subscribe({
      next: contactsList => {
        set({ contacts: contactsList });
      },
      error: error => {
        console.error('Contacts live query error:', error);
      },
    });

    set({
      subscriptionDiscussions,
      subscriptionContacts,
      isInitializing: false,
    });
  },

  getDiscussionsForContact: (contactUserId: string) => {
    const ownerUserId = useAccountStore.getState().userProfile?.userId;
    if (!ownerUserId) return [];
    return get().discussions.filter(
      discussion => discussion.contactUserId === contactUserId
    );
  },

  getDiscussionsByStatus: (status: SessionStatus[]) => {
    const ownerUserId = useAccountStore.getState().userProfile?.userId;
    if (!ownerUserId) return [];
    // Return empty array if session is not open (cannot get status)
    if (!getSdk().isSessionOpen) return [];
    return get().discussions.filter(discussion => {
      return status.includes(
        getSdk().discussions.getStatus(discussion.contactUserId)
      );
    });
  },

  cleanup: () => {
    const subDisc = get().subscriptionDiscussions;
    if (subDisc) subDisc.unsubscribe();
    const subCont = get().subscriptionContacts;
    if (subCont) subCont.unsubscribe();
    set({
      subscriptionDiscussions: null,
      subscriptionContacts: null,
      discussions: [],
      contacts: [],
      lastMessages: new Map(),
    });
  },

  setModalOpen: (discussionId: number, isOpen: boolean) => {
    const currentModals = get().openNameModals;
    const currentlyOpen = currentModals.has(discussionId);

    if (isOpen === currentlyOpen) return;

    const openModals = new Set(currentModals);
    if (isOpen) {
      openModals.add(discussionId);
    } else {
      openModals.delete(discussionId);
    }
    set({ openNameModals: openModals });
  },

  isModalOpen: (discussionId: number) => {
    return get().openNameModals.has(discussionId);
  },

  setFilter: (filter: DiscussionFilter) => {
    set({ filter });
  },
}));

export const useDiscussionStore = createSelectors(useDiscussionStoreBase);
