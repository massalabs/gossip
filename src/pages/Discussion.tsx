import { logger } from '../utils/logger.ts';
import React, {
  useContext,
  useEffect,
  useCallback,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDiscussion } from '../hooks/useDiscussion';
import { useAppStore } from '../stores/appStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import { EMPTY_STORE_MESSAGES } from '../stores/messageStore.helpers';
import toast from 'react-hot-toast';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import { Message, SessionStatus } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useDiscussionMessageSelection } from '../hooks/useDiscussionMessageSelection';
import { useDiscussionScrollToMessage } from '../hooks/useDiscussionScrollToMessage';
import { useHeaderScrollDetection } from '../hooks/useHeaderScroll';
import { ExitAnimationContext } from '../components/ui/ExitAnimationContext';
import { useForwardPreview } from '../hooks/useForwardPreview';
import { useDiscussionActions } from '../hooks/useDiscussionActions';
import { useKeyboardStore } from '../stores/keyboardStore';
import DiscussionTopSection from '../components/discussions/DiscussionTopSection';
import DiscussionDebugButton from '../components/discussions/DiscussionDebugButton';
import MessageInput from '../components/discussions/MessageInput';
import DiscussionLayout from '../components/ui/Layout/DiscussionLayout';

const TEST_MESSAGE_COUNT = 50;
const TEST_MESSAGE_BATCH_DELAY_MS = 100;

// Stable empty array so MessageList sees a referentially-equal value for
// messages without reactions instead of a fresh [] on every render.
const EMPTY_REACTIONS: never[] = [];

