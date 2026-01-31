import React, { useEffect, useCallback, useRef, useState } from 'react';
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
import { Message, gossipSdk } from '@massalabs/gossip-sdk';
import { isDifferentDay } from '../utils/timeUtils';
import { useUiStore } from '../stores/uiStore';

// Debug test message constants
const TEST_MESSAGE_COUNT = 50;
const TEST_MESSAGE_BATCH_DELAY_MS = 100;

const Discussion: React.FC = () => {
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

  const isLoading = useMessageStore(s => s.isLoading);
  const sendMessage = useMessageStore(s => s.sendMessage);

  // Track previous contact userId to prevent unnecessary updates
  const prevContactUserIdRef = useRef<string | null>(null);

  // Reply state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Scroll to bottom button visibility
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Handle at bottom state changes
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    setShowScrollToBottom(!atBottom);
  }, []);

  // Track timeout for message highlight
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Ref to the MessageList for imperative scrolling
  const messageListRef = useRef<MessageListHandle>(null);
  const messageListContainerRef = useRef<HTMLDivElement>(null);

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

  // Scroll to bottom utility - uses the virtuoso ref
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
  }, []);

  const handleSendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (!contact?.userId) return;
      try {
        await sendMessage(
          contact.userId,
          text,
          replyToId,
          forwardFromMessageId
        );
        setReplyingTo(null);
        if (forwardFromMessageId !== undefined) {
          setForwardFromMessageId(undefined);
        }
        // Clear any prefill after a successful send so the input is empty
        setInputPrefill(undefined);
        setForwardPreviewText(null);
        // Scroll to bottom after sending (handled automatically by followOutput)
      } catch (error) {
        toast.error('Failed to send message');
        console.error('Failed to send message:', error);
      }
    },
    [sendMessage, contact?.userId, forwardFromMessageId]
  );

  const handleReplyToMessage = useCallback((message: Message) => {
    setReplyingTo(message);
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

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const handleCancelForward = useCallback(() => {
    setForwardFromMessageId(undefined);
    setForwardPreviewText(null);
  }, []);

  // Handle input focus - scroll to bottom after keyboard appears
  const handleInputFocus = useCallback(() => {
    // Delay to let the keyboard animation start and layout adjust
    setTimeout(() => {
      scrollToBottom();
    }, 150);
    // Second scroll after keyboard is fully open
    setTimeout(() => {
      scrollToBottom();
    }, 350);
  }, [scrollToBottom]);

  const handleScrollToMessage = useCallback(
    (messageId: number) => {
      (async () => {
        // Look up the message to determine which discussion it belongs to
        const target = await gossipSdk.messages.get(messageId);
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

        // Add highlight after a short delay to ensure element is rendered
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
      })();
    },
    [
      contact?.userId,
      navigate,
      messages,
      messageListRef,
      discussion?.lastAnnouncementMessage,
      discussion?.createdAt,
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

      const original = await gossipSdk.messages.get(forwardFromMessageId);
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
  }, [forwardFromMessageId, contact]);

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
      toast.success(`Sent ${TEST_MESSAGE_COUNT} test messages!`);
    } catch (error) {
      toast.error('Failed to send some test messages');
      console.error('Failed to send test messages:', error);
    } finally {
      setIsSendingTestMessages(false);
    }
  }, [contact?.userId, sendMessage, isSendingTestMessages]);

  if (!contact) return null;

  return (
    <div className="h-full app-max-w mx-auto bg-card flex flex-col relative">
      <DiscussionHeader
        contact={contact}
        discussion={discussion}
        onBack={onBack}
      />

      <div
        ref={messageListContainerRef}
        className="flex-1 min-h-0 overflow-hidden"
      >
        <MessageList
          ref={messageListRef}
          messages={messages}
          discussion={discussion}
          isLoading={isLoading || isDiscussionLoading}
          onReplyTo={handleReplyToMessage}
          onForward={handleForwardMessage}
          onScrollToMessage={handleScrollToMessage}
          onAtBottomChange={handleAtBottomChange}
        />
      </div>

      <ScrollToBottomButton
        onClick={scrollToBottom}
        isVisible={showScrollToBottom}
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

      <MessageInput
        onSend={handleSendMessage}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        initialValue={forwardFromMessageId ? undefined : inputPrefill}
        forwardPreview={forwardFromMessageId ? forwardPreviewText : null}
        forwardMode={forwardPreviewMode}
        onCancelForward={handleCancelForward}
        onFocus={handleInputFocus}
      />
    </div>
  );
};

export default Discussion;
