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
import type {
  GroupMessage,
  GroupSummary,
  GroupTimelineItem,
} from '@massalabs/gossip-sdk';
import DiscussionLayout from '../components/ui/Layout/DiscussionLayout';
import HeaderBar from '../components/ui/HeaderBar';
import BackButton from '../components/ui/BackButton';
import Button from '../components/ui/Button';
import BaseModal from '../components/ui/BaseModal';
import FormInput from '../components/ui/FormInput';
import MessageInput from '../components/discussions/MessageInput';
import GroupMessageItem from '../components/groups/GroupMessageItem';
import {
  composerBlockedReason,
  isTooLargeError,
  messageText,
} from '../utils/groupTimeline';
import GroupTimelineLine from '../components/groups/GroupTimelineLine';
import ArchivePrefix from '../components/groups/ArchivePrefix';
import EarlierChats from '../components/groups/EarlierChats';
import ContinuationPrompt from '../components/groups/ContinuationPrompt';
import { useDiscussionStore } from '../stores/discussionStore';
import SafeName from '../components/groups/SafeName';
import AutoDeleteChip from '../components/ui/AutoDeleteChip';
import { messageTimerLabel } from '../constants/messageTimer';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useAccountStore } from '../stores/accountStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { groupDisplayName } from '../utils/groupName';
import { nearByteLimit, utf8Bytes } from '../utils/textBytes';
import { ROUTES } from '../constants/routes';

/** What the input shows of a group message being replied to or edited. */
interface InputTarget {
  content: string;
  id?: number;
  message: GroupMessage;
}

/**
 * A message sent from this screen and not yet read back from the engine's
 * timeline (D5). It lives in this component only: nothing is stored or sent
 * because of it, and it is gone when the screen is left.
 */
interface Sending {
  n: number;
  text: string;
  reply: GroupMessage | null;
  at: bigint;
  /** Its id, once `sendMessage` gave it. */
  id?: string;
  /** How many timeline reads had started when `sendMessage` resolved. */
  readsAtResolve?: number;
}

/**
 * The rows still to show once the timeline read `read` gave `items`, so that
 * the real message replaces its row in the same render. A sent row goes when
 * its id is in the timeline, or at the latest with the first read started
 * after the send resolved (that read sees what the send recorded). A row not
 * resolved yet goes when the timeline already shows an own message with its
 * text that was not there before (`claimed`) and no other row took.
 */
function stillSending(
  rows: Sending[],
  items: GroupTimelineItem[],
  read: number,
  me: string | undefined,
  claimed: Set<string>
): Sending[] {
  if (rows.length === 0) return rows;
  const ids = new Set<string>();
  for (const i of items) if (i.kind === 'message') ids.add(i.syncObjId);
  const taken = new Set(claimed);
  for (const r of rows) if (r.id !== undefined) taken.add(r.id);
  return rows.filter(r => {
    if (r.id !== undefined) {
      return !ids.has(r.id) && read <= (r.readsAtResolve ?? Infinity);
    }
    const shown = items.find(
      i =>
        i.kind === 'message' &&
        i.author === me &&
        !taken.has(i.syncObjId) &&
        i.body.type === 'text' &&
        i.body.text === r.text
    );
    if (!shown || shown.kind !== 'message') return true;
    taken.add(shown.syncObjId);
    return false;
  });
}

type Confirm =
  | { kind: 'deleteEveryone'; message: GroupMessage }
  | { kind: 'deleteLocally'; message: GroupMessage }
  | { kind: 'editLocally'; message: GroupMessage; text: string }
  | null;

/**
 * The text of a local-only edit. Over `maxBytes` it says so and cannot be
 * saved, and the text stays as typed or pasted.
 */
