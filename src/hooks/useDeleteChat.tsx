import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import ConfirmSheet from '../components/groups/ConfirmSheet';
import { getGroupService, useGroupStore } from '../stores/groupStore';

/**
 * "Delete chat", with its confirmation (Lucas's screen 13), the same from
 * the chat's settings and from the long press on its row. Only a chat the
 * user is no longer a member of can be deleted from this device: the engine
 * deletes a kicked, left or dissolved chat only.
 */
export function useDeleteChat(onDeleted?: () => void): {
  ask: (groupId: string) => void;
  sheet: React.ReactNode;
} {
  const { t } = useTranslation('groups');
  const refresh = useGroupStore(s => s.refresh);
  const [groupId, setGroupId] = useState<string | null>(null);

  const confirm = useCallback(async () => {
    const service = getGroupService();
    const id = groupId;
    setGroupId(null);
    if (!service || !id) return;
    try {
      await service.deleteGroup(id);
      refresh();
      toast.success(t('details.deleted'));
      onDeleted?.();
    } catch {
      toast.error(t('details.failed'));
    }
  }, [groupId, refresh, t, onDeleted]);

  const sheet = (
    <ConfirmSheet
      isOpen={groupId !== null}
      title={t('details.delete_title')}
      body={t('details.delete_body')}
      confirmLabel={t('common:delete')}
      onConfirm={() => void confirm()}
      onClose={() => setGroupId(null)}
    />
  );
  return { ask: setGroupId, sheet };
}

/** Whether the engine lets this chat be deleted from this device. */
export function canDeleteChat(status: string): boolean {
  return status !== 'member' && status !== 'waiting';
}
