import {
  type Message,
  MessageStatus,
  MessageType,
  SdkEventType,
} from '@massalabs/gossip-sdk';
import type { MessageStoreState, StoreMessage } from './messageStore.types';
import type { getSdk } from './sdkStore';
import {
  messageIdEquals,
  messageIdKey,
  patchContact,
  findAndPatch,
  upsertMessage,
  addReactionToState,
  removeReactionFromState,
  clearReactionsForDeletedMessage,
  patchReactionCache,
  recomputeFullCache,
  type SetFn,
} from './messageStore.helpers';

type GetFn = () => MessageStoreState;

export function createEventHandlers(
  sdk: ReturnType<typeof getSdk>,
  set: SetFn,
  get: GetFn
) {
  const onReceived = (message: Message) => {
    if (message.type === MessageType.REACTION) {
      addReactionToState(set, message.contactUserId, message, true);
      return;
    }

    if (message.type === MessageType.DELETED && message.messageId) {
      // If this delete targets a reaction row, remove it from state
      const removed = removeReactionFromState(set, message.contactUserId, r =>
        messageIdEquals(r.messageId, message.messageId)
      );
      if (removed) return;
    }

    set(state => {
      const msgMap = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => upsertMessage(msgs, message)
      );
      if (!msgMap) return state;

      // When a message is deleted, also clear reactions referencing it
      if (message.type === MessageType.DELETED && message.messageId) {
        const rxnUpdate = clearReactionsForDeletedMessage(
          state,
          message.contactUserId,
          message.messageId,
          msgMap
        );
        return rxnUpdate
          ? { messagesByContact: msgMap, ...rxnUpdate }
          : { messagesByContact: msgMap };
      }

      return { messagesByContact: msgMap };
    });
  };

  const onSent = (message: Message) => {
    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => {
          let changed = false;
          const updated = msgs.map(entry => {
            if (messageIdEquals(entry.messageId, message.messageId)) {
              changed = true;
              return {
                ...entry,
                id: message.id ?? entry.id,
                status: message.status,
              };
            }
            return entry;
          });
          return changed ? updated : null;
        }
      );
      return map ? { messagesByContact: map } : state;
    });

    // Also reconcile optimistic reactions — they live in reactionsByContact
    // and won't be found by the messagesByContact scan above.
    if (message.type === MessageType.REACTION && message.messageId) {
      set(state => {
        const existing =
          state.reactionsByContact.get(message.contactUserId) || [];
        let changed = false;
        const updated = existing.map(r => {
          if (messageIdEquals(r.messageId, message.messageId)) {
            changed = true;
            return { ...r, id: message.id ?? r.id, status: message.status };
          }
          return r;
        });
        if (!changed) return state;
        const rxnMap = new Map(state.reactionsByContact);
        rxnMap.set(message.contactUserId, updated);
        return {
          reactionsByContact: rxnMap,
          reactionGroupsCache: patchReactionCache(
            state.reactionGroupsCache,
            message.contactUserId,
            state.messagesByContact,
            rxnMap
          ),
        };
      });
    }
  };

  const onDeleted = ({
    messages: deletedMessages,
  }: {
    messages: Message[];
  }) => {
    const map = new Map<string, StoreMessage[]>(get().messagesByContact);
    let postMsgchanged = false;
    for (const msg of deletedMessages) {
      if (msg.type === MessageType.REACTION) {
        removeReactionFromState(set, msg.contactUserId, r => r.id === msg.id);
        continue;
      }

      const msgs = map.get(msg.contactUserId);
      if (!msgs) continue;
      const updated = msgs.filter(entry => entry.id !== msg.id);
      map.set(msg.contactUserId, updated);
      postMsgchanged = true;
    }

    if (postMsgchanged) {
      set(_ => ({ messagesByContact: map }));
    }
  };

  const onUpdated = ({
    messages: updatedMessages,
  }: {
    messages: Message[];
  }) => {
    set(state => {
      const map = new Map<string, StoreMessage[]>(state.messagesByContact);
      let changed = false;
      for (const msg of updatedMessages) {
        const msgs = map.get(msg.contactUserId);
        if (!msgs) continue;
        const idx = msgs.findIndex(entry => entry.id === msg.id);
        if (idx < 0) continue;
        const updated = [...msgs];
        updated[idx] = { ...msg };
        map.set(msg.contactUserId, updated);
        changed = true;
      }
      return changed ? { messagesByContact: map } : state;
    });
  };

  const onRead = (messageDbId: number) => {
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        entry => entry.id === messageDbId,
        entry => ({
          ...entry,
          status: MessageStatus.READ,
        })
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onAcknowledged = ({
    messageDbId,
  }: {
    contactUserId: string;
    messageDbId: number;
  }) => {
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        entry => entry.id === messageDbId,
        entry => ({
          ...entry,
          status: MessageStatus.DELIVERED,
        })
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  // ── Session event: merge DB data with pending optimistic ────────

  const onSessionEvent = async () => {
    const currentContact = get().currentContactUserId;
    if (!currentContact || !sdk.isSessionOpen) return;
    try {
      const dbMessages = await sdk.messages.getVisibleMessages(currentContact);
      const dbReactions = await sdk.messages.getReactions(currentContact);
      set(state => {
        const currentMsgs = state.messagesByContact.get(currentContact) || [];

        // Build lookup sets from DB results
        const dbMsgIdKeys = new Set<string>();
        for (const m of dbMessages) {
          if (m.messageId) dbMsgIdKeys.add(messageIdKey(m.messageId));
        }
        const dbMsgDbIds = new Set(
          dbMessages.map(m => m.id).filter(Boolean) as number[]
        );

        // Keep optimistic messages not yet in DB
        const pendingOptimistic = currentMsgs.filter(m => {
          if (!m.storeId) return false;
          if (m.status !== MessageStatus.WAITING_SESSION) return false;
          if (m.id && dbMsgDbIds.has(m.id)) return false;
          if (m.messageId && dbMsgIdKeys.has(messageIdKey(m.messageId)))
            return false;
          return true;
        });

        const merged: StoreMessage[] = [
          ...dbMessages.map(m => ({ ...m })),
          ...pendingOptimistic,
        ];

        // Same for reactions
        const currentRxns = state.reactionsByContact.get(currentContact) || [];
        const dbRxnIdKeys = new Set<string>();
        for (const r of dbReactions) {
          if (r.messageId) dbRxnIdKeys.add(messageIdKey(r.messageId));
        }
        const pendingRxns = currentRxns.filter(r => {
          if (r.status !== MessageStatus.WAITING_SESSION) return false;
          if (r.messageId && dbRxnIdKeys.has(messageIdKey(r.messageId)))
            return false;
          return true;
        });
        const mergedRxns: StoreMessage[] = [
          ...dbReactions.map(r => ({ ...r })),
          ...pendingRxns,
        ];

        const msgMap = new Map(state.messagesByContact);
        const rxnMap = new Map(state.reactionsByContact);
        msgMap.set(currentContact, merged);
        if (mergedRxns.length > 0) rxnMap.set(currentContact, mergedRxns);
        else rxnMap.delete(currentContact);
        return {
          messagesByContact: msgMap,
          reactionsByContact: rxnMap,
          reactionGroupsCache: recomputeFullCache(msgMap, rxnMap),
        };
      });
    } catch (error) {
      console.error('Session event refetch error:', error);
    }
  };

  // ── Register all handlers ───────────────────────────────────────

  sdk.on(SdkEventType.MESSAGE_RECEIVED, onReceived);
  sdk.on(SdkEventType.MESSAGE_SENT, onSent);
  sdk.on(SdkEventType.MESSAGE_READ, onRead);
  sdk.on(SdkEventType.MESSAGE_ACKNOWLEDGED, onAcknowledged);
  sdk.on(SdkEventType.MESSAGE_DELETED, onDeleted);
  sdk.on(SdkEventType.MESSAGE_UPDATED, onUpdated);
  sdk.on(SdkEventType.SESSION_CREATED, onSessionEvent);
  sdk.on(SdkEventType.SESSION_ACCEPTED, onSessionEvent);

  return () => {
    try {
      sdk.off(SdkEventType.MESSAGE_RECEIVED, onReceived);
      sdk.off(SdkEventType.MESSAGE_SENT, onSent);
      sdk.off(SdkEventType.MESSAGE_READ, onRead);
      sdk.off(SdkEventType.MESSAGE_ACKNOWLEDGED, onAcknowledged);
      sdk.off(SdkEventType.MESSAGE_DELETED, onDeleted);
      sdk.off(SdkEventType.MESSAGE_UPDATED, onUpdated);
      sdk.off(SdkEventType.SESSION_CREATED, onSessionEvent);
      sdk.off(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
    } catch {
      // SDK might not be available during cleanup
    }
  };
}