const LocalEdit: React.FC<{
  text: string;
  maxBytes?: number;
  onChange: (text: string) => void;
  onSave: () => void;
  onCancel: () => void;
}> = ({ text, maxBytes, onChange, onSave, onCancel }) => {
  const { t } = useTranslation('groups');
  const bytes = utf8Bytes(text);
  const tooLong = maxBytes !== undefined && bytes > maxBytes;
  const near = maxBytes !== undefined && nearByteLimit(bytes, maxBytes);
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t('message_menu.edit_locally_body')}
      </p>
      <FormInput
        id="local-edit"
        type="textarea"
        value={text}
        onChange={onChange}
        error={tooLong ? t('composer.edit_too_long') : null}
        helperText={
          near
            ? t('discussions:message_input.size_counter', {
                used: bytes,
                max: maxBytes,
              })
            : undefined
        }
      />
      <div className="flex gap-3">
        <Button
          variant="primary"
          size="custom"
          className="flex-1 h-11 rounded-lg font-semibold"
          disabled={tooLong}
          onClick={onSave}
        >
          {t('common:save')}
        </Button>
        <Button
          variant="secondary"
          size="custom"
          className="flex-1 h-11 rounded-lg font-semibold"
          onClick={onCancel}
        >
          {t('choices.cancel')}
        </Button>
      </div>
    </div>
  );
};

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
  const allGroups = useGroupStore(s => s.groups);
  // The group of each epoch held, for the quotes of another group.
  const groupOfEpoch = useMemo(() => {
    const m = new Map<string, GroupSummary>();
    for (const { summary } of allGroups) {
      m.set(summary.groupId, summary);
      m.set(summary.currentEpoch, summary);
      for (const e of summary.timers) m.set(e.epochId, summary);
    }
    return m;
  }, [allGroups]);
  // A replaced chat of two opens the chat that continues it (§5.12).
  const supersededBy = useGroupStore(s => s.supersededBy[groupId]);
  // Another person's new chat that continues this one, to answer here.
  const continuation = useGroupStore(s =>
    s.invitations.find(i => i.continues === groupId)
  );
  // The earlier one-to-one conversation this direct chat continues (§5.12).
  const archivePeer = useDiscussionStore(
    s => s.discussions.find(d => d.linkedGroupId === groupId)?.contactUserId
  );
  const setCurrentGroup = useGroupStore(s => s.setCurrentGroup);
  const [replyingTo, setReplyingTo] = useState<InputTarget | null>(null);
  const [editing, setEditing] = useState<InputTarget | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  // The text of a send that failed, put back in a fresh composer (`n` keys it).
  const [draft, setDraft] = useState<{ text: string; n: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const [sending, setSending] = useState<Sending[]>([]);
  const sent = useRef(0);
  const reads = useRef(0);
  // The own messages the timeline already showed, or a send returned: a row
  // still sending is never matched with one of them.
  const claimed = useRef<Set<string> | null>(null);

  useEffect(() => {
    setCurrentGroup(groupId);
    return () => setCurrentGroup(null);
  }, [groupId, setCurrentGroup]);

  useEffect(() => {
    if (supersededBy) {
      navigate(ROUTES.group({ groupId: supersededBy }), { replace: true });
    }
  }, [supersededBy, navigate]);

  const [timeline, setTimeline] = useState<GroupTimelineItem[]>([]);
  useEffect(() => {
    let alive = true;
    const read = ++reads.current;
    getGroupService()
      ?.timeline(groupId)
      .then(items => {
        if (!alive) return;
        const shown = items.flatMap(i =>
          i.kind === 'message' ? [i.syncObjId] : []
        );
        // The first read only tells what was there before any send.
        const before = new Set(claimed.current ?? shown);
        claimed.current = new Set([...before, ...shown]);
        setTimeline(items);
        setSending(rows => stillSending(rows, items, read, me, before));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [groupId, version, me]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [timeline.length, sending.length]);

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
      } catch (e) {
        toast.error(
          isTooLargeError(e) ? t('composer.too_long') : t('message_menu.failed')
        );
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
  // A chat of two the other person left still names that person.
  const title = groupDisplayName(
    group,
    memberName,
    me,
    archivePeer ? memberName(archivePeer) : t('invitation.unnamed')
  );
  const maxTextBytes = service?.messageLimits.textBytes;
  const target = (m: GroupMessage): InputTarget => ({
    content: messageText(m, t),
    message: m,
  });

  // Tapping an emoji adds this account's reaction, or removes it if it is there.
  const toggleReaction = (m: GroupMessage, emoji: string) => {
    if (!service) return;
    const mine = m.reactions.some(r => r.emoji === emoji && r.mine);
    void run(() =>
      mine
        ? service.unreact(group.groupId, m.syncObjId, emoji)
        : service.react(group.groupId, m.syncObjId, emoji)
    );
  };

  const send = (text: string) => {
    if (!service) return;
    const reply = replyingTo?.message ?? null;
    setReplyingTo(null);
    const n = ++sent.current;
    setSending(rows => [...rows, { n, text, reply, at: BigInt(Date.now()) }]);
    void service
      .sendMessage(group.groupId, text, {
        replyTo: reply
          ? [{ epochId: reply.epochId, syncObjId: reply.syncObjId }]
          : undefined,
      })
      .then(
        ({ syncObjId }) => {
          claimed.current?.add(syncObjId);
          const readsAtResolve = reads.current;
          setSending(rows =>
            rows.map(r =>
              r.n === n ? { ...r, id: syncObjId, readsAtResolve } : r
            )
          );
          refresh();
        },
        (e: unknown) => {
          setSending(rows => rows.filter(r => r.n !== n));
          // The composer was cleared on send: give the text back, after
          // what was typed since, so that nothing typed is lost.
          const typed =
            composerRef.current?.querySelector('textarea')?.value ?? '';
          const back = typed.trim() ? `${typed}\n${text}` : text;
          setDraft(d => ({ text: back, n: (d?.n ?? 0) + 1 }));
          toast.error(
            isTooLargeError(e)
              ? t('composer.too_long')
              : t('message_menu.failed')
          );
        }
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
            {group.status === 'member' || group.status === 'waiting'
              ? t('list.members_count', { count: group.members.length })
              : // Removed, left or dissolved: the member list is the one of
                // the last epoch held, no longer the group's.
                t(`details.status_${group.status}`)}
          </p>
          {group.messageTimer > 0 && (
            // The current timer (§7.7), as the earlier one-to-one header
            // shows its retention.
            <div className="flex min-w-0">
              <AutoDeleteChip
                duration={messageTimerLabel(group.messageTimer, t)}
                testId="group-timer-chip"
              />
            </div>
          )}
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

  const composer = canWrite ? (
    <div ref={composerRef} className="contents">
      <MessageInput
        key={draft?.n ?? 0}
        initialValue={draft?.text}
        onSend={send}
        // A chat of two is no "group" to its users.
        placeholderKey={
          group.members.length === 2 ? undefined : 'groups:composer.placeholder'
        }
        maxBytes={maxTextBytes}
        onTooLong={() => toast.error(t('composer.too_long'))}
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
    </div>
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
  const footer = continuation ? (
    <>
      <ContinuationPrompt invitation={continuation} />
      {composer}
    </>
  ) : (
    composer
  );

  return (
    <DiscussionLayout header={header} footer={footer}>
      <div
        ref={scrollRef}
        className="h-full overflow-y-auto py-3"
        data-testid="group-timeline"
      >
        {archivePeer && <ArchivePrefix contactUserId={archivePeer} />}
        <EarlierChats
          earlier={group.earlier}
          me={me}
          memberName={memberName}
          version={version}
        />
        {timeline.length === 0 &&
          sending.length === 0 &&
          !archivePeer &&
          group.earlier.length === 0 && (
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
              // The target as the SDK read it from its own timeline, in this
              // chat or another; shown once the device holds it, never asked
              // for because it is displayed.
              replyPreviews={item.replyTo.map(r => {
                const m =
                  r.message ??
                  (r.epochId
                    ? byKey.get(`${r.epochId}:${r.syncObjId}`)
                    : undefined);
                return m ? messageText(m, t) : null;
              })}
              // "in <group>" for a quote of another group (§7.6).
              replyGroups={item.replyTo.map(r => {
                const other = r.epochId ? groupOfEpoch.get(r.epochId) : null;
                return other && other.groupId !== groupId
                  ? groupDisplayName(
                      other,
                      memberName,
                      me,
                      t('invitation.unnamed')
                    )
                  : null;
              })}
              canWrite={canWrite}
              memberName={memberName}
              onToggleReaction={toggleReaction}
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
        {sending.map(r => (
          <GroupMessageItem
            key={`sending-${r.n}`}
            sending
            message={{
              kind: 'message',
              epochId: '',
              syncObjId: '',
              author: me ?? '',
              createdAt: r.at,
              lastModifiedAt: r.at,
              edited: false,
              body: { type: 'text', text: r.text },
              metadata: {},
              replyTo: [],
              reactions: [],
            }}
            isOutgoing
            authorName=""
            replyPreviews={r.reply ? [messageText(r.reply, t)] : []}
            canWrite={false}
          />
        ))}
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
          <LocalEdit
            text={confirm.text}
            maxBytes={maxTextBytes}
            onChange={text => setConfirm({ ...confirm, text })}
            onSave={() => {
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
            onCancel={() => setConfirm(null)}
          />
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
