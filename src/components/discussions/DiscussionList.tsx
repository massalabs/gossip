import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDiscussionList } from '../../hooks/useDiscussionList';
import { useDiscussionStore } from '../../stores/discussionStore';
import EmptyDiscussions from './EmptyDiscussions';
import DiscussionListItem from './DiscussionListItem';
import { ROUTES } from '../../constants/routes';
import { DiscussionStatus } from '../../db';
import ContactAvatar from '../avatar/ContactAvatar';
import UserIdDisplay from '../ui/UserIdDisplay';

interface DiscussionListProps {
  onSelect: (contactUserId: string) => void;
  activeUserId?: string;
  headerVariant?: 'button' | 'link';
  searchQuery?: string;
}

const DiscussionList: React.FC<DiscussionListProps> = ({
  onSelect,
  activeUserId,
  searchQuery = '',
}) => {
  const discussions = useDiscussionStore(s => s.discussions);
  const lastMessages = useDiscussionStore(s => s.lastMessages);
  const contacts = useDiscussionStore(s => s.contacts);
  const navigate = useNavigate();

  const { handleAcceptDiscussionRequest, handleRefuseDiscussionRequest } =
    useDiscussionList();

  // Get all non-closed discussions (before search filter)
  const allDiscussions = React.useMemo(() => {
    return discussions.filter(d => d.status !== DiscussionStatus.CLOSED);
  }, [discussions]);

  // Create a Map for O(1) contact lookup instead of O(n) find operations
  const contactsMap = React.useMemo(() => {
    const map = new Map<string, (typeof contacts)[0]>();
    contacts.forEach(contact => {
      map.set(contact.userId, contact);
    });
    return map;
  }, [contacts]);

  // Filter discussions by status and search query
  const filteredDiscussions = React.useMemo(() => {
    let filtered = allDiscussions;

    // Apply search filter if query exists
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(discussion => {
        const contact = contactsMap.get(discussion.contactUserId);
        if (!contact) return false;

        // displayName already includes contact.name as fallback, so we only need to check it and userId
        const displayName = discussion.customName || contact.name || '';
        const userId = contact.userId || '';

        return (
          displayName.toLowerCase().includes(query) ||
          userId.toLowerCase().includes(query)
        );
      });
    }

    return filtered;
  }, [allDiscussions, contactsMap, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  // Contacts that match search query (we intentionally allow duplicates so
  // a contact and its discussion can both appear)
  const filteredContacts = React.useMemo(() => {
    if (!isSearching) return [];

    const query = searchQuery.toLowerCase().trim();
    if (!query) return [];

    return contacts.filter(contact => {
      const name = (contact.name || '').toLowerCase();
      const userId = (contact.userId || '').toLowerCase();
      return name.includes(query) || userId.includes(query);
    });
  }, [contacts, isSearching, searchQuery]);

  const hasDiscussionResults = filteredDiscussions.length > 0;
  const hasContactResults = filteredContacts.length > 0;
  const hasNoResults = !hasDiscussionResults && !hasContactResults;

  const renderDiscussionItems = (items: typeof filteredDiscussions) => {
    return items.map(discussion => {
      const contact = contactsMap.get(discussion.contactUserId);
      if (!contact) return null;

      const lastMessage = lastMessages.get(discussion.contactUserId);
      const isSelected = discussion.contactUserId === activeUserId;

      return (
        <div
          key={discussion.id}
          className={isSelected ? 'bg-blue-50 dark:bg-blue-950/20' : ''}
        >
          <DiscussionListItem
            discussion={discussion}
            contact={contact}
            lastMessage={lastMessage}
            onSelect={d => onSelect(d.contactUserId)}
            onAccept={async (d, newName) => {
              await handleAcceptDiscussionRequest(d, newName);
              navigate(ROUTES.discussion({ userId: d.contactUserId }));
            }}
            onRefuse={() => handleRefuseDiscussionRequest(discussion)}
          />
        </div>
      );
    });
  };

  return (
    <>
      {isSearching ? (
        hasNoResults ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No results found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {hasDiscussionResults && (
              <div>
                <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Discussions
                </p>
                <div className="space-y-1">
                  {renderDiscussionItems(filteredDiscussions)}
                </div>
              </div>
            )}

            {hasContactResults && (
              <div>
                <p className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Contacts
                </p>
                <div className="space-y-1">
                  {filteredContacts.map(contact => (
                    <button
                      key={contact.userId}
                      type="button"
                      onClick={() => onSelect(contact.userId)}
                      className="w-full px-3 py-2 flex items-center gap-3 rounded-xl hover:bg-accent/50 transition-colors text-left"
                    >
                      <ContactAvatar contact={contact} size={10} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">
                          {contact.name}
                        </p>
                        <UserIdDisplay
                          userId={contact.userId}
                          textClassName="text-muted-foreground"
                        />
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      ) : hasNoResults ? (
        <EmptyDiscussions />
      ) : (
        <>{renderDiscussionItems(filteredDiscussions)}</>
      )}
    </>
  );
};

export default DiscussionList;
