import { create } from 'zustand';
import { Contact, SessionStatus, SdkEventType } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { getSdk } from './sdkStore';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';

export type DiscussionFilter = 'all' | 'unread' | 'pending';

const POLL_INTERVAL_MS = 3000;

interface DiscussionStoreState {
  discussions: Discussion[];
  sessionsStatuses: Map<string, SessionStatus>;
  contacts: Contact[];
  lastMessages: Map<string, { content: string; timestamp: Date }>;
  openNameModals: Set<number>;
  pollTimer: ReturnType<typeof setInterval> | null;
  eventHandler: (() => void) | null;
  sessionStatusHandler:
    | ((contactUserId: string, status: SessionStatus) => void)
    | null;
  cancelDebounce: (() => void) | null;
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
  sessionsStatuses: new Map<string, SessionStatus>(),
  contacts: [],
  lastMessages: new Map(),
  openNameModals: new Set<number>(),
  pollTimer: null,
  eventHandler: null,
  sessionStatusHandler: null,
  cancelDebounce: null,
  isInitializing: false,
  filter: 'all',

  init: () => {
    const ownerUserId = useAccountStore.getState().userProfile?.userId;

    if (!ownerUserId || get().pollTimer || get().isInitializing) return;

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
            statusMap.set(
              d.contactUserId,
              sdk.discussions.getStatus(d.contactUserId)
            );
          }
          set({ sessionsStatuses: statusMap }); // Update sessionsStatuses map reference
        }

        // Sort discussions: new requests (PENDING) first, then active discussions
        // Within each group, sort by most recent activity
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
          // Pinned first
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

    // Immediate fetch
    fetchData();

    // Polling interval
    const timer = setInterval(fetchData, POLL_INTERVAL_MS);

    // Event-driven immediate refetch (debounced to collapse rapid events)
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(fetchData, 100);
    };
    // Cancel pending debounce (called from cleanup)
    const cancelDebounce = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };
    const sdk = getSdk();
    sdk.on(SdkEventType.MESSAGE_RECEIVED, onEvent);
    sdk.on(SdkEventType.MESSAGE_READ, onEvent);
    sdk.on(SdkEventType.SESSION_CREATED, onEvent);
    sdk.on(SdkEventType.SESSION_ACCEPTED, onEvent);
    sdk.on(SdkEventType.SESSION_RENEWED, onEvent);
    sdk.on(SdkEventType.SESSION_REQUESTED, onEvent);

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

    set({
      pollTimer: timer,
      eventHandler: onEvent,
      sessionStatusHandler: onSessionStatusChanged,
      cancelDebounce,
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
    const timer = get().pollTimer;
    if (timer) clearInterval(timer);
    get().cancelDebounce?.();
    const handler = get().eventHandler;
    const statusHandler = get().sessionStatusHandler;
    if (handler || statusHandler) {
      try {
        const sdk = getSdk();
        if (handler) {
          sdk.off(SdkEventType.MESSAGE_RECEIVED, handler);
          sdk.off(SdkEventType.MESSAGE_READ, handler);
          sdk.off(SdkEventType.SESSION_CREATED, handler);
          sdk.off(SdkEventType.SESSION_ACCEPTED, handler);
          sdk.off(SdkEventType.SESSION_RENEWED, handler);
          sdk.off(SdkEventType.SESSION_REQUESTED, handler);
        }
        if (statusHandler) {
          sdk.off(SdkEventType.SESSION_STATUS_CHANGED, statusHandler);
        }
      } catch {
        // SDK might not be available during cleanup
      }
    }
    set({
      sessionsStatuses: new Map<string, SessionStatus>(),
      pollTimer: null,
      eventHandler: null,
      sessionStatusHandler: null,
      cancelDebounce: null,
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
