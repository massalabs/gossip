import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { db, Message } from '../db';
import { useDiscussion } from '../hooks/useDiscussion';
import { useAccountStore } from '../stores/accountStore';
import { useAppStore } from '../stores/appStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import toast from 'react-hot-toast';
import DiscussionHeader from '../components/discussions/DiscussionHeader';
import MessageList, {
  MessageListHandle,
} from '../components/discussions/MessageList';
import MessageInput from '../components/discussions/MessageInput';

const Discussion: React.FC = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const contacts = useDiscussionStore(s => s.contacts);

  // Get prefilled message from location state (for shared content)
  const locationState = location.state as { prefilledMessage?: string } | null;
  const prefilledMessage = locationState?.prefilledMessage;

  // Also check app store as fallback (in case location state is lost)
  const pendingSharedContent = useAppStore(s => s.pendingSharedContent);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);

  // Use prefilledMessage from location state, or fallback to app store
  const finalPrefilledMessage = prefilledMessage || pendingSharedContent;

  // Clear pendingSharedContent whenever it is used
  useEffect(() => {
    if (pendingSharedContent) {
      setPendingSharedContent(null);
    }
  }, [pendingSharedContent, setPendingSharedContent]);

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

  const { userProfile } = useAccountStore();

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

  // Track timeout for message highlight
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Ref to the MessageList for imperative scrolling
  const messageListRef = useRef<MessageListHandle>(null);

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

  // Mark messages as read when viewing the discussion
  useEffect(() => {
    if (
      messages.length > 0 &&
      !isLoading &&
      userProfile?.userId &&
      contact?.userId
    ) {
      db.markMessagesAsRead(userProfile.userId, contact.userId).catch(error =>
        console.error('Failed to mark messages as read:', error)
      );
    }
  }, [messages.length, isLoading, userProfile?.userId, contact?.userId]);

  // Scroll to bottom utility - uses the virtuoso ref
  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom();
  }, []);

  const handleSendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (!contact?.userId) return;
      try {
        await sendMessage(contact.userId, text, replyToId);
        setReplyingTo(null);
        // Scroll to bottom after sending (handled automatically by followOutput)
      } catch (error) {
        toast.error('Failed to send message');
        console.error('Failed to send message:', error);
      }
    },
    [sendMessage, contact?.userId]
  );

  const handleReplyToMessage = useCallback((message: Message) => {
    setReplyingTo(message);
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
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

  const handleScrollToMessage = useCallback((messageId: number) => {
    const element = document.getElementById(`message-${messageId}`);
    if (element) {
      element.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      // Add visual feedback
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
    } else {
      console.warn(`Message element with id message-${messageId} not found`);
    }
  }, []);

  if (!contact) return null;

  return (
    <div className="h-full app-max-w mx-auto bg-card flex flex-col">
      <DiscussionHeader
        contact={contact}
        discussion={discussion}
        onBack={onBack}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <MessageList
          ref={messageListRef}
          messages={messages}
          discussion={discussion}
          isLoading={isLoading || isDiscussionLoading}
          onReplyTo={handleReplyToMessage}
          onScrollToMessage={handleScrollToMessage}
        />
      </div>

      <MessageInput
        onSend={handleSendMessage}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        initialValue={finalPrefilledMessage || undefined}
        onFocus={handleInputFocus}
      />
    </div>
  );
};

export default Discussion;
