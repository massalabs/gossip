import { create } from 'zustand';
import {
  Contact,
  SessionStatus,
  SdkEventType,
  SELF_CONTACT_ID,
} from '@massalabs/gossip-sdk';
import type { Discussion, Message } from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';

export type DiscussionFilter = 'all' | 'unread' | 'pending';

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
  getDiscussionsForContact: (contactUserId: string) => Discussion[];
  getDiscussionsByStatus: (status: SessionStatus[]) => Discussion[];
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

    let isFetching = false;
    const fetchData = async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const sdk = getSdk();
        const isSessionOpen = sdk.isSessionOpen;

        // Fetch discussions
        const discussionsList = isSessionOpen
          ? await sdk.discussions.list()
          : [];

        // Initialize sessionsStatuses map if empty
        if (isSessionOpen && get().sessionsStatuses.size === 0) {
          const statusMap = new Map<string, SessionStatus>();
          for (const d of discussionsList) {
            if (d.contactUserId === SELF_CONTACT_ID) continue;
            statusMap.set(
              d.contactUserId,
              sdk.discussions.getStatus(d.contactUserId)
            );
          }
          set({ sessionsStatuses: statusMap });
        }

        // Sort discussions
        const getActivityTime = (discussion: Discussion): number => {
          if (discussion.lastMessageTimestamp) {
            return discussion.lastMessageTimestamp.getTime();
          }
          const status = get().sessionsStatuses.get(discussion.contactUserId);
          if (
            status &&
            [SessionStatus.SelfRequested, SessionStatus.PeerRequested].includes(
              status
            ) &&
            discussion.updatedAt
          ) {
            return discussion.updatedAt.getTime();
          }
          return discussion.createdAt.getTime();
        };

        const getStatusPriority = (status: SessionStatus): number => {
          if (
            [SessionStatus.SelfRequested, SessionStatus.PeerRequested].includes(
              status
            )
          )
            return 0;
          if (status === SessionStatus.Active) return 1;
          return 2;
        };

        const getPinnedPriority = (discussion: Discussion): number =>
          discussion.pinned ? 0 : 1;

        const sortedDiscussions = discussionsList.sort((a, b) => {
          const pinnedDiff = getPinnedPriority(a) - getPinnedPriority(b);
          if (pinnedDiff !== 0) return pinnedDiff;

          if (isSessionOpen) {
            const statusDiff =
              getStatusPriority(get().sessionsStatuses.get(a.contactUserId)!) -
              getStatusPriority(get().sessionsStatuses.get(b.contactUserId)!);
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

        // Fetch contacts
        let contactsList: Contact[] = [];
        if (isSessionOpen) {
          contactsList = await sdk.contacts.list();
        }

        set({
          discussions: sortedDiscussions,
          lastMessages: messagesMap,
          contacts: contactsList,
        });
      } catch (error) {
        console.error('Discussion/contacts fetch error:', error);
      } finally {
        isFetching = false;
      }
    };

    // Initial fetch
    fetchData();

    // Event-driven refetch (debounced to collapse rapid events)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchData, 100);
    };

    // Optimistic: update lastMessages immediately on outgoing/incoming messages
    const onMessageEvent = (message: Message) => {
      set(state => {
        const lastMessages = new Map(state.lastMessages);
        lastMessages.set(message.contactUserId, {
          content: message.content,
          timestamp: message.timestamp,
        });
        // Re-sort: move the affected discussion to top (after pinned)
        const discussions = [...state.discussions].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          const timeA =
            lastMessages.get(a.contactUserId)?.timestamp.getTime() ?? 0;
          const timeB =
            lastMessages.get(b.contactUserId)?.timestamp.getTime() ?? 0;
          return timeB - timeA;
        });
        return { lastMessages, discussions };
      });
      // Also trigger a full refetch to sync DB state (discussion metadata)
      debouncedFetch();
    };

    const sdk = getSdk();
    sdk.on(SdkEventType.MESSAGE_OPTIMISTIC, onMessageEvent);
    sdk.on(SdkEventType.MESSAGE_RECEIVED, onMessageEvent);
    sdk.on(SdkEventType.MESSAGE_READ, debouncedFetch);
    sdk.on(SdkEventType.SESSION_CREATED, debouncedFetch);
    sdk.on(SdkEventType.SESSION_ACCEPTED, debouncedFetch);
    sdk.on(SdkEventType.SESSION_RENEWED, debouncedFetch);
    sdk.on(SdkEventType.SESSION_REQUESTED, debouncedFetch);
    sdk.on(SdkEventType.DISCUSSION_UPDATED, debouncedFetch);

    const onSessionStatusChanged = (
      contactUserId: string,
      status: SessionStatus
    ) => {
      set(state => {
        const next = new Map(state.sessionsStatuses);
        next.set(contactUserId, status);
        return { sessionsStatuses: next };
      });
    };
    sdk.on(SdkEventType.SESSION_STATUS_CHANGED, onSessionStatusChanged);

    const cleanupFn = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      try {
        sdk.off(SdkEventType.MESSAGE_OPTIMISTIC, onMessageEvent);
        sdk.off(SdkEventType.MESSAGE_RECEIVED, onMessageEvent);
        sdk.off(SdkEventType.MESSAGE_READ, debouncedFetch);
        sdk.off(SdkEventType.SESSION_CREATED, debouncedFetch);
        sdk.off(SdkEventType.SESSION_ACCEPTED, debouncedFetch);
        sdk.off(SdkEventType.SESSION_RENEWED, debouncedFetch);
        sdk.off(SdkEventType.SESSION_REQUESTED, debouncedFetch);
        sdk.off(SdkEventType.DISCUSSION_UPDATED, debouncedFetch);
        sdk.off(SdkEventType.SESSION_STATUS_CHANGED, onSessionStatusChanged);
      } catch {
        // SDK might not be available during cleanup
      }
    };

    set({ cleanupFn, isInitializing: false });
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
    if (!getSdk().isSessionOpen) return [];
    return get().discussions.filter(discussion => {
      return status.includes(
        getSdk().discussions.getStatus(discussion.contactUserId)
      );
    });
  },

  cleanup: () => {
    get().cleanupFn?.();
    set({
      sessionsStatuses: new Map<string, SessionStatus>(),
      cleanupFn: null,
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
