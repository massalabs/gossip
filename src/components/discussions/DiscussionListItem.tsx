import React, { useState, useEffect } from 'react';
import { Discussion, Contact } from '../../db';
import ContactAvatar from '../avatar/ContactAvatar';
import { formatRelativeTime } from '../../utils/timeUtils';
import { formatUserId } from '../../utils/userId';
import BaseModal from '../ui/BaseModal';
import ContactNameModal from '../ui/ContactNameModal';
import Button from '../ui/Button';
import { useDiscussionStore } from '../../stores/discussionStore';

export type LastMessageInfo = { content: string; timestamp: Date } | undefined;

interface DiscussionListItemProps {
  discussion: Discussion;
  contact: Contact;
  lastMessage: LastMessageInfo;
  onSelect: (discussion: Discussion) => void;
  onAccept: (discussion: Discussion, newName?: string) => void;
  onRefuse: (discussion: Discussion) => void;
}

const DiscussionListItem: React.FC<DiscussionListItemProps> = ({
  discussion,
  contact,
  lastMessage,
  onSelect,
  onAccept,
  onRefuse,
}) => {
  const [proposedName, setProposedName] = useState(contact.name || '');
  const [isRefuseModalOpen, setIsRefuseModalOpen] = useState(false);
  // Re-render trigger to update relative time display every minute
  const [_updateKey, setUpdateKey] = useState(0);

  // Use store to persist modal state across component remounts
  const openNameModals = useDiscussionStore(s => s.openNameModals);
  const setModalOpen = useDiscussionStore(s => s.setModalOpen);
  const isModalOpenInStore = discussion.id
    ? openNameModals.has(discussion.id)
    : false;

  // Sync local state with store state
  const [isNameModalOpen, setIsNameModalOpen] = useState(isModalOpenInStore);

  // Update every minute to refresh relative time display
  useEffect(() => {
    const interval = setInterval(() => {
      setUpdateKey(prev => prev + 1);
    }, 60000); // Update every minute

    return () => clearInterval(interval);
  }, []);

  // Effect 1: Close the modal if the discussion is no longer pending
  useEffect(() => {
    const isPendingIncomingCheck =
      discussion.status === 'pending' && discussion.direction === 'received';

    if (!isPendingIncomingCheck) {
      // Use functional update to avoid dependency on isNameModalOpen
      setIsNameModalOpen(prev => {
        if (prev) {
          if (discussion.id) {
            setModalOpen(discussion.id, false);
          }
          return false;
        }
        return prev;
      });
    }
  }, [discussion.status, discussion.direction, discussion.id, setModalOpen]);

  // Effect 2: Open the modal if the store says it should be open and discussion is pending
  useEffect(() => {
    const isPendingIncomingCheck =
      discussion.status === 'pending' && discussion.direction === 'received';

    if (!isPendingIncomingCheck) {
      return;
    }

    const shouldBeOpen = discussion.id
      ? openNameModals.has(discussion.id)
      : false;

    // Use functional update to avoid dependency on isNameModalOpen
    setIsNameModalOpen(prev => {
      if (shouldBeOpen && !prev) {
        setProposedName(contact.name || '');
        return true;
      }
      return prev;
    });
  }, [
    discussion.status,
    discussion.direction,
    discussion.id,
    openNameModals,
    contact.name,
  ]);

  const isPendingIncoming =
    discussion.status === 'pending' && discussion.direction === 'received';
  const isPendingOutgoing =
    discussion.status === 'pending' && discussion.direction === 'initiated';

  return (
    <div key={discussion.id} className="w-full px-2 py-1 text-left">
      <div
        className={`${
          isPendingIncoming || isPendingOutgoing
            ? 'cursor-not-allowed opacity-95'
            : 'cursor-pointer hover:ring-1 hover:ring-border'
        } bg-card border border-border rounded-xl px-4 py-3 transition-colors`}
        {...(!(isPendingIncoming || isPendingOutgoing)
          ? {
              onClick: () => onSelect(discussion),
              role: 'button',
              tabIndex: 0,
            }
          : {})}
      >
        <div className="flex items-center space-x-3">
          <ContactAvatar contact={contact} size={12} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground truncate">
                {contact.name}
              </h3>
              <div className="flex items-center gap-2">
                {isPendingOutgoing && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-accent text-accent-foreground border border-border">
                    Waiting approval
                  </span>
                )}
                {lastMessage && (
                  <p className="text-xs text-muted-foreground">
                    {formatRelativeTime(lastMessage.timestamp)}
                  </p>
                )}
                {!isPendingIncoming && !isPendingOutgoing && (
                  <svg
                    className="w-4 h-4 text-muted-foreground"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                )}
              </div>
            </div>
            {isPendingIncoming ? (
              <>
                {discussion.announcementMessage && (
                  <div className="mt-2 p-2.5 bg-muted/50 border border-border rounded-lg">
                    <p className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
                      {discussion.announcementMessage}
                    </p>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <span className="whitespace-nowrap">User ID:</span>{' '}
                  <span className="break-all">
                    {formatUserId(contact.userId)}
                  </span>
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    onClick={() => {
                      setProposedName(contact.name || '');
                      setIsNameModalOpen(true);
                      if (discussion.id) {
                        setModalOpen(discussion.id, true);
                      }
                    }}
                    variant="primary"
                    size="custom"
                    className="px-2.5 py-1 text-xs font-medium rounded border border-primary text-primary hover:bg-primary/10"
                  >
                    Accept
                  </Button>
                  <Button
                    onClick={() => {
                      setIsRefuseModalOpen(true);
                    }}
                    variant="outline"
                    size="custom"
                    className="px-2.5 py-1 text-xs font-medium rounded border border-border text-foreground hover:bg-accent"
                  >
                    Refuse
                  </Button>
                  {discussion.unreadCount > 0 && (
                    <span className="ml-auto inline-flex items-center justify-center px-2 py-1 text-[10px] font-bold leading-none text-destructive-foreground bg-destructive rounded-full">
                      {discussion.unreadCount}
                    </span>
                  )}
                </div>
                {/* Name prompt modal */}
                <ContactNameModal
                  isOpen={isNameModalOpen}
                  onClose={() => {
                    setIsNameModalOpen(false);
                    if (discussion.id) {
                      setModalOpen(discussion.id, false);
                    }
                  }}
                  title="Set contact name"
                  initialName={proposedName}
                  confirmLabel="Continue"
                  allowEmpty
                  showSkip
                  onConfirm={name => {
                    setIsNameModalOpen(false);
                    if (discussion.id) {
                      setModalOpen(discussion.id, false);
                    }
                    if (name && name.trim()) {
                      onAccept(discussion, name.trim());
                    } else {
                      onAccept(discussion);
                    }
                  }}
                  onSkip={() => {
                    setIsNameModalOpen(false);
                    if (discussion.id) {
                      setModalOpen(discussion.id, false);
                    }
                    onAccept(discussion);
                  }}
                />
                {/* Refuse confirm modal */}
                <BaseModal
                  isOpen={isRefuseModalOpen}
                  onClose={() => setIsRefuseModalOpen(false)}
                  title="Refuse connection?"
                >
                  <div className="space-y-4">
                    <p className="text-sm text-foreground">
                      Refusing will close this discussion request.
                    </p>
                    <div className="flex gap-3">
                      <Button
                        onClick={() => {
                          setIsRefuseModalOpen(false);
                          onRefuse(discussion);
                        }}
                        variant="danger"
                        size="custom"
                        className="flex-1 h-11 rounded-lg font-semibold"
                      >
                        Refuse
                      </Button>
                      <Button
                        onClick={() => setIsRefuseModalOpen(false)}
                        variant="secondary"
                        size="custom"
                        className="flex-1 h-11 rounded-lg font-semibold"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                </BaseModal>
              </>
            ) : (
              <div className="flex items-center justify-between mt-1">
                <p className="text-sm text-muted-foreground truncate">
                  {lastMessage?.content || ''}
                </p>
                {discussion.unreadCount > 0 && (
                  <span className="inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-destructive-foreground bg-destructive rounded-full">
                    {discussion.unreadCount}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DiscussionListItem;
