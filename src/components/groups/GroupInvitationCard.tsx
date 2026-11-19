import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Shield } from 'react-feather';
import type { GroupInvitation } from '@massalabs/gossip-sdk';
import Button from '../ui/Button';
import SafeName from './SafeName';
import LeaveGroupSheet, { type LeaveAction } from './LeaveGroupSheet';

interface GroupInvitationCardProps {
  invitation: GroupInvitation;
  memberName: (userId: string) => string;
  onAccept: (epochId: string) => Promise<void>;
  onDecline: (
    epochId: string,
    choice: Extract<LeaveAction, { type: 'decline' }>['choice']
  ) => Promise<void>;
}

/**
 * The invitation prompt of §4.8: the verified owner, the group name, the
 * member list and who delivered it, with Accept and Decline (§5.2). The name
 * is untrusted and shown beside the owner and the members (§5.11 rule 8).
 */
const GroupInvitationCard: React.FC<GroupInvitationCardProps> = ({
  invitation,
  memberName,
  onAccept,
  onDecline,
}) => {
  const { t } = useTranslation('groups');
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
    } catch {
      toast.error(t('invitation.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="w-full bg-card rounded-2xl shadow-sm dark:shadow-none dark:border dark:border-border/60 mb-2 p-4"
      data-testid="group-invitation"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('invitation.title')}
      </p>
      <h3 className="mt-1 text-sm font-medium text-foreground">
        <SafeName name={invitation.name} fallback={t('invitation.unnamed')} />
      </h3>
      <p className="mt-2 flex items-center gap-1 text-xs text-foreground">
        <Shield className="w-3.5 h-3.5 text-success shrink-0" />
        <span className="min-w-0 truncate">
          {t('invitation.owner_verified')}{' '}
          <SafeName name={memberName(invitation.owner)} />
        </span>
      </p>
      {invitation.receivedFrom && (
        <p className="mt-1 text-xs text-muted-foreground truncate">
          {t('invitation.received_from')}{' '}
          <SafeName name={memberName(invitation.receivedFrom)} />
        </p>
      )}
      <p className="mt-2 text-xs font-medium text-muted-foreground">
        {t('invitation.members')}
      </p>
      <ul className="mt-1 flex flex-wrap gap-1">
        {invitation.members.map(m => (
          <li
            key={m}
            className="max-w-full px-2 py-0.5 rounded-full bg-muted text-xs text-foreground"
          >
            <SafeName name={memberName(m)} maxGraphemes={24} />
          </li>
        ))}
      </ul>
      {invitation.closedBefore && (
        <p className="mt-3 flex gap-2 text-xs text-destructive">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t('invitation.closed_before')}
        </p>
      )}
      {invitation.rejoins && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('invitation.rejoins')}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button
          onClick={() =>
            act(() => onAccept(invitation.epochId), t('invitation.accepted'))
          }
          disabled={busy}
          variant="primary"
          size="custom"
          className="px-2.5 py-1 text-xs font-medium rounded border border-accent-soft-foreground/40 text-accent-soft-foreground hover:bg-accent-soft"
        >
          {t('invitation.accept')}
        </Button>
        <Button
          onClick={() => setDeclining(true)}
          disabled={busy}
          variant="outline"
          size="custom"
          className="px-2.5 py-1 text-xs font-medium rounded border border-border text-foreground hover:bg-accent"
        >
          {t('invitation.decline')}
        </Button>
      </div>
      <LeaveGroupSheet
        isOpen={declining}
        mode="decline"
        onClose={() => setDeclining(false)}
        onAction={action => {
          setDeclining(false);
          if (action.type === 'decline') {
            void act(
              () => onDecline(invitation.epochId, action.choice),
              t('invitation.declined')
            );
          }
        }}
      />
    </div>
  );
};

export default GroupInvitationCard;
