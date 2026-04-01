import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Message } from '@massalabs/gossip-sdk';
import type { GossipSdk } from '@massalabs/gossip-sdk';
import { ROUTES } from '../constants/routes';
import { useAppStore } from '../stores/appStore';
import { useMessageStore } from '../stores/messageStore';
import type { TFunction } from 'i18next';

interface UseDiscussionActionsParams {
  contact: { userId: string } | undefined;
  isSelecting: boolean;
  gossip: GossipSdk;
  t: TFunction;
  forwardFromMessageId: number | undefined;
  setReplyingTo: (msg: Message | null) => void;
  setEditingMessage: (msg: Message | null) => void;
  setInputPrefill: (text: string | undefined) => void;
  clearForward: () => void;
}

export function useDiscussionActions({
  contact,
  isSelecting,
  t,
  forwardFromMessageId,
  setReplyingTo,
  setEditingMessage,
  setInputPrefill,
  clearForward,
}: UseDiscussionActionsParams) {
  const navigate = useNavigate();
  const sendMessage = useMessageStore(s => s.sendMessage);
  const deleteMessage = useMessageStore(s => s.deleteMessage);
  const editMessage = useMessageStore(s => s.editMessage);
  const setPendingSharedContent = useAppStore(s => s.setPendingSharedContent);
  const setPendingForwardMessageId = useAppStore(
    s => s.setPendingForwardMessageId
  );

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
        clearForward();
        setInputPrefill(undefined);
      } catch (error) {
        toast.error(t('failed_to_send'));
        console.error('Failed to send message:', error);
      }
    },
    [
      isSelecting,
      sendMessage,
      contact?.userId,
      forwardFromMessageId,
      t,
      clearForward,
      setReplyingTo,
      setEditingMessage,
      setInputPrefill,
    ]
  );

  const handleReplyToMessage = useCallback(
    (message: Message) => {
      setReplyingTo(message);
      setEditingMessage(null);
      // Reply and forward are mutually exclusive
      clearForward();
    },
    [setReplyingTo, setEditingMessage, clearForward]
  );

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

  const handleEditMessage = useCallback(
    (message: Message) => {
      setEditingMessage(message);
      setReplyingTo(null);
      setInputPrefill(message.content);
    },
    [setEditingMessage, setReplyingTo, setInputPrefill]
  );

  // Optimistic delete via store
  const handleDeleteMessage = useCallback(
    async (message: Message) => {
      if (!message.id || !contact?.userId) return;
      try {
        await deleteMessage(contact.userId, message.id);
      } catch (error) {
        toast.error(t('failed_to_delete'));
        console.error('Failed to delete message:', error);
      }
    },
    [contact?.userId, deleteMessage, t]
  );

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
  }, [setReplyingTo]);

  const handleCancelEdit = useCallback(() => {
    setEditingMessage(null);
    setInputPrefill(undefined);
  }, [setEditingMessage, setInputPrefill]);

  // Optimistic edit via store
  const handleConfirmEdit = useCallback(
    async (newContent: string, message: Message) => {
      if (!message.id || !contact?.userId) return;
      try {
        await editMessage(contact.userId, message.id, newContent);
      } catch (error) {
        toast.error(t('failed_to_edit'));
        console.error('Failed to edit message:', error);
      } finally {
        setEditingMessage(null);
        setInputPrefill(undefined);
      }
    },
    [contact?.userId, editMessage, t, setEditingMessage, setInputPrefill]
  );

  const handleInputFocus = useCallback(() => {
    // No forced scroll — let the container resize naturally.
  }, []);

  return {
    handleSendMessage,
    handleReplyToMessage,
    handleForwardMessage,
    handleEditMessage,
    handleDeleteMessage,
    handleCancelReply,
    handleCancelEdit,
    handleConfirmEdit,
    handleInputFocus,
  };
}
