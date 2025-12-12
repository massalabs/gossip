import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDiscussionList } from '../../hooks/useDiscussionList';
import { useDiscussionStore } from '../../stores/discussionStore';
import EmptyDiscussions from './EmptyDiscussions';
import DiscussionListItem from './DiscussionListItem';
import { ROUTES } from '../../constants/routes';
import { DiscussionStatus } from '../../db';

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
  // Use the store directly instead of receiving props
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

  // Filter discussions by status and search query
  const filteredDiscussions = React.useMemo(() => {
    let filtered = allDiscussions;

    // Apply search filter if query exists
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      filtered = filtered.filter(discussion => {
        const contact = contacts.find(
          c => c.userId === discussion.contactUserId
        );
        if (!contact) return false;

        const displayName = discussion.customName || contact.name || '';
        const contactName = contact.name || '';
        const userId = contact.userId || '';

        return (
          displayName.toLowerCase().includes(query) ||
          contactName.toLowerCase().includes(query) ||
          userId.toLowerCase().includes(query)
        );
      });
    }

    return filtered;
  }, [allDiscussions, contacts, searchQuery]);

  const isSearching = searchQuery.trim().length > 0;
  const hasNoResults = filteredDiscussions.length === 0;

  return (
    <>
      {hasNoResults && isSearching ? (
        <div className="py-8 text-center">
          <p className="text-sm text-muted-foreground">No discussions found</p>
        </div>
      ) : hasNoResults ? (
        <EmptyDiscussions />
      ) : (
        <>
          {filteredDiscussions.map(discussion => {
            const contact = contacts.find(
              c => c.userId === discussion.contactUserId
            );
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
          })}
        </>
      )}
    </>
  );
};

export default DiscussionList;
