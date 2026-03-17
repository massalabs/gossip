import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useDiscussion } from '../hooks/useDiscussion';
import { useAppStore } from '../stores/appStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import toast from 'react-hot-toast';
import { ROUTES } from '../constants/routes';
import DiscussionHeader from '../components/discussions/DiscussionHeader';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import MessageInput from '../components/discussions/MessageInput';
import ScrollToBottomButton from '../components/discussions/ScrollToBottomButton';
import MessageSearch from '../components/discussions/MessageSearch';
import {
  Message,
  MessageDirection,
  MessageStatus,
} from '@massalabs/gossip-sdk';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { isDifferentDay } from '../utils/timeUtils';
import { useUiStore } from '../stores/uiStore';
import SessionIssueBanner from '../components/discussions/SessionIssueBanner';
import SelectionHeader from '../components/discussions/SelectionHeader';

// Debug test message constants
const TEST_MESSAGE_COUNT = 50;
const TEST_MESSAGE_BATCH_DELAY_MS = 100;

const Discussion: React.FC = () => {
  const { t } = useTranslation('discussions');
  const gossip = useGossipSdk();
  const { userId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const contacts = useDiscussionStore(s => s.contacts);

  // Get prefilled message from location state (for shared content)
  const locationState = location.state as {
    prefilledMessage?: string;
    forwardFromMessageId?: number;
    scrollToMessageId?: number;
  } | null;
  const prefilledMessage = locationState?.prefilledMessage;

  // Also check app store as fallback (in case location state is lost)
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);
  const setPendingForwardMessageId = useAppStore(
    s => s.setPendingForwardMessageId
  );

  // Use prefilledMessage from location state, or fallback to app store
  const finalPrefilledMessage = prefilledMessage || pendingSharedContent;

  // Local one-shot prefill state for the input. This lets us clear the input
  // after sending (especially for forwards) without reusing location state.
  const [inputPrefill, setInputPrefill] = useState<string | undefined>(
    finalPrefilledMessage || undefined
  );

  // Dedicated preview text for forwards (loaded from DB using forwardFromMessageId)
  const [forwardPreviewText, setForwardPreviewText] = useState<string | null>(
    null
  );
  const [forwardPreviewMode, setForwardPreviewMode] = useState<
    'forward' | 'reply'
  >('forward');

  // Track forwardFromMessageId for a single send
  const [forwardFromMessageId, setForwardFromMessageId] = useState<
    number | undefined
  >(locationState?.forwardFromMessageId);

  // Track an optional initial message to scroll to when opening this discussion
  const initialScrollToMessageIdRef = useRef<number | null>(
    locationState?.scrollToMessageId ?? null
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

  const contact = userId ? contacts.find(c => c.userId === userId) : undefined;
  const onBack = () => navigate(-1);

  // Provide a fallback contact to prevent hook errors
  const safeContact = contact || {
    userId: '',
    ownerUserId: '',
    name: '',
    publicKeys: new Uint8Array(),
    isOnline: false,
    lastSeen: new Date(),
    createdAt: new Date(),
  };

  const { discussion, isLoading: isDiscussionLoading } = useDiscussion({
    contact: safeContact,
  });

  const showDebugOption = useAppStore(s => s.showDebugOption);
  const [isSendingTestMessages, setIsSendingTestMessages] = useState(false);

  // Use message store
  const setCurrentContact = useMessageStore(s => s.setCurrentContact);
  const messages = useMessageStore(s =>
    contact ? s.getMessagesForContact(contact.userId) : []
  );
  const getReactionsForMessage = useMessageStore(s => s.getReactionsForMessage);
  const sendReaction = useMessageStore(s => s.sendReaction);
  const removeReaction = useMessageStore(s => s.removeReaction);
  const outgoingSentCount = React.useMemo(
    () =>
      messages.filter(
        message =>
          message.direction === MessageDirection.OUTGOING &&
          message.status === MessageStatus.SENT
      ).length,
    [messages]
  );

  const isLoading = useMessageStore(s => s.isLoading);
  const sendMessage = useMessageStore(s => s.sendMessage);

  // Track previous contact userId to prevent unnecessary updates
  const prevContactUserIdRef = useRef<string | null>(null);

  // Multi-select state
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(
    new Set()
  );
  const isSelecting = selectedMessageIds.size > 0;
  const selectedMessages = React.useMemo(
    () =>
      messages.filter(
        // Keep this as != null (not truthy) so message id 0 remains valid.
        m => m.id != null && selectedMessageIds.has(m.id)
      ),
    [messages, selectedMessageIds]
  );
  const canDeleteSelected = React.useMemo(
    () =>
      selectedMessages.length > 0 &&
      selectedMessages.every(
        message => message.direction === MessageDirection.OUTGOING
      ),
    [selectedMessages]
  );

  const handleToggleSelect = useCallback((messageId: number) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedMessageIds(new Set());
  }, []);

  const handleCopySelected = useCallback(async () => {
    const selected = messages
      // Keep this as != null (not truthy) so message id 0 remains valid.
      .filter(m => m.id != null && selectedMessageIds.has(m.id))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const contactName = discussion?.customName || contact?.name || 'Unknown';
    const text = selected
      .map(m => {
        const sender =
          m.direction === MessageDirection.OUTGOING
            ? t('copy_you')
            : contactName;
        return `${sender}\n${m.content}`;
      })
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      handleClearSelection();
    } catch {
      toast.error(t('failed_to_copy_selected'));
    }
  }, [
    messages,
    selectedMessageIds,
    discussion,
    contact,
    handleClearSelection,
    t,
  ]);

  const handleDeleteSelected = useCallback(async () => {
    if (!canDeleteSelected || selectedMessages.length === 0) return;

    const failedMessageIds: number[] = [];
    const deletedMessageIds: number[] = [];
    for (const message of selectedMessages) {
      if (message.id == null) continue;
      try {
        const deleted = await gossip.messages.deleteMessage(message.id);
        if (!deleted) {
          failedMessageIds.push(message.id);
          console.error('[multi-delete] deleteMessage returned false', {
            messageId: message.id,
          });
        } else {
          deletedMessageIds.push(message.id);
        }
      } catch (error) {
        failedMessageIds.push(message.id);
        console.error('[multi-delete] deleteMessage threw', {
          messageId: message.id,
          error,
        });
      }
    }

    if (failedMessageIds.length > 0) {
      console.error('[multi-delete] partial failure summary', {
        selectedCount: selectedMessages.length,
        deletedCount: deletedMessageIds.length,
        failedCount: failedMessageIds.length,
        failedMessageIds,
      });
    }

    handleClearSelection();
    if (failedMessageIds.length > 0) {
      toast.error(t('failed_to_delete_selected'));
    }
  }, [canDeleteSelected, selectedMessages, gossip, handleClearSelection, t]);

  // Reply state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);

  // Scroll to bottom button visibility
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Message search
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchHighlightId, setSearchHighlightId] = useState<number | null>(
    null
  );
  const isSearchOpenRef = useRef(false);
  isSearchOpenRef.current = isSearchOpen;

  // Handle at bottom state changes
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollToBottom(!atBottom);
  }, []);

  // Track timeout for message highlight
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Ref to the MessageList for imperative scrolling
  const messageListRef = useRef<MessageListHandle>(null);
  const messageListContainerRef = useRef<HTMLDivElement>(null);

  // Measure input area height so ScrollToBottomButton sits just above it
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const [inputAreaHeight, setInputAreaHeight] = useState(0);
  useEffect(() => {
    const el = inputAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const nextHeight = entry.contentRect.height;
      setInputAreaHeight(prev => (prev === nextHeight ? prev : nextHeight));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Find Virtuoso's scroll container and set up header scroll detection
  useEffect(() => {
    if (!messageListContainerRef.current) return;

    let scrollContainer: HTMLElement | null = null;
    let rafId: number | null = null;
    const setHeaderIsScrolled = useUiStore.getState().setHeaderIsScrolled;

    // Virtuoso creates a scroll container, find it
    const findScrollContainer = (): HTMLElement | null => {
      // Virtuoso typically creates a div with overflow-y-auto or overflow-auto
      const container = messageListContainerRef.current?.querySelector(
        '[data-virtuoso-scroller]'
      ) as HTMLElement;

      if (container) {
        return container;
      }

      // Fallback: find any element with overflow-y-auto or overflow-auto
      const allElements =
        messageListContainerRef.current?.querySelectorAll('*');
      if (allElements) {
        for (const el of Array.from(allElements)) {
          const htmlEl = el as HTMLElement;
          const style = window.getComputedStyle(htmlEl);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            htmlEl.scrollHeight > htmlEl.clientHeight
          ) {
            return htmlEl;
          }
        }
      }
      return null;
    };

    const handleScroll = () => {
      if (!scrollContainer) return;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        setHeaderIsScrolled(scrollContainer!.scrollTop > 0);
        rafId = null;
      });
    };

    // Try to find scroll container after a short delay to ensure Virtuoso has rendered
    const timeoutId = setTimeout(() => {
      scrollContainer = findScrollContainer();
      if (scrollContainer) {
        // Set initial state
        setHeaderIsScrolled(scrollContainer.scrollTop > 0);
        scrollContainer.addEventListener('scroll', handleScroll, {
          passive: true,
        });
      }
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      if (scrollContainer) {
        scrollContainer.removeEventListener('scroll', handleScroll);
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [messages.length, discussion?.id]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  // Set current contact when it changes (only if different)
  useEffect(() => {
    const contactUserId = contact?.userId || null;
    if (prevContactUserIdRef.current !== contactUserId) {
      prevContactUserIdRef.current = contactUserId;
      setCurrentContact(contactUserId);
    }
  }, [contact?.userId, setCurrentContact]);

  // Reset message selection when switching discussions
  useEffect(() => {
    handleClearSelection();
  }, [contact?.userId, handleClearSelection]);

  // Scroll to bottom utility - uses the virtuoso ref
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
  }, []);

  const handleSendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (isSelecting) return;
      if (!contact?.userId) return;
      try {
        await sendMessage(
          contact.userId,
          text,
          replyToId,
          forwardFromMessageId
        );
        setReplyingTo(null);
        setEditingMessage(null);
        if (forwardFromMessageId !== undefined) {
          setForwardFromMessageId(undefined);
        }
        // Clear any prefill after a successful send so the input is empty
        setInputPrefill(undefined);
        setForwardPreviewText(null);
        // Scroll to bottom after sending (handled automatically by followOutput)
      } catch (error) {
        toast.error(t('failed_to_send'));
        console.error('Failed to send message:', error);
      }
    },
    [isSelecting, sendMessage, contact?.userId, forwardFromMessageId, t]
  );

  const handleReplyToMessage = useCallback((message: Message) => {
    setReplyingTo(message);
    setEditingMessage(null);
    // Clear forward preview — reply and forward are mutually exclusive
    setForwardFromMessageId(undefined);
    setForwardPreviewText(null);
  }, []);

  const handleForwardMessage = useCallback(
    (message: Message) => {
      if (!message.id) return;
      // Reuse the share flow: set pending content + forward id, then navigate to discussions
      setPendingSharedContent(message.content);
      setPendingForwardMessageId(message.id);
      navigate(ROUTES.discussions());
    },
    [navigate, setPendingForwardMessageId, setPendingSharedContent]
  );

  const handleEditMessage = useCallback((message: Message) => {
    setEditingMessage(message);
    setReplyingTo(null);
    setInputPrefill(message.content);
  }, []);

  const handleDeleteMessage = useCallback(
    async (message: Message) => {
      if (!message.id) return;
      try {
        const deleted = await gossip.messages.deleteMessage(message.id);
        if (!deleted) {
          toast.error(t('unable_to_delete'));
        }
      } catch (error) {
        toast.error(t('failed_to_delete'));
        console.error('Failed to delete message:', error);
      }
    },
    [gossip, t]
  );

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setInputPrefill(undefined);
  }, []);

  const handleCancelForward = useCallback(() => {
    setForwardFromMessageId(undefined);
    setForwardPreviewText(null);
  }, []);

  const handleConfirmEdit = useCallback(
    async (newContent: string, message: Message) => {
      if (!message.id) return;
      try {
        const ok = await gossip.messages.editMessage(message.id, newContent);
        if (!ok) {
          toast.error(t('unable_to_edit'));
        }
      } catch (error) {
        toast.error(t('failed_to_edit'));
        console.error('Failed to edit message:', error);
      } finally {
        setEditingMessage(null);
        setInputPrefill(undefined);
      }
    },
    [gossip, t]
  );

  const handleInputFocus = useCallback(() => {
    // No forced scroll — let the container resize naturally.
    // Virtuoso maintains scroll position when the container shrinks.
  }, []);

  const handleScrollToMessage = useCallback(
    (messageId: number) => {
      (async () => {
        // Look up the message to determine which discussion it belongs to
        const target = await gossip.messages.get(messageId);
        if (!target) {
          console.warn(`Message with id ${messageId} not found in database`);
          return;
        }

        // If the message belongs to a different discussion, navigate there
        if (target.contactUserId !== contact?.userId) {
          navigate(ROUTES.discussion({ userId: target.contactUserId }), {
            state: { scrollToMessageId: messageId },
          });
          return;
        }

        // Same discussion → scroll within current view
        // Find the message in the messages array and calculate its virtual index
        const messageIndex = messages.findIndex(msg => msg.id === messageId);
        if (messageIndex === -1) {
          console.warn(
            `Message ${messageId} not found in current messages array. It may not be loaded yet.`
          );
          return;
        }

        // Calculate virtual index by counting items before the target message
        let virtualIndex = 0;

        // Add announcement if exists
        if (discussion?.lastAnnouncementMessage && discussion.createdAt) {
          virtualIndex++;
        }

        // Count items before the target message
        for (let i = 0; i < messageIndex; i++) {
          const message = messages[i];
          const prevMessage = i > 0 ? messages[i - 1] : null;

          // Add date separator if day changed
          if (
            !prevMessage ||
            isDifferentDay(message.timestamp, prevMessage.timestamp)
          ) {
            virtualIndex++;
          }

          // Add the message itself
          virtualIndex++;
        }

        // Add date separator for the target message if needed
        const prevMessage =
          messageIndex > 0 ? messages[messageIndex - 1] : null;
        const targetMessage = messages[messageIndex];
        if (
          !prevMessage ||
          isDifferentDay(targetMessage.timestamp, prevMessage.timestamp)
        ) {
          virtualIndex++;
        }

        // The target message is at this virtual index
        // Use scrollToIndex to scroll to the message
        messageListRef.current?.scrollToIndex(virtualIndex);

        // Add animated highlight only when NOT driven by search (search uses persistent highlight)
        if (!isSearchOpenRef.current) {
          setTimeout(() => {
            const element = document.getElementById(`message-${messageId}`);
            if (element) {
              element.classList.add('highlight-message');

              // Clear any existing timeout
              if (highlightTimeoutRef.current) {
                clearTimeout(highlightTimeoutRef.current);
              }

              highlightTimeoutRef.current = setTimeout(() => {
                const el = document.getElementById(`message-${messageId}`);
                if (el) {
                  el.classList.remove('highlight-message');
                }
              }, 2000);
            }
          }, 200);
        }
      })();
    },
    [
      gossip,
      contact?.userId,
      messages,
      discussion?.lastAnnouncementMessage,
      discussion?.createdAt,
      navigate,
    ]
  );

  // Load forward preview text from DB when a forward is active
  useEffect(() => {
    let cancelled = false;

    const loadForwardPreview = async () => {
      if (forwardFromMessageId == null) {
        setForwardPreviewText(null);
        setForwardPreviewMode('forward');
        return;
      }

      // Clear reply — reply and forward are mutually exclusive
      setReplyingTo(null);
      const original = await gossip.messages.get(forwardFromMessageId);
      if (!cancelled) {
        setForwardPreviewText(original?.content ?? null);
        if (original && contact && original.contactUserId === contact.userId) {
          setForwardPreviewMode('reply');
        } else {
          setForwardPreviewMode('forward');
        }
      }
    };

    loadForwardPreview();

    return () => {
      cancelled = true;
    };
  }, [forwardFromMessageId, contact, gossip]);

  // When opening a discussion with a target message (e.g. from forwarded content),
  // automatically scroll to that message once messages have loaded.
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

  // Debug function to send test messages
  const handleSendTestMessages = useCallback(async () => {
    if (!contact?.userId || isSendingTestMessages) return;

    setIsSendingTestMessages(true);
    try {
      for (let i = 1; i <= TEST_MESSAGE_COUNT; i++) {
        await sendMessage(contact.userId, i.toString());
        // Small delay between messages to avoid overwhelming the system
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
      onMouseDown={e => {
        // Prevent taps from stealing focus / dismissing keyboard,
        // unless the tap target is itself a focusable input element.
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
        }
      }}
    >
      {/* Header stays fixed in place — shifted content slides behind it */}
      <div className="relative z-10">
        {isSelecting ? (
          <SelectionHeader
            count={selectedMessageIds.size}
            onClear={handleClearSelection}
            onCopy={handleCopySelected}
            onDelete={handleDeleteSelected}
            canDelete={canDeleteSelected}
          />
        ) : (
          <DiscussionHeader
            contact={contact}
            discussion={discussion}
            onBack={onBack}
            onSearchToggle={() => setIsSearchOpen(prev => !prev)}
          />
        )}
        <SessionIssueBanner
          discussion={discussion}
          outgoingSentCount={outgoingSentCount}
        />
        {isSearchOpen && (
          <MessageSearch
            messages={messages}
            onScrollToMessage={handleScrollToMessage}
            onHighlightChange={setSearchHighlightId}
            onClose={() => {
              setIsSearchOpen(false);
              setSearchHighlightId(null);
            }}
          />
        )}
      </div>

      {/* Content shifts up via CSS transform when keyboard opens.
          Messages slide behind the header. No scroll manipulation needed. */}
      <div className="flex-1 min-h-0 flex flex-col keyboard-shift-content">
        <div
          ref={messageListContainerRef}
          className="flex-1 min-h-0 overflow-hidden"
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
            getReactionsForMessage={messageId =>
              getReactionsForMessage(contact.userId, messageId)
            }
            onToggleReaction={(message, emoji, myReactionId) => {
              if (myReactionId) {
                removeReaction(myReactionId).catch(err => {
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
            highlightedMessageId={searchHighlightId}
            isSelecting={isSelecting}
            selectedMessageIds={selectedMessageIds}
            onToggleSelect={handleToggleSelect}
          />
        </div>

        <ScrollToBottomButton
          onClick={scrollToBottom}
          isVisible={showScrollToBottom}
          bottomOffset={isSelecting ? 0 : inputAreaHeight}
        />

        {/* Debug test button - only show when debug mode is enabled */}
        {showDebugOption && (
          <div className="absolute bottom-32 right-4 z-10">
            <button
              onClick={handleSendTestMessages}
              disabled={isSendingTestMessages}
              className={`w-12 h-12 rounded-full bg-orange-500 hover:bg-orange-600 disabled:bg-orange-300 text-white shadow-lg border border-border flex items-center justify-center text-xs font-bold transition-all ${
                isSendingTestMessages ? 'animate-pulse' : ''
              }`}
              title={`Send ${TEST_MESSAGE_COUNT} test messages (Debug)`}
            >
              {isSendingTestMessages ? '...' : TEST_MESSAGE_COUNT.toString()}
            </button>
          </div>
        )}

        <div
          ref={inputAreaRef}
          className={`transition-all duration-300 ease-out ${
            isSelecting ? 'pointer-events-none opacity-0' : 'opacity-100'
          }`}
          style={{
            transform: isSelecting
              ? `translateY(${inputAreaHeight}px)`
              : 'translateY(0)',
            marginBottom: isSelecting ? `-${inputAreaHeight}px` : '0px',
          }}
          aria-hidden={isSelecting}
        >
          <MessageInput
            onSend={handleSendMessage}
            disabled={isSelecting}
            replyingTo={replyingTo}
            onCancelReply={handleCancelReply}
            initialValue={forwardFromMessageId ? undefined : inputPrefill}
            forwardPreview={forwardFromMessageId ? forwardPreviewText : null}
            forwardMode={forwardPreviewMode}
            onCancelForward={handleCancelForward}
            onFocus={handleInputFocus}
            editingMessage={editingMessage}
            onCancelEdit={handleCancelEdit}
            onConfirmEdit={handleConfirmEdit}
          />
        </div>
      </div>
    </div>
  );
};

export default Discussion;
