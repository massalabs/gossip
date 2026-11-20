import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import type { GroupInvitation } from '@massalabs/gossip-sdk';
import Button from '../ui/Button';
import LeaveGroupSheet from './LeaveGroupSheet';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { useGroupStore } from '../../stores/groupStore';
import { useGroupMemberName } from '../../hooks/useGroupMemberName';
import { isolate } from '../../utils/groupName';
import { ROUTES } from '../../constants/routes';
import { messageTimerSentence } from '../../constants/messageTimer';
import { logger } from '../../utils/logger.ts';

interface ContinuationPromptProps {
  /** An invitation whose `continues` names the chat it is shown in. */
  invitation: GroupInvitation;
  /** Smaller, for a row of the conversation list. */
  compact?: boolean;
}

/**
 * "<name> wants to continue this conversation in a new group" (§5.12), with
 * Accept and Decline, inside the chat it continues and on that chat's row.
 * Accepting makes the new chat the conversation and keeps the current one
 * above it as read-only history; declining changes nothing.
 */
const ContinuationPrompt: React.FC<ContinuationPromptProps> = ({
  invitation,
  compact = false,
}) => {
  const { t } = useTranslation('groups');
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const memberName = useGroupMemberName();
  const refresh = useGroupStore(s => s.refresh);
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const name = isolate(memberName(invitation.owner));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      logger.error('Continuation not answered', error);
      toast.error(t('invitation.failed'));
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    run(async () => {
      const groupId = await gossip.conversations.acceptInvitation(
        invitation.epochId
      );
      await refresh();
      toast.success(t('invitation.accepted'));
      navigate(ROUTES.group({ groupId }), { replace: true });
    });

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div
      className={
        compact
          ? 'mt-2'
          : 'bg-card border-t border-border px-4 py-3 text-center'
      }
      role="status"
      data-testid="continuation-prompt"
      onClick={stop}
      onKeyDown={stop}
    >
      <p
        className={
          compact ? 'text-xs text-foreground' : 'text-sm text-foreground'
        }
      >
        {t('archive.continue_invitation', { name })}
      </p>
      <p
        className="mt-0.5 text-xs text-muted-foreground"
        data-testid="continuation-timer"
      >
        {messageTimerSentence(invitation.messageTimer, t)}
      </p>
      <div className={`mt-2 flex gap-2 ${compact ? '' : 'justify-center'}`}>
        <Button
          onClick={() => void accept()}
          disabled={busy}
          variant="primary"
          size="custom"
          className={`px-4 rounded-lg font-semibold ${compact ? 'h-8 text-xs' : 'h-10'}`}
          data-testid="continuation-accept"
        >
          {t('invitation.accept')}
        </Button>
        <Button
          onClick={() => setDeclining(true)}
          disabled={busy}
          variant="secondary"
          size="custom"
          className={`px-4 rounded-lg font-semibold ${compact ? 'h-8 text-xs' : 'h-10'}`}
          data-testid="continuation-decline"
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
          if (action.type !== 'decline') return;
          void run(async () => {
            await gossip.conversations.declineInvitation(
              invitation.epochId,
              action.choice
            );
            await refresh();
            toast.success(t('invitation.declined'));
          });
        }}
      />
    </div>
  );
};

export default ContinuationPrompt;
