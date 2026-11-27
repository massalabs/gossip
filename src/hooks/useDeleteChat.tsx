import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import ConfirmSheet from '../components/groups/ConfirmSheet';
import LeaveChatSheet from '../components/groups/LeaveChatSheet';
import type { LeaveAction } from '../components/groups/LeaveGroupSheet';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { useAccountStore } from '../stores/accountStore';
import { useGroupMemberName } from './useGroupMemberName';

/**
 * "Leave chat" and "Delete chat", the same from the chat's settings and from
 * the long press on its row (Lucas's screens 09, 12 and 13).
 *
 * Leaving opens one screen with two questions: how to leave, and what to keep
 * on this device (`LeaveChatSheet`). "Delete chat" on a chat the user is still
 * in opens that screen with "Delete it" preselected: the engine deletes only a
 * chat the user is out of, so the user first chooses how to leave. On a chat
 * the user is already out of (kicked, left elsewhere, dissolved), "Delete chat"
 * keeps its simple confirmation.
 *
 * Every way of leaving that deletes is one engine operation, never a leave
 * followed by a delete: a signed leave (or a hand-over and leave) is queued as
 * bytes for every member before the chat closes on this device, and closing
 * keeps those bytes queued (`leave_group`, `close_group`); the SDK starts
 * sending them as soon as the operation ends. Nothing is lost if the network
 * is down: the queued leave waits in the engine's records like any send.
 */
export function useChatExit(onDone?: () => void): {
  leave: (groupId: string) => void;
  remove: (groupId: string) => void;
  sheets: React.ReactNode;
} {
  const { t } = useTranslation('groups');
  const refresh = useGroupStore(s => s.refresh);
  const groups = useGroupStore(s => s.groups);
  const me = useAccountStore(s => s.userProfile?.userId) ?? '';
  const memberName = useGroupMemberName();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<{
    groupId: string;
    deleting: boolean;
  } | null>(null);
  const group = leaving
    ? groups.find(g => g.summary.groupId === leaving.groupId)?.summary
    : undefined;

  const confirmDelete = useCallback(async () => {
    const service = getGroupService();
    const id = confirmId;
    setConfirmId(null);
    if (!service || !id) return;
    try {
      await service.deleteGroup(id);
      refresh();
      toast.success(t('details.deleted'));
      onDone?.();
    } catch {
      toast.error(t('details.failed'));
    }
  }, [confirmId, refresh, t, onDone]);

  const act = useCallback(
    async (groupId: string, action: LeaveAction) => {
      const service = getGroupService();
      if (!service) return;
      try {
        switch (action.type) {
          case 'leave':
            await service.leave(groupId, action.choice);
            break;
          case 'handoverLeave':
            await service.handOver(groupId, action.newOwner, { leave: true });
            break;
          case 'dissolve':
            await service.dissolve(groupId, action.deleteMessages);
            break;
          default:
            return;
        }
      } catch {
        toast.error(t('details.failed'));
        return;
      }
      refresh();
      toast.success(t('details.saved'));
      // A chat dissolved and kept stays here, read only.
      if (!(action.type === 'dissolve' && !action.deleteMessages)) onDone?.();
    },
    [refresh, t, onDone]
  );

  const remove = useCallback(
    (groupId: string) => {
      const status = groups.find(g => g.summary.groupId === groupId)?.summary
        .status;
      if (status === 'member') setLeaving({ groupId, deleting: true });
      else setConfirmId(groupId);
    },
    [groups]
  );

  const sheets = (
    <>
      <ConfirmSheet
        isOpen={confirmId !== null}
        title={t('details.delete_title')}
        body={t('details.delete_body')}
        confirmLabel={t('common:delete')}
        onConfirm={() => void confirmDelete()}
        onClose={() => setConfirmId(null)}
      />
      <LeaveChatSheet
        isOpen={leaving !== null && group !== undefined}
        isOwner={group?.owner === me}
        otherMembers={group?.members.filter(m => m !== me) ?? []}
        memberName={memberName}
        deleting={leaving?.deleting ?? false}
        onAction={action => {
          if (leaving) void act(leaving.groupId, action);
        }}
        onClose={() => setLeaving(null)}
      />
    </>
  );
  return {
    leave: (groupId: string) => setLeaving({ groupId, deleting: false }),
    remove,
    sheets,
  };
}

/** Whether "Leave chat" applies: the user is still a member. */
export function canLeaveChat(status: string): boolean {
  return status === 'member';
}

/**
 * Whether "Delete chat" is offered: on a chat the user is still in (through
 * the leave screen) or already out of. Not while waiting to be kicked: the
 * user already chose how to leave, and the messages are already deleted.
 */
export function canDeleteChat(status: string): boolean {
  return status !== 'waiting';
}
