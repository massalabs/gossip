import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Info, Users } from 'react-feather';
import type { GroupMessage, GroupTimelineItem } from '@massalabs/gossip-sdk';
import DiscussionLayout from '../components/ui/Layout/DiscussionLayout';
import HeaderBar from '../components/ui/HeaderBar';
import BackButton from '../components/ui/BackButton';
import Button from '../components/ui/Button';
import BaseModal from '../components/ui/BaseModal';
import FormInput from '../components/ui/FormInput';
import MessageInput from '../components/discussions/MessageInput';
import GroupMessageItem from '../components/groups/GroupMessageItem';
import { composerBlockedReason, messageText } from '../utils/groupTimeline';
import GroupTimelineLine from '../components/groups/GroupTimelineLine';
import SafeName from '../components/groups/SafeName';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useAccountStore } from '../stores/accountStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { groupDisplayName } from '../utils/groupName';
import { ROUTES } from '../constants/routes';

/** What the input shows of a group message being replied to or edited. */
interface InputTarget {
  content: string;
  id?: number;
  message: GroupMessage;
}

type Confirm =
  | { kind: 'deleteEveryone'; message: GroupMessage }
  | { kind: 'deleteLocally'; message: GroupMessage }
  | { kind: 'editLocally'; message: GroupMessage; text: string }
  | null;

