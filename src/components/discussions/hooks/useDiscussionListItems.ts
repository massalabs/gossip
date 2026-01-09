import { useMemo } from 'react';
import {
  Discussion,
  Contact,
  DiscussionStatus,
  DiscussionDirection,
} from '../../../db';
import { LastMessageInfo } from '../DiscussionListItem';
import { DiscussionFilter } from '../../../stores/discussionStore';

// =============================================================================
// Types
// =============================================================================

export type HeaderItem = {
  type: 'header';
  label: string;
  key: string;
};

export type DiscussionItem = {
  type: 'discussion';
  discussion: Discussion;
  contact: Contact;
  lastMessage: LastMessageInfo;
  isSelected: boolean;
};

export type ContactItem = {
  type: 'contact';
  contact: Contact;
};

export type VirtualItem = HeaderItem | DiscussionItem | ContactItem;

// =============================================================================
// Hooks
// =============================================================================

/**
 * Creates a Map for O(1) contact lookup by userId
 */
export function useContactsMap(contacts: Contact[]): Map<string, Contact> {
  return useMemo(() => {
    const map = new Map<string, Contact>();
    contacts.forEach(contact => map.set(contact.userId, contact));
    return map;
  }, [contacts]);
}

/**
 * Filters discussions based on search query
 */
export function useFilteredDiscussions(
  discussions: Discussion[],
  contactsMap: Map<string, Contact>,
  searchQuery: string
): Discussion[] {
  return useMemo(() => {
    // Filter out closed discussions
    const openDiscussions = discussions.filter(
      d => d.status !== DiscussionStatus.CLOSED
    );

    // No search query - return all open discussions
    if (!searchQuery.trim()) {
      return openDiscussions;
    }

    // Filter by search query
    const query = searchQuery.toLowerCase().trim();
    return openDiscussions.filter(discussion => {
      const contact = contactsMap.get(discussion.contactUserId);
      if (!contact) return false;

      const displayName = discussion.customName || contact.name || '';
      const userId = contact.userId || '';

      return (
        displayName.toLowerCase().includes(query) ||
        userId.toLowerCase().includes(query)
      );
    });
  }, [discussions, contactsMap, searchQuery]);
}

/**
 * Filters contacts based on search query
 */
export function useFilteredContacts(
  contacts: Contact[],
  searchQuery: string
): Contact[] {
  return useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return [];

    return contacts.filter(contact => {
      const name = (contact.name || '').toLowerCase();
      const userId = (contact.userId || '').toLowerCase();
      return name.includes(query) || userId.includes(query);
    });
  }, [contacts, searchQuery]);
}

/**
 * Builds the virtualized item list from filtered discussions and contacts
 */
