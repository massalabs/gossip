import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useLocation } from 'react-router-dom';
import { Clock, Settings } from 'react-feather';
import { MessageDirection, Message } from '@massalabs/gossip-sdk';
import BackButton from '../components/ui/BackButton';
import MessageList from '../components/discussions/MessageList';
import MessageInput from '../components/discussions/MessageInput';
import { useSelfMessageStore } from '../stores/selfMessageStore';
import { getSdk } from '../stores/sdkStore';
import { ROUTES } from '../constants/routes';

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

const RETENTION_HEADER_LABELS: Record<number, string> = {
  300: 'settings.auto_delete_5m',
  3600: 'settings.auto_delete_1h',
  28800: 'settings.auto_delete_8h',
  86400: 'settings.auto_delete_1d',
  604800: 'settings.auto_delete_1w',
  2592000: 'settings.auto_delete_1mo',
};

const SelfDiscussion: React.FC = () => {
  const { t } = useTranslation('discussions');
  const location = useLocation();
  const navigate = useNavigate();
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

  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [forwardedContent, setForwardedContent] = useState<string | null>(null);
  const [isRetentionModalOpen, setIsRetentionModalOpen] = useState(false);
  const [retentionDuration, setRetentionDuration] = useState<number | null>(
    null
  );
  const [retentionPolicySetAt, setRetentionPolicySetAt] = useState<
    number | null
  >(null);

  const forwardFromMessageId = (
    location.state as { forwardFromMessageId?: number } | undefined
  )?.forwardFromMessageId;

  useEffect(() => {
    if (forwardFromMessageId == null) return;
    let cancelled = false;
    const load = async () => {
      const msg = await getSdk().messages.get(forwardFromMessageId);
      if (!cancelled && msg?.content) {
        setForwardedContent(msg.content);
      }
      if (!cancelled) {
        navigate(ROUTES.selfDiscussion(), { replace: true, state: {} });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [forwardFromMessageId, navigate]);

  useEffect(() => {
    void loadMessages();
    void loadReactions();
  }, [loadMessages, loadReactions]);

  useEffect(() => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;
    void sdk.selfMessages.getRetentionInfo().then(info => {
      setRetentionDuration(info.duration);
      setRetentionPolicySetAt(info.setAt);
    });
  }, []);

  const handleSelectRetention = useCallback(async (value: number | null) => {
    const sdk = getSdk();
    if (!sdk.isSessionOpen) return;
    await sdk.selfMessages.setRetentionPolicy(value);
    setRetentionDuration(value);
    setRetentionPolicySetAt(value ? Date.now() : null);
    setIsRetentionModalOpen(false);
  }, []);

  const retentionHeaderLabel = useMemo(() => {
    if (!retentionDuration) return null;
    const key = RETENTION_HEADER_LABELS[retentionDuration];
    return key ? t(key) : null;
  }, [retentionDuration, t]);

  const outgoingMessages = useMemo(
    () =>
      messages.map(m => ({
        ...m,
        direction: MessageDirection.OUTGOING,
      })),
    [messages]
  );

  return (
    <div className="h-full app-max-w mx-auto bg-discussion-pattern flex flex-col relative overflow-hidden">
      {/* Header */}
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

      {/* Body */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-hidden">
          {!isLoading && outgoingMessages.length === 0 ? (
            <div className="h-full flex items-center justify-center px-8">
              <p className="text-center text-sm text-muted-foreground">
                {t('selfDiscussion.emptyState')}
              </p>
            </div>
          ) : (
            <MessageList
              messages={outgoingMessages}
              isLoading={isLoading}
              retentionInfo={
                retentionDuration && retentionPolicySetAt
                  ? { setAt: retentionPolicySetAt, duration: retentionDuration }
                  : null
              }
              onEdit={message => {
                setEditingMessage(message);
                setReplyingTo(null);
              }}
              onDelete={message => {
                if (message.id != null) {
                  void deleteMessage(message.id);
                }
              }}
              getReactionsForMessage={messageId =>
                reactions.get(messageId) ?? []
              }
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

        <MessageInput
          initialValue={
            editingMessage?.content ?? forwardedContent ?? undefined
          }
          onSend={content => {
            void sendMessage(content);
            setReplyingTo(null);
            setForwardedContent(null);
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
      </div>

      {/* Retention picker modal */}
      {isRetentionModalOpen && (
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
      )}
    </div>
  );
};

export default SelfDiscussion;
