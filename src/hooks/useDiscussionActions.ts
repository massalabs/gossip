import { logger } from '../utils/logger.ts';
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Message, MessageType } from '@massalabs/gossip-sdk';
import { ROUTES } from '../constants/routes';
import { useAppStore } from '../stores/appStore';
import { useMessageStore } from '../stores/messageStore';
import type { TFunction } from 'i18next';

interface UseDiscussionActionsParams {
  contact: { userId: string } | undefined;
  isSelecting: boolean;
  t: TFunction;
  forwardFromMessageIds: number[];
  setReplyingTo: (msg: Message | null) => void;
  setEditingMessage: (msg: Message | null) => void;
  setInputPrefill: (text: string | undefined) => void;
  clearForward: () => void;
}

function getForwardableMessages(messages: Message[]): Message[] {
  return messages
    .filter(m => m.id != null && m.id !== 0 && m.type !== MessageType.DELETED)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export function useDiscussionActions({
  contact,
  isSelecting,
  t,
  forwardFromMessageIds,
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
  const setPendingForwardMessageIds = useAppStore(
    s => s.setPendingForwardMessageIds
  );

  const handleSendMessage = useCallback(
    async (text: string, replyToId?: number) => {
      if (isSelecting) return;
      if (!contact?.userId) return;
      const idsToForward = [...forwardFromMessageIds];
      setReplyingTo(null);
      setEditingMessage(null);
      clearForward();
      setInputPrefill(undefined);
      try {
        if (idsToForward.length === 0) {
          await sendMessage(contact.userId, text, replyToId);
          return;
        }
        // Send each selected message as its own forward (timestamp order).
        // Optional composer text attaches to the first forward only.
        for (let i = 0; i < idsToForward.length; i++) {
          await sendMessage(
            contact.userId,
            i === 0 ? text : '',
            i === 0 ? replyToId : undefined,
            idsToForward[i]
          );
        }
      } catch (error) {
        toast.error(t('failed_to_send'));
        logger.error('Failed to send message:', error);
      }
    },
    [
      isSelecting,
      sendMessage,
      contact?.userId,
      forwardFromMessageIds,
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

  const handleForwardMessages = useCallback(
    (messages: Message[]) => {
      const eligible = getForwardableMessages(messages);
      if (eligible.length === 0) return;
      // Set pending forward state, then go to discussions list for recipient selection.
      // replace: true avoids pushing a duplicate /discussions entry so back navigation
      // after forwarding returns cleanly to the discussions list.
      setPendingSharedContent(eligible[0].content);
      setPendingForwardMessageIds(eligible.map(m => m.id!));
      navigate(ROUTES.discussions(), { replace: true });
    },
    [navigate, setPendingForwardMessageIds, setPendingSharedContent]
  );

  const handleForwardMessage = useCallback(
    (message: Message) => {
      handleForwardMessages([message]);
    },
    [handleForwardMessages]
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
        logger.error('Failed to delete message:', error);
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
      setEditingMessage(null);
      setInputPrefill(undefined);
      try {
        await editMessage(contact.userId, message.id, newContent);
      } catch (error) {
        toast.error(t('failed_to_edit'));
        logger.error('Failed to edit message:', error);
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
    handleForwardMessages,
    handleEditMessage,
    handleDeleteMessage,
    handleCancelReply,
    handleCancelEdit,
    handleConfirmEdit,
    handleInputFocus,
  };
}
