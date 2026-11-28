import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Archive,
  Edit2,
  LogOut,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from 'react-feather';
import { Star, UserMinus } from 'react-feather';
import { SessionStatus, type GroupEpoch } from '@massalabs/gossip-sdk';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import BaseModal from '../components/ui/BaseModal';
import ContactNameModal from '../components/ui/ContactNameModal';
import SafeName from '../components/groups/SafeName';
import ChatNameDialog from '../components/groups/ChatNameDialog';
import ResolveForkPanel from '../components/groups/ResolveForkPanel';
import ContactAvatar from '../components/avatar/ContactAvatar';
import MemberPicker from '../components/groups/MemberPicker';
import ConfirmSheet from '../components/groups/ConfirmSheet';
import {
  canDeleteChat,
  canLeaveChat,
  useChatExit,
} from '../hooks/useDeleteChat';
import MessageTimerField from '../components/groups/MessageTimerField';
import { messageTimerSentence } from '../constants/messageTimer';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useAccountStore } from '../stores/accountStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { ROUTES } from '../constants/routes';
import { GROUP_NAME_MAX_BYTES } from './NewGroup';
import { isAcceptedContact, isDisplayNameTaken } from '../utils/conversations';
import { groupDisplayName, isolate, safeName } from '../utils/groupName';

type Modal =
  | { kind: 'name' }
  | { kind: 'add' }
  | { kind: 'transfer' }
  | { kind: 'remove'; member: string }
  | { kind: 'addContact'; member: string }
  | null;

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="px-4 py-3 border-b border-border last:border-b-0">
    <p className="text-xs text-muted-foreground">{label}</p>
    <div className="text-sm text-foreground mt-0.5 min-w-0">{children}</div>
  </div>
);

const ActionButton: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
  <button
    type="button"
    onClick={onClick}
    className={`w-full px-4 py-3 flex items-center gap-3 text-left text-sm border-b border-border last:border-b-0 hover:bg-muted ${
      danger ? 'text-destructive' : 'text-foreground'
    }`}
  >
    {icon}
    {label}
  </button>
);

/**
 * Group details (§5.11 names, members, owner, the §7.7 message timer) with
 * the owner's tools (add, remove, rename, the message timer, transfer, the
 * §5.8 popup, the §4.9 resolution) and the member's tools (leave with its
 * choices, delete locally, retry). Only the owner changes the timer, by a new
 * root; the others see it.
 */