const DiscussionInner: React.FC = () => {
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const { userId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const contacts = useDiscussionStore(s => s.contacts);
  const patchDiscussion = useDiscussionStore(s => s.patchDiscussion);
  const sessionsStatuses = useDiscussionStore(s => s.sessionsStatuses);

  const locationState = location.state as {
    prefilledMessage?: string;
    forwardFromMessageId?: number;
    scrollToMessageId?: number;
  } | null;
  const prefilledMessage = locationState?.prefilledMessage;

  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);

  const finalPrefilledMessage = prefilledMessage || pendingSharedContent;

  const [inputPrefill, setInputPrefill] = useState<string | undefined>(
    finalPrefilledMessage || undefined
  );

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  const contact = userId ? contacts.find(c => c.userId === userId) : undefined;
  const isDiscussionPending =
    !!contact &&
    sessionsStatuses.get(contact.userId) === SessionStatus.SelfRequested;
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
    anyDiscussionRetentionPolicySetAt,
    isLoading: isDiscussionLoading,
  } = useDiscussion({
    contact: safeContact,
  });

  const {
    forwardFromMessageId,
    forwardPreviewText,
    forwardPreviewMode,
    clearForward,
  } = useForwardPreview({
    gossip,
    contact: contact ?? undefined,
    initialForwardFromMessageId: locationState?.forwardFromMessageId,
    setReplyingTo,
  });

  const showDebugOption = useAppStore(s => s.showDebugOption);
  const defaultRetentionDuration = useAppStore(s => s.defaultRetentionDuration);
  const [isSendingTestMessages, setIsSendingTestMessages] = useState(false);

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
  const reactToMessage = useMessageStore(s => s.reactToMessage);
  const removeReaction = useMessageStore(s => s.removeReaction);
  const isLoading = useMessageStore(s => s.isInitializing);
  const sendMessage = useMessageStore(s => s.sendMessage);

  const {
    selectedMessageIds,
    isSelecting,
    canDeleteSelected,
    outgoingSentCount,
    handleToggleSelect,
    handleClearSelection,
    handleCopySelected,
    handleDeleteSelected,
  } = useDiscussionMessageSelection({
    messages,
    gossip,
    t,
  });

  const {
    handleSendMessage,
    handleReplyToMessage,
    handleForwardMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleCancelReply,
    handleCancelEdit,
    handleConfirmEdit,
    handleInputFocus,
  } = useDiscussionActions({
    contact: contact ?? undefined,
    isSelecting,
    t,
    forwardFromMessageId,
    setReplyingTo,
    setEditingMessage,
    setInputPrefill,
    clearForward,
  });

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchHighlightId, setSearchHighlightId] = useState<number | null>(
    null
  );

  const handleToggleSearch = useCallback(() => {
    // Side effect kept outside the setState updater (updaters must stay
    // pure — StrictMode invokes them twice).
    if (isSearchOpen) {
      const textarea = inputAreaRef.current?.querySelector('textarea');
      textarea?.focus({ preventScroll: true });
    }
    setIsSearchOpen(!isSearchOpen);
  }, [isSearchOpen]);
  const handleCloseSearch = useCallback(() => {
    const textarea = inputAreaRef.current?.querySelector('textarea');
    textarea?.focus({ preventScroll: true });
    setIsSearchOpen(false);
    setSearchHighlightId(null);
  }, []);

  const atBottomRef = useRef(true);
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const isKeyboardVisible = useKeyboardStore(s => s.isVisible);
  useEffect(() => {
    if (isKeyboardVisible && atBottomRef.current) {
      requestAnimationFrame(() => {
        messageListRef.current?.scrollToBottom();
      });
    }
  }, [isKeyboardVisible]);

  const messageListRef = useRef<MessageListHandle>(null);
  const messageListContainerRef = useRef<HTMLDivElement>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const initialScrollToMessageIdRef = useRef<number | null>(
    locationState?.scrollToMessageId ?? null
  );

  const isExiting = useContext(ExitAnimationContext);
  useHeaderScrollDetection(
    messageListContainerRef,
    messages.length,
    discussion?.id,
    isExiting
  );

  const hasPrefilledMessage = !!locationState?.prefilledMessage;
  useEffect(() => {
    if (hasPrefilledMessage && pendingSharedContent) {
      setPendingSharedContent(null);
    }
  }, [hasPrefilledMessage, pendingSharedContent, setPendingSharedContent]);

  useEffect(() => {
    if (finalPrefilledMessage) {
      setInputPrefill(finalPrefilledMessage);
    }
  }, [finalPrefilledMessage]);

  const contactUserId = contact?.userId ?? null;
  // Tracked via a ref so the unmount cleanup below sees the LATEST store
  // value, not the one captured when the effect ran.
  const storeCurrentContact = useMessageStore(s => s.currentContactUserId);
  const storeCurrentContactRef = useRef(storeCurrentContact);
  storeCurrentContactRef.current = storeCurrentContact;

  useEffect(() => {
    void setCurrentContact(contactUserId);
    return () => {
      // Leaving the discussion must stop suppressing notifications for this
      // contact. Guard against clobbering a newer value: with exit
      // animations, this cleanup can run after the next page already set
      // its own contact.
      if (storeCurrentContactRef.current === contactUserId) {
        void setCurrentContact(null);
      }
    };
  }, [contactUserId, setCurrentContact]);

  // Location state (forward / scroll-to / prefill) is one-shot: clear it
  // from the history entry so a reload or back/forward doesn't replay it.
  // (SelfDiscussion does the same.)
  useEffect(() => {
    if (
      locationState?.forwardFromMessageId != null ||
      locationState?.scrollToMessageId != null ||
      locationState?.prefilledMessage
    ) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    // Run once per mount — everything above captured the values already.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleClearSelection();
  }, [contact?.userId, handleClearSelection]);

  const hasAppliedDefaultRetentionRef = useRef(false);
  useEffect(() => {
    if (hasAppliedDefaultRetentionRef.current) return;
    if (!userId || anyDiscussionId === null) return;
    if (defaultRetentionDuration === null) return;
    if (
      anyDiscussionRetentionDuration !== null ||
      anyDiscussionRetentionPolicySetAt !== null
    )
      return;
    hasAppliedDefaultRetentionRef.current = true;
    patchDiscussion(anyDiscussionId, {
      messageRetentionDuration: defaultRetentionDuration,
      retentionPolicySetAt: Date.now(),
    });
    gossip.discussions
      .setRetentionPolicy(userId, defaultRetentionDuration)
      .catch(error => {
        logger.error('Failed to apply default retention policy:', error);
      });
  }, [
    userId,
    anyDiscussionId,
    anyDiscussionRetentionDuration,
    anyDiscussionRetentionPolicySetAt,
    defaultRetentionDuration,
    gossip,
    patchDiscussion,
  ]);

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

  useEffect(() => {
    if (
      initialScrollToMessageIdRef.current != null &&
      messages.length > 0 &&
      !isLoading
    ) {
      handleScrollToMessage(initialScrollToMessageIdRef.current);
      initialScrollToMessageIdRef.current = null;
    }
  }, [messages.length, isLoading, handleScrollToMessage]);

  // Stable handlers so the memoized MessageList isn't re-rendered by fresh
  // inline lambdas on every Discussion render.
  const handleReact = useCallback(
    (message: Message, emoji: string) => {
      if (!message.id || !contactUserId) return;
      reactToMessage(contactUserId, emoji, message.id).catch(err => {
        logger.error('Failed to send reaction', err);
      });
    },
    [contactUserId, reactToMessage]
  );

  const handleToggleReaction = useCallback(
    (
      message: Message,
      emoji: string,
      myReactionId?: number,
      myReactionMessageId?: Uint8Array
    ) => {
      if (myReactionId || myReactionMessageId) {
        removeReaction(myReactionId, myReactionMessageId).catch(err => {
          logger.error('Failed to remove reaction', err);
        });
      } else if (message.id && contactUserId) {
        reactToMessage(contactUserId, emoji, message.id).catch(err => {
          logger.error('Failed to send reaction', err);
        });
      }
    },
    [contactUserId, reactToMessage, removeReaction]
  );

  const handleSendTestMessages = useCallback(async () => {
    if (!contact?.userId || isSendingTestMessages) return;

    setIsSendingTestMessages(true);
    try {
      for (let i = 1; i <= TEST_MESSAGE_COUNT; i++) {
        await sendMessage(contact.userId, i.toString());
        if (i % 10 === 0) {
          await new Promise(resolve =>
            setTimeout(resolve, TEST_MESSAGE_BATCH_DELAY_MS)
          );
        }
      }
      toast.success(t('test_messages_sent', { count: TEST_MESSAGE_COUNT }));
    } catch (error) {
      toast.error(t('test_messages_failed'));
      logger.error('Failed to send test messages:', error);
    } finally {
      setIsSendingTestMessages(false);
    }
  }, [contact?.userId, sendMessage, isSendingTestMessages, t]);

  if (!contact) return null;

  // Hide reply + edit while the session is waiting approval (SelfRequested).
  const onReplyToMessage = isDiscussionPending
    ? undefined
    : handleReplyToMessage;
  const onEditMessage = isDiscussionPending ? undefined : handleEditMessage;

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
            canDeleteSelected,
            onClearSelection: handleClearSelection,
            onCopySelected: handleCopySelected,
            onDeleteSelected: handleDeleteSelected,
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
      beforeFooter={
        <DiscussionDebugButton
          show={showDebugOption}
          isSending={isSendingTestMessages}
          testMessageCount={TEST_MESSAGE_COUNT}
          onSend={handleSendTestMessages}
        />
      }
      footer={
        <MessageInput
          containerRef={inputAreaRef}
          disabled={isSelecting}
          isSelecting={isSelecting}
          onSend={handleSendMessage}
          replyingTo={replyingTo}
          onCancelReply={handleCancelReply}
          initialValue={forwardFromMessageId ? undefined : inputPrefill}
          forwardPreview={forwardFromMessageId ? forwardPreviewText : null}
          forwardMode={forwardPreviewMode}
          onCancelForward={clearForward}
          onFocus={handleInputFocus}
          editingMessage={editingMessage}
          onCancelEdit={handleCancelEdit}
          onConfirmEdit={handleConfirmEdit}
        />
      }
    >
      <div ref={messageListContainerRef} className="h-full">
        <MessageList
          ref={messageListRef}
          messages={messages}
          discussion={discussion}
          contact={contact}
          isLoading={isLoading || isDiscussionLoading}
          onReplyTo={onReplyToMessage}
          onForward={handleForwardMessage}
          onDelete={handleDeleteMessage}
          onEdit={onEditMessage}
          onReact={handleReact}
          getReactions={getReactions}
          onToggleReaction={handleToggleReaction}
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

// Keyed by contact so navigating from one discussion straight to another
// (e.g. jump-to-original across discussions) remounts the page: per-contact
// refs and compose state (prefill, reply, edit, default-retention flag)
// must not leak from contact A into contact B.
const Discussion: React.FC = () => {
  const { userId } = useParams();
  return <DiscussionInner key={userId ?? 'none'} />;
};

export default Discussion;
