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
import type {
  Discussion,
  GroupInvitation,
  LeaveChoice,
} from '@massalabs/gossip-sdk';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../constants/routes';
import { useGroupStore } from '../../stores/groupStore';
import { useAccountStore } from '../../stores/accountStore';
import {
  isAcceptedContact,
  isConversationRow,
  isDirectChatInvitationFrom,
} from '../../utils/conversations';

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
  const { t } = useTranslation('discussions');
  return (
    <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {t(item.labelKey)}
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
  const allDiscussions = useDiscussionStore(s => s.discussions);
  const lastMessages = useDiscussionStore(s => s.lastMessages);
  const allContacts = useDiscussionStore(s => s.contacts);
  const groups = useGroupStore(s => s.groups);
  const invitations = useGroupStore(s => s.invitations);
  // Automatic connections are no contacts (§5.12).
  const contacts = React.useMemo(
    () => allContacts.filter(isAcceptedContact),
    [allContacts]
  );
  // Archives and requests are rows; a discussion continued by a direct chat
  // held here is shown through that group. The archived list is apart.
  const discussions = React.useMemo(() => {
    const held = new Set(groups.map(g => g.summary.groupId));
    return allDiscussions.filter(
      d =>
        isConversationRow(
          d,
          allContacts.find(c => c.userId === d.contactUserId),
          held
        ) && (filter === 'archived') === !!d.archived
    );
  }, [allDiscussions, allContacts, groups, filter]);
  // The contacts whose invitation to the pair's chat waits (§5.12).
  const me = useAccountStore(s => s.userProfile?.userId);
  const chatInvitationFrom = React.useMemo(
    () =>
      new Set(
        invitations
          .filter(i => isDirectChatInvitationFrom(i, i.owner, me))
          .map(i => i.owner)
      ),
    [invitations, me]
  );
  const migrationOf = React.useMemo(
    () =>
      new Map(
        invitations
          .filter(i => i.migrationOf && !i.continues)
          .map(i => [i.migrationOf as string, i])
      ),
    [invitations]
  );
  const patchDiscussion = useDiscussionStore(s => s.patchDiscussion);

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
    filter === 'archived' ? 'all' : filter
  );

  // Check for empty state
  const hasNoResults = virtualItems.length === 0;

  // Handlers
  const handleSelect = useCallback(
    (discussion: Discussion) => onSelect(discussion.contactUserId),
    [onSelect]
  );

  const handleEditName = useCallback(
    async (discussion: Discussion, newName: string) => {
      if (!discussion.id) return;
      const result = await gossip.discussions.updateName(
        discussion.id,
        newName || undefined
      );
      if (result.success) {
        // Optimistic store update so the UI reflects the new name without
        // waiting for the SDK's DISCUSSION_UPDATED event / refetch.
        patchDiscussion(discussion.id, { customName: newName || null });
        toast.success(t('list_item.name_updated'));
      } else {
        toast.error(result.message || t('list_item.name_update_failed'));
      }
    },
    [gossip, patchDiscussion, t]
  );

  const handleTogglePin = useCallback(
    async (discussion: Discussion) => {
      if (!discussion.id) return;
      const newPinned = !discussion.pinned;
      const result = await gossip.discussions.pin(discussion.id, newPinned);
      if (result.success) {
        // Optimistic store update so the pin icon toggles immediately.
        patchDiscussion(discussion.id, { pinned: newPinned });
      } else {
        toast.error(result.message || t('list_item.pin_failed'));
      }
    },
    [gossip, patchDiscussion, t]
  );

  // The peer's migration, answered from the archive's row (§5.12).
  const navigate = useNavigate();
  const refreshGroups = useGroupStore(s => s.refresh);
  const acceptMigration = useCallback(
    async (inv: GroupInvitation) => {
      try {
        const groupId = await gossip.conversations.acceptInvitation(
          inv.epochId
        );
        await refreshGroups();
        navigate(ROUTES.group({ groupId }));
      } catch {
        toast.error(t('groups:invitation.failed'));
      }
    },
    [gossip, refreshGroups, navigate, t]
  );
  const declineMigration = useCallback(
    async (inv: GroupInvitation, choice: LeaveChoice) => {
      try {
        await gossip.conversations.declineInvitation(inv.epochId, choice);
        await refreshGroups();
      } catch {
        toast.error(t('groups:invitation.failed'));
      }
    },
    [gossip, refreshGroups, t]
  );
  const openInvitation = useCallback(
    (d: Discussion) =>
      navigate(ROUTES.invitation({ kind: 'contact', id: d.contactUserId })),
    [navigate]
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
                migrationInvitation={migrationOf.get(
                  item.discussion.contactUserId
                )}
                chatInvitation={chatInvitationFrom.has(
                  item.discussion.contactUserId
                )}
                onAcceptMigration={acceptMigration}
                onDeclineMigration={declineMigration}
                onOpenInvitation={openInvitation}
                lastMessage={item.lastMessage}
                onSelect={handleSelect}
                onAccept={handleAcceptDiscussionRequest}
                onRefuse={handleRefuseDiscussionRequest}
                onEditName={handleEditName}
                onTogglePin={handleTogglePin}
              />
            </div>
          );

        default:
          return null;
      }
    },
    [
      onSelect,
      handleSelect,
      handleAcceptDiscussionRequest,
      handleRefuseDiscussionRequest,
      handleEditName,
      handleTogglePin,
      migrationOf,
      chatInvitationFrom,
      acceptMigration,
      declineMigration,
      openInvitation,
    ]
  );

  // Empty states
  if (hasNoResults) {
    if (filter === 'archived') {
      return (
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">{t('archived.empty')}</p>
        </div>
      );
    }
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
