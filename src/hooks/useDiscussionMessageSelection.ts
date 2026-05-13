import { logger } from '../utils/logger.ts';
import { useCallback, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Message,
  MessageDirection,
  MessageStatus,
  GossipSdk,
} from '@massalabs/gossip-sdk';
import { TFunction } from 'i18next';

interface UseDiscussionMessageSelectionParams {
  messages: Message[];
  gossip: GossipSdk;
  t: TFunction;
  /** Override the default delete function (e.g. for self messages) */
  onDeleteMessage?: (messageId: number) => Promise<boolean>;
}

interface UseDiscussionMessageSelectionResult {
  selectedMessageIds: Set<number>;
  isSelecting: boolean;
  selectedMessages: Message[];
  canDeleteSelected: boolean;
  outgoingSentCount: number;
  handleToggleSelect: (messageId: number) => void;
  handleClearSelection: () => void;
  handleCopySelected: () => Promise<void>;
  handleDeleteSelected: () => Promise<void>;
}

export const useDiscussionMessageSelection = ({
  messages,
  gossip,
  t,
  onDeleteMessage,
}: UseDiscussionMessageSelectionParams): UseDiscussionMessageSelectionResult => {
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(
    new Set()
  );

  const isSelecting = selectedMessageIds.size > 0;

  const selectedMessages = useMemo(
    () =>
      messages.filter(
        // Keep this as != null (not truthy) so message id 0 remains valid.
        m => m.id != null && selectedMessageIds.has(m.id)
      ),
    [messages, selectedMessageIds]
  );

  const canDeleteSelected = useMemo(
    () => selectedMessages.length > 0,
    [selectedMessages]
  );

  const outgoingSentCount = useMemo(
    () =>
      messages.filter(
        message =>
          message.direction === MessageDirection.OUTGOING &&
          message.status === MessageStatus.SENT
      ).length,
    [messages]
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

    const text = selected.map(m => m.content).join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      handleClearSelection();
    } catch {
      toast.error(t('failed_to_copy_selected'));
    }
  }, [messages, selectedMessageIds, t, handleClearSelection]);

  const handleDeleteSelected = useCallback(async () => {
    if (!canDeleteSelected || selectedMessages.length === 0) return;

    const failedMessageIds: number[] = [];
    const deletedMessageIds: number[] = [];
    for (const message of selectedMessages) {
      if (message.id == null) continue;
      try {
        const deleted = onDeleteMessage
          ? await onDeleteMessage(message.id)
          : await gossip.messages.deleteMessage(message.id);
        if (!deleted) {
          failedMessageIds.push(message.id);
          logger.error('[multi-delete] deleteMessage returned false', {
            messageId: message.id,
          });
        } else {
          deletedMessageIds.push(message.id);
        }
      } catch (error) {
        failedMessageIds.push(message.id);
        logger.error('[multi-delete] deleteMessage threw', {
          messageId: message.id,
          error,
        });
      }
    }

    if (failedMessageIds.length > 0) {
      logger.error('[multi-delete] partial failure summary', {
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
  }, [
    canDeleteSelected,
    selectedMessages,
    gossip,
    onDeleteMessage,
    handleClearSelection,
    t,
  ]);

  return {
    selectedMessageIds,
    isSelecting,
    selectedMessages,
    canDeleteSelected,
    outgoingSentCount,
    handleToggleSelect,
    handleClearSelection,
    handleCopySelected,
    handleDeleteSelected,
  };
};
