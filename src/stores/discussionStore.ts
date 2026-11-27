import { logger } from '../utils/logger.ts';
import { create } from 'zustand';
import { Contact, SessionStatus, SELF_CONTACT_ID } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { createDiscussionEventHandlers } from './discussionStore.events';
import { createSelectors } from './utils/createSelectors';
import { shownStatus } from '../utils/conversations';
import { useAccountStore } from './accountStore';

/** `archived`: the archives the user moved out of the list (§5.12), on their own page. */
export type DiscussionFilter = 'all' | 'unread' | 'pending' | 'archived';

interface DiscussionStoreState {
  discussions: Discussion[];
  sessionsStatuses: Map<string, SessionStatus>;
  contacts: Contact[];
  lastMessages: Map<string, { content: string; timestamp: Date }>;
  openNameModals: Set<number>;
  cleanupFn: (() => void) | null;
  isInitializing: boolean;
  filter: DiscussionFilter;

  init: () => void;
  cleanup: () => void;
  setModalOpen: (discussionId: number, isOpen: boolean) => void;
  isModalOpen: (discussionId: number) => boolean;
  setFilter: (filter: DiscussionFilter) => void;
  patchDiscussion: (discussionId: number, patch: Partial<Discussion>) => void;
}

const useDiscussionStoreBase = create<DiscussionStoreState>((set, get) => ({
  discussions: [],
  sessionsStatuses: new Map<string, SessionStatus>(),
  contacts: [],
  lastMessages: new Map(),
  openNameModals: new Set<number>(),
  cleanupFn: null,
  isInitializing: false,
  filter: 'all',

  init: () => {
    const ownerUserId = useAccountStore.getState().userProfile?.userId;

    if (!ownerUserId || get().cleanupFn || get().isInitializing) return;

    set({ isInitializing: true });

    // Set by cleanup() so an in-flight fetch can't repopulate the store
    // with the previous account's data after logout.
    let disposed = false;
    let isFetching = false;
    // Peers whose status is shown as a request waiting (`shownStatus`).
    const shownAsRequest = new Set<string>();
    const fetchData = async () => {
      if (isFetching || disposed) return;
      isFetching = true;
      try {
        const sdk = getSdk();
        const isSessionOpen = sdk.isSessionOpen;

        // Fetch discussions
        const discussionsList = isSessionOpen
          ? await sdk.discussions.list()
          : [];
        if (disposed) return;

        // Fetch contacts
        let contactsList: Contact[] = [];
        if (isSessionOpen) {
          contactsList = await sdk.contacts.list();
        }
        if (disposed) return;
        const contactOf = new Map(contactsList.map(c => [c.userId, c]));

        // Initialize sessionsStatuses map if empty. The request of a member
        // of a shared chat is shown as a request waiting, its connection
        // open or not (§5.12); once answered, its live status again.
        if (isSessionOpen) {
          const initial = get().sessionsStatuses.size === 0;
          const statusMap = new Map(get().sessionsStatuses);
          for (const d of discussionsList) {
            if (d.contactUserId === SELF_CONTACT_ID) continue;
            const contact = contactOf.get(d.contactUserId);
            const isRequest = contact?.connection === 'requested';
            if (!initial && !isRequest && !shownAsRequest.has(d.contactUserId))
              continue;
            if (isRequest) shownAsRequest.add(d.contactUserId);
            else shownAsRequest.delete(d.contactUserId);
            statusMap.set(
              d.contactUserId,
              shownStatus(sdk.discussions.getStatus(d.contactUserId), contact)
            );
          }
          set({ sessionsStatuses: statusMap });
        }

        // Sort discussions. Snapshot the statuses once instead of re-reading
        // the store inside the comparator (O(n log n) store reads otherwise).
        const statuses = get().sessionsStatuses;
        const isRequested = (status: SessionStatus | undefined): boolean =>
          status === SessionStatus.SelfRequested ||
          status === SessionStatus.PeerRequested;

        const getActivityTime = (discussion: Discussion): number => {
          if (discussion.lastMessageTimestamp) {
            return discussion.lastMessageTimestamp.getTime();
          }
          const status = statuses.get(discussion.contactUserId);
          if (isRequested(status) && discussion.updatedAt) {
            return discussion.updatedAt.getTime();
          }
          return discussion.createdAt.getTime();
        };

        const getStatusPriority = (
          status: SessionStatus | undefined
        ): number => {
          if (isRequested(status)) return 0;
          if (status === SessionStatus.Active) return 1;
          return 2;
        };

        const getPinnedPriority = (discussion: Discussion): number =>
          discussion.pinned ? 0 : 1;

        // Sort a copy — the SDK owns the array returned by list().
        const sortedDiscussions = [...discussionsList].sort((a, b) => {
          const pinnedDiff = getPinnedPriority(a) - getPinnedPriority(b);
          if (pinnedDiff !== 0) return pinnedDiff;

          if (isSessionOpen) {
            const statusDiff =
              getStatusPriority(statuses.get(a.contactUserId)) -
              getStatusPriority(statuses.get(b.contactUserId));
            if (statusDiff !== 0) return statusDiff;
          }

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

        set({
          discussions: sortedDiscussions,
          lastMessages: messagesMap,
          contacts: contactsList,
        });
      } catch (error) {
        logger.error('Discussion/contacts fetch error:', error);
      } finally {
        isFetching = false;
      }
    };

    // Initial fetch
    fetchData();

    const sdk = getSdk();
    const removeEventHandlers = createDiscussionEventHandlers(
      sdk,
      set,
      fetchData
    );
    const cleanupFn = () => {
      disposed = true;
      removeEventHandlers();
    };

    set({ cleanupFn, isInitializing: false });
  },

  cleanup: () => {
    get().cleanupFn?.();
    set({
      sessionsStatuses: new Map<string, SessionStatus>(),
      cleanupFn: null,
      isInitializing: false,
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

  patchDiscussion: (discussionId: number, patch: Partial<Discussion>) => {
    set(state => ({
      discussions: state.discussions.map(d =>
        d.id === discussionId ? { ...d, ...patch } : d
      ),
    }));
  },
}));

export const useDiscussionStore = createSelectors(useDiscussionStoreBase);
