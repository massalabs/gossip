import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import type { Message } from '@massalabs/gossip-sdk';
import { useDiscussion } from '../hooks/useDiscussion';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import { useGroupStore } from '../stores/groupStore';
import { EMPTY_STORE_MESSAGES } from '../stores/messageStore.helpers';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useDiscussionMessageSelection } from '../hooks/useDiscussionMessageSelection';
import { useDiscussionScrollToMessage } from '../hooks/useDiscussionScrollToMessage';
import { useHeaderScrollDetection } from '../hooks/useHeaderScroll';
import { ExitAnimationContext } from '../components/ui/ExitAnimationContext';
import DiscussionTopSection from '../components/discussions/DiscussionTopSection';
import ArchiveFooter from '../components/groups/ArchiveFooter';
import DiscussionLayout from '../components/ui/Layout/DiscussionLayout';
import { ROUTES } from '../constants/routes';

const EMPTY_REACTIONS: never[] = [];

/**
 * The screen of a contact with no chat held (§2.1, §5.12): an earlier
 * one-to-one conversation (read only, nothing of it is sent), a contact
 * request, or a contact with no chat yet. Its footer offers the peer's
 * pending migration or chat invitation, "Migrate to a new group" and
 * "Archive", or "Start a chat". Once a direct chat held here continues it,
 * the conversation is that group, which shows these messages first.
 */
const DiscussionInner: React.FC = () => {
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const { userId } = useParams();
  const navigate = useNavigate();
  const contacts = useDiscussionStore(s => s.contacts);
  const contact = userId ? contacts.find(c => c.userId === userId) : undefined;
  const onBack = () => navigate(-1);

  const safeContact = contact || {
    userId: '',
    ownerUserId: '',
    name: '',
    publicKeys: new Uint8Array(),
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  const {
    discussion,
    anyDiscussionId,
    anyDiscussionRetentionDuration,
    isLoading: isDiscussionLoading,
  } = useDiscussion({ contact: safeContact });

  // Continued by a direct chat held here: that group is the conversation.
  const linked = useGroupStore(s =>
    discussion?.linkedGroupId
      ? s.groups.find(g => g.summary.groupId === discussion.linkedGroupId)
      : undefined
  );
  useEffect(() => {
    if (linked) {
      navigate(ROUTES.group({ groupId: linked.summary.groupId }), {
        replace: true,
      });
    }
  }, [linked, navigate]);

  const setCurrentContact = useMessageStore(s => s.setCurrentContact);
  const messages = useMessageStore(s =>
    contact ? s.getMessagesForContact(contact.userId) : EMPTY_STORE_MESSAGES
  );
  const reactionGroups = useMessageStore(s => s.reactionGroupsCache);
  const getReactions = useCallback(
    (msg: Message) =>
      msg.messageId
        ? (reactionGroups.get(msg.messageId.join(',')) ?? EMPTY_REACTIONS)
        : EMPTY_REACTIONS,
    [reactionGroups]
  );
  const isLoading = useMessageStore(s => s.isInitializing);

  const {
    selectedMessageIds,
    isSelecting,
    outgoingSentCount,
    handleToggleSelect,
    handleClearSelection,
    handleCopySelected,
  } = useDiscussionMessageSelection({ messages, gossip, t });

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchHighlightId, setSearchHighlightId] = useState<number | null>(
    null
  );
  const handleToggleSearch = useCallback(
    () => setIsSearchOpen(open => !open),
    []
  );
  const handleCloseSearch = useCallback(() => {
    setIsSearchOpen(false);
    setSearchHighlightId(null);
  }, []);
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollToBottom(!atBottom);
  }, []);

  const messageListRef = useRef<MessageListHandle>(null);
  const messageListContainerRef = useRef<HTMLDivElement>(null);
  const isExiting = useContext(ExitAnimationContext);
  useHeaderScrollDetection(
    messageListContainerRef,
    messages.length,
    discussion?.id,
    isExiting
  );

  const contactUserId = contact?.userId ?? null;
  const storeCurrentContact = useMessageStore(s => s.currentContactUserId);
  const storeCurrentContactRef = useRef(storeCurrentContact);
  storeCurrentContactRef.current = storeCurrentContact;
  useEffect(() => {
    void setCurrentContact(contactUserId);
    return () => {
      if (storeCurrentContactRef.current === contactUserId) {
        void setCurrentContact(null);
      }
    };
  }, [contactUserId, setCurrentContact]);

  useEffect(() => {
    handleClearSelection();
  }, [contact?.userId, handleClearSelection]);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
  }, []);

  const { handleScrollToMessage } = useDiscussionScrollToMessage({
    gossip,
    navigate,
    contactUserId: contact?.userId,
    messages,
    discussion: discussion ?? undefined,
    messageListRef,
    isSearchOpen,
  });

  if (!contact) return null;

  return (
    <DiscussionLayout
      header={
        <DiscussionTopSection
          contact={contact}
          discussion={discussion}
          anyDiscussionId={anyDiscussionId}
          anyDiscussionRetentionDuration={anyDiscussionRetentionDuration}
          onBack={onBack}
          outgoingSentCount={outgoingSentCount}
          selection={{
            isSelecting,
            selectedCount: selectedMessageIds.size,
            canDeleteSelected: false,
            onClearSelection: handleClearSelection,
            onCopySelected: handleCopySelected,
            onDeleteSelected: () => undefined,
          }}
          search={{
            isOpen: isSearchOpen,
            messages,
            onToggleSearch: handleToggleSearch,
            onScrollToMessage: handleScrollToMessage,
            onHighlightChange: setSearchHighlightId,
            onCloseSearch: handleCloseSearch,
          }}
        />
      }
      footer={<ArchiveFooter contact={contact} discussion={discussion} />}
    >
      <div ref={messageListContainerRef} className="h-full">
        <MessageList
          ref={messageListRef}
          messages={messages}
          discussion={discussion}
          contact={contact}
          isLoading={isLoading || isDiscussionLoading}
          getReactions={getReactions}
          onScrollToMessage={handleScrollToMessage}
          onAtBottomChange={handleAtBottomChange}
          onScrollToBottom={scrollToBottom}
          showScrollToBottom={showScrollToBottom && !isSelecting}
          highlightedMessageId={searchHighlightId}
          isSelecting={isSelecting}
          selectedMessageIds={selectedMessageIds}
          onToggleSelect={handleToggleSelect}
        />
      </div>
    </DiscussionLayout>
  );
};

// Keyed by contact so per-contact state never leaks across archives.
const Discussion: React.FC = () => {
  const { userId } = useParams();
  return <DiscussionInner key={userId ?? 'none'} />;
};

export default Discussion;
