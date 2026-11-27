import React, { useCallback, useState } from 'react';
import { Archive, Trash2 } from 'react-feather';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import type { GroupInvitation, LeaveChoice } from '@massalabs/gossip-sdk';
import { useMinuteTick } from '../../hooks/useMinuteTick';
import { formatRelativeTime } from '../../utils/timeUtils';
import { groupDisplayName, safeName } from '../../utils/groupName';
import { useGroupMemberName } from '../../hooks/useGroupMemberName';
import { useAccountStore } from '../../stores/accountStore';
import {
  getGroupService,
  useGroupStore,
  type GroupListEntry,
} from '../../stores/groupStore';
import { ROUTES } from '../../constants/routes';
import { getSdk } from '../../stores/sdkStore';
import { useDiscussionStore } from '../../stores/discussionStore';
import GroupInvitationCard from './GroupInvitationCard';
import ContinuationPrompt from './ContinuationPrompt';
import SafeName from './SafeName';
import GroupAvatar from './GroupAvatar';
import ContextMenu from '../ui/ContextMenu';
import { useLongPress } from '../../hooks/useLongPress';
import { canDeleteChat, useDeleteChat } from '../../hooks/useDeleteChat';

interface GroupListSectionProps {
  /** Only groups whose name matches (the list's search). */
  searchQuery?: string;
  /** Only unread groups (the list's "unread" filter). */
  unreadOnly?: boolean;
  /**
   * The archived chats (the "Archived chats" page) instead of the others.
   * Invitations are shown with the others only.
   */
  archived?: boolean;
}

