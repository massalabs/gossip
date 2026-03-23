import { create } from 'zustand';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  decodeUserId,
  SdkEventType,
} from '@massalabs/gossip-sdk';
import { createSelectors } from './utils/createSelectors';
import { useAccountStore } from './accountStore';
import { getSdk } from './sdkStore';

const POLL_INTERVAL_MS = 3000;
const EVENT_DEBOUNCE_MS = 30;
let optimisticIdCounter = 0;
let activeSendCount = 0;

// ── Helpers ────────────────────────────────────────────────────

const EMPTY_MESSAGES: Message[] = [];

/** Status ranking — never downgrade visually. */
const STATUS_RANK: Record<string, number> = {
  [MessageStatus.WAITING_SESSION]: 0,
  [MessageStatus.READY]: 1,
  [MessageStatus.SENT]: 2,
  [MessageStatus.DELIVERED]: 3,
  [MessageStatus.READ]: 4,
};

const _statusRank = (s: string): number => STATUS_RANK[s] ?? -1;

/**
 * Reliable mapping from optimistic id (negative) → real DB id.
 * Set when the SDK send returns; used by mergeMessages to match
 * optimistic messages to their DB counterparts without heuristics.
 */
const pendingToRealId = new Map<number, number>();

/**
 * Stable key for Virtuoso: maps message id → sequence number.
 * The sequence number is assigned once when the optimistic message is
 * created and transferred to the real id during the swap. This ensures
 * Virtuoso sees the same key across the id change, preventing
 * unmount/remount flicker.
 */
const clientSeq = new Map<number, number>();

/** Get a stable Virtuoso key for any message id. */
export const getStableKey = (msgId: number): string => {
  const seq = clientSeq.get(msgId);
  return seq != null ? `msg-seq-${seq}` : `msg-${msgId}`;
};

/**
 * Pure merge of confirmed (from polls) and optimistic (from sends) layers.
 *
 * Optimistic messages whose real id already appears in the confirmed list
 * are dropped — the confirmed version wins. Remaining optimistic messages
 * are appended and the result is sorted by timestamp.
 */
/**
 * Memoized merge cache — prevents creating a new array reference on
 * every getMessagesForContact() call, which would trigger infinite
 * re-renders via Zustand's useSyncExternalStore.
 */
const mergeCache = new Map<
  string,
  { confirmed: Message[]; optimistic: Message[]; result: Message[] }
>();

function mergeMessages(
  contactUserId: string,
  confirmed: Message[],
  optimistic: Message[]
): Message[] {
  // Fast path: no optimistic → return confirmed directly (stable ref)
  if (optimistic.length === 0) return confirmed;

  // Check cache: same inputs → same output (stable ref)
  const cached = mergeCache.get(contactUserId);
  if (
    cached &&
    cached.confirmed === confirmed &&
    cached.optimistic === optimistic
  ) {
    return cached.result;
  }

  const confirmedIds = new Set<number>();
  for (const m of confirmed) if (m.id != null) confirmedIds.add(m.id);

  const pending = optimistic.filter(opt => {
    const realId = pendingToRealId.get(opt.id!);
    if (realId != null && confirmedIds.has(realId)) return false;
    return true;
  });

  // All optimistic confirmed → return confirmed directly
  if (pending.length === 0) {
    mergeCache.set(contactUserId, { confirmed, optimistic, result: confirmed });
    return confirmed;
  }

  const result = [...confirmed, ...pending].sort(
    (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
  );
  mergeCache.set(contactUserId, { confirmed, optimistic, result });
  return result;
}

/** Field-level comparison for confirmed messages (avoids spurious re-renders). */
const confirmedChanged = (
  existing: Message[],
  incoming: Message[]
): boolean => {
  if (incoming.length !== existing.length) return true;
  return existing.some((msg, i) => {
    const other = incoming[i];
    return (
      msg.id !== other.id ||
      msg.content !== other.content ||
      msg.status !== other.status ||
      !!(msg.metadata as { edited?: boolean })?.edited !==
        !!(other.metadata as { edited?: boolean })?.edited
    );
  });
};

/** Field-level comparison for reactions (always new objects from DB). */
const reactionsChanged = (
  existing: Message[],
  incoming: Message[]
): boolean => {
  if (existing === incoming) return false;
  if (incoming.length !== existing.length) return true;
  return existing.some((msg, i) => {
    const other = incoming[i];
    if (!other) return true;
    return (
      msg.id !== other.id ||
      msg.content !== other.content ||
      msg.status !== other.status
    );
  });
};

// ── Store ──────────────────────────────────────────────────────

interface MessageStoreState {
  confirmedByContact: Map<string, Message[]>;
  optimisticByContact: Map<string, Message[]>;
  reactionsByContact: Map<string, Message[]>;
  currentContactUserId: string | null;
  isLoading: boolean;
  pollTimer: ReturnType<typeof setInterval> | null;
  eventHandler: (() => void) | null;
  cancelDebounce: (() => void) | null;
  isInitializing: boolean;

  init: () => Promise<void>;
  setCurrentContact: (contactUserId: string | null) => void;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
  ) => Promise<void>;
  getMessagesForContact: (contactUserId: string) => Message[];
  getReactionsForMessage: (
    contactUserId: string,
    messageDbId: number
  ) => ReactionGroup[];
  sendReaction: (
    contactUserId: string,
    emoji: string,
    messageDbId: number
  ) => void;
  removeReaction: (contactUserId: string, reactionDbId: number) => void;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
}