const GroupSettings: React.FC = () => {
  const { groupId = '' } = useParams();
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  const gossip = useGossipSdk();
  const me = useAccountStore(s => s.userProfile?.userId) ?? '';
  const memberName = useGroupMemberName();
  const contacts = useDiscussionStore(s => s.contacts);
  const refresh = useGroupStore(s => s.refresh);
  const setArchived = useGroupStore(s => s.setArchived);
  const entry = useGroupStore(s =>
    s.groups.find(g => g.summary.groupId === groupId)
  );
  const group = entry?.summary;
  const archived = entry?.archived ?? false;
  const [modal, setModal] = useState<Modal>(null);
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [contactNameError, setContactNameError] = useState<string | null>(null);
  const service = getGroupService();
  const exit = useChatExit(() => navigate(ROUTES.discussions()));

  const [ownedEnds, setOwnedEnds] = useState<GroupEpoch[]>([]);
  const ends = group?.mustResolve
    ? [group.currentEpoch, ...group.sideBranches].join(',')
    : '';
  useEffect(() => {
    let alive = true;
    if (!ends || !service) {
      setOwnedEnds([]);
      return;
    }
    Promise.all(ends.split(',').map(e => service.epoch(e)))
      .then(list => {
        if (!alive) return;
        setOwnedEnds(
          list.filter((e): e is GroupEpoch => !!e && e.owner === me)
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ends, service, me]);

  // Ends of former owners (§5.9): shown for information; the current owner may
  // merge them, which blocks nothing meanwhile.
  const [formerEnds, setFormerEnds] = useState<GroupEpoch[]>([]);
  const [mergingFormer, setMergingFormer] = useState(false);
  const former =
    group && group.formerOwnerBranches.length > 0
      ? [group.currentEpoch, ...group.formerOwnerBranches].join(',')
      : '';
  useEffect(() => {
    let alive = true;
    if (!former || !service) {
      setFormerEnds([]);
      return;
    }
    Promise.all(former.split(',').map(e => service.epoch(e)))
      .then(list => {
        if (alive) setFormerEnds(list.filter((e): e is GroupEpoch => !!e));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [former, service]);

  const run = async (fn: () => Promise<unknown>, ok = t('details.saved')) => {
    try {
      await fn();
      refresh();
      toast.success(ok);
      return true;
    } catch {
      toast.error(t('details.failed'));
      return false;
    }
  };

  if (!group || !service) {
    return (
      <PageLayout
        header={
          <PageHeader
            title={t('details.title')}
            onBack={() => navigate(ROUTES.discussions())}
          />
        }
        className="app-max-w mx-auto"
        contentClassName="px-6 py-6"
      >
        <p className="text-sm text-muted-foreground">
          {t('details.not_found')}
        </p>
      </PageLayout>
    );
  }

  const isOwner = group.owner === me;
  const active = group.status === 'member';
  // The name shown: the user's own name for the chat, else the shared one
  // (else the members, as in the chat list). The shared name is shown under
  // it when the two differ.
  const ownName = safeName(group.localName);
  const sharedName = safeName(group.name);
  const shownName = groupDisplayName(group, memberName, me);
  const others = group.members.filter(m => m !== me);
  // As "New group": contacts the user accepted, with an active session. A
  // member of another chat who is no contact is added as a contact first
  // (§5.12): putting someone in a chat the user owns shows them to every
  // member, which only a contact the user chose should get.
  const addable = contacts
    .filter(
      c =>
        isAcceptedContact(c) &&
        !group.members.includes(c.userId) &&
        gossip.discussions.getStatus(c.userId) === SessionStatus.Active
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const openAdd = () => {
    setToAdd(new Set());
    setModal({ kind: 'add' });
  };
  // "Add as contact" for a member who is no contact the user accepted.
  const canAddAsContact = (m: string) => {
    if (m === me) return false;
    const c = contacts.find(x => x.userId === m);
    return !c || !isAcceptedContact(c);
  };
  const addAsContact = async (member: string, name?: string) => {
    const trimmed = name?.trim() ?? '';
    if (!trimmed) {
      setContactNameError(t('contacts:name_empty'));
      return;
    }
    if (isDisplayNameTaken(contacts, trimmed, member)) {
      setContactNameError(t('details.contact_name_taken'));
      return;
    }
    setModal(null);
    // Local: nothing is sent (§5.12).
    await run(async () => {
      const result = await gossip.conversations.addAsContact(member, trimmed);
      if (!result.success) throw new Error(result.reason);
    }, t('details.contact_added'));
  };

  return (
    <PageLayout
      header={
        <PageHeader
          title={t('details.title')}
          onBack={() => navigate(ROUTES.group({ groupId }))}
        />
      }
      className="app-max-w mx-auto"
      contentClassName="px-6 py-6 space-y-4"
    >
      {group.mustResolve && isOwner && ownedEnds.length > 1 && (
        <div className="bg-card rounded-xl border border-destructive/50 p-4 space-y-3">
          <p className="text-sm font-medium text-foreground">
            {t('resolve.title')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('details.resolve_body')}
          </p>
          <ResolveForkPanel
            ends={ownedEnds}
            me={me}
            memberName={memberName}
            onSend={async members => {
              await run(
                () => service.resolveFork(groupId, members),
                t('resolve.sent')
              );
            }}
          />
        </div>
      )}

      <div className="flex flex-col items-center text-center pt-2 pb-1">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
          <Users className="w-8 h-8 text-foreground" />
        </div>
        <div className="mt-3 flex items-center justify-center gap-1 max-w-full min-w-0">
          <h2
            className="text-xl font-semibold text-foreground min-w-0 truncate"
            data-testid="chat-name"
          >
            <SafeName name={shownName} fallback={t('invitation.unnamed')} />
          </h2>
          <button
            type="button"
            onClick={() => setModal({ kind: 'name' })}
            aria-label={t('details.name_edit')}
            title={t('details.name_edit')}
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-full hover:bg-muted"
            data-testid="chat-name-edit"
          >
            <Edit2 className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>
        {ownName && ownName !== sharedName && (
          <p
            className="text-xs text-muted-foreground max-w-full min-w-0 truncate"
            data-testid="chat-shared-name"
          >
            {sharedName
              ? t('details.name_shared', { name: isolate(sharedName) })
              : t('details.name_shared_none')}
          </p>
        )}
        <p className="mt-1 text-sm text-muted-foreground">
          {t('list.members_count', { count: group.members.length })}
        </p>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <Row label={t('details.owner')}>
          <SafeName name={memberName(group.owner)} />
        </Row>
        <Row label={t('details.status')}>
          {t(`details.status_${group.status}`)}
        </Row>
        {!(isOwner && active) && (
          <Row label={t('timer.label')}>
            <span data-testid="group-timer">
              {messageTimerSentence(group.messageTimer, t)}
            </span>
            <p className="text-xs text-muted-foreground mt-1">
              {t('timer.owner_only')}
            </p>
          </Row>
        )}
      </div>

      {/* Members (Lucas's screen 09): adding and removing are here only. */}
      <section>
        <p className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('details.members')} · {group.members.length}
        </p>
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          {isOwner && active && (
            <button
              type="button"
              onClick={openAdd}
              className="w-full px-4 py-3 flex items-center gap-3 text-left border-b border-border hover:bg-muted"
            >
              <span className="w-10 h-10 rounded-full bg-accent-soft flex items-center justify-center shrink-0">
                <UserPlus className="w-5 h-5 text-accent-soft-foreground" />
              </span>
              <span className="text-sm font-medium text-accent-soft-foreground">
                {t('details.add_members')}
              </span>
            </button>
          )}
          <ul data-testid="group-members">
            {group.members.map(m => (
              <li
                key={m}
                className="px-4 py-2.5 flex items-center gap-3 border-b border-border last:border-b-0"
              >
                <ContactAvatar
                  contact={{ userId: m, name: memberName(m), avatar: null }}
                  size={10}
                />
                <span className="flex-1 text-sm text-foreground min-w-0 truncate">
                  <SafeName name={memberName(m)} />
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {m === group.owner && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-muted text-foreground">
                      <Star className="w-3 h-3" />
                      {t('details.owner')}
                    </span>
                  )}
                  {canAddAsContact(m) && (
                    <Button
                      variant="link"
                      size="sm"
                      data-testid="member-add-contact"
                      onClick={() => {
                        setContactNameError(null);
                        setModal({ kind: 'addContact', member: m });
                      }}
                    >
                      {t('details.add_as_contact')}
                    </Button>
                  )}
                  {isOwner && active && m !== me && (
                    <Button
                      variant="icon"
                      ariaLabel={t('details.remove')}
                      data-testid="member-remove"
                      onClick={() => setModal({ kind: 'remove', member: m })}
                    >
                      <UserMinus className="w-5 h-5 text-muted-foreground" />
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {group.sideBranches.length > 0 && !group.mustResolve && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-sm text-foreground">
            {t('details.side_branches')}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('details.side_branches_hint')}
          </p>
        </div>
      )}

      {group.formerOwnerBranches.length > 0 && (
        <div
          className="bg-card rounded-xl border border-border p-4 space-y-3"
          data-testid="former-owner-branches"
        >
          <div>
            <p className="text-sm text-foreground">
              {t('details.former_branches', {
                count: group.formerOwnerBranches.length,
              })}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('details.former_branches_hint')}
            </p>
          </div>
          {isOwner && active && formerEnds.length > 1 && (
            <>
              <Button
                variant="link"
                size="sm"
                onClick={() => setMergingFormer(m => !m)}
              >
                {t('details.former_branches_resolve')}
              </Button>
              {mergingFormer && (
                <ResolveForkPanel
                  ends={formerEnds}
                  me={me}
                  memberName={memberName}
                  onSend={async members => {
                    if (
                      await run(
                        () => service.resolveFork(groupId, members),
                        t('resolve.sent')
                      )
                    ) {
                      setMergingFormer(false);
                    }
                  }}
                />
              )}
            </>
          )}
        </div>
      )}

      {isOwner && active && (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <p className="px-4 pt-3 pb-1 text-xs text-muted-foreground">
            {t('details.owner_tools')}
          </p>
          <div className="border-b border-border last:border-b-0">
            <MessageTimerField
              value={group.messageTimer}
              hint={t('timer.change_hint')}
              testId="group-timer-field"
              onChange={timer => {
                if (timer === group.messageTimer) return;
                void run(() => service.setMessageTimer(groupId, timer));
              }}
            />
          </div>
          {others.length > 0 && (
            <ActionButton
              icon={<Users className="w-4 h-4" />}
              label={t('details.transfer')}
              onClick={() => setModal({ kind: 'transfer' })}
            />
          )}
        </div>
      )}

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        {/* Lucas's screen 09: a mark on this device only, nothing is sent. */}
        <button
          type="button"
          onClick={() => {
            const to = !archived;
            setArchived(groupId, to).then(
              () =>
                toast.success(
                  to ? t('archive.archived') : t('archive.unarchived')
                ),
              () => toast.error(t('details.failed'))
            );
          }}
          className="w-full px-4 py-3 flex items-start gap-3 text-left text-sm text-foreground border-b border-border last:border-b-0 hover:bg-muted"
          data-testid="chat-archive"
        >
          <Archive className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="min-w-0">
            <span className="block">
              {archived ? t('details.unarchive') : t('details.archive')}
            </span>
            {!archived && (
              <span className="block mt-0.5 text-xs text-muted-foreground">
                {t('details.archive_hint')}
              </span>
            )}
          </span>
        </button>
        {active && (
          <ActionButton
            icon={<RefreshCw className="w-4 h-4" />}
            label={t('details.retry_sync')}
            onClick={() =>
              void run(
                () => service.resendRoot(groupId),
                t('details.retry_sync_done')
              )
            }
          />
        )}
        {canLeaveChat(group.status) && (
          <ActionButton
            icon={<LogOut className="w-4 h-4" />}
            label={t('details.leave')}
            onClick={() => exit.leave(groupId)}
            danger
          />
        )}
        {/* On a chat the user is still in, it opens the leave screen with
            "Delete it" chosen: the engine deletes a chat the user is out of. */}
        {canDeleteChat(group.status) && (
          <ActionButton
            icon={<Trash2 className="w-4 h-4" />}
            label={t('details.delete_locally')}
            danger
            onClick={() => exit.remove(groupId)}
          />
        )}
      </div>
      {exit.sheets}

      <ChatNameDialog
        isOpen={modal?.kind === 'name'}
        onClose={() => setModal(null)}
        initialName={group.localName ?? group.name}
        hasOwnName={group.localName !== null}
        canSaveForEveryone={isOwner && active}
        maxBytes={GROUP_NAME_MAX_BYTES}
        onSaveForMe={name => {
          setModal(null);
          void run(() => service.setLocalName(groupId, name));
        }}
        onSaveForEveryone={name => {
          setModal(null);
          void run(async () => {
            await service.changeMembers(groupId, { name });
            // The owner's own name for the chat would hide the new shared
            // name on this device: what they just typed is what they see.
            if (group.localName !== null) {
              await service.setLocalName(groupId, null);
            }
          });
        }}
      />
      <ContactNameModal
        isOpen={modal?.kind === 'addContact'}
        onClose={() => setModal(null)}
        title={t('details.add_as_contact')}
        initialName=""
        confirmLabel={t('details.add_as_contact')}
        hint={t('details.add_as_contact_hint')}
        error={contactNameError}
        onConfirm={name => {
          if (modal?.kind !== 'addContact') return;
          void addAsContact(modal.member, name);
        }}
      />
      <ConfirmSheet
        isOpen={modal?.kind === 'remove'}
        title={
          modal?.kind === 'remove'
            ? t('details.remove_title', {
                name: `\u2068${memberName(modal.member)}\u2069`,
              })
            : ''
        }
        body={
          modal?.kind === 'remove'
            ? t('details.remove_confirm', {
                name: `\u2068${memberName(modal.member)}\u2069`,
              })
            : ''
        }
        confirmLabel={t('details.remove')}
        onConfirm={() => {
          if (modal?.kind !== 'remove') return;
          const member = modal.member;
          setModal(null);
          void run(() => service.changeMembers(groupId, { remove: [member] }));
        }}
        onClose={() => setModal(null)}
      />
      <BaseModal
        isOpen={modal?.kind === 'add'}
        onClose={() => setModal(null)}
        title={t('details.add_members')}
      >
        <div className="space-y-3">
          {/* The picker of a new chat (Lucas's screen 10). */}
          <MemberPicker
            contacts={addable}
            selected={toAdd}
            onToggle={userId =>
              setToAdd(s => {
                const n = new Set(s);
                if (n.has(userId)) n.delete(userId);
                else n.add(userId);
                return n;
              })
            }
            emptyText={t('new_group.no_eligible_contacts')}
          />
          <Button
            variant="primary"
            fullWidth
            disabled={toAdd.size === 0}
            onClick={() => {
              const add = [...toAdd];
              setModal(null);
              void run(() => service.changeMembers(groupId, { add }));
            }}
          >
            {t('details.add_members')}
          </Button>
        </div>
      </BaseModal>
      <BaseModal
        isOpen={modal?.kind === 'transfer'}
        onClose={() => setModal(null)}
        title={t('details.transfer_title')}
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('details.transfer_body')}
          </p>
          <ul className="max-h-[50vh] overflow-y-auto divide-y divide-border">
            {others.map(m => (
              <li key={m}>
                <button
                  type="button"
                  className="w-full text-left px-2 py-3 text-sm hover:bg-muted rounded"
                  onClick={() => {
                    setModal(null);
                    void run(() => service.handOver(groupId, m));
                  }}
                >
                  <SafeName name={memberName(m)} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      </BaseModal>
    </PageLayout>
  );
};

export default GroupSettings;
