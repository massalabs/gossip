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
  discussionCustomName?: string;
  contactName?: string;
  gossip: GossipSdk;
  t: TFunction;
  /** Override the default delete function (e.g. for self messages) */
  onDeleteMessage?: (id: number) => Promise<boolean>;
}

interface UseDiscussionMessageSelectionResult {
  selectedMessageIds: Set<number>;
  isSelecting: boolean;
  selectedMessages: Message[];
  canDeleteSelected: boolean;
  outgoingSentCount: number;
  handleToggleSelect: (id: number) => void;
  handleClearSelection: () => void;
  handleCopySelected: () => Promise<void>;
  handleDeleteSelected: () => Promise<void>;
}

export const useDiscussionMessageSelection = ({
  messages,
  discussionCustomName,
  contactName,
  gossip,
  t,
  onDeleteMessage,
}: UseDiscussionMessageSelectionParams): UseDiscussionMessageSelectionResult => {
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(
    new Set()
  );

  const isSelecting = selectedMessageIds.size > 0;

  const selectedMessages = useMemo(
    () => messages.filter(m => m.id != null && selectedMessageIds.has(m.id)),
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

  const handleToggleSelect = useCallback((id: number) => {
    setSelectedMessageIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedMessageIds(new Set());
  }, []);

  const handleCopySelected = useCallback(async () => {
    const selected = messages
      .filter(m => m.id != null && selectedMessageIds.has(m.id))
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const resolvedContactName =
      discussionCustomName || contactName || 'Unknown';
    const text = selected
      .map(m => {
        const sender =
          m.direction === MessageDirection.OUTGOING
            ? t('copy_you')
            : resolvedContactName;
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
    discussionCustomName,
    contactName,
    t,
    handleClearSelection,
  ]);

  const handleDeleteSelected = useCallback(async () => {
    if (!canDeleteSelected || selectedMessages.length === 0) return;

    const failedIds: number[] = [];
    const deletedIds: number[] = [];
    for (const message of selectedMessages) {
      if (message.id == null) continue;
      try {
        const deleted = onDeleteMessage
          ? await onDeleteMessage(message.id)
          : await gossip.messages.deleteMessage(message.id);
        if (!deleted) {
          failedIds.push(message.id);
          console.error('[multi-delete] deleteMessage returned false', {
            id: message.id,
          });
        } else {
          deletedIds.push(message.id);
        }
      } catch (error) {
        failedIds.push(message.id);
        console.error('[multi-delete] deleteMessage threw', {
          id: message.id,
          error,
        });
      }
    }

    if (failedIds.length > 0) {
      console.error('[multi-delete] partial failure summary', {
        selectedCount: selectedMessages.length,
        deletedCount: deletedIds.length,
        failedCount: failedIds.length,
        failedIds,
      });
    }

    handleClearSelection();
    if (failedIds.length > 0) {
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
