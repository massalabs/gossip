import {
  Message,
  MessageStatus,
  MessageType,
  SdkEventType,
} from '@massalabs/gossip-sdk';
import type { MessageStoreState } from './messageStore.types';
import type { getSdk } from './sdkStore';
import {
  messageIdEquals,
  patchContact,
  findAndPatch,
  upsertMessage,
  addReactionToState,
  removeReactionFromState,
  recomputeFullCache,
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
  };

  const onWriteFailed = (
    failedMessageId: Uint8Array | undefined,
    entityType: string
  ) => {
    if (entityType !== 'message') return;
    set(state => {
      const map = findAndPatch(
        state.messagesByContact,
        m => messageIdEquals(m.messageId, failedMessageId),
        m => ({ ...m, status: MessageStatus.FAILED })
      );
      return map ? { messagesByContact: map } : state;
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

  const onSessionEvent = async () => {
    const currentContact = get().currentContactUserId;
    if (!currentContact || !sdk.isSessionOpen) return;
    try {
      const messages = await sdk.messages.getVisibleMessages(currentContact);
      const reactions = await sdk.messages.getReactions(currentContact);
      set(state => {
        const msgMap = new Map(state.messagesByContact);
        const rxnMap = new Map(state.reactionsByContact);
        msgMap.set(currentContact, messages);
        if (reactions.length > 0) rxnMap.set(currentContact, reactions);
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

  sdk.on(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
  sdk.on(SdkEventType.MESSAGE_RECEIVED, onReceived);
  sdk.on(SdkEventType.MESSAGE_SENT, onSent);
  sdk.on(SdkEventType.MESSAGE_READ, onRead);
  sdk.on(SdkEventType.WRITE_FAILED, onWriteFailed);
  sdk.on(SdkEventType.SESSION_CREATED, onSessionEvent);
  sdk.on(SdkEventType.SESSION_ACCEPTED, onSessionEvent);

  return () => {
    try {
      sdk.off(SdkEventType.MESSAGE_OPTIMISTIC, onOptimistic);
      sdk.off(SdkEventType.MESSAGE_RECEIVED, onReceived);
      sdk.off(SdkEventType.MESSAGE_SENT, onSent);
      sdk.off(SdkEventType.MESSAGE_READ, onRead);
      sdk.off(SdkEventType.WRITE_FAILED, onWriteFailed);
      sdk.off(SdkEventType.SESSION_CREATED, onSessionEvent);
      sdk.off(SdkEventType.SESSION_ACCEPTED, onSessionEvent);
    } catch {
      // SDK might not be available during cleanup
    }
  };
}
