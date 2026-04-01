import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDiscussion } from '../hooks/useDiscussion';
import { useAppStore } from '../stores/appStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import toast from 'react-hot-toast';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import { Message } from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useDiscussionMessageSelection } from '../hooks/useDiscussionMessageSelection';
import { useDiscussionScrollToMessage } from '../hooks/useDiscussionScrollToMessage';
import { useHeaderScrollDetection } from '../hooks/useHeaderScrollDetection';
import { useForwardPreview } from '../hooks/useForwardPreview';
import { useDiscussionActions } from '../hooks/useDiscussionActions';
import { useKeyboardStore } from '../stores/keyboardStore';
import DiscussionTopSection from '../components/discussions/DiscussionTopSection';
import DiscussionDebugButton from '../components/discussions/DiscussionDebugButton';
import MessageInput from '../components/discussions/MessageInput';
import { useSwipeBack } from '../hooks/useSwipeBack';

const TEST_MESSAGE_COUNT = 50;
const TEST_MESSAGE_BATCH_DELAY_MS = 100;

const Discussion: React.FC = () => {
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const { userId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const contacts = useDiscussionStore(s => s.contacts);
  const patchDiscussion = useDiscussionStore(s => s.patchDiscussion);

  const locationState = location.state as {
    prefilledMessage?: string;
    forwardFromMessageId?: number;
    scrollToMessageId?: number;
  } | null;
  const prefilledMessage = locationState?.prefilledMessage;

  // Also check app store as fallback (in case location state is lost)
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);

  const finalPrefilledMessage = prefilledMessage || pendingSharedContent;

  // Local one-shot prefill state for the input. This lets us clear the input
  // after sending (especially for forwards) without reusing location state.
  const [inputPrefill, setInputPrefill] = useState<string | undefined>(
    finalPrefilledMessage || undefined
  );

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  const contact = userId ? contacts.find(c => c.userId === userId) : undefined;
  const onBack = () => navigate(-1);
  const swipeBack = useSwipeBack();

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
    contact ? s.getMessagesForContact(contact.userId) : []
  );
  const reactionGroups = useMessageStore(s => s.reactionGroupsCache);
  const sendReaction = useMessageStore(s => s.sendReaction);
  const removeReaction = useMessageStore(s => s.removeReaction);
  const isLoading = useMessageStore(s => s.isInitializing);
  const sendMessage = useMessageStore(s => s.sendMessage);

  const prevContactUserIdRef = useRef<string | null>(null);

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
    discussionCustomName: discussion?.customName ?? undefined,
    contactName: contact?.name,
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
    gossip,
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
    setIsSearchOpen(prev => {
      if (prev) {
        // Closing search — transfer focus to textarea so keyboard stays
        const textarea = inputAreaRef.current?.querySelector('textarea');
        textarea?.focus({ preventScroll: true });
      }
      return !prev;
    });
  }, []);
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

  // Scroll to bottom when keyboard opens so newest messages stay visible
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

  useHeaderScrollDetection(
    messageListContainerRef,
    messages.length,
    discussion?.id
  );

  // Clear pendingSharedContent only when this discussion was opened
  // with a prefilled message from the share/forward flow.
  const hasPrefilledMessage = !!locationState?.prefilledMessage;
  useEffect(() => {
    if (hasPrefilledMessage && pendingSharedContent) {
      setPendingSharedContent(null);
    }
  }, [hasPrefilledMessage, pendingSharedContent, setPendingSharedContent]);

  // Keep inputPrefill in sync with finalPrefilledMessage for third-party shares.
  useEffect(() => {
    if (finalPrefilledMessage) {
      setInputPrefill(finalPrefilledMessage);
    }
  }, [finalPrefilledMessage]);

  useEffect(() => {
    const contactUserId = contact?.userId || null;
    if (prevContactUserIdRef.current !== contactUserId) {
      prevContactUserIdRef.current = contactUserId;
      setCurrentContact(contactUserId);
    }
  }, [contact?.userId, setCurrentContact]);

  useEffect(() => {
    handleClearSelection();
  }, [contact?.userId, handleClearSelection]);

  // Apply default retention policy to new discussions that have never had one set
  const hasAppliedDefaultRetentionRef = useRef(false);
  useEffect(() => {
    if (hasAppliedDefaultRetentionRef.current) return;
    if (!userId || anyDiscussionId === null) return;
    if (defaultRetentionDuration === null) return;
    // Only apply if no retention policy has ever been configured
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
    void gossip.discussions.setRetentionPolicy(
      userId,
      defaultRetentionDuration
    );
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
      console.error('Failed to send test messages:', error);
    } finally {
      setIsSendingTestMessages(false);
    }
  }, [contact?.userId, sendMessage, isSendingTestMessages, t]);

  if (!contact) return null;

  return (
    <div
      className="h-full app-max-w mx-auto bg-card flex flex-col relative select-none overflow-hidden"
      style={{ WebkitTouchCallout: 'none' }}
      onTouchStart={swipeBack.onTouchStart}
      onTouchEnd={swipeBack.onTouchEnd}
      onPointerDown={e => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
        }
      }}
    >
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

      <div className="flex-1 min-h-0 flex flex-col">
        <div
          ref={messageListContainerRef}
          className="flex-1 min-h-0 overflow-hidden relative"
        >
          <MessageList
            ref={messageListRef}
            messages={messages}
            discussion={discussion}
            contact={contact}
            isLoading={isLoading || isDiscussionLoading}
            onReplyTo={handleReplyToMessage}
            onForward={handleForwardMessage}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onReact={(message, emoji) => {
              if (!message.id) return;
              sendReaction(contact.userId, emoji, message.id).catch(err => {
                console.error('Failed to send reaction', err);
              });
            }}
            reactionGroups={reactionGroups}
            onToggleReaction={(
              message,
              emoji,
              myReactionId,
              myReactionMessageId
            ) => {
              if (myReactionId || myReactionMessageId) {
                removeReaction(myReactionId, myReactionMessageId).catch(err => {
                  console.error('Failed to remove reaction', err);
                });
              } else if (message.id) {
                sendReaction(contact.userId, emoji, message.id).catch(err => {
                  console.error('Failed to send reaction', err);
                });
              }
            }}
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

        <DiscussionDebugButton
          show={showDebugOption}
          isSending={isSendingTestMessages}
          testMessageCount={TEST_MESSAGE_COUNT}
          onSend={handleSendTestMessages}
        />

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
      </div>
    </div>
  );
};

export default Discussion;
