import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Archive } from 'react-feather';
import {
  DiscussionDirection,
  type Contact,
  type Discussion,
} from '@massalabs/gossip-sdk';
import Button from '../ui/Button';
import LeaveGroupSheet from './LeaveGroupSheet';
import { useGossipSdk } from '../../hooks/useGossipSdk';
import { useGroupStore } from '../../stores/groupStore';
import { useGroupMemberName } from '../../hooks/useGroupMemberName';
import { isolate } from '../../utils/groupName';
import { ROUTES } from '../../constants/routes';
import { logger } from '../../utils/logger.ts';

interface ArchiveFooterProps {
  contact: Contact;
  discussion: Discussion | null | undefined;
}

/**
 * What an earlier one-to-one conversation offers instead of a composer
 * (§5.12): nothing is written in it any more. The peer's migration, when it
 * is pending, is shown with Accept and Decline and hides "Migrate"; otherwise
 * an archive offers "Migrate to a new group" and "Archive". A new contact
 * whose chat is not founded yet says what it waits for.
 */
const ArchiveFooter: React.FC<ArchiveFooterProps> = ({
  contact,
  discussion,
}) => {
  const { t } = useTranslation('groups');
  const gossip = useGossipSdk();
  const navigate = useNavigate();
  const memberName = useGroupMemberName();
  const refresh = useGroupStore(s => s.refresh);
  const invitation = useGroupStore(s =>
    s.invitations.find(i => i.migrationOf === contact.userId)
  );
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  // Made safe (§5.11) and isolated from the direction of the sentence.
  const name = isolate(memberName(contact.userId));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    run(async () => {
      if (!invitation) return;
      try {
        const groupId = await gossip.conversations.acceptInvitation(
          invitation.epochId
        );
        await refresh();
        toast.success(t('invitation.accepted'));
        navigate(ROUTES.group({ groupId }), { replace: true });
      } catch (error) {
        logger.error('Migration not accepted', error);
        toast.error(t('invitation.failed'));
      }
    });

  const migrate = () =>
    run(async () => {
      try {
        const groupId = await gossip.conversations.migrate(contact.userId);
        await refresh();
        toast.success(t('archive.migrated'));
        navigate(ROUTES.group({ groupId }), { replace: true });
      } catch (error) {
        // The peer's migration arrived meanwhile: it is shown instead.
        await refresh();
        logger.error('Migration not created', error);
        toast.error(t('archive.migrate_failed'));
      }
    });

  const toggleArchived = () =>
    run(async () => {
      const archived = !discussion?.archived;
      await gossip.conversations.setArchived(contact.userId, archived);
      toast.success(archived ? t('archive.archived') : t('archive.unarchived'));
      if (archived) navigate(ROUTES.discussions());
    });

  let body: React.ReactNode;
  if (invitation) {
    body = (
      <>
        <p className="text-sm text-foreground">
          {t('archive.invitation', { name })}
        </p>
        <div className="mt-3 flex gap-2 justify-center">
          <Button
            onClick={accept}
            disabled={busy}
            variant="primary"
            size="custom"
            className="px-4 h-10 rounded-lg font-semibold"
            data-testid="archive-accept-migration"
          >
            {t('invitation.accept')}
          </Button>
          <Button
            onClick={() => setDeclining(true)}
            disabled={busy}
            variant="secondary"
            size="custom"
            className="px-4 h-10 rounded-lg font-semibold"
          >
            {t('invitation.decline')}
          </Button>
        </div>
      </>
    );
  } else if (discussion?.isArchive) {
    body = (
      <>
        <p className="text-xs text-muted-foreground">
          {t('archive.read_only')}
        </p>
        <div className="mt-3 flex gap-2 justify-center flex-wrap">
          <Button
            onClick={migrate}
            disabled={busy}
            variant="primary"
            size="custom"
            className="px-4 h-10 rounded-lg font-semibold"
            data-testid="archive-migrate"
          >
            {t('archive.migrate')}
          </Button>
          <Button
            onClick={toggleArchived}
            disabled={busy}
            variant="secondary"
            size="custom"
            className="px-4 h-10 rounded-lg font-semibold inline-flex items-center gap-2"
            data-testid="archive-toggle"
          >
            <Archive className="w-4 h-4" />
            {discussion.archived
              ? t('archive.unarchive')
              : t('archive.archive')}
          </Button>
        </div>
      </>
    );
  } else if (discussion?.direction === DiscussionDirection.RECEIVED) {
    body = (
      <p className="text-sm text-muted-foreground">
        {t('archive.request_received', { name })}
      </p>
    );
  } else {
    body = (
      <p className="text-sm text-muted-foreground">
        {t('archive.waiting_contact', { name })}
      </p>
    );
  }

  return (
    <div
      className="bg-card border-t border-border px-4 py-4 text-center"
      role="status"
      data-testid="archive-footer"
    >
      {body}
      <LeaveGroupSheet
        isOpen={declining}
        mode="decline"
        onClose={() => setDeclining(false)}
        onAction={action => {
          setDeclining(false);
          if (action.type !== 'decline' || !invitation) return;
          void run(async () => {
            try {
              await gossip.conversations.declineInvitation(
                invitation.epochId,
                action.choice
              );
              await refresh();
              toast.success(t('invitation.declined'));
            } catch {
              toast.error(t('invitation.failed'));
            }
          });
        }}
      />
    </div>
  );
};

export default ArchiveFooter;
