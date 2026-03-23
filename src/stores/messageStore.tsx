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

const statusRank = (s: string): number => STATUS_RANK[s] ?? -1;

/**
 * Reliable mapping from optimistic id (negative) → real DB id.
 * Set when the SDK send returns; used by mergeWithOptimistic to match
 * optimistic messages to their DB counterparts without heuristics.
 */
const pendingToRealId = new Map<number, number>();

/** Check if a DB message confirms an optimistic one. */
const isConfirmed = (opt: Message, db: Message): boolean => {
  const realId = pendingToRealId.get(opt.id!);
  if (realId != null) return db.id === realId;
  // No fallback heuristic — pendingToRealId is the only reliable source.
  // A content-based fallback causes false positives when multiple messages
  // have the same content (e.g. "a", "a", "a"), making them disappear
  // during poll reconciliation.
  return false;
};

/**
 * Reconcile DB results with the current store array.
 *
 * Key property: **preserves existing JS references** when a message hasn't
 * visibly changed.  This prevents Virtuoso from re-measuring unchanged items,
 * which eliminates scroll jumps on routine polls.
 *
 * - Confirmed (id > 0) messages are matched by DB id; the existing store
 *   object is kept when id / content / status / edited are identical.
 * - Status is never downgraded — if the store already shows a higher status
 *   the store object is kept as-is.
 * - Unconfirmed optimistic messages (id < 0) are appended at the end.
 */
