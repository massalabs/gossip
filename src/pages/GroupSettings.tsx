import React, { useMemo, useState } from 'react';
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
import LeaveGroupSheet, {
  type LeaveAction,
} from '../components/groups/LeaveGroupSheet';
import ResolveForkPanel from '../components/groups/ResolveForkPanel';
import { useGossipSdk } from '../hooks/useGossipSdk';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useAccountStore } from '../stores/accountStore';
import { useDiscussionStore } from '../stores/discussionStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { ROUTES } from '../constants/routes';
import { GROUP_NAME_MAX_BYTES } from './NewGroup';

type Modal =
  | { kind: 'localName' }
  | { kind: 'rename' }
  | { kind: 'add' }
  | { kind: 'transfer' }
  | { kind: 'remove'; member: string }
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
 * Group details (§5.11 names, members, owner) with the owner's tools (add,
 * remove, rename, transfer, the §5.8 popup, the §4.9 resolution) and the
 * member's tools (leave with its choices, delete locally, retry).
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
  const service = getGroupService();

  const ownedEnds: GroupEpoch[] = useMemo(() => {
    if (!group?.mustResolve || !service) return [];
    return [group.currentEpoch, ...group.sideBranches]
      .map(e => service.epoch(e))
      .filter((e): e is GroupEpoch => !!e && e.owner === me);
  }, [group, service, me]);

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
  const others = group.members.filter(m => m !== me);
  const addable = contacts.filter(
    c =>
      !group.members.includes(c.userId) &&
      gossip.discussions.getStatus(c.userId) === SessionStatus.Active
  );

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

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <Row label={t('details.your_name')}>
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">
              <SafeName
                name={group.localName ?? ''}
                fallback={t('details.not_set')}
              />
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={() => setModal({ kind: 'localName' })}
            >
              {t('details.set_name')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {t('details.your_name_hint')}
          </p>
        </Row>
        <Row label={t('details.group_name')}>
          <SafeName name={group.name} fallback={t('details.not_set')} />
        </Row>
        <Row label={t('details.owner')}>
          <SafeName name={memberName(group.owner)} />
        </Row>
        <Row label={t('details.status')}>
          {t(`details.status_${group.status}`)}
        </Row>
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
              {isOwner && active && m !== me && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setModal({ kind: 'remove', member: m })}
                >
                  {t('details.remove')}
                </Button>
              )}
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
          <ActionButton
            icon={<Edit2 className="w-4 h-4" />}
            label={t('details.rename')}
            onClick={() => setModal({ kind: 'rename' })}
          />
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

      <ContactNameModal
        isOpen={modal?.kind === 'localName'}
        onClose={() => setModal(null)}
        title={t('details.your_name')}
        initialName={group.localName ?? ''}
        confirmLabel={t('common:save')}
        allowEmpty
        onConfirm={name => {
          setModal(null);
          void run(() => service.setLocalName(groupId, name?.trim() || null));
        }}
      />
      <ContactNameModal
        isOpen={modal?.kind === 'rename'}
        onClose={() => setModal(null)}
        title={t('details.rename_title')}
        initialName={group.name}
        confirmLabel={t('common:save')}
        allowEmpty
        onConfirm={name => {
          const next = name?.trim() ?? '';
          if (new TextEncoder().encode(next).length > GROUP_NAME_MAX_BYTES) {
            toast.error(t('new_group.name_too_long'));
            return;
          }
          setModal(null);
          void run(() => service.changeMembers(groupId, { name: next }));
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
                <li
                  key={c.userId}
                  className="flex items-center justify-between py-2 gap-2"
                >
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
