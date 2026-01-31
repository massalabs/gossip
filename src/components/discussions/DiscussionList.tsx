import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';

import { useDiscussionList } from '../../hooks/useDiscussionList';
import {
  DiscussionFilter,
  useDiscussionStore,
} from '../../stores/discussionStore';
import { ROUTES } from '../../constants/routes';

import EmptyDiscussions from './EmptyDiscussions';
import DiscussionListItem from './DiscussionListItem';
import ContactAvatar from '../avatar/ContactAvatar';
import UserIdDisplay from '../ui/UserIdDisplay';

import {
  HeaderItem,
  ContactItem,
  useContactsMap,
  useFilteredDiscussions,
  useFilteredContacts,
  useVirtualItems,
} from './hooks/useDiscussionListItems';
import { Discussion } from '@massalabs/gossip-sdk';

// =============================================================================
// Types
// =============================================================================

interface DiscussionListProps {
  onSelect: (contactUserId: string) => void;
  activeUserId?: string;
  headerVariant?: 'button' | 'link';
  searchQuery?: string;
  scrollParent: HTMLElement;
  filter?: DiscussionFilter;
}

// =============================================================================
// Item Renderers
// =============================================================================

interface HeaderItemProps {
  item: HeaderItem;
}

const HeaderItemRenderer: React.FC<HeaderItemProps> = ({ item }) => {
  return (
    <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {item.label}
    </p>
  );
};

interface ContactItemProps {
  item: ContactItem;
  onSelect: (userId: string) => void;
}

const ContactItemRenderer: React.FC<ContactItemProps> = ({
  item,
  onSelect,
}) => (
  <button
    type="button"
    onClick={() => onSelect(item.contact.userId)}
    className="w-full px-3 py-2 flex items-center gap-3 rounded-xl hover:bg-accent/50 transition-colors text-left"
  >
    <ContactAvatar contact={item.contact} size={10} />
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-foreground truncate">
        {item.contact.name}
      </p>
      <UserIdDisplay
        userId={item.contact.userId}
        textClassName="text-muted-foreground"
      />
    </div>
  </button>
);

// =============================================================================
// Main Component
// =============================================================================

const DiscussionList: React.FC<DiscussionListProps> = ({
  onSelect,
  activeUserId,
  searchQuery = '',
  scrollParent,
  filter = 'all',
}) => {
  const navigate = useNavigate();

  // Store selectors
  const discussions = useDiscussionStore(s => s.discussions);
  const lastMessages = useDiscussionStore(s => s.lastMessages);
  const contacts = useDiscussionStore(s => s.contacts);

  // Discussion actions
  const { handleAcceptDiscussionRequest, handleRefuseDiscussionRequest } =
    useDiscussionList();

  // Derived state
  const isSearching = searchQuery.trim().length > 0;
  const contactsMap = useContactsMap(contacts);
  const filteredDiscussions = useFilteredDiscussions(
    discussions,
    contactsMap,
    searchQuery
  );
  const filteredContacts = useFilteredContacts(contacts, searchQuery);

  // Build virtual items
  const virtualItems = useVirtualItems(
    filteredDiscussions,
    filteredContacts,
    contactsMap,
    lastMessages,
    activeUserId,
    isSearching,
    filter
  );

  // Check for empty state
  const hasNoResults = virtualItems.length === 0;

  // Handlers
  const handleAccept = useCallback(
    async (discussion: Discussion, newName?: string) => {
      await handleAcceptDiscussionRequest(discussion, newName);
      navigate(ROUTES.discussion({ userId: discussion.contactUserId }));
    },
    [handleAcceptDiscussionRequest, navigate]
  );

  const handleRefuse = useCallback(
    (discussion: Discussion) => {
      handleRefuseDiscussionRequest(discussion);
    },
    [handleRefuseDiscussionRequest]
  );

  // Virtuoso item renderer
  const renderItem = useCallback(
    (index: number) => {
      const item = virtualItems[index];
      if (!item) return null;

      switch (item.type) {
        case 'header':
          return <HeaderItemRenderer key={item.key} item={item} />;

        case 'contact':
          return (
            <ContactItemRenderer
              key={item.contact.userId}
              item={item}
              onSelect={onSelect}
            />
          );

        case 'discussion':
          return (
            <div
              key={item.discussion.id}
              className={
                item.isSelected ? 'bg-blue-50 dark:bg-blue-950/20' : ''
              }
            >
              <DiscussionListItem
                discussion={item.discussion}
                contact={item.contact}
                lastMessage={item.lastMessage}
                onSelect={d => onSelect(d.contactUserId)}
                onAccept={handleAccept}
                onRefuse={() => handleRefuse(item.discussion)}
              />
            </div>
          );

        default:
          return null;
      }
    },
    [virtualItems, onSelect, handleAccept, handleRefuse]
  );

  // Empty states
  if (hasNoResults) {
    if (isSearching) {
      return (
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">No results found</p>
        </div>
      );
    }
    return <EmptyDiscussions />;
  }

  // Main render
  return (
    <Virtuoso
      customScrollParent={scrollParent}
      totalCount={virtualItems.length}
      itemContent={renderItem}
      increaseViewportBy={{ top: 200, bottom: 200 }}
      components={{
        Footer: () => <div className="h-20" />, // Add padding at bottom
      }}
    />
  );
};

export default DiscussionList;
