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

/** Check if a DB message confirms an optimistic one. */
const isConfirmed = (opt: Message, db: Message): boolean => {
  // Prefer exact ID match (set after SDK send returns the real DB id)
  if (opt.id != null && opt.id < 0 && db.id === -opt.id) return true;
  // Fallback: content + direction + narrow timestamp window
  return (
    db.content === opt.content &&
    db.direction === opt.direction &&
    Math.abs(db.timestamp.getTime() - opt.timestamp.getTime()) < 5000
  );
};

/** Status ranking — never downgrade visually. */
const STATUS_RANK: Record<string, number> = {
  [MessageStatus.WAITING_SESSION]: 0,
  [MessageStatus.READY]: 1,
  [MessageStatus.SENT]: 2,
  [MessageStatus.DELIVERED]: 3,
  [MessageStatus.READ]: 4,
};

/**
 * Merge DB results with unconfirmed optimistic messages from the store.
 * - Reads the LATEST store state at merge time (race-safe).
 * - Never downgrades status (optimistic SENT stays SENT even if DB says READY).
 * - Sorts by timestamp for stable order.
 */
function mergeWithOptimistic(
  contactUserId: string,
  dbMessages: Message[],
  getState: () => MessageStoreState
): Message[] {
  const current = getState().messagesByContact.get(contactUserId) || [];
  const optimistic = current.filter(m => m.id != null && m.id < 0);
  if (optimistic.length === 0) return dbMessages;

  // For confirmed messages: keep DB version but don't downgrade status
  const result = dbMessages.map(db => {
    const matchedOpt = optimistic.find(opt => isConfirmed(opt, db));
    if (
      matchedOpt &&
      (STATUS_RANK[matchedOpt.status] ?? 0) > (STATUS_RANK[db.status] ?? 0)
    ) {
      return { ...db, status: matchedOpt.status };
    }
    return db;
  });

  // Append unconfirmed optimistic messages
  const unconfirmed = optimistic.filter(
    opt => !dbMessages.some(db => isConfirmed(opt, db))
  );
  if (unconfirmed.length > 0) {
    result.push(...unconfirmed);
  }

  // Sort by timestamp for stable order
  result.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return result;
}

const messagesChanged = (existing: Message[], incoming: Message[]): boolean => {
  if (incoming.length !== existing.length) return true;
  return existing.some((msg, i) => {
    const other = incoming[i];
    if (!other) return true;
    const editedA = !!(msg.metadata as { edited?: boolean })?.edited;
    const editedB = !!(other.metadata as { edited?: boolean })?.edited;
    return (
      msg.id !== other.id ||
      msg.content !== other.content ||
      msg.status !== other.status ||
      editedA !== editedB
    );
  });
};

// ── Store ──────────────────────────────────────────────────────

interface MessageStoreState {
  messagesByContact: Map<string, Message[]>;
  reactionsByContact: Map<string, Message[]>;
  currentContactUserId: string | null;
  isLoading: boolean;
  isSending: boolean;
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
  ) => Promise<void>;
  removeReaction: (reactionDbId: number) => Promise<void>;
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
  isSending: false,
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
        const merged = mergeWithOptimistic(contactUserId, dbMessages, get);

        const current = get().messagesByContact.get(contactUserId) || [];
        if (messagesChanged(current, merged)) {
          const newMap = new Map(get().messagesByContact);
          newMap.set(contactUserId, merged);
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
        const mergedMap = new Map<string, Message[]>();
        const newReactionsMap = new Map<string, Message[]>();

        for (const d of discussions) {
          const dbMessages = await sdk.messages.getVisibleMessages(
            d.contactUserId
          );
          const merged = mergeWithOptimistic(d.contactUserId, dbMessages, get);
          if (merged.length > 0) {
            mergedMap.set(d.contactUserId, merged);
          }
          const reactions = await sdk.messages.getReactions(d.contactUserId);
          if (reactions.length > 0) {
            newReactionsMap.set(d.contactUserId, reactions);
          }
        }

        const latestMap = get().messagesByContact;
        const currentReactionsMap = get().reactionsByContact;
        let hasChanges = false;

        mergedMap.forEach((msgs, cid) => {
          if (!hasChanges) {
            const existing = latestMap.get(cid) || [];
            if (messagesChanged(existing, msgs)) hasChanges = true;
          }
        });

        if (!hasChanges) {
          newReactionsMap.forEach((rxns, cid) => {
            if (!hasChanges) {
              const existing = currentReactionsMap.get(cid) || [];
              if (messagesChanged(existing, rxns)) hasChanges = true;
            }
          });
        }

        if (!hasChanges) {
          latestMap.forEach((_, cid) => {
            if (!mergedMap.has(cid)) hasChanges = true;
          });
        }
        if (!hasChanges) {
          currentReactionsMap.forEach((_, cid) => {
            if (!newReactionsMap.has(cid)) hasChanges = true;
          });
        }

        if (hasChanges) {
          set({
            messagesByContact: mergedMap,
            reactionsByContact: newReactionsMap,
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
    // All async work (discussion lookup, reply lookup, SDK send) happens after.
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
        // Verify discussion still exists (guards against deletion during
        // the fire-and-forget window — same check dev had before optimistic).
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

        // Tag the optimistic message with the real DB id so
        // isConfirmed() uses exact ID matching instead of content heuristics.
        if (result.success && result.message?.id) {
          const realId = result.message.id;
          set(state => {
            const msgs = state.messagesByContact.get(contactUserId);
            if (!msgs) return state;
            const updated = msgs.map(m =>
              m.id === optimisticMessage.id ? { ...m, id: -realId } : m
            );
            const newMap = new Map(state.messagesByContact);
            newMap.set(contactUserId, updated);
            return { messagesByContact: newMap };
          });
        }
      } catch (error) {
        console.error('Failed to send message:', error);
        // sdk.messages.send() handles retries internally — if encryption or
        // network fails, the message stays in DB and is resent by stateUpdate.
        // A throw here means the message couldn't even be inserted into DB
        // (catastrophic). Remove the optimistic message so the user doesn't
        // see a phantom that will never be delivered.
        set(state => {
          const msgs = state.messagesByContact.get(contactUserId);
          if (!msgs) return state;
          const filtered = msgs.filter(m => m.id !== optimisticMessage.id);
          const newMap = new Map(state.messagesByContact);
          newMap.set(contactUserId, filtered);
          return { messagesByContact: newMap };
        });
      }
    })();
  },

  getMessagesForContact: (contactUserId: string) => {
    return get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
  },

  sendReaction: async (
    contactUserId: string,
    emoji: string,
    messageDbId: number
  ) => {
    const messages =
      get().messagesByContact.get(contactUserId) || EMPTY_MESSAGES;
    const target = messages.find(m => m.id === messageDbId);
    if (!target || !target.messageId) {
      console.warn('Cannot react to message without messageId');
      return;
    }
    const sdk = getSdk();
    await sdk.messages.sendReaction(contactUserId, emoji, target.messageId);
  },

  removeReaction: async (reactionDbId: number) => {
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
        r.reactionOf.originalMsgId.every((b, i) => b === originalMsgId[i]) &&
        r.id != null
    );

    if (targets.length === 0) {
      await sdk.messages.deleteMessage(reactionDbId);
      return;
    }

    for (const r of targets) {
      await sdk.messages.deleteMessage(r.id!);
    }
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
    set({
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      isSending: false,
    });
  },
}));

export const useMessageStore = createSelectors(useMessageStoreBase);
