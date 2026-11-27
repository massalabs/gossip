import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { ArrowRight, Users, X } from 'react-feather';
import { SessionStatus, type Contact } from '@massalabs/gossip-sdk';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import FormInput from '../components/ui/FormInput';
import Button from '../components/ui/Button';
import ContactAvatar from '../components/avatar/ContactAvatar';
import UserProfileAvatar from '../components/avatar/UserProfileAvatar';
import SafeName from '../components/groups/SafeName';
import MessageTimerField from '../components/groups/MessageTimerField';
import MemberPicker from '../components/groups/MemberPicker';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useDefaultMessageTimer } from '../hooks/useDefaultMessageTimer';
import { useDiscussionStore } from '../stores/discussionStore';
import { useAccountStore } from '../stores/accountStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { ROUTES } from '../constants/routes';
import { isAcceptedContact } from '../utils/conversations';

/** The largest group name, in UTF-8 bytes (§5.11). */
export const GROUP_NAME_MAX_BYTES = 256;

/**
 * New chat, in two steps (Lucas's screens 01 and 02): the members, picked
 * among the contacts that have an active session (a root is delivered inside
 * the one-to-one sessions), then the name and the message timer.
 */
const NewGroup: React.FC = () => {
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  const gossip = useGossipSdk();
  const refresh = useGroupStore(s => s.refresh);
  const storeContacts = useDiscussionStore(s => s.contacts);
  const username = useAccountStore(s => s.userProfile?.username);
  const [contacts, setContacts] = useState<Contact[]>(storeContacts);
  const [name, setName] = useState('');
  // Members first, then the name (Lucas's screens 01 and 02).
  const [step, setStep] = useState<'members' | 'name'>('members');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  // The creator's default, pre-selected (§7.7).
  const defaultTimer = useDefaultMessageTimer();
  const [timer, setTimer] = useState<number | null>(null);
  const messageTimer = timer ?? defaultTimer;

  useEffect(() => {
    let alive = true;
    gossip.contacts
      .list()
      .then(list => {
        if (alive) setContacts(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [gossip]);

  const eligible = useMemo(
    () =>
      contacts
        .filter(
          c =>
            // Contacts the user accepted, with an active session.
            isAcceptedContact(c) &&
            gossip.discussions.getStatus(c.userId) === SessionStatus.Active
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [contacts, gossip]
  );

  const nameTooLong =
    new TextEncoder().encode(name).length > GROUP_NAME_MAX_BYTES;
  const canCreate = selected.size > 0 && !nameTooLong && !creating;

  const toggle = (userId: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });

  const create = async () => {
    const service = getGroupService();
    if (!service || !canCreate) return;
    setCreating(true);
    try {
      const groupId = await service.createGroup(name.trim(), [...selected], {
        messageTimer,
      });
      refresh();
      toast.success(t('new_group.created'));
      navigate(ROUTES.group({ groupId }), { replace: true });
    } catch {
      toast.error(t('new_group.failed'));
    } finally {
      setCreating(false);
    }
  };

  const picked = eligible.filter(c => selected.has(c.userId));

  if (step === 'members') {
    return (
      <PageLayout
        header={
          <PageHeader
            title={t('new_group.title')}
            onBack={() => navigate(ROUTES.newDiscussion())}
          />
        }
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6 space-y-4"
      >
        {picked.length > 0 && (
          <ul
            className="flex gap-4 overflow-x-auto pb-1"
            data-testid="picked-members"
          >
            {picked.map(c => (
              <li key={c.userId} className="w-14 shrink-0 text-center">
                <button
                  type="button"
                  onClick={() => toggle(c.userId)}
                  className="relative block mx-auto"
                  aria-label={t('new_group.unselect', { name: c.name })}
                >
                  <ContactAvatar contact={c} size={14} />
                  <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center">
                    <X className="w-3 h-3 text-muted-foreground" />
                  </span>
                </button>
                <p className="mt-1 text-xs text-foreground truncate">
                  <SafeName name={c.name.split(' ')[0] || c.name} />
                </p>
              </li>
            ))}
          </ul>
        )}

        <MemberPicker
          contacts={eligible}
          selected={selected}
          onToggle={toggle}
          emptyText={t('new_group.no_eligible_contacts')}
        />
        <p className="px-1 text-xs text-muted-foreground">
          {t('new_group.members_hint')}
        </p>

        <div className="sticky bottom-0 pt-2 pb-4 bg-background">
          <Button
            onClick={() => setStep('name')}
            disabled={selected.size === 0}
            variant="primary"
            fullWidth
          >
            {t('common:next')}
            <ArrowRight className="w-5 h-5" />
          </Button>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('new_group.title')}
          onBack={() => setStep('members')}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-4"
    >
      <div className="flex justify-center">
        <div className="w-20 h-20 rounded-full bg-accent-soft flex items-center justify-center">
          <Users className="w-9 h-9 text-accent-soft-foreground" />
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <FormInput
          id="group-name"
          label={t('new_group.name_label')}
          value={name}
          onChange={setName}
          placeholder={t('new_group.name_placeholder')}
          helperText={t('new_group.name_hint')}
          error={nameTooLong ? t('new_group.name_too_long') : null}
        />
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <MessageTimerField
          value={messageTimer}
          onChange={setTimer}
          hint={t('timer.new_chat_hint')}
        />
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <p className="px-4 py-3 text-sm font-medium text-foreground border-b border-border">
          {t('new_group.members_title')} · {picked.length + 1}
        </p>
        <ul data-testid="new-chat-members">
          <li className="px-4 py-2.5 flex items-center gap-3 border-b border-border">
            <UserProfileAvatar name={username} size={8} />
            <span className="text-sm text-foreground">{t('list.you')}</span>
          </li>
          {picked.map(c => (
            <li
              key={c.userId}
              className="px-4 py-2.5 flex items-center gap-3 border-b border-border last:border-b-0"
            >
              <ContactAvatar contact={c} size={8} />
              <span className="text-sm text-foreground min-w-0 truncate">
                <SafeName name={c.name} />
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="sticky bottom-0 pt-2 pb-4 bg-background">
        <Button
          onClick={create}
          disabled={!canCreate}
          loading={creating}
          variant="primary"
          fullWidth
        >
          {creating ? t('new_group.creating') : t('new_group.create')}
        </Button>
      </div>
    </PageLayout>
  );
};

export default NewGroup;