const GroupRow: React.FC<{
  entry: GroupListEntry;
  name: string;
  /** The last message's author, shown before it as "Author: text". */
  author: string | null;
  preview: string;
  me?: string;
  memberName: (userId: string) => string;
  /** Another person's new chat that continues this one (§5.12). */
  continuation?: GroupInvitation;
  onOpen: () => void;
  /** "Archive chat" or "Unarchive", a mark on this device only. */
  onToggleArchived: () => void;
  /** "Delete chat", with its confirmation, when the engine allows it. */
  onDelete?: () => void;
}> = ({
  entry,
  name,
  author,
  preview,
  me,
  memberName,
  continuation,
  onOpen,
  onToggleArchived,
  onDelete,
}) => {
  const { t } = useTranslation('groups');
  const readOnly = entry.summary.status !== 'member';
  // The long press offers what Lucas's design lists for a chat: archiving
  // (a mark on this device only) and "Delete chat" where the engine allows it.
  const [menuOpen, setMenuOpen] = useState(false);
  const longPress = useLongPress({
    onLongPress: () => setMenuOpen(true),
  });
  return (
    <div
      className="w-full text-left bg-card rounded-2xl shadow-sm dark:shadow-none dark:border dark:border-border/60 mb-2 hover:bg-muted/60 hover:shadow-md dark:hover:border-border active:scale-[0.99] transition-all cursor-pointer p-4"
      role="button"
      tabIndex={0}
      onClick={() => {
        if (longPress.longPressTriggered.current) return;
        onOpen();
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') onOpen();
      }}
      onTouchStart={longPress.onTouchStart}
      onTouchMove={longPress.onTouchMove}
      onTouchEnd={longPress.onTouchEnd}
      onContextMenu={longPress.onContextMenu}
      data-testid="group-row"
    >
      <div className="flex items-center space-x-3">
        <GroupAvatar
          members={entry.summary.members}
          me={me}
          memberName={memberName}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium text-foreground truncate min-w-0">
              <SafeName name={name} />
            </h3>
            <div className="flex items-center gap-1.5 shrink-0">
              {readOnly && (
                <span className="inline-flex items-center px-2 rounded-full text-[10px] font-medium bg-badge text-badge-foreground border border-badge-border">
                  {t('list.read_only')}
                </span>
              )}
              {entry.lastMessage && (
                <p className="text-xs text-muted-foreground">
                  {formatRelativeTime(new Date(entry.lastMessage.at))}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between mt-1">
            <p
              className="text-sm text-muted-foreground truncate"
              data-testid="group-preview"
            >
              {author !== null && (
                <span className="font-medium text-foreground">
                  <bdi dir="auto">{author}</bdi>:{' '}
                </span>
              )}
              {preview}
            </p>
            {entry.unread && (
              <span
                className="inline-block w-2.5 h-2.5 rounded-full bg-accent-soft-foreground animate-badge-pop shrink-0"
                aria-label="unread"
                data-testid="group-unread"
              />
            )}
          </div>
          {continuation && (
            <ContinuationPrompt invitation={continuation} compact />
          )}
        </div>
      </div>
      <div onClick={e => e.stopPropagation()}>
        <ContextMenu
          items={[
            {
              label: entry.archived
                ? t('details.unarchive')
                : t('details.archive'),
              icon: <Archive className="w-4 h-4" />,
              onClick: onToggleArchived,
            },
            ...(onDelete
              ? [
                  {
                    label: t('details.delete_locally'),
                    icon: <Trash2 className="w-4 h-4" />,
                    onClick: onDelete,
                    danger: true,
                  },
                ]
              : []),
          ]}
          isOpen={menuOpen}
          onClose={() => setMenuOpen(false)}
        />
      </div>
    </div>
  );
};

/**
 * Groups and group invitations in the conversation list, above the one-to-one
 * discussions, in the style of `DiscussionListItem`.
 */
const GroupListSection: React.FC<GroupListSectionProps> = ({
  searchQuery = '',
  unreadOnly = false,
  archived = false,
}) => {
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  useMinuteTick();
  const available = useGroupStore(s => s.available);
  const groups = useGroupStore(s => s.groups);
  // A migration is shown on its archive's row and inside it, and an
  // invitation to continue a chat on that chat's row and inside it (§5.12).
  const allInvitations = useGroupStore(s => s.invitations);
  const invitations = archived
    ? []
    : allInvitations.filter(i => !i.migrationOf && !i.continues);
  const refresh = useGroupStore(s => s.refresh);
  const setArchived = useGroupStore(s => s.setArchived);
  const deleteChat = useDeleteChat();
  const me = useAccountStore(s => s.userProfile?.userId);
  const memberName = useGroupMemberName();
  const discussions = useDiscussionStore(s => s.discussions);
  const linkedPeer = new Map(
    discussions.flatMap(d =>
      d.linkedGroupId ? [[d.linkedGroupId, d.contactUserId] as const] : []
    )
  );

  const accept = useCallback(
    async (epochId: string) => {
      const service = getGroupService();
      if (!service) return;
      const groupId = await getSdk().conversations.acceptInvitation(epochId);
      refresh();
      navigate(ROUTES.group({ groupId }));
    },
    [navigate, refresh]
  );

  const decline = useCallback(
    async (epochId: string, choice: LeaveChoice) => {
      await getSdk().conversations.declineInvitation(epochId, choice);
      refresh();
    },
    [refresh]
  );

  if (!available) return null;

  const query = safeName(searchQuery).toLowerCase();
  const shown = groups
    // A group dissolved with "Delete" is only kept to relay the dissolve
    // (§5.8); its messages are gone and it is no longer a conversation.
    .filter(entry => entry.summary.status !== 'dissolved-deleted')
    // An archived chat stays in the archived list, new messages included
    // (product owner, closer to Telegram): the "Archived chats" row shows a
    // dot instead.
    .filter(entry => !!entry.archived === archived)
    .map(entry => ({
      entry,
      name: groupDisplayName(
        entry.summary,
        memberName,
        me,
        // A chat of two the other person left still names that person.
        linkedPeer.has(entry.summary.groupId)
          ? memberName(linkedPeer.get(entry.summary.groupId)!)
          : t('invitation.unnamed')
      ),
    }))
    .filter(g => !query || g.name.toLowerCase().includes(query))
    .filter(g => !unreadOnly || g.entry.unread);

  if (shown.length === 0 && (invitations.length === 0 || query)) return null;

  return (
    <section aria-label={t('list.section_title')}>
      {!query && invitations.length > 0 && (
        <>
          <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('list.invitations_title')}
          </p>
          {invitations.map(inv => (
            <GroupInvitationCard
              key={inv.epochId}
              invitation={inv}
              memberName={memberName}
              me={me}
              onAccept={accept}
              onDecline={decline}
              onOpen={() =>
                navigate(ROUTES.invitation({ kind: 'group', id: inv.epochId }))
              }
            />
          ))}
        </>
      )}
      {shown.length > 0 && (
        <>
          {!archived && (
            <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('list.section_title')}
            </p>
          )}
          {shown.map(({ entry, name }) => {
            const last = entry.lastMessage;
            const preview = last
              ? last.media
                ? t('timeline.media')
                : safeName(last.text, 80)
              : t('list.no_messages');
            return (
              <GroupRow
                key={entry.summary.groupId}
                entry={entry}
                name={name}
                author={last ? memberName(last.author) : null}
                preview={preview}
                me={me}
                memberName={memberName}
                continuation={allInvitations.find(
                  i => i.continues === entry.summary.groupId
                )}
                onOpen={() =>
                  navigate(ROUTES.group({ groupId: entry.summary.groupId }))
                }
                onToggleArchived={() => {
                  const to = !entry.archived;
                  setArchived(entry.summary.groupId, to).then(
                    () =>
                      toast.success(
                        to ? t('archive.archived') : t('archive.unarchived')
                      ),
                    () => toast.error(t('details.failed'))
                  );
                }}
                onDelete={
                  canDeleteChat(entry.summary.status)
                    ? () => deleteChat.ask(entry.summary.groupId)
                    : undefined
                }
              />
            );
          })}
        </>
      )}
      {deleteChat.sheet}
    </section>
  );
};

export default GroupListSection;
