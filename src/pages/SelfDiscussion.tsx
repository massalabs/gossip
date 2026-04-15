import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Clock, Settings } from 'react-feather';
import { MessageDirection, Message } from '@massalabs/gossip-sdk';
import BackButton from '../components/ui/BackButton';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import MessageInput from '../components/discussions/MessageInput';
import DiscussionLayout from '../components/discussions/DiscussionLayout';
import { useSelfMessageStore } from '../stores/selfMessageStore';
import { getSdk } from '../stores/sdkStore';
import { useDiscussionMessageSelection } from '../hooks/useDiscussionMessageSelection';
import { useGossipSdk } from '../hooks/useGossipSdk';
import SelectionHeader from '../components/discussions/SelectionHeader';
import { useRetentionPolicy } from '../hooks/useRetentionPolicy';
import { useKeyboardStore } from '../stores/keyboardStore';

const RETENTION_OPTIONS: {
  labelKey: string;
  value: number | null;
}[] = [
  { labelKey: 'settings.auto_delete_off', value: null },
  { labelKey: 'settings.auto_delete_5m', value: 300 },
  { labelKey: 'settings.auto_delete_1h', value: 3600 },
  { labelKey: 'settings.auto_delete_8h', value: 28800 },
  { labelKey: 'settings.auto_delete_1d', value: 86400 },
  { labelKey: 'settings.auto_delete_1w', value: 604800 },
  { labelKey: 'settings.auto_delete_1mo', value: 2592000 },
];

