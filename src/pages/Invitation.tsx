import React, { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { AlertTriangle, Clock, Shield } from 'react-feather';
import {
  formatUserId,
  SessionStatus,
  type Discussion,
  type GroupInvitation,
} from '@massalabs/gossip-sdk';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import SafeName from '../components/groups/SafeName';
import LeaveGroupSheet from '../components/groups/LeaveGroupSheet';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useDiscussionList } from '../hooks/useDiscussionList';
import { useDiscussionStore } from '../stores/discussionStore';
import { useGroupStore } from '../stores/groupStore';
import { useAccountStore } from '../stores/accountStore';
import { isolate } from '../utils/groupName';
import { isAcceptedContact } from '../utils/conversations';
import { ROUTES } from '../constants/routes';
import { messageTimerSentence } from '../constants/messageTimer';

const Section: React.FC<{
  title: string;
  children: React.ReactNode;
  testId?: string;
}> = ({ title, children, testId }) => (
  <section
    className="bg-card rounded-xl border border-border p-4 space-y-2"
    data-testid={testId}
  >
    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </p>
    {children}
  </section>
);

/**
 * The one invitation screen (§5.12): every invitation, a group's, a direct
 * chat's, a migration's or a contact request, is shown with the sections
 * that apply, in this order: who asks; adding them as a contact; the group,
 * its owner and members; its message timer (§7.7), which only its owner
 * changes; the earlier conversation it continues; warnings
 * (§4.8, §5.11); the choices. A person who is no contact and asks for a chat
 * is shown once, as asking both to become a contact and to open the chat.
 *
 * `kind` is `group` (an invitation, by its epoch) or `contact` (a contact
 * request, by the requester's user ID).
 */