export function useVirtualItems(
  filteredDiscussions: Discussion[],
  filteredContacts: Contact[],
  contactsMap: Map<string, Contact>,
  lastMessages: Map<string, LastMessageInfo>,
  activeUserId: string | undefined,
  isSearching: boolean,
  filter: DiscussionFilter = 'all'
): VirtualItem[] {
  return useMemo(() => {
    const items: VirtualItem[] = [];

    // In search mode, show sections for discussions and contacts
    if (isSearching) {
      // Discussions section
      if (filteredDiscussions.length > 0) {
        items.push({
          type: 'header',
          label: 'Discussions',
          key: 'header-discussions',
        });

        filteredDiscussions.forEach(discussion => {
          const contact = contactsMap.get(discussion.contactUserId);
          if (contact) {
            items.push({
              type: 'discussion',
              discussion,
              contact,
              lastMessage: lastMessages.get(discussion.contactUserId),
              isSelected: discussion.contactUserId === activeUserId,
            });
          }
        });
      }

      // Contacts section
      if (filteredContacts.length > 0) {
        items.push({
          type: 'header',
          label: 'Contacts',
          key: 'header-contacts',
        });

        filteredContacts.forEach(contact => {
          items.push({ type: 'contact', contact });
        });
      }
    } else {
      // Normal mode - filter discussions based on selected filter
      let discussionsToShow: Discussion[] = [];

      if (filter === 'pending') {
        // Show only pending discussions
        discussionsToShow = filteredDiscussions.filter(
          d => d.status === DiscussionStatus.PENDING
        );

        // Sort pending: incoming (RECEIVED) first, then outgoing (INITIATED)
        // Within each group, sort by updatedAt (newest first)
        discussionsToShow.sort((a, b) => {
          if (
            a.direction === DiscussionDirection.RECEIVED &&
            b.direction === DiscussionDirection.INITIATED
          ) {
            return -1;
          }
          if (
            a.direction === DiscussionDirection.INITIATED &&
            b.direction === DiscussionDirection.RECEIVED
          ) {
            return 1;
          }
          const timeA = a.updatedAt?.getTime() || a.createdAt.getTime();
          const timeB = b.updatedAt?.getTime() || b.createdAt.getTime();
          return timeB - timeA;
        });
      } else if (filter === 'unread') {
        // Show only unread active discussions
        discussionsToShow = filteredDiscussions.filter(
          d => d.status === DiscussionStatus.ACTIVE && d.unreadCount > 0
        );

        // Sort by latest message timestamp (newest first)
        discussionsToShow.sort((a, b) => {
          const hasMessageA = !!a.lastMessageTimestamp;
          const hasMessageB = !!b.lastMessageTimestamp;
          if (hasMessageA && !hasMessageB) return -1;
          if (!hasMessageA && hasMessageB) return 1;
          const timeA =
            a.lastMessageTimestamp?.getTime() ||
            a.updatedAt?.getTime() ||
            a.createdAt.getTime();
          const timeB =
            b.lastMessageTimestamp?.getTime() ||
            b.updatedAt?.getTime() ||
            b.createdAt.getTime();
          return timeB - timeA;
        });
      } else {
        // 'all' - show all discussions sorted by most recent update
        // Sort by: lastMessageTimestamp (if exists) or updatedAt (for new incoming discussions)
        const allDiscussions = [...filteredDiscussions];

        // Sort all discussions by most recent update (new message or new incoming discussion)
        allDiscussions.sort((a, b) => {
          // Use lastMessageTimestamp if available (new message), otherwise use updatedAt (new incoming discussion)
          const timeA =
            a.lastMessageTimestamp?.getTime() ||
            a.updatedAt?.getTime() ||
            a.createdAt.getTime();
          const timeB =
            b.lastMessageTimestamp?.getTime() ||
            b.updatedAt?.getTime() ||
            b.createdAt.getTime();
          return timeB - timeA; // Newest first
        });

        // Separate into pending and active sections, but maintain the sorted order
        const pendingDiscussions: Discussion[] = [];
        const activeDiscussions: Discussion[] = [];

        allDiscussions.forEach(discussion => {
          if (discussion.status === DiscussionStatus.PENDING) {
            pendingDiscussions.push(discussion);
          } else if (discussion.status === DiscussionStatus.ACTIVE) {
            activeDiscussions.push(discussion);
          }
        });

        // Add pending section if any
        if (pendingDiscussions.length > 0) {
          items.push({
            type: 'header',
            label: 'Pending',
            key: 'header-pending',
          });

          pendingDiscussions.forEach(discussion => {
            const contact = contactsMap.get(discussion.contactUserId);
            if (contact) {
              items.push({
                type: 'discussion',
                discussion,
                contact,
                lastMessage: lastMessages.get(discussion.contactUserId),
                isSelected: discussion.contactUserId === activeUserId,
              });
            }
          });
        }

        // Add active section
        if (activeDiscussions.length > 0) {
          items.push({
            type: 'header',
            label: 'Active',
            key: 'header-active',
          });

          activeDiscussions.forEach(discussion => {
            const contact = contactsMap.get(discussion.contactUserId);
            if (contact) {
              items.push({
                type: 'discussion',
                discussion,
                contact,
                lastMessage: lastMessages.get(discussion.contactUserId),
                isSelected: discussion.contactUserId === activeUserId,
              });
            }
          });
        }
      }

      // For 'pending' and 'unread' filters, show discussions directly without headers
      discussionsToShow.forEach(discussion => {
        const contact = contactsMap.get(discussion.contactUserId);
        if (contact) {
          items.push({
            type: 'discussion',
            discussion,
            contact,
            lastMessage: lastMessages.get(discussion.contactUserId),
            isSelected: discussion.contactUserId === activeUserId,
          });
        }
      });
    }

    return items;
  }, [
    filteredDiscussions,
    filteredContacts,
    contactsMap,
    lastMessages,
    activeUserId,
    isSearching,
    filter,
  ]);
}
