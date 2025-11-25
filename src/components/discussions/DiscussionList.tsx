import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useDiscussionList } from '../../hooks/useDiscussionList';
import { useDiscussionStore } from '../../stores/discussionStore';
import EmptyDiscussions from './EmptyDiscussions';
import DiscussionListItem from './DiscussionListItem';

interface DiscussionListProps {
  onSelect: (contactUserId: string) => void;
  activeUserId?: string;
  headerVariant?: 'button' | 'link';
}

const DiscussionList: React.FC<DiscussionListProps> = ({
  onSelect,
  activeUserId,
}) => {
  // Use the store directly instead of receiving props
  const discussions = useDiscussionStore(s => s.discussions);
  const lastMessages = useDiscussionStore(s => s.lastMessages);
  const contacts = useDiscussionStore(s => s.contacts);
  const navigate = useNavigate();

  const { handleAcceptDiscussionRequest, handleRefuseDiscussionRequest } =
    useDiscussionList();

  return (
    <>
      {discussions.filter(d => d.status !== 'closed').length === 0 ? (
        <EmptyDiscussions />
      ) : (
        <>
          {discussions
            .filter(d => d.status !== 'closed')
            .map(discussion => {
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
                      navigate(`/discussion/${d.contactUserId}`);
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