const Invitation: React.FC = () => {
  const { kind, id } = useParams();
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  const gossip = useGossipSdk();
  const me = useAccountStore(s => s.userProfile?.userId);
  const memberName = useGroupMemberName();
  const refresh = useGroupStore(s => s.refresh);
  const contacts = useDiscussionStore(s => s.contacts);
  const discussions = useDiscussionStore(s => s.discussions);
  const statuses = useDiscussionStore(s => s.sessionsStatuses);
  const invitation: GroupInvitation | undefined = useGroupStore(s =>
    kind === 'group' ? s.invitations.find(i => i.epochId === id) : undefined
  );
  const { handleAcceptDiscussionRequest, handleRefuseDiscussionRequest } =
    useDiscussionList();
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);

  const request: Discussion | undefined =
    kind === 'contact'
      ? discussions.find(
          d =>
            d.contactUserId === id &&
            !d.weAccepted &&
            statuses.get(d.contactUserId) === SessionStatus.PeerRequested
        )
      : undefined;

  const back = () => navigate(ROUTES.discussions());

  if (!invitation && !request) {
    return (
      <PageLayout
        header={<PageHeader title={t('invite.title')} onBack={back} />}
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6"
      >
        <p className="text-sm text-muted-foreground text-center">
          {t('invite.not_found')}
        </p>
      </PageLayout>
    );
  }

  const asker = invitation ? invitation.owner : request!.contactUserId;
  const askerContact = contacts.find(c => c.userId === asker);
  const isContact = !!askerContact && isAcceptedContact(askerContact);
  const ofTwo =
    !!invitation &&
    invitation.members.length === 2 &&
    !!me &&
    invitation.members.includes(me);
  // A chat asked by someone who is no contact also asks to become one.
  const asksContact = !!request || (ofTwo && !isContact);
  const name = isolate(memberName(asker));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch {
      toast.error(t('invitation.failed'));
    } finally {
      setBusy(false);
    }
  };

  const accept = () =>
    run(async () => {
      if (invitation) {
        const groupId = await gossip.conversations.acceptInvitation(
          invitation.epochId
        );
        await refresh();
        toast.success(t('invitation.accepted'));
        navigate(ROUTES.group({ groupId }), { replace: true });
      } else if (request) {
        await handleAcceptDiscussionRequest(request);
        toast.success(t('invitation.accepted'));
        navigate(ROUTES.discussions(), { replace: true });
      }
    });

  const decline = () => {
    if (invitation) {
      setDeclining(true);
      return;
    }
    if (request) {
      void run(async () => {
        await handleRefuseDiscussionRequest(request);
        toast.success(t('invitation.declined'));
        navigate(ROUTES.discussions(), { replace: true });
      });
    }
  };

  return (
    <PageLayout
      header={<PageHeader title={t('invite.title')} onBack={back} />}
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-4"
    >
      <Section title={t('invite.who_asks')} testId="invite-who">
        <p className="text-sm font-medium text-foreground">
          <SafeName name={memberName(asker)} />
        </p>
        <p className="text-[11px] text-muted-foreground break-all">
          {formatUserId(asker)}
        </p>
        {invitation && (
          <p className="flex items-center gap-1 text-xs text-foreground">
            <Shield className="w-3.5 h-3.5 text-success shrink-0" />
            <span className="min-w-0 truncate">
              {t('invitation.owner_verified')}{' '}
              <SafeName name={memberName(invitation.owner)} />
            </span>
          </p>
        )}
        {invitation?.receivedFrom && (
          <p className="text-xs text-muted-foreground truncate">
            {t('invitation.received_from')}{' '}
            <SafeName name={memberName(invitation.receivedFrom)} />
          </p>
        )}
        {asksContact && (
          <p className="text-sm text-foreground">
            {t('invite.asks_contact_and_chat', { name })}
          </p>
        )}
        {request?.lastAnnouncementMessage && (
          <div className="mt-2 p-2.5 bg-muted/50 border border-border rounded-lg">
            <p className="text-xs text-muted-foreground mb-1">
              {t('invite.their_message')}
            </p>
            <p className="text-sm text-foreground whitespace-pre-wrap wrap-break-word">
              {request.lastAnnouncementMessage}
            </p>
          </div>
        )}
      </Section>

      {asksContact && (
        <Section title={t('invite.add_contact')} testId="invite-contact">
          <p className="text-sm text-foreground">
            {t('invite.add_contact_hint', { name })}
          </p>
        </Section>
      )}

      {invitation && !ofTwo && (
        <Section title={t('invite.group')} testId="invite-group">
          <p className="text-sm font-medium text-foreground">
            <SafeName
              name={invitation.name}
              fallback={t('invitation.unnamed')}
            />
          </p>
          <p className="text-xs text-muted-foreground">
            {t('invite.owner')}:{' '}
            <SafeName name={memberName(invitation.owner)} />
          </p>
          <p className="text-xs font-medium text-muted-foreground">
            {t('invitation.members')}
          </p>
          <ul className="flex flex-wrap gap-1">
            {invitation.members.map(m => (
              <li
                key={m}
                className="max-w-full px-2 py-0.5 rounded-full bg-muted text-xs text-foreground"
              >
                <SafeName name={memberName(m)} maxGraphemes={24} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {invitation && (
        <Section title={t('timer.label')} testId="invite-timer">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Clock className="w-4 h-4 shrink-0 text-muted-foreground" />
            {messageTimerSentence(invitation.messageTimer, t)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('timer.owner_only')}
          </p>
        </Section>
      )}

      {(invitation?.migrationOf || invitation?.continues) && (
        <Section title={t('invite.continues')} testId="invite-continues">
          <p className="text-sm text-foreground">
            {invitation.continues
              ? t('invite.continues_chat_body', { name })
              : t('invite.continues_body', { name })}
          </p>
        </Section>
      )}

      <Section title={t('invite.warnings')} testId="invite-warnings">
        {invitation?.closedBefore && (
          <p className="flex gap-2 text-xs text-destructive">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {t('invitation.closed_before')}
          </p>
        )}
        {invitation?.rejoins && (
          <p className="text-xs text-muted-foreground">
            {t('invitation.rejoins')}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {t('invite.untrusted_names')}
        </p>
      </Section>

      <Section title={t('invite.choices')}>
        <div className="flex gap-3">
          <Button
            onClick={accept}
            disabled={busy}
            variant="primary"
            size="custom"
            className="flex-1 h-11 rounded-lg font-semibold"
            data-testid="invite-accept"
          >
            {t('invitation.accept')}
          </Button>
          <Button
            onClick={decline}
            disabled={busy}
            variant="secondary"
            size="custom"
            className="flex-1 h-11 rounded-lg font-semibold"
            data-testid="invite-decline"
          >
            {t('invitation.decline')}
          </Button>
        </div>
      </Section>

      <LeaveGroupSheet
        isOpen={declining}
        mode="decline"
        onClose={() => setDeclining(false)}
        onAction={action => {
          setDeclining(false);
          if (action.type !== 'decline' || !invitation) return;
          void run(async () => {
            await gossip.conversations.declineInvitation(
              invitation.epochId,
              action.choice
            );
            await refresh();
            toast.success(t('invitation.declined'));
            navigate(ROUTES.discussions(), { replace: true });
          });
        }}
      />
    </PageLayout>
  );
};

export default Invitation;
