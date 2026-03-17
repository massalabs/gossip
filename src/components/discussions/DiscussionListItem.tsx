import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Contact, SessionStatus } from '@massalabs/gossip-sdk';
import type { Discussion } from '@massalabs/gossip-sdk';
import { Bookmark, Edit2 } from 'react-feather';
import ContactAvatar from '../avatar/ContactAvatar';
import { formatRelativeTime } from '../../utils/timeUtils';
import { formatUserId } from '@massalabs/gossip-sdk';
import BaseModal from '../ui/BaseModal';
import ContactNameModal from '../ui/ContactNameModal';
import ContextMenu from '../ui/ContextMenu';
import Button from '../ui/Button';
import { useDiscussionStore } from '../../stores/discussionStore';
import { useLongPress } from '../../hooks/useLongPress';

export type LastMessageInfo = { content: string; timestamp: Date } | undefined;

interface DiscussionListItemProps {
  discussion: Discussion;
  contact: Contact;
  lastMessage: LastMessageInfo;
  onSelect: (discussion: Discussion) => void;
  onAccept: (discussion: Discussion, newName?: string) => void;
  onRefuse: (discussion: Discussion) => void;
  onEditName?: (discussion: Discussion, newName: string) => void;
  onTogglePin?: (discussion: Discussion) => void;
}

const DiscussionListItem: React.FC<DiscussionListItemProps> = ({
  discussion,
  contact,
  lastMessage,
  onSelect,
  onAccept,
  onRefuse,
  onEditName,
  onTogglePin,
}) => {
  const { t } = useTranslation('discussions');
  const [proposedName, setProposedName] = useState(contact.name || '');
  const [isRefuseModalOpen, setIsRefuseModalOpen] = useState(false);
  const [isContextMenuOpen, setIsContextMenuOpen] = useState(false);
  const [isEditNameModalOpen, setIsEditNameModalOpen] = useState(false);
  // Re-render trigger to update relative time display every minute
  const [_updateKey, setUpdateKey] = useState(0);

  // Use store to persist modal state across component remounts
  const openNameModals = useDiscussionStore(s => s.openNameModals);
  const setModalOpen = useDiscussionStore(s => s.setModalOpen);
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);
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
      sessionsStatuses.get(discussion.contactUserId) ===
      SessionStatus.PeerRequested;

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
  }, [discussion.contactUserId, discussion.id, sessionsStatuses, setModalOpen]);

  // Effect 2: Open the modal if the store says it should be open and discussion is pending
  useEffect(() => {
    const isPendingIncomingCheck =
      sessionsStatuses.get(discussion.contactUserId) ===
      SessionStatus.PeerRequested;

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
    discussion.contactUserId,
    discussion.id,
    openNameModals,
    contact.name,
    sessionsStatuses,
  ]);

  const isPendingIncoming =
    sessionsStatuses.get(discussion.contactUserId) ===
    SessionStatus.PeerRequested;
  const isPendingOutgoing =
    sessionsStatuses.get(discussion.contactUserId) ===
    SessionStatus.SelfRequested;

  const isPending = isPendingIncoming || isPendingOutgoing;

  const longPress = useLongPress({
    onLongPress: () => setIsContextMenuOpen(true),
    disabled: isPending,
  });

  const handleClick = () => {
    if (longPress.longPressTriggered.current) return;
    onSelect(discussion);
  };

  return (
    <div
      key={discussion.id}
      className="w-full px-2 py-0.5 text-left bg-background/20 border border-border rounded-xl mb-1 hover:bg-accent/10"
    >
      <div
        className={`${
          isPendingIncoming ? 'cursor-not-allowed opacity-95' : 'cursor-pointer'
        } p-4 transition-colors `}
        {...(!isPendingIncoming
          ? {
              onClick: handleClick,
              role: 'button',
              tabIndex: 0,
            }
          : {})}
        onTouchStart={longPress.onTouchStart}
        onTouchMove={longPress.onTouchMove}
        onTouchEnd={longPress.onTouchEnd}
        onContextMenu={longPress.onContextMenu}
      >
        <div className="flex items-center space-x-3">
          <ContactAvatar contact={contact} size={12} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-foreground truncate flex items-center gap-1">
                {discussion.customName || contact.name}
                {discussion.pinned && (
                  <Bookmark className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                )}
              </h3>
              <div className="flex items-center gap-2">
                {isPendingOutgoing && (
                  <span className="inline-flex items-center px-2 rounded-full text-[10px] font-medium bg-badge text-badge-foreground border border-badge-border">
                    {t('header.waiting_approval')}
                  </span>
                )}
                {lastMessage && (
                  <p className="text-xs text-muted-foreground">
                    {formatRelativeTime(lastMessage.timestamp)}
                  </p>
                )}
              </div>
            </div>
            {isPendingIncoming ? (
              <>
                {discussion.lastAnnouncementMessage && (
                  <div className="mt-2 p-2.5 bg-muted/50 border border-border rounded-lg">
                    <p className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
                      {discussion.lastAnnouncementMessage}
                    </p>
                  </div>
                )}
                <p className="mt-2 text-[11px] text-muted-foreground">
                  <span className="whitespace-nowrap">{t('list.user_id')}</span>{' '}
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
                    {t('list.accept')}
                  </Button>
                  <Button
                    onClick={() => {
                      setIsRefuseModalOpen(true);
                    }}
                    variant="outline"
                    size="custom"
                    className="px-2.5 py-1 text-xs font-medium rounded border border-border text-foreground hover:bg-accent"
                  >
                    {t('list.refuse')}
                  </Button>
                  {discussion.unreadCount > 0 && (
                    <span className="ml-auto inline-flex items-center justify-center px-2 py-1 text-[10px] font-bold leading-none text-primary-foreground bg-primary rounded-full">
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
                  title={t('list.set_contact_name')}
                  initialName={proposedName}
                  confirmLabel={t('common:continue')}
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
                  title={t('list.refuse_title')}
                >
                  <div className="space-y-4">
                    <p className="text-sm text-foreground">
                      {t('list.refuse_body')}
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
                        {t('list.refuse')}
                      </Button>
                      <Button
                        onClick={() => setIsRefuseModalOpen(false)}
                        variant="secondary"
                        size="custom"
                        className="flex-1 h-11 rounded-lg font-semibold"
                      >
                        {t('common:cancel')}
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
                  <span className="inline-flex items-center justify-center px-2 py-1 text-xs font-bold leading-none text-primary-foreground bg-primary rounded-full">
                    {discussion.unreadCount}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Long-press context menu */}
      <ContextMenu
        items={[
          {
            label: discussion.pinned
              ? t('list_item.unpin_discussion')
              : t('list_item.pin_discussion'),
            icon: <Bookmark className="w-4 h-4" />,
            onClick: () => onTogglePin?.(discussion),
          },
          {
            label: t('list_item.edit_name'),
            icon: <Edit2 className="w-4 h-4" />,
            onClick: () => setIsEditNameModalOpen(true),
          },
        ]}
        isOpen={isContextMenuOpen}
        onClose={() => setIsContextMenuOpen(false)}
      />

      {/* Edit name modal */}
      <ContactNameModal
        isOpen={isEditNameModalOpen}
        onClose={() => setIsEditNameModalOpen(false)}
        title={t('list_item.edit_name_title')}
        initialName={discussion.customName || contact.name}
        confirmLabel={t('common:save')}
        allowEmpty
        onConfirm={name => {
          setIsEditNameModalOpen(false);
          if (onEditName) {
            onEditName(discussion, name?.trim() || '');
          }
        }}
      />
    </div>
  );
};

export default DiscussionListItem;
