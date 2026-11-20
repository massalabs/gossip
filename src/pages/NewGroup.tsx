import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Check } from 'react-feather';
import { SessionStatus, type Contact } from '@massalabs/gossip-sdk';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import FormInput from '../components/ui/FormInput';
import Button from '../components/ui/Button';
import SearchBar from '../components/ui/SearchBar';
import ContactAvatar from '../components/avatar/ContactAvatar';
import UserIdDisplay from '../components/ui/UserIdDisplay';
import SafeName from '../components/groups/SafeName';
import MessageTimerField from '../components/groups/MessageTimerField';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useDefaultMessageTimer } from '../hooks/useDefaultMessageTimer';
import { useDiscussionStore } from '../stores/discussionStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { ROUTES } from '../constants/routes';
import { safeName } from '../utils/groupName';
import { isAcceptedContact } from '../utils/conversations';

/** The largest group name, in UTF-8 bytes (§5.11). */
export const GROUP_NAME_MAX_BYTES = 256;

/**
 * New group: a name and members picked among the contacts that have an
 * active session (a root is delivered inside the one-to-one sessions).
 */
const NewGroup: React.FC = () => {
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  const gossip = useGossipSdk();
  const refresh = useGroupStore(s => s.refresh);
  const storeContacts = useDiscussionStore(s => s.contacts);
  const [contacts, setContacts] = useState<Contact[]>(storeContacts);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter(
      c =>
        safeName(c.name).toLowerCase().includes(q) ||
        c.userId.toLowerCase().includes(q)
    );
  }, [eligible, query]);

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
        <div className="border-b border-border px-4 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">
              {t('new_group.members_title')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('new_group.selected', { count: selected.size })}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('new_group.members_hint')}
          </p>
          <SearchBar
            value={query}
            onChange={setQuery}
            placeholder={t('common:search')}
            aria-label={t('common:search')}
          />
        </div>
        {eligible.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {t('new_group.no_eligible_contacts')}
          </p>
        ) : (
          <ul className="max-h-[50vh] overflow-y-auto">
            {shown.map(contact => {
              const isSelected = selected.has(contact.userId);
              return (
                <li key={contact.userId}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isSelected}
                    onClick={() => toggle(contact.userId)}
                    className="hover-fill w-full px-4 py-3 flex items-center gap-3 text-left border-b border-border last:border-b-0"
                  >
                    <ContactAvatar contact={contact} size={10} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground truncate">
                        <SafeName name={contact.name} />
                      </p>
                      <UserIdDisplay
                        userId={contact.userId}
                        textClassName="text-muted-foreground"
                      />
                    </div>
                    <span
                      className={`w-6 h-6 rounded-full border flex items-center justify-center shrink-0 ${
                        isSelected
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-border'
                      }`}
                    >
                      {isSelected && <Check className="w-4 h-4" />}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Button
        onClick={create}
        disabled={!canCreate}
        loading={creating}
        variant="primary"
        fullWidth
      >
        {creating ? t('new_group.creating') : t('new_group.create')}
      </Button>
    </PageLayout>
  );
};

export default NewGroup;
