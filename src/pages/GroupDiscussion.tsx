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
import GroupComposer, {
  type InputTarget,
  type Scope,
} from '../components/groups/GroupComposer';
import GroupMessageItem, {
  type ReplyQuote,
} from '../components/groups/GroupMessageItem';
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
import ConfirmSheet from '../components/groups/ConfirmSheet';
import AutoDeleteChip from '../components/ui/AutoDeleteChip';
import { messageTimerLabel } from '../constants/messageTimer';
import { useGroupMemberName } from '../hooks/useGroupMemberName';
import { useAccountStore } from '../stores/accountStore';
import { getGroupService, useGroupStore } from '../stores/groupStore';
import { groupDisplayName, isolate } from '../utils/groupName';
import { ROUTES } from '../constants/routes';

/** How long a new message glows once it comes into view, in ms. */
const GLOW_MS = 1200;

/**
 * A message sent from this screen and not yet read back from the engine's
 * timeline (D5). It lives in this component only: nothing is stored or sent
 * because of it, and it is gone when the screen is left.
 */
interface Sending {
  n: number;
  text: string;
  /** The author it is sent under: the user, or the member chosen. */
  author: string;
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
 * resolved yet goes when the timeline already shows a message by its author
 * with its text that was not there before (`claimed`) and no other row took.
 */
function stillSending(
  rows: Sending[],
  items: GroupTimelineItem[],
  read: number,
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
        i.author === r.author &&
        !taken.has(i.syncObjId) &&
        i.body.type === 'text' &&
        i.body.text === r.text
    );
    if (!shown || shown.kind !== 'message') return true;
    taken.add(shown.syncObjId);
    return false;
  });
}

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
  // What was typed before an edit filled the text box, given back after it.
  const typedBeforeEdit = useRef('');
  // The message whose deletion asks for whom.
  const [deleting, setDeleting] = useState<GroupMessage | null>(null);
  // The message whose "Retry synchronisation" waits for the warning's answer.
  const [retrying, setRetrying] = useState<GroupMessage | null>(null);
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
  // The message briefly marked after a tap on a quote of it.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // New messages of others not seen yet on this device, and those glowing
  // because they just came into view (K). Memory only: see `markSeen`.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [glowing, setGlowing] = useState<ReadonlySet<string>>(new Set());
  const glowTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      for (const timer of glowTimers.current) clearTimeout(timer);
    },
    []
  );

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
        // What is new to this screen: the messages of others not seen here
        // yet. At the first opening in this run nothing is known to be new
        // (the unread state is per chat, not per message), so all is seen.
        const store = useGroupStore.getState();
        const keys = items.flatMap(i =>
          i.kind === 'message' ? [`${i.epochId}:${i.syncObjId}`] : []
        );
        const seenBefore = store.seenOf(groupId);
        if (!seenBefore) {
          store.markSeen(groupId, keys);
        } else {
          const own = items.flatMap(i =>
            i.kind === 'message' && i.author === me
              ? [`${i.epochId}:${i.syncObjId}`]
              : []
          );
          store.markSeen(groupId, own);
          setFresh(new Set(keys.filter(k => !seenBefore.has(k))));
        }
        setTimeline(items);
        setSending(rows => stillSending(rows, items, read, before));
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

  // A new message is seen when it comes into view: it glows a moment, and
  // is recorded as seen in memory. Nothing else happens: no read receipt
  // exists, nothing is sent or stored.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || fresh.size === 0) return;
    const seenNow = (keys: string[]) => {
      if (keys.length === 0) return;
      useGroupStore.getState().markSeen(groupId, keys);
      setFresh(f => new Set([...f].filter(k => !keys.includes(k))));
      setGlowing(g => new Set([...g, ...keys]));
      glowTimers.current.push(
        setTimeout(
          () => setGlowing(g => new Set([...g].filter(k => !keys.includes(k)))),
          GLOW_MS
        )
      );
    };
    const targets = Array.from(
      root.querySelectorAll<HTMLElement>('[data-fresh]')
    );
    if (typeof IntersectionObserver === 'undefined') {
      // No way to know what is in view: seen at once, without a glow.
      useGroupStore.getState().markSeen(
        groupId,
        targets.map(e => e.dataset.fresh ?? '')
      );
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        const keys: string[] = [];
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const key = (e.target as HTMLElement).dataset.fresh;
          if (key) keys.push(key);
          observer.unobserve(e.target);
        }
        seenNow(keys);
      },
      { root, threshold: 0.6 }
    );
    for (const el of targets) observer.observe(el);
    return () => observer.disconnect();
  }, [fresh, groupId]);

  const jumpTo = (key: string) => {
    const el = Array.from(
      scrollRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? []
    ).find(e => e.dataset.key === key);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    setHighlighted(key);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlighted(null), 1500);
  };

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
  // A chat this device can only read (left, removed, dissolved and kept)
  // still takes new messages written on this device only (product owner,
  // 2026-11-27, for plausible deniability): the composer stays, with "only
  // for me" as its one scope. Nothing marks such a message, anywhere.
  const writesLocally =
    group.status === 'left' ||
    group.status === 'removed' ||
    group.status === 'dissolved';
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

  /** The text in the text box now. */
  const typed = () =>
    composerRef.current?.querySelector('textarea')?.value ?? '';
  const putInComposer = (text: string) =>
    setDraft(d => ({ text, n: (d?.n ?? 0) + 1 }));

  const startEdit = (m: GroupMessage) => {
    setReplyingTo(null);
    if (!editing) typedBeforeEdit.current = typed();
    const t0 = target(m);
    setEditing(t0);
    putInComposer(t0.content);
  };
  const endEdit = () => {
    setEditing(null);
    putInComposer(typedBeforeEdit.current);
    typedBeforeEdit.current = '';
  };

  const send = (text: string, options: { author: string; scope: Scope }) => {
    if (!service) return;
    const reply = replyingTo?.message ?? null;
    setReplyingTo(null);
    const n = ++sent.current;
    const { author, scope } = options;
    setSending(rows => [
      ...rows,
      { n, text, author, reply, at: BigInt(Date.now()) },
    ]);
    const sendOptions = {
      replyTo: reply
        ? [{ epochId: reply.epochId, syncObjId: reply.syncObjId }]
        : undefined,
      author: author === me ? undefined : author,
    };
    // "Only for me": stored on this device only, nothing sent. Nothing in the
    // app remembers which messages were sent so: once shown, it is a message
    // like any other (no label, no mark, no stored flag).
    void (
      scope === 'me'
        ? service.sendMessageLocally(group.groupId, text, sendOptions)
        : service.sendMessage(group.groupId, text, sendOptions)
    ).then(
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
        const now = typed();
        putInComposer(now.trim() ? `${now}\n${text}` : text);
        toast.error(
          isTooLargeError(e) ? t('composer.too_long') : t('message_menu.failed')
        );
      }
    );
  };

  /**
   * The quotes of a reply (G): the target as the SDK read it from its own
   * timeline, in this chat or another, shown once the device holds it and
   * never asked for because it is displayed. A target in an epoch this device
   * lacks has no quote (the protocol cannot say what it was); one held but
   * not shown (deleted, or not received yet) says it is not available.
   */
  const quotesOf = (item: GroupMessage): ReplyQuote[] =>
    item.replyTo.flatMap(r => {
      if (!r.epochId) return [];
      const key = `${r.epochId}:${r.syncObjId}`;
      const m = r.message ?? byKey.get(key) ?? null;
      const other = groupOfEpoch.get(r.epochId);
      const elsewhere = !!other && other.groupId !== groupId;
      return [
        {
          author: m ? memberName(m.author) : null,
          authorId: m?.author,
          text: m ? messageText(m, t) : null,
          // "in <chat>" for a quote of another chat (§7.6).
          group: elsewhere
            ? groupDisplayName(other, memberName, me, t('invitation.unnamed'))
            : null,
          onJump:
            m && !elsewhere && byKey.has(key) ? () => jumpTo(key) : undefined,
        },
      ];
    });

  const header = (
    <HeaderBar>
      <div className="flex items-center gap-3 w-full min-w-0">
        <BackButton onClick={() => navigate(ROUTES.discussions())} />
        {/* The whole title area opens the chat's settings (I). */}
        <button
          type="button"
          onClick={() => navigate(ROUTES.groupSettings({ groupId }))}
          aria-label={t('details.open_settings', { name: isolate(title) })}
          className="flex-1 min-w-0 flex items-center gap-3 text-left rounded-lg hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="group-header-title"
        >
          <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <span
              role="heading"
              aria-level={1}
              className="block text-base font-semibold text-foreground truncate"
            >
              <SafeName name={title} />
            </span>
            <span className="block text-xs text-muted-foreground">
              {group.status === 'member' || group.status === 'waiting'
                ? t('list.members_count', { count: group.members.length })
                : // Removed, left or dissolved: the member list is the one of
                  // the last epoch held, no longer the group's.
                  t(`details.status_${group.status}`)}
            </span>
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
        </button>
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

  // A read-only chat keeps the composer for this device only, the one scope
  // left to it: new messages and edits stay here, nothing is sent.
  const composer =
    canWrite || writesLocally || editing ? (
      <div ref={composerRef} className="contents">
        {!canWrite && (
          <p
            className="bg-card border-t border-border px-4 pt-2 text-center text-xs text-muted-foreground"
            role="status"
            data-testid="composer-local-only"
          >
            {t('composer.local_only_line')}
          </p>
        )}
        <GroupComposer
          me={me ?? ''}
          members={group.members}
          memberName={memberName}
          canChooseAuthor
          canSendLocally
          localOnly={!canWrite}
          draft={draft}
          // A chat of two is no "group" to its users.
          placeholderKey={
            group.members.length === 2
              ? undefined
              : 'groups:composer.placeholder'
          }
          maxBytes={maxTextBytes}
          onTooLong={() => toast.error(t('composer.too_long'))}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          editing={editing}
          onCancelEdit={endEdit}
          onSend={send}
          onEdit={(m, text, scope, author) => {
            setEditing(null);
            // What was typed before the edit comes back.
            if (typedBeforeEdit.current) putInComposer(typedBeforeEdit.current);
            typedBeforeEdit.current = '';
            if (!service) return;
            const { epochId, syncObjId } = m.message;
            // The author is sent only when it changes (§7.2).
            const newAuthor = author !== m.message.author ? author : undefined;
            // A local edit is stored like any other version: nothing marks
            // it, by design (it cannot be told apart from a normal edit).
            void run(() =>
              scope === 'me'
                ? service.editMessageLocally(epochId, syncObjId, {
                    body: { type: 'text', text },
                    author: newAuthor,
                  })
                : newAuthor
                  ? service.editMessage(epochId, syncObjId, text, {
                      author: newAuthor,
                    })
                  : service.editMessage(epochId, syncObjId, text)
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
            <div
              key={`${item.epochId}:${item.syncObjId}`}
              data-key={`${item.epochId}:${item.syncObjId}`}
              data-fresh={
                fresh.has(`${item.epochId}:${item.syncObjId}`)
                  ? `${item.epochId}:${item.syncObjId}`
                  : undefined
              }
            >
              <GroupMessageItem
                message={item}
                isOutgoing={item.author === me}
                authorName={memberName(item.author)}
                quotes={quotesOf(item)}
                // In every chat, a chat of two included (product owner,
                // 2026-11-27): a chat of two that looked different from the
                // others surprised its users.
                showAvatar
                runStart={(() => {
                  const prev = timeline[i - 1];
                  return !(
                    prev &&
                    prev.kind === 'message' &&
                    prev.author === item.author
                  );
                })()}
                highlighted={
                  highlighted === `${item.epochId}:${item.syncObjId}`
                }
                glow={glowing.has(`${item.epochId}:${item.syncObjId}`)}
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
                onEdit={startEdit}
                onDelete={setDeleting}
                onRetry={setRetrying}
              />
            </div>
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
              author: r.author,
              createdAt: r.at,
              lastModifiedAt: r.at,
              edited: false,
              body: { type: 'text', text: r.text },
              metadata: {},
              replyTo: [],
              reactions: [],
            }}
            isOutgoing={r.author === me}
            authorName={r.author === me ? '' : memberName(r.author)}
            quotes={
              r.reply
                ? [
                    {
                      author: memberName(r.reply.author),
                      text: messageText(r.reply, t),
                      group: null,
                    },
                  ]
                : []
            }
            canWrite={false}
          />
        ))}
      </div>
      {/*
        Always asked, on every message: whether a message was changed or
        created only on this device cannot be known, by construction (§9.4).
      */}
      <ConfirmSheet
        isOpen={retrying !== null}
        title={t('message_menu.retry_title')}
        body={t('message_menu.retry_body')}
        confirmLabel={t('message_menu.retry_confirm')}
        onClose={() => setRetrying(null)}
        onConfirm={() => {
          const m = retrying;
          setRetrying(null);
          if (!m || !service) return;
          void run(
            () => service.retryMessage(m.epochId, m.syncObjId),
            t('message_menu.retried')
          );
        }}
      />
      <BaseModal
        isOpen={deleting !== null}
        onClose={() => setDeleting(null)}
        title={t('message_menu.delete_title')}
      >
        <div className="space-y-3" data-testid="delete-confirm">
          {canWrite && (
            <div>
              <Button
                variant="danger"
                size="custom"
                className="w-full h-11 rounded-lg font-semibold"
                onClick={() => {
                  const m = deleting;
                  setDeleting(null);
                  if (!m || !service) return;
                  void run(() => service.deleteMessage(m.epochId, m.syncObjId));
                }}
              >
                {t('message_menu.delete_everyone')}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('message_menu.delete_confirm_body')}
              </p>
            </div>
          )}
          <div>
            <Button
              variant={canWrite ? 'outline' : 'danger'}
              size="custom"
              className={`w-full h-11 rounded-lg font-semibold ${canWrite ? 'text-destructive' : ''}`}
              onClick={() => {
                const m = deleting;
                setDeleting(null);
                if (!m || !service) return;
                void run(() =>
                  service.deleteMessageLocally(m.epochId, m.syncObjId)
                );
              }}
            >
              {t('message_menu.delete_on_device')}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('message_menu.delete_locally_body')}
            </p>
          </div>
          <Button
            variant="ghost"
            size="custom"
            className="w-full h-11 rounded-lg font-semibold"
            onClick={() => setDeleting(null)}
          >
            {t('choices.cancel')}
          </Button>
        </div>
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
