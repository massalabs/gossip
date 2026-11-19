import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Users } from 'react-feather';
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

interface GroupListSectionProps {
  /** Only groups whose name matches (the list's search). */
  searchQuery?: string;
  /** Only unread groups (the list's "unread" filter). */
  unreadOnly?: boolean;
}

const GroupRow: React.FC<{
  entry: GroupListEntry;
  name: string;
  preview: string;
  /** Another person's new chat that continues this one (§5.12). */
  continuation?: GroupInvitation;
  onOpen: () => void;
}> = ({ entry, name, preview, continuation, onOpen }) => {
  const { t } = useTranslation('groups');
  const readOnly = entry.summary.status !== 'member';
  return (
    <div
      className="w-full text-left bg-card rounded-2xl shadow-sm dark:shadow-none dark:border dark:border-border/60 mb-2 hover:bg-muted/60 hover:shadow-md dark:hover:border-border active:scale-[0.99] transition-all cursor-pointer p-4"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        if (e.key === 'Enter') onOpen();
      }}
      data-testid="group-row"
    >
      <div className="flex items-center space-x-3">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Users className="w-6 h-6 text-foreground" />
        </div>
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
            <p className="text-sm text-muted-foreground truncate">{preview}</p>
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
}) => {
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  useMinuteTick();
  const available = useGroupStore(s => s.available);
  const groups = useGroupStore(s => s.groups);
  // A migration is shown on its archive's row and inside it, and an
  // invitation to continue a chat on that chat's row and inside it (§5.12).
  const allInvitations = useGroupStore(s => s.invitations);
  const invitations = allInvitations.filter(
    i => !i.migrationOf && !i.continues
  );
  const refresh = useGroupStore(s => s.refresh);
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
          <p className="px-2 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t('list.section_title')}
          </p>
          {shown.map(({ entry, name }) => {
            const last = entry.lastMessage;
            const preview = last
              ? `${memberName(last.author)}: ${safeName(last.text, 80)}`
              : t('list.no_messages');
            return (
              <GroupRow
                key={entry.summary.groupId}
                entry={entry}
                name={name}
                preview={preview}
                continuation={allInvitations.find(
                  i => i.continues === entry.summary.groupId
                )}
                onOpen={() =>
                  navigate(ROUTES.group({ groupId: entry.summary.groupId }))
                }
              />
            );
          })}
        </>
      )}
    </section>
  );
};

export default GroupListSection;
