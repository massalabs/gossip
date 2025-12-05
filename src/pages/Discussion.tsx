// TODO: use virtual list to render messages
import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { db, Message } from '../db';
import { useDiscussion } from '../hooks/useDiscussion';
import { useAccountStore } from '../stores/accountStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { useMessageStore } from '../stores/messageStore';
import toast from 'react-hot-toast';
import DiscussionHeader from '../components/discussions/DiscussionHeader';
import MessageList from '../components/discussions/MessageList';
import MessageInput from '../components/discussions/MessageInput';

const Discussion: React.FC = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const contacts = useDiscussionStore(s => s.contacts);

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

  // Use message store instead of hook
  const setCurrentContact = useMessageStore(s => s.setCurrentContact);
  const messages = useMessageStore(s =>
    contact ? s.getMessagesForContact(contact.userId) : []
  );

  const isLoading = useMessageStore(s => s.isLoading);
  const isSending = useMessageStore(s => s.isSending);
  const sendMessage = useMessageStore(s => s.sendMessage);
  const resendMessage = useMessageStore(s => s.resendMessage);
  // Track previous contact userId to prevent unnecessary updates
  const prevContactUserIdRef = useRef<string | null>(null);

  const isMsgFailed = messages.some(m => m.status === 'failed');

  // Reply state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Track timeout for message highlight
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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

  const handleSendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (!contact?.userId) return;
      try {
        await sendMessage(contact.userId, text, replyToId);
        setReplyingTo(null);
      } catch (error) {
        toast.error('Failed to send message');
        console.error('Failed to send message:', error);
      }
    },
    [sendMessage, contact?.userId, setReplyingTo]
  );

  const handleReplyToMessage = useCallback((message: Message) => {
    setReplyingTo(message);
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const handleScrollToMessage = useCallback((messageId: number) => {
    // Use native scrollIntoView to scroll to the message
    const element = document.getElementById(`message-${messageId}`);
    if (element) {
      element.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      // Add visual feedback for the scrolled-to message
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

  // Mobile-first: show only discussion page when selected
  return (
    <div className="h-full app-max-w mx-auto bg-background flex flex-col">
      <DiscussionHeader
        contact={contact}
        discussion={discussion}
        onBack={onBack}
      />

      <MessageList
        messages={messages}
        discussion={discussion}
        isLoading={isLoading || isDiscussionLoading}
        onResend={resendMessage}
        onReplyTo={handleReplyToMessage}
        onScrollToMessage={handleScrollToMessage}
      />

      <MessageInput
        onSend={handleSendMessage}
        disabled={isSending || isMsgFailed}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
      />
    </div>
  );
};

export default Discussion;
