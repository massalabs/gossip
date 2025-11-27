import { create } from 'zustand';
import { Subscription } from 'dexie';
import { liveQuery } from 'dexie';
import { Discussion, Contact, db } from '../db';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';

interface DiscussionStoreState {
  discussions: Discussion[];
  contacts: Contact[];
  lastMessages: Map<string, { content: string; timestamp: Date }>;
  openNameModals: Set<number>;
  subscriptionDiscussions: Subscription | null;
  subscriptionContacts: Subscription | null;
  isInitializing: boolean;

  init: () => void;
  getDiscussionsForContact: (contactUserId: string) => Discussion[];

  cleanup: () => void;
  setModalOpen: (discussionId: number, isOpen: boolean) => void;
  isModalOpen: (discussionId: number) => boolean;
}

const useDiscussionStoreBase = create<DiscussionStoreState>((set, get) => ({
  discussions: [],
  contacts: [],
  lastMessages: new Map(),
  openNameModals: new Set<number>(),
  subscriptionDiscussions: null,
  subscriptionContacts: null,
  isInitializing: false,

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
        // Sort discussions as in original
        const sortedDiscussions = discussionsList.sort((a, b) => {
          if (a.lastMessageTimestamp && b.lastMessageTimestamp) {
            return (
              b.lastMessageTimestamp.getTime() -
              a.lastMessageTimestamp.getTime()
            );
          }
          if (a.lastMessageTimestamp) return -1;
          if (b.lastMessageTimestamp) return 1;
          return b.createdAt.getTime() - a.createdAt.getTime();
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
        console.log(
          'Global live query received contacts:',
          contactsList.length
        );
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
}));

export const useDiscussionStore = createSelectors(useDiscussionStoreBase);
