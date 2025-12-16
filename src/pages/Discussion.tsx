// TODO: use virtual list to render messages
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
import VirtualizedMessageList from '../components/discussions/VirtualizedMessageList';
import MessageInput from '../components/discussions/MessageInput';
import ScrollableContent from '../components/ui/ScrollableContent';

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

  // Clear pendingSharedContent whenever it is used (either as prefilledMessage or fallback)
  // This prevents it from persisting and appearing unexpectedly in future discussions
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

  // Use message store instead of hook
  const setCurrentContact = useMessageStore(s => s.setCurrentContact);
  const messages = useMessageStore(s =>
    contact ? s.getMessagesForContact(contact.userId) : []
  );

  const isLoading = useMessageStore(s => s.isLoading);
  const isSending = useMessageStore(s => s.isSending);
  const sendMessage = useMessageStore(s => s.sendMessage);

  // Track previous contact userId to prevent unnecessary updates
  const prevContactUserIdRef = useRef<string | null>(null);

  // Reply state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

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

  if (!contact) return null;

  // Mobile-first: show only discussion page when selected
  return (
    <div className="h-full app-max-w mx-auto bg-card flex flex-col">
      <DiscussionHeader
        contact={contact}
        discussion={discussion}
        onBack={onBack}
      />

      <ScrollableContent
        className="flex-1 overflow-y-auto"
        id="messagesContainer"
      >
        {contact && (
          <VirtualizedMessageList
            contactUserId={contact.userId}
            messages={messages}
            discussion={discussion}
            isLoading={isLoading || isDiscussionLoading}
            onReplyTo={handleReplyToMessage}
          />
        )}
      </ScrollableContent>

      <MessageInput
        onSend={handleSendMessage}
        disabled={isSending}
        replyingTo={replyingTo}
        onCancelReply={handleCancelReply}
        initialValue={finalPrefilledMessage || undefined}
      />
    </div>
  );
};

export default Discussion;
