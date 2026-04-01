import React, { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtualizer } from 'virtua';
import toast from 'react-hot-toast';

import { useDiscussionList } from '../../hooks/useDiscussionList';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import {
  DiscussionFilter,
  useDiscussionStore,
} from '../../stores/discussionStore';

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
import type { Discussion } from '@massalabs/gossip-sdk';

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
    className="hover-fill w-full px-3 py-2 flex items-center gap-3 rounded-xl text-left"
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
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const scrollRef = useRef<HTMLElement | null>(null);
  scrollRef.current = scrollParent;

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
    },
    [handleAcceptDiscussionRequest]
  );

  const handleRefuse = useCallback(
    (discussion: Discussion) => {
      handleRefuseDiscussionRequest(discussion);
    },
    [handleRefuseDiscussionRequest]
  );

  const handleEditName = useCallback(
    async (discussion: Discussion, newName: string) => {
      if (!discussion.id) return;
      const result = await gossip.discussions.updateName(
        discussion.id,
        newName || undefined
      );
      if (result.success) {
        toast.success('Name updated');
      } else {
        toast.error(result.message || 'Failed to update name');
      }
    },
    [gossip]
  );

  const handleTogglePin = useCallback(
    async (discussion: Discussion) => {
      if (!discussion.id) return;
      const result = await gossip.discussions.pin(
        discussion.id,
        !discussion.pinned
      );
      if (!result.success) {
        toast.error(result.message || 'Failed to pin discussion');
      }
    },
    [gossip]
  );

  // Item renderer
  const renderItem = useCallback(
    (item: (typeof virtualItems)[number]) => {
      switch (item.type) {
        case 'header':
          return <HeaderItemRenderer item={item} />;

        case 'contact':
          return <ContactItemRenderer item={item} onSelect={onSelect} />;

        case 'discussion':
          return (
            <div className={item.isSelected ? 'bg-accent/10' : ''}>
              <DiscussionListItem
                discussion={item.discussion}
                contact={item.contact}
                lastMessage={item.lastMessage}
                onSelect={d => onSelect(d.contactUserId)}
                onAccept={handleAccept}
                onRefuse={() => handleRefuse(item.discussion)}
                onEditName={handleEditName}
                onTogglePin={handleTogglePin}
              />
            </div>
          );

        default:
          return null;
      }
    },
    [onSelect, handleAccept, handleRefuse, handleEditName, handleTogglePin]
  );

  // Empty states
  if (hasNoResults) {
    if (isSearching) {
      return (
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t('list.no_results')}
          </p>
        </div>
      );
    }
    return <EmptyDiscussions />;
  }

  // Main render
  return (
    <Virtualizer scrollRef={scrollRef} bufferSize={200}>
      {virtualItems.map(item => {
        const key =
          item.type === 'header'
            ? item.key
            : item.type === 'contact'
              ? item.contact.userId
              : item.discussion.contactUserId;
        return <div key={key}>{renderItem(item)}</div>;
      })}
      <div className="h-20" aria-hidden="true" />
    </Virtualizer>
  );
};

export default DiscussionList;
