import {
  type Message,
  MessageStatus,
  MessageType,
  SdkEventType,
} from '@massalabs/gossip-sdk';
import type { MessageStoreState } from './messageStore.types';
import type { getSdk } from './sdkStore';
import {
  messageIdEquals,
  messageIdKey,
  patchContact,
  findAndPatch,
  upsertMessage,
  addReactionToState,
  removeReactionFromState,
  patchReactionCache,
  recomputeFullCache,
  rollbackReplace,
  type SetFn,
} from './messageStore.helpers';

type GetFn = () => MessageStoreState;

export function createEventHandlers(
  sdk: ReturnType<typeof getSdk>,
  set: SetFn,
  get: GetFn
) {
  const onOptimistic = (message: Message) => {
    if (message.type === MessageType.REACTION) {
      addReactionToState(set, message.contactUserId, message, false);
      return;
    }
    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => [...msgs, message]
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onReceived = (message: Message) => {
    if (message.type === MessageType.REACTION) {
      addReactionToState(set, message.contactUserId, message, true);
      return;
    }

    if (message.type === MessageType.DELETED && message.messageId) {
      const removed = removeReactionFromState(set, message.contactUserId, r =>
        messageIdEquals(r.messageId, message.messageId)
      );
      if (removed) return;
    }

    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => upsertMessage(msgs, message)
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onSent = (message: Message) => {
    set(state => {
      const map = patchContact(
        state.messagesByContact,
        message.contactUserId,
        msgs => {
          let changed = false;
          const updated = msgs.map(m => {
            if (messageIdEquals(m.messageId, message.messageId)) {
              changed = true;
              return { ...m, id: message.id ?? m.id, status: message.status };
            }
            return m;
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

  const onWriteFailed = ({
    messageId: failedMessageId,
    entityType,
  }: {
    messageId: Uint8Array | undefined;
    entityType: string;
    error: Error;
  }) => {
    if (entityType !== 'message') return;
    set(state => {
      // Try messages first
      const map = findAndPatch(
        state.messagesByContact,
        m => messageIdEquals(m.messageId, failedMessageId),
        m => ({ ...m, status: MessageStatus.FAILED })
      );
      if (map) return { messagesByContact: map };

      // Fall back to reactions — remove silently on failure
      for (const [contact, reactions] of state.reactionsByContact) {
        const idx = reactions.findIndex(r =>
          messageIdEquals(r.messageId, failedMessageId)
        );
        if (idx >= 0) {
          const rxnMap = new Map(state.reactionsByContact);
          rxnMap.set(
            contact,
            reactions.filter((_, i) => i !== idx)
          );
          return {
            reactionsByContact: rxnMap,
            reactionGroupsCache: patchReactionCache(
              state.reactionGroupsCache,
              contact,
              state.messagesByContact,
              rxnMap
            ),
          };
        }
      }
      return state;
    });
  };

  const onRead = (messageDbId: number) => {
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        m => m.id === messageDbId,
        m => ({ ...m, status: MessageStatus.READ })
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  // ── Semantic optimistic events ──────────────────────────────────

  const onDeletedOptimistic = ({
    contactUserId,
    messageDbId,
  }: {
    contactUserId: string;
    messageDbId: number;
    originalMsgId: Uint8Array;
  }) => {
    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === messageDbId
            ? { ...m, type: MessageType.DELETED, content: '[Message deleted]' }
            : m
        )
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onDeleteFailed = ({
    contactUserId,
    messageDbId,
    original,
  }: {
    contactUserId: string;
    messageDbId: number;
    original: Message;
  }) => {
    rollbackReplace(set, contactUserId, messageDbId, original);
  };

  const onEditedOptimistic = ({
    contactUserId,
    messageDbId,
    newContent,
    metadata,
  }: {
    contactUserId: string;
    messageDbId: number;
    newContent: string;
    metadata: Record<string, unknown>;
  }) => {
    set(state => {
      const map = patchContact(state.messagesByContact, contactUserId, ms =>
        ms.map(m =>
          m.id === messageDbId ? { ...m, content: newContent, metadata } : m
        )
      );
      return map ? { messagesByContact: map } : state;
    });
  };

  const onEditFailed = ({
    contactUserId,
    messageDbId,
    original,
  }: {
    contactUserId: string;
    messageDbId: number;
    original: Message;
  }) => {
    rollbackReplace(set, contactUserId, messageDbId, original);
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
          if (m.status !== MessageStatus.WAITING_SESSION) return false;
          if (m.id && dbMsgDbIds.has(m.id)) return false;
          if (m.messageId && dbMsgIdKeys.has(messageIdKey(m.messageId)))
            return false;
          return true;
        });

        const merged = [...dbMessages, ...pendingOptimistic];

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
        const mergedRxns = [...dbReactions, ...pendingRxns];

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

  sdk.on(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
  sdk.on(SdkEventType.MESSAGE_RECEIVED, onReceived);
  sdk.on(SdkEventType.MESSAGE_SENT, onSent);
  sdk.on(SdkEventType.MESSAGE_READ, onRead);
  sdk.on(SdkEventType.WRITE_FAILED, onWriteFailed);
  sdk.on(SdkEventType.SESSION_CREATED, onSessionEvent);
  sdk.on(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
  sdk.on(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, onDeletedOptimistic);
  sdk.on(SdkEventType.MESSAGE_EDITED_OPTIMISTIC, onEditedOptimistic);
  sdk.on(SdkEventType.MESSAGE_DELETE_FAILED, onDeleteFailed);
  sdk.on(SdkEventType.MESSAGE_EDIT_FAILED, onEditFailed);

  return () => {
    try {
      sdk.off(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
      sdk.off(SdkEventType.MESSAGE_RECEIVED, onReceived);
      sdk.off(SdkEventType.MESSAGE_SENT, onSent);
      sdk.off(SdkEventType.MESSAGE_READ, onRead);
      sdk.off(SdkEventType.WRITE_FAILED, onWriteFailed);
      sdk.off(SdkEventType.SESSION_CREATED, onSessionEvent);
      sdk.off(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
      sdk.off(SdkEventType.MESSAGE_DELETED_OPTIMISTIC, onDeletedOptimistic);
      sdk.off(SdkEventType.MESSAGE_EDITED_OPTIMISTIC, onEditedOptimistic);
      sdk.off(SdkEventType.MESSAGE_DELETE_FAILED, onDeleteFailed);
      sdk.off(SdkEventType.MESSAGE_EDIT_FAILED, onEditFailed);
    } catch {
      // SDK might not be available during cleanup
    }
  };
}