function reconcile(
  contactUserId: string,
  dbMessages: Message[],
  getState: () => MessageStoreState
): Message[] {
  const current = getState().messagesByContact.get(contactUserId) || [];

  // Index confirmed messages currently in the store by their DB id
  const storeById = new Map<number, Message>();
  const optimistic: Message[] = [];
  for (const m of current) {
    if (m.id != null && m.id < 0) {
      optimistic.push(m);
    } else if (m.id != null) {
      storeById.set(m.id, m);
    }
  }

  // Index DB messages by id for fast lookup
  const dbIdSet = new Set<number>();
  for (const m of dbMessages) if (m.id != null) dbIdSet.add(m.id);

  // Build the result from DB messages, reusing store objects when possible
  const result: Message[] = dbMessages.map(db => {
    if (db.id == null) return db;
    const existing = storeById.get(db.id);
    if (!existing) return db;

    // Never downgrade status — keep the store version if it's higher
    if (statusRank(existing.status) > statusRank(db.status)) {
      return existing;
    }

    // If nothing visible changed, return the SAME reference
    const editedE = !!(existing.metadata as { edited?: boolean })?.edited;
    const editedD = !!(db.metadata as { edited?: boolean })?.edited;
    if (
      existing.id === db.id &&
      existing.content === db.content &&
      existing.status === db.status &&
      editedE === editedD
    ) {
      return existing;
    }

    return db;
  });

  let needsSort = false;

  // Append unconfirmed optimistic messages (id < 0, no DB match yet)
  if (optimistic.length > 0) {
    const unconfirmed = optimistic.filter(
      opt => !dbMessages.some(db => isConfirmed(opt, db))
    );
    if (unconfirmed.length > 0) {
      result.push(...unconfirmed);
      needsSort = true;
    }
  }

  // Preserve recently-swapped messages whose real id isn't in DB yet.
  // This covers the race: SDK returned (swap happened) but the poll
  // fetched stale data that doesn't include the new message.
  for (const [optId, realId] of pendingToRealId) {
    if (dbIdSet.has(realId)) {
      // DB caught up — clean up mapping
      pendingToRealId.delete(optId);
    } else {
      // DB hasn't caught up — keep the store version if we have it
      const existing = storeById.get(realId);
      if (existing) {
        result.push(existing);
        needsSort = true;
      }
    }
  }

  if (needsSort) {
    result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Return the SAME array reference if nothing changed.
  // This is critical: it prevents Zustand selectors from seeing a new
  // reference, which would trigger React re-renders and Virtuoso re-layout.
  if (
    result.length === current.length &&
    result.every((m, i) => m === current[i])
  ) {
    return current;
  }

  return result;
}

const messagesChanged = (existing: Message[], incoming: Message[]): boolean => {
  if (existing === incoming) return false;
  if (incoming.length !== existing.length) return true;
  return existing.some((msg, i) => msg !== incoming[i]);
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
  messagesByContact: Map<string, Message[]>;
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
  messagesByContact: new Map(),
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
        const reconciled = reconcile(contactUserId, dbMessages, get);

        const current = get().messagesByContact.get(contactUserId) || [];
        if (messagesChanged(current, reconciled)) {
          const newMap = new Map(get().messagesByContact);
          newMap.set(contactUserId, reconciled);
          set({ messagesByContact: newMap });
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
        const reconciledMap = new Map<string, Message[]>();
        const newReactionsMap = new Map<string, Message[]>();

        for (const d of discussions) {
          const dbMessages = await sdk.messages.getVisibleMessages(
            d.contactUserId
          );
          const reconciled = reconcile(d.contactUserId, dbMessages, get);
          if (reconciled.length > 0) {
            reconciledMap.set(d.contactUserId, reconciled);
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
        const latestMap = get().messagesByContact;
        const currentReactionsMap = get().reactionsByContact;

        let msgsChanged = false;
        reconciledMap.forEach((msgs, cid) => {
          if (!msgsChanged) {
            const existing = latestMap.get(cid) || [];
            if (messagesChanged(existing, msgs)) msgsChanged = true;
          }
        });
        if (!msgsChanged) {
          latestMap.forEach((_, cid) => {
            if (!reconciledMap.has(cid)) msgsChanged = true;
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
          if (msgsChanged) updates.messagesByContact = reconciledMap;
          if (rxnsChanged) updates.reactionsByContact = newReactionsMap;
          set(updates);
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
    const optimisticMessage: Message = {
      ownerUserId: userProfile.userId,
      contactUserId,
      content,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      id: -++optimisticIdCounter,
    };

    const currentMessages = get().messagesByContact.get(contactUserId) || [];
    const newMap = new Map(get().messagesByContact);
    newMap.set(contactUserId, [...currentMessages, optimisticMessage]);
    set({ messagesByContact: newMap });

    // Fire-and-forget — all async work runs in the background.
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

          // Swap optimistic → confirmed immediately.
          // Keep the higher status so the check doesn't flicker.
          // Preserve the optimistic timestamp so the Virtuoso key stays
          // stable (key = timestamp + content). Using the SDK's timestamp
          // would change the key, causing unmount/remount and a visual flash.
          set(state => {
            const msgs = state.messagesByContact.get(contactUserId);
            if (!msgs) return state;
            const idx = msgs.findIndex(m => m.id === optimisticMessage.id);
            if (idx === -1) return state;

            const updated = [...msgs];

            // Race: a poll may have already added the DB message (with
            // the real id) while this send was in-flight. If so, just
            // drop the optimistic duplicate and preserve the DB version.
            const existingRealIdx = msgs.findIndex(
              m => m.id === realMsg.id && m.id !== optimisticMessage.id
            );
            if (existingRealIdx !== -1) {
              const kept =
                statusRank(msgs[idx].status) >
                statusRank(msgs[existingRealIdx].status)
                  ? msgs[idx].status
                  : msgs[existingRealIdx].status;
              updated[existingRealIdx] = {
                ...msgs[existingRealIdx],
                status: kept,
              };
              updated.splice(idx, 1);
            } else {
              const kept =
                statusRank(msgs[idx].status) > statusRank(realMsg.status)
                  ? msgs[idx].status
                  : realMsg.status;
              updated[idx] = {
                ...msgs[idx],
                id: realMsg.id,
                messageId: realMsg.messageId,
                status: kept,
              };
            }

            const newMap = new Map(state.messagesByContact);
            newMap.set(contactUserId, updated);
            return { messagesByContact: newMap };
          });
        } else if (!result.success) {
          // SDK could not persist the message at all (no DB row).
          // This is a permanent error — mark as FAILED.
          console.error('Failed to send message:', result.error);
          set(state => {
            const msgs = state.messagesByContact.get(contactUserId);
            if (!msgs) return state;
            const idx = msgs.findIndex(m => m.id === optimisticMessage.id);
            if (idx === -1) return state;
            const updated = [...msgs];
            updated[idx] = { ...msgs[idx], status: MessageStatus.FAILED };
            const newMap = new Map(state.messagesByContact);
            newMap.set(contactUserId, updated);
            return { messagesByContact: newMap };
          });
        }
        // If result.message exists but !result.success, the SDK persisted
        // the message with WAITING_SESSION — it will be sent automatically
        // on the next stateUpdate. Keep the clock icon (optimistic stays).
      } catch (error) {
        // Unexpected throw (not a structured SDK error).
        // The message may or may not be persisted. Keep it as optimistic
        // (clock icon) — the next poll will either confirm it or it will
        // stay pending. Don't mark as FAILED for transient errors.
        console.error('Failed to send message:', error);
      }
    })();
  },

  getMessagesForContact: (contactUserId: string) => {
    return get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
  },

  sendReaction: (contactUserId: string, emoji: string, messageDbId: number) => {
    const messages =
      get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
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
    const messages =
      get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
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
    const newMessagesMap = new Map(get().messagesByContact);
    const newReactionsMap = new Map(get().reactionsByContact);
    newMessagesMap.delete(contactUserId);
    newReactionsMap.delete(contactUserId);
    set({
      messagesByContact: newMessagesMap,
      reactionsByContact: newReactionsMap,
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
    set({
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