const SelfDiscussion: React.FC = () => {
  const { t } = useTranslation('discussions');
  const location = useLocation();
  const messages = useSelfMessageStore.use.messages();
  const isLoading = useSelfMessageStore.use.isLoading();
  const loadMessages = useSelfMessageStore.use.loadMessages();
  const sendMessage = useSelfMessageStore.use.sendMessage();
  const editMessage = useSelfMessageStore.use.editMessage();
  const deleteMessage = useSelfMessageStore.use.deleteMessage();
  const sendReaction = useSelfMessageStore.use.sendReaction();
  const removeReaction = useSelfMessageStore.use.removeReaction();
  const reactions = useSelfMessageStore.use.reactions();
  const loadReactions = useSelfMessageStore.use.loadReactions();

  const gossip = useGossipSdk();

  const selfReactionGroups = useMemo(() => {
    const map = new Map<
      string,
      { emoji: string; count: number; myReactionId?: number }[]
    >();
    for (const msg of messages) {
      if (msg.messageId && msg.id != null) {
        const groups = reactions.get(msg.id);
        if (groups) map.set(msg.messageId.join(','), groups);
      }
    }
    return map;
  }, [messages, reactions]);

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const messageListRef = useRef<MessageListHandle>(null);
  const atBottomRef = useRef(true);

  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setShowScrollToBottom(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
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

  const {
    retentionDuration,
    isRetentionModalOpen,
    setIsRetentionModalOpen,
    handleSelectRetention,
    retentionHeaderLabel,
    retentionInfo,
  } = useRetentionPolicy(t);

  const forwardFromMessageId = (
    location.state as { forwardFromMessageId?: number } | undefined
  )?.forwardFromMessageId;

  const forwardHandledRef = useRef<number | null>(null);
  useEffect(() => {
    if (forwardFromMessageId == null) return;
    if (forwardHandledRef.current === forwardFromMessageId) return;
    forwardHandledRef.current = forwardFromMessageId;

    void (async () => {
      const msg = await getSdk().messages.get(forwardFromMessageId);
      if (msg?.content) {
        await sendMessage(msg.content);
      }
    })();
  }, [forwardFromMessageId, sendMessage]);

  useEffect(() => {
    void loadMessages();
    void loadReactions();
  }, [loadMessages, loadReactions]);

  const outgoingMessages = useMemo(
    () =>
      messages.map(m => ({
        ...m,
        direction: MessageDirection.OUTGOING,
      })),
    [messages]
  );

  // Scroll to bottom once messages are loaded
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (initialScrollDone.current || isLoading || outgoingMessages.length === 0)
      return;
    initialScrollDone.current = true;
    requestAnimationFrame(() => {
      messageListRef.current?.scrollToBottom();
    });
  }, [isLoading, outgoingMessages.length]);

  const {
    selectedMessageIds,
    isSelecting,
    handleToggleSelect,
    handleClearSelection,
    handleCopySelected,
    handleDeleteSelected,
    canDeleteSelected,
  } = useDiscussionMessageSelection({
    messages: outgoingMessages,
    contactName: t('selfDiscussion.title'),
    gossip,
    t,
    onDeleteMessage: async (id: number) => {
      await deleteMessage(id);
      return true;
    },
  });

  const header = isSelecting ? (
    <SelectionHeader
      count={selectedMessageIds.size}
      onClear={handleClearSelection}
      onCopy={handleCopySelected}
      onDelete={handleDeleteSelected}
      canDelete={canDeleteSelected}
    />
  ) : (
    <div className="px-header-padding pt-safe-t h-header-safe flex items-center gap-3 shrink-0 z-10 bg-card">
      <BackButton />
      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-semibold text-foreground">
          {t('selfDiscussion.title')}
        </h1>
        {retentionHeaderLabel && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="w-3 h-3 shrink-0" />
            {t('header.auto_delete_active', {
              duration: retentionHeaderLabel,
            })}
          </span>
        )}
      </div>
      <button
        onClick={() => setIsRetentionModalOpen(true)}
        className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted transition-colors shrink-0"
        aria-label={t('settings.auto_delete')}
      >
        <Settings className="w-5 h-5 text-muted-foreground" />
      </button>
    </div>
  );

  const retentionModal = isRetentionModalOpen ? (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={() => setIsRetentionModalOpen(false)}
    >
      <div
        className="bg-background w-full max-w-md rounded-t-2xl p-6 pb-8"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold text-foreground mb-1">
          {t('settings.auto_delete')}
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          {t('settings.auto_delete_description')}
        </p>
        <div className="flex flex-col gap-1">
          {RETENTION_OPTIONS.map(option => (
            <button
              key={String(option.value)}
              onClick={() => void handleSelectRetention(option.value)}
              className={`w-full text-left px-4 py-3 rounded-lg text-sm transition-colors ${
                retentionDuration === option.value
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted text-foreground'
              }`}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <DiscussionLayout
      header={header}
      className="bg-card"
      footer={
        <MessageInput
          disabled={isSelecting}
          isSelecting={isSelecting}
          initialValue={editingMessage?.content}
          onSend={content => {
            void sendMessage(content);
            setReplyingTo(null);
          }}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          editingMessage={editingMessage}
          onCancelEdit={() => setEditingMessage(null)}
          onConfirmEdit={(newContent, message) => {
            if (message.id != null) {
              void editMessage(message.id, newContent);
            }
            setEditingMessage(null);
          }}
          placeholderKey="selfDiscussion.placeholder"
        />
      }
      overlay={retentionModal}
    >
      <div className="h-full bg-discussion-pattern">
        {!isLoading && outgoingMessages.length === 0 ? (
          <div className="h-full flex items-center justify-center px-8">
            <p className="text-center text-sm text-muted-foreground">
              {t('selfDiscussion.emptyState')}
            </p>
          </div>
        ) : (
          <MessageList
            ref={messageListRef}
            messages={outgoingMessages}
            isLoading={isLoading}
            isSelecting={isSelecting}
            selectedMessageIds={selectedMessageIds}
            onToggleSelect={handleToggleSelect}
            retentionInfo={retentionInfo}
            onAtBottomChange={handleAtBottomChange}
            onScrollToBottom={scrollToBottom}
            showScrollToBottom={showScrollToBottom && !isSelecting}
            onEdit={message => {
              setEditingMessage(message);
              setReplyingTo(null);
            }}
            onDelete={message => {
              if (message.id != null) {
                void deleteMessage(message.id);
              }
            }}
            reactionGroups={selfReactionGroups}
            onReact={(message, emoji) => {
              if (message.id != null) {
                void sendReaction(emoji, message.id);
              }
            }}
            onToggleReaction={(message, emoji, myReactionId) => {
              if (myReactionId) {
                void removeReaction(myReactionId);
              } else if (message.id != null) {
                void sendReaction(emoji, message.id);
              }
            }}
          />
        )}
      </div>
    </DiscussionLayout>
  );
};

export default SelfDiscussion;
