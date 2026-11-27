import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import {
  Edit2,
  LogOut,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
} from 'react-feather';
import { SessionStatus, type GroupEpoch } from '@massalabs/gossip-sdk';
import PageLayout from '../components/ui/Layout/PageLayout';
import PageHeader from '../components/ui/PageHeader';
import Button from '../components/ui/Button';
import BaseModal from '../components/ui/BaseModal';
import ContactNameModal from '../components/ui/ContactNameModal';
import SafeName from '../components/groups/SafeName';
import ChatNameDialog from '../components/groups/ChatNameDialog';
import LeaveGroupSheet, {
  type LeaveAction,
} from '../components/groups/LeaveGroupSheet';
import ResolveForkPanel from '../components/groups/ResolveForkPanel';
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
  const group = useGroupStore(s =>
    s.groups.find(g => g.summary.groupId === groupId)
  )?.summary;
  const [modal, setModal] = useState<Modal>(null);
  const [leaving, setLeaving] = useState(false);
  const [toAdd, setToAdd] = useState<Set<string>>(new Set());
  const [contactNameError, setContactNameError] = useState<string | null>(null);
  const service = getGroupService();

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
  const addable = contacts.filter(
    c =>
      isAcceptedContact(c) &&
      !group.members.includes(c.userId) &&
      gossip.discussions.getStatus(c.userId) === SessionStatus.Active
  );
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

  const onLeaveAction = async (action: LeaveAction) => {
    setLeaving(false);
    let ok = false;
    switch (action.type) {
      case 'leave':
        ok = await run(() => service.leave(groupId, action.choice));
        break;
      case 'handoverLeave':
        ok = await run(() =>
          service.handOver(groupId, action.newOwner, { leave: true })
        );
        break;
      case 'dissolve':
        ok = await run(() => service.dissolve(groupId, action.deleteMessages));
        break;
      default:
        break;
    }
    if (ok && action.type !== 'dissolve') navigate(ROUTES.discussions());
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

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <p className="px-4 pt-3 text-xs text-muted-foreground flex items-center gap-2">
          <Users className="w-3.5 h-3.5" />
          {t('details.members')} ({group.members.length})
        </p>
        <ul data-testid="group-members">
          {group.members.map(m => (
            <li
              key={m}
              className="px-4 py-2 flex items-center justify-between gap-2 border-b border-border last:border-b-0"
            >
              <span className="text-sm min-w-0 truncate">
                <SafeName name={memberName(m)} />
                {m === group.owner && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({t('details.owner')})
                  </span>
                )}
              </span>
              <span className="flex items-center gap-1 shrink-0">
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
                    variant="link"
                    size="sm"
                    onClick={() => setModal({ kind: 'remove', member: m })}
                  >
                    {t('details.remove')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

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
          <ActionButton
            icon={<UserPlus className="w-4 h-4" />}
            label={t('details.add_members')}
            onClick={() => {
              setToAdd(new Set());
              setModal({ kind: 'add' });
            }}
          />
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
        {active && (
          <ActionButton
            icon={<LogOut className="w-4 h-4" />}
            label={t('details.leave')}
            onClick={() => setLeaving(true)}
            danger
          />
        )}
        {!active && group.status !== 'waiting' && (
          <ActionButton
            icon={<Trash2 className="w-4 h-4" />}
            label={t('details.delete_locally')}
            danger
            onClick={async () => {
              if (await run(() => service.deleteGroup(groupId)))
                navigate(ROUTES.discussions());
            }}
          />
        )}
      </div>

      <LeaveGroupSheet
        isOpen={leaving}
        mode="leave"
        isOwner={isOwner}
        otherMembers={others}
        memberName={memberName}
        onAction={action => void onLeaveAction(action)}
        onClose={() => setLeaving(false)}
      />

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
      <BaseModal
        isOpen={modal?.kind === 'remove'}
        onClose={() => setModal(null)}
        title={t('details.remove')}
      >
        {modal?.kind === 'remove' && (
          <div className="space-y-4">
            <p className="text-sm text-foreground">
              {t('details.remove_confirm', {
                name: `⁨${memberName(modal.member)}⁩`,
              })}
            </p>
            <div className="flex gap-3">
              <Button
                variant="danger"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
                onClick={() => {
                  const member = modal.member;
                  setModal(null);
                  void run(() =>
                    service.changeMembers(groupId, { remove: [member] })
                  );
                }}
              >
                {t('details.remove')}
              </Button>
              <Button
                variant="secondary"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
                onClick={() => setModal(null)}
              >
                {t('choices.cancel')}
              </Button>
            </div>
          </div>
        )}
      </BaseModal>
      <BaseModal
        isOpen={modal?.kind === 'add'}
        onClose={() => setModal(null)}
        title={t('details.add_members')}
      >
        <div className="space-y-3">
          {addable.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('new_group.no_eligible_contacts')}
            </p>
          ) : (
            <ul className="max-h-[50vh] overflow-y-auto divide-y divide-border">
              {addable.map(c => (
                <li key={c.userId}>
                  <label className="flex items-center justify-between py-2 gap-2 cursor-pointer">
                    <span className="text-sm min-w-0 truncate">
                      <SafeName name={c.name} />
                    </span>
                    <input
                      type="checkbox"
                      aria-label={c.name}
                      checked={toAdd.has(c.userId)}
                      onChange={() =>
                        setToAdd(s => {
                          const n = new Set(s);
                          if (n.has(c.userId)) n.delete(c.userId);
                          else n.add(c.userId);
                          return n;
                        })
                      }
                    />
                  </label>
                </li>
              ))}
            </ul>
          )}
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