const useMessageStoreBase = create<MessageStoreState>((set, get) => ({
  confirmedByContact: new Map(),
  optimisticByContact: new Map(),
  reactionsByContact: new Map(),
  currentContactUserId: null,
  isLoading: false,
  pollTimer: null,
  eventHandler: null,
  cancelDebounce: null,
  isInitializing: false,

  setCurrentContact: (contactUserId: string | null) => {
    if (get().currentContactUserId === contactUserId) return;
    set({ currentContactUserId: contactUserId });
  },

  init: async () => {
    const { userProfile } = useAccountStore.getState();
    const ownerUserId = userProfile?.userId;

    if (!ownerUserId || get().pollTimer || get().isInitializing) return;

    set({ isInitializing: true });

    // ── Targeted fetch (active contact only) ─────────────────
    let isFetchingSingle = false;
    const fetchForContact = async (contactUserId: string) => {
      if (isFetchingSingle) return;
      isFetchingSingle = true;
      try {
        const sdk = getSdk();
        if (!sdk.isSessionOpen) return;

        const dbMessages = await sdk.messages.getVisibleMessages(contactUserId);

        // Clean up pendingToRealId + optimistic when DB confirms
        const dbIdSet = new Set<number>();
        for (const m of dbMessages) if (m.id != null) dbIdSet.add(m.id);
        const confirmedOptIds: number[] = [];
        for (const [optId, realId] of pendingToRealId) {
          if (dbIdSet.has(realId)) {
            pendingToRealId.delete(optId);
            confirmedOptIds.push(optId);
          }
        }

        const current =
          get().confirmedByContact.get(contactUserId) || EMPTY_MESSAGES;
        if (confirmedChanged(current, dbMessages)) {
          const newMap = new Map(get().confirmedByContact);
          newMap.set(contactUserId, dbMessages);
          set({ confirmedByContact: newMap });
        }

        // Clean up confirmed optimistic entries
        if (confirmedOptIds.length > 0) {
          set(state => {
            const opts = state.optimisticByContact.get(contactUserId);
            if (!opts) return state;
            const idSet = new Set(confirmedOptIds);
            const filtered = opts.filter(m => !idSet.has(m.id!));
            if (filtered.length === opts.length) return state;
            const newMap = new Map(state.optimisticByContact);
            if (filtered.length === 0) {
              newMap.delete(contactUserId);
            } else {
              newMap.set(contactUserId, filtered);
            }
            return { optimisticByContact: newMap };
          });
        }
      } catch (error) {
        console.error('Messages fetch error:', error);
      } finally {
        isFetchingSingle = false;
      }
    };

    // ── Full fetch (all contacts — polling fallback) ─────────
    let isFetching = false;
    const fetchAll = async () => {
      if (isFetching) return;
      isFetching = true;
      try {
        const sdk = getSdk();
        if (!sdk.isSessionOpen) return;

        const discussions = await sdk.discussions.list();
        const newConfirmedMap = new Map<string, Message[]>();
        const newReactionsMap = new Map<string, Message[]>();
        // Track which optimistic IDs were confirmed by this poll, per contact
        const confirmedOptByContact = new Map<string, number[]>();

        for (const d of discussions) {
          const dbMessages = await sdk.messages.getVisibleMessages(
            d.contactUserId
          );

          // Clean up pendingToRealId when DB has the real id
          const dbIdSet = new Set<number>();
          for (const m of dbMessages) if (m.id != null) dbIdSet.add(m.id);
          for (const [optId, realId] of pendingToRealId) {
            if (dbIdSet.has(realId)) {
              pendingToRealId.delete(optId);
              const list = confirmedOptByContact.get(d.contactUserId) || [];
              list.push(optId);
              confirmedOptByContact.set(d.contactUserId, list);
            }
          }

          if (dbMessages.length > 0) {
            newConfirmedMap.set(d.contactUserId, dbMessages);
          }
          const dbReactions = await sdk.messages.getReactions(d.contactUserId);
          // Preserve unconfirmed optimistic reactions (negative IDs)
          // so they survive the poll until the SDK call returns.
          const currentRxns =
            get().reactionsByContact.get(d.contactUserId) || [];
          const optimisticRxns = currentRxns.filter(
            r => r.id != null && r.id < 0
          );
          const reactions =
            optimisticRxns.length > 0
              ? [...dbReactions, ...optimisticRxns]
              : dbReactions;
          if (reactions.length > 0) {
            newReactionsMap.set(d.contactUserId, reactions);
          }
        }

        // Check messages and reactions independently — only update
        // what actually changed to avoid spurious re-renders.
        const latestMap = get().confirmedByContact;
        const currentReactionsMap = get().reactionsByContact;

        let msgsChanged = false;
        newConfirmedMap.forEach((msgs, cid) => {
          if (!msgsChanged) {
            const existing = latestMap.get(cid) || [];
            if (confirmedChanged(existing, msgs)) msgsChanged = true;
          }
        });
        if (!msgsChanged) {
          latestMap.forEach((_, cid) => {
            if (!newConfirmedMap.has(cid)) msgsChanged = true;
          });
        }

        let rxnsChanged = false;
        newReactionsMap.forEach((rxns, cid) => {
          if (!rxnsChanged) {
            const existing = currentReactionsMap.get(cid) || [];
            if (reactionsChanged(existing, rxns)) rxnsChanged = true;
          }
        });
        if (!rxnsChanged) {
          currentReactionsMap.forEach((_, cid) => {
            if (!newReactionsMap.has(cid)) rxnsChanged = true;
          });
        }

        if (msgsChanged || rxnsChanged) {
          const updates: Partial<MessageStoreState> = {};
          if (msgsChanged) updates.confirmedByContact = newConfirmedMap;
          if (rxnsChanged) updates.reactionsByContact = newReactionsMap;
          set(updates);
        }

        // Clean up optimistic entries that are now confirmed in DB
        if (confirmedOptByContact.size > 0) {
          set(state => {
            const newOptMap = new Map(state.optimisticByContact);
            let changed = false;
            for (const [cid, optIds] of confirmedOptByContact) {
              const opts = newOptMap.get(cid);
              if (!opts) continue;
              const idSet = new Set(optIds);
              const filtered = opts.filter(m => !idSet.has(m.id!));
              if (filtered.length !== opts.length) {
                changed = true;
                if (filtered.length === 0) {
                  newOptMap.delete(cid);
                } else {
                  newOptMap.set(cid, filtered);
                }
              }
            }
            return changed ? { optimisticByContact: newOptMap } : state;
          });
        }
      } catch (error) {
        console.error('Messages fetch error:', error);
      } finally {
        isFetching = false;
      }
    };

    await fetchAll();

    const timer = setInterval(fetchAll, POLL_INTERVAL_MS);

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = () => {
      if (activeSendCount > 0) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      const active = get().currentContactUserId;
      debounceTimer = setTimeout(
        active ? () => fetchForContact(active) : fetchAll,
        EVENT_DEBOUNCE_MS
      );
    };
    const cancelDebounce = () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const sdk = getSdk();
    sdk.on(SdkEventType.MESSAGE_RECEIVED, onEvent);
    sdk.on(SdkEventType.MESSAGE_SENT, onEvent);
    sdk.on(SdkEventType.MESSAGE_READ, onEvent);
    sdk.on(SdkEventType.SESSION_CREATED, onEvent);
    sdk.on(SdkEventType.SESSION_ACCEPTED, onEvent);

    set({
      pollTimer: timer,
      eventHandler: onEvent,
      cancelDebounce,
      isInitializing: false,
    });
  },

  sendMessage: async (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
  ) => {
    const { userProfile } = useAccountStore.getState();
    const isForward = !!forwardFromMessageId;
    if (
      !userProfile?.userId ||
      (!content.trim() && !isForward) ||
      !getSdk().isSessionOpen
    )
      return;

    // Optimistic UI FIRST — zero await before showing the message.
    const seq = ++optimisticIdCounter;
    const optimisticMessage: Message = {
      ownerUserId: userProfile.userId,
      contactUserId,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      id: -seq,
    };
    clientSeq.set(-seq, seq);

    // Write to optimistic layer only
    const currentOptimistic =
      get().optimisticByContact.get(contactUserId) || [];
    const newOptMap = new Map(get().optimisticByContact);
    newOptMap.set(contactUserId, [...currentOptimistic, optimisticMessage]);
    set({ optimisticByContact: newOptMap });

    // Fire-and-forget — all async work runs in the background.
    // Guard fetches while sends are in-flight: the SDK writes to DB
    // before returning, so a poll could see the DB message before
    // pendingToRealId is set, causing a temporary duplicate.
    activeSendCount++;
    void (async () => {
      try {
        const discussion = await getSdk().discussions.get(contactUserId);
        if (!discussion) {
          throw new Error('Discussion not found');
        }

        let replyTo: Message['replyTo'] = undefined;
        let forwardOf: Message['forwardOf'] = undefined;

        if (replyToId) {
          const originalMessage = await getSdk().messages.get(replyToId);
          if (originalMessage?.messageId) {
            replyTo = { originalMsgId: originalMessage.messageId };
          }
        }

        if (forwardFromMessageId) {
          const originalMessage =
            await getSdk().messages.get(forwardFromMessageId);
          if (originalMessage?.messageId) {
            if (originalMessage.contactUserId === contactUserId) {
              replyTo = { originalMsgId: originalMessage.messageId };
            } else {
              try {
                forwardOf = {
                  originalContent: originalMessage.content,
                  originalContactId: decodeUserId(
                    originalMessage.contactUserId
                  ),
                };
              } catch {
                // Invalid userId — send as regular message
              }
            }
          }
        }

        const message: Omit<Message, 'id'> = {
          ownerUserId: userProfile.userId,
          contactUserId,
          content,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.WAITING_SESSION,
          timestamp: optimisticMessage.timestamp,
          replyTo,
          forwardOf,
        };

        const result = await getSdk().messages.send(message);

        if (result.message?.id) {
          const realMsg = result.message;
          pendingToRealId.set(optimisticMessage.id!, realMsg.id!);
          // Transfer stable key: seq stays the same across id change
          const seqVal = clientSeq.get(optimisticMessage.id!);
          if (seqVal != null) {
            clientSeq.set(realMsg.id!, seqVal);
            clientSeq.delete(optimisticMessage.id!);
          }
          // Don't remove the optimistic message here. The merge function
          // will exclude it once the confirmed version appears in the next
          // poll. The poll cleanup removes it from optimisticByContact
          // when it cleans up the pendingToRealId entry.
          //
          // Touch the optimistic layer to bust the merge cache — if a poll
          // already added the confirmed version (race), the merge will now
          // exclude the optimistic immediately instead of showing a duplicate.
          set(state => {
            const opts = state.optimisticByContact.get(contactUserId);
            if (!opts) return state;
            const newMap = new Map(state.optimisticByContact);
            newMap.set(contactUserId, [...opts]);
            return { optimisticByContact: newMap };
          });
        } else if (!result.success) {
          // SDK could not persist the message (invalid userId, no
          // discussion, DB error). These are programming/infra errors
          // that shouldn't happen in normal use. Log and keep the
          // message as pending — no FAILED state for the user.
          console.error('Failed to send message:', result.error);
        }
      } catch (error) {
        // Unexpected throw (not a structured SDK error).
        // The message may or may not be persisted. Keep it as optimistic
        // (clock icon) — the next poll will either confirm it or it will
        // stay pending. Don't mark as FAILED for transient errors.
        console.error('Failed to send message:', error);
      } finally {
        activeSendCount--;
      }
    })();
  },

  getMessagesForContact: (contactUserId: string) => {
    const confirmed =
      get().confirmedByContact.get(contactUserId) || EMPTY_MESSAGES;
    const optimistic =
      get().optimisticByContact.get(contactUserId) || EMPTY_MESSAGES;
    return mergeMessages(contactUserId, confirmed, optimistic);
  },

  sendReaction: (contactUserId: string, emoji: string, messageDbId: number) => {
    const messages = get().getMessagesForContact(contactUserId);
    const target = messages.find(m => m.id === messageDbId);
    if (!target || !target.messageId) {
      console.warn('Cannot react to message without messageId');
      return;
    }

    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) return;

    // Optimistic UI — show reaction immediately.
    const optimisticReaction: Message = {
      id: -++optimisticIdCounter,
      ownerUserId: userProfile.userId,
      contactUserId,
      content: emoji,
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      reactionOf: { originalMsgId: target.messageId },
    };

    const currentReactions = get().reactionsByContact.get(contactUserId) || [];
    const newReactionsMap = new Map(get().reactionsByContact);
    newReactionsMap.set(contactUserId, [
      ...currentReactions,
      optimisticReaction,
    ]);
    set({ reactionsByContact: newReactionsMap });

    // Fire-and-forget SDK call.
    void (async () => {
      try {
        const result = await getSdk().messages.sendReaction(
          contactUserId,
          emoji,
          target.messageId!
        );
        if (result.success && result.message?.id) {
          // Swap optimistic → confirmed.
          set(state => {
            const reactions = state.reactionsByContact.get(contactUserId);
            if (!reactions) return state;
            const idx = reactions.findIndex(
              r => r.id === optimisticReaction.id
            );
            if (idx === -1) return state;
            const updated = [...reactions];
            updated[idx] = result.message!;
            const newMap = new Map(state.reactionsByContact);
            newMap.set(contactUserId, updated);
            return { reactionsByContact: newMap };
          });
        }
      } catch (error) {
        console.error('Failed to send reaction:', error);
        // Rollback — remove optimistic reaction.
        set(state => {
          const reactions = state.reactionsByContact.get(contactUserId);
          if (!reactions) return state;
          const filtered = reactions.filter(
            r => r.id !== optimisticReaction.id
          );
          const newMap = new Map(state.reactionsByContact);
          newMap.set(contactUserId, filtered);
          return { reactionsByContact: newMap };
        });
      }
    })();
  },

  removeReaction: (contactUserId: string, reactionDbId: number) => {
    // Optimistic UI — remove from store immediately.
    const currentReactions = get().reactionsByContact.get(contactUserId) || [];
    const removedReaction = currentReactions.find(r => r.id === reactionDbId);

    if (removedReaction) {
      const newReactionsMap = new Map(get().reactionsByContact);
      newReactionsMap.set(
        contactUserId,
        currentReactions.filter(r => r.id !== reactionDbId)
      );
      set({ reactionsByContact: newReactionsMap });
    }

    // Optimistic reactions (negative ID) have no DB row — done.
    if (reactionDbId < 0) return;

    // Fire-and-forget SDK delete.
    void (async () => {
      try {
        const sdk = getSdk();
        const reaction = await sdk.messages.get(reactionDbId);
        if (
          !reaction ||
          reaction.type !== MessageType.REACTION ||
          !reaction.reactionOf?.originalMsgId
        ) {
          await sdk.messages.deleteMessage(reactionDbId);
          return;
        }

        const originalMsgId = reaction.reactionOf.originalMsgId;
        const allReactions = await sdk.messages.getReactions(
          reaction.contactUserId
        );

        const targets = allReactions.filter(
          r =>
            r.direction === MessageDirection.OUTGOING &&
            r.reactionOf?.originalMsgId &&
            r.reactionOf.originalMsgId.length === originalMsgId.length &&
            r.reactionOf.originalMsgId.every(
              (b, i) => b === originalMsgId[i]
            ) &&
            r.id != null
        );

        if (targets.length === 0) {
          await sdk.messages.deleteMessage(reactionDbId);
          return;
        }

        for (const r of targets) {
          await sdk.messages.deleteMessage(r.id!);
        }
      } catch (error) {
        console.error('Failed to remove reaction:', error);
        // Rollback — re-add reaction to store.
        if (removedReaction) {
          set(state => {
            const reactions = state.reactionsByContact.get(contactUserId) || [];
            const newMap = new Map(state.reactionsByContact);
            newMap.set(contactUserId, [...reactions, removedReaction]);
            return { reactionsByContact: newMap };
          });
        }
      }
    })();
  },

  getReactionsForMessage: (contactUserId: string, messageDbId: number) => {
    const reactions =
      get().reactionsByContact.get(contactUserId) || EMPTY_MESSAGES;
    const messages = get().getMessagesForContact(contactUserId);
    const target = messages.find(m => m.id === messageDbId);
    if (!target || !target.messageId) return [];

    let latestIncoming: Message | undefined;
    let latestOutgoing: Message | undefined;

    for (const reaction of reactions) {
      if (!reaction.reactionOf?.originalMsgId) continue;
      if (
        reaction.reactionOf.originalMsgId.length === target.messageId.length &&
        reaction.reactionOf.originalMsgId.every(
          (b, i) => b === target.messageId![i]
        )
      ) {
        if (reaction.direction === MessageDirection.OUTGOING) {
          if (
            !latestOutgoing ||
            reaction.timestamp > latestOutgoing.timestamp
          ) {
            latestOutgoing = reaction;
          }
        } else if (reaction.direction === MessageDirection.INCOMING) {
          if (
            !latestIncoming ||
            reaction.timestamp > latestIncoming.timestamp
          ) {
            latestIncoming = reaction;
          }
        }
      }
    }

    const effective: Message[] = [];
    if (latestIncoming) effective.push(latestIncoming);
    if (latestOutgoing) effective.push(latestOutgoing);

    const groups = new Map<string, ReactionGroup>();
    for (const r of effective) {
      const key = r.content;
      const existing = groups.get(key) ?? { emoji: key, count: 0 };
      const isMine = r.direction === MessageDirection.OUTGOING && r.id != null;
      groups.set(key, {
        emoji: key,
        count: existing.count + 1,
        myReactionId: isMine ? r.id : existing.myReactionId,
      });
    }

    return Array.from(groups.values());
  },

  clearMessages: (contactUserId: string) => {
    const newConfirmed = new Map(get().confirmedByContact);
    const newOptimistic = new Map(get().optimisticByContact);
    const newReactions = new Map(get().reactionsByContact);
    newConfirmed.delete(contactUserId);
    newOptimistic.delete(contactUserId);
    newReactions.delete(contactUserId);
    set({
      confirmedByContact: newConfirmed,
      optimisticByContact: newOptimistic,
      reactionsByContact: newReactions,
    });
  },

  cleanup: () => {
    const timer = get().pollTimer;
    if (timer) clearInterval(timer);
    get().cancelDebounce?.();
    const handler = get().eventHandler;
    if (handler) {
      try {
        const sdk = getSdk();
        sdk.off(SdkEventType.MESSAGE_RECEIVED, handler);
        sdk.off(SdkEventType.MESSAGE_SENT, handler);
        sdk.off(SdkEventType.MESSAGE_READ, handler);
        sdk.off(SdkEventType.SESSION_CREATED, handler);
        sdk.off(SdkEventType.SESSION_ACCEPTED, handler);
      } catch {
        // SDK might not be available during cleanup
      }
    }
    pendingToRealId.clear();
    clientSeq.clear();
    mergeCache.clear();
    activeSendCount = 0;
    set({
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
