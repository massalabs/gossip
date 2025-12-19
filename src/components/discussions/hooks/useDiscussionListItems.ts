import { useMemo } from 'react';
import { Discussion, Contact, DiscussionStatus } from '../../../db';
import { LastMessageInfo } from '../DiscussionListItem';

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
  isSearching: boolean
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
      // Normal mode - just show discussions
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

    return items;
  }, [
    filteredDiscussions,
    filteredContacts,
    contactsMap,
    lastMessages,
    activeUserId,
    isSearching,
  ]);
}