const GroupDiscussionInner: React.FC<{ groupId: string }> = ({ groupId }) => {
  const { t } = useTranslation('groups');
  const navigate = useNavigate();
  const me = useAccountStore(s => s.userProfile?.userId);
  const memberName = useGroupMemberName();
  const version = useGroupStore(s => s.version);
  const entry = useGroupStore(s =>
    s.groups.find(g => g.summary.groupId === groupId)
  );
  const refresh = useGroupStore(s => s.refresh);
  const setCurrentGroup = useGroupStore(s => s.setCurrentGroup);
  const [replyingTo, setReplyingTo] = useState<InputTarget | null>(null);
  const [editing, setEditing] = useState<InputTarget | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentGroup(groupId);
    return () => setCurrentGroup(null);
  }, [groupId, setCurrentGroup]);

  const timeline: GroupTimelineItem[] = useMemo(() => {
    void version;
    try {
      return getGroupService()?.timeline(groupId) ?? [];
    } catch {
      return [];
    }
  }, [groupId, version]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length]);

  const byKey = useMemo(() => {
    const map = new Map<string, GroupMessage>();
    for (const item of timeline) {
      if (item.kind === 'message') {
        map.set(`${item.epochId}:${item.syncObjId}`, item);
      }
    }
    return map;
  }, [timeline]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        refresh();
        if (ok) toast.success(ok);
      } catch {
        toast.error(t('message_menu.failed'));
      }
    },
    [refresh, t]
  );

  const group = entry?.summary;
  if (!group) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm text-muted-foreground">
          {t('details.not_found')}
        </p>
        <Button
          onClick={() => navigate(ROUTES.discussions())}
          variant="secondary"
        >
          {t('common:back')}
        </Button>
      </div>
    );
  }

  const service = getGroupService();
  const blocked = composerBlockedReason(group);
  const canWrite = blocked === null;
  const title = groupDisplayName(group, memberName, me);
  const target = (m: GroupMessage): InputTarget => ({
    content: messageText(m, t),
    message: m,
  });

  const send = (text: string) => {
    if (!service) return;
    const reply = replyingTo?.message;
    setReplyingTo(null);
    void run(() =>
      service.sendMessage(group.groupId, text, {
        replyTo: reply
          ? [{ epochId: reply.epochId, syncObjId: reply.syncObjId }]
          : undefined,
      })
    );
  };

  const header = (
    <HeaderBar>
      <div className="flex items-center gap-3 w-full min-w-0">
        <BackButton onClick={() => navigate(ROUTES.discussions())} />
        <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
          <Users className="w-5 h-5 text-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-foreground truncate">
            <SafeName name={title} />
          </h1>
          <p className="text-xs text-muted-foreground">
            {t('list.members_count', { count: group.members.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(ROUTES.groupSettings({ groupId }))}
          aria-label={t('details.title')}
          title={t('details.title')}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:opacity-70"
        >
          <Info className="w-5 h-5 text-accent-soft-foreground" />
        </button>
      </div>
    </HeaderBar>
  );

  const footer = canWrite ? (
    <MessageInput
      onSend={send}
      placeholderKey="groups:composer.placeholder"
      replyingTo={replyingTo}
      onCancelReply={() => setReplyingTo(null)}
      editingMessage={editing}
      onCancelEdit={() => setEditing(null)}
      onConfirmEdit={(text, m) => {
        setEditing(null);
        if (!service) return;
        void run(() =>
          service.editMessage(m.message.epochId, m.message.syncObjId, text)
        );
      }}
    />
  ) : (
    <div
      className="bg-card border-t border-border px-4 py-4 text-center text-sm text-muted-foreground"
      role="status"
      data-testid="composer-blocked"
    >
      <p>{t(blocked)}</p>
      {group.mustResolve && (
        <Button
          onClick={() => navigate(ROUTES.groupSettings({ groupId }))}
          variant="link"
          className="mt-1"
        >
          {t('details.resolve_open')}
        </Button>
      )}
    </div>
  );

  return (
    <DiscussionLayout header={header} footer={footer}>
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto py-3"
        data-testid="group-timeline"
      >
        {timeline.length === 0 && (
          <p className="text-center text-sm text-muted-foreground mt-8">
            {t('timeline.empty')}
          </p>
        )}
        {timeline.map((item, i) =>
          item.kind === 'line' ? (
            <GroupTimelineLine
              key={`line-${i}`}
              line={item.line}
              memberName={memberName}
            />
          ) : (
            <GroupMessageItem
              key={`${item.epochId}:${item.syncObjId}`}
              message={item}
              isOutgoing={item.author === me}
              authorName={memberName(item.author)}
              replyPreviews={item.replyTo.map(r => {
                const m = r.epochId
                  ? byKey.get(`${r.epochId}:${r.syncObjId}`)
                  : undefined;
                return m ? messageText(m, t) : null;
              })}
              canWrite={canWrite}
              onReply={m => {
                setEditing(null);
                setReplyingTo(target(m));
              }}
              onCopy={m => {
                void navigator.clipboard
                  ?.writeText(messageText(m, t))
                  .then(() => toast.success(t('message_menu.copied')))
                  .catch(() => {});
              }}
              onEdit={m => {
                setReplyingTo(null);
                setEditing(target(m));
              }}
              onDeleteForEveryone={m =>
                setConfirm({ kind: 'deleteEveryone', message: m })
              }
              onEditLocally={m =>
                setConfirm({
                  kind: 'editLocally',
                  message: m,
                  text: messageText(m, t),
                })
              }
              onDeleteLocally={m =>
                setConfirm({ kind: 'deleteLocally', message: m })
              }
              onRetry={m =>
                service &&
                void run(
                  () => service.retryMessage(m.epochId, m.syncObjId),
                  t('message_menu.retried')
                )
              }
            />
          )
        )}
      </div>
      <BaseModal
        isOpen={
          confirm?.kind === 'deleteEveryone' ||
          confirm?.kind === 'deleteLocally'
        }
        onClose={() => setConfirm(null)}
        title={
          confirm?.kind === 'deleteLocally'
            ? t('message_menu.delete_locally_title')
            : t('message_menu.delete_confirm_title')
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-foreground">
            {confirm?.kind === 'deleteLocally'
              ? t('message_menu.delete_locally_body')
              : t('message_menu.delete_confirm_body')}
          </p>
          <div className="flex gap-3">
            <Button
              variant="danger"
              size="custom"
              className="flex-1 h-11 rounded-lg font-semibold"
              onClick={() => {
                const c = confirm;
                setConfirm(null);
                if (!c || !service || c.kind === 'editLocally') return;
                const { epochId, syncObjId } = c.message;
                void run(() =>
                  c.kind === 'deleteLocally'
                    ? service.deleteMessageLocally(epochId, syncObjId)
                    : service.deleteMessage(epochId, syncObjId)
                );
              }}
            >
              {t('choices.confirm')}
            </Button>
            <Button
              variant="secondary"
              size="custom"
              className="flex-1 h-11 rounded-lg font-semibold"
              onClick={() => setConfirm(null)}
            >
              {t('choices.cancel')}
            </Button>
          </div>
        </div>
      </BaseModal>
      <BaseModal
        isOpen={confirm?.kind === 'editLocally'}
        onClose={() => setConfirm(null)}
        title={t('message_menu.edit_locally_title')}
      >
        {confirm?.kind === 'editLocally' && (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {t('message_menu.edit_locally_body')}
            </p>
            <FormInput
              id="local-edit"
              type="textarea"
              value={confirm.text}
              onChange={text => setConfirm({ ...confirm, text })}
            />
            <div className="flex gap-3">
              <Button
                variant="primary"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
                onClick={() => {
                  const c = confirm;
                  setConfirm(null);
                  if (!service) return;
                  void run(() =>
                    service.editMessageLocally(
                      c.message.epochId,
                      c.message.syncObjId,
                      {
                        body: { type: 'text', text: c.text },
                      }
                    )
                  );
                }}
              >
                {t('common:save')}
              </Button>
              <Button
                variant="secondary"
                size="custom"
                className="flex-1 h-11 rounded-lg font-semibold"
                onClick={() => setConfirm(null)}
              >
                {t('choices.cancel')}
              </Button>
            </div>
          </div>
        )}
      </BaseModal>
    </DiscussionLayout>
  );
};

/** Keyed by group, like `Discussion`, so compose state never leaks across groups. */
const GroupDiscussion: React.FC = () => {
  const { groupId } = useParams();
  if (!groupId) return null;
  return <GroupDiscussionInner key={groupId} groupId={groupId} />;
};

export default GroupDiscussion;
