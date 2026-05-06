import type { Message } from '@massalabs/gossip-sdk';

export interface ReactionGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
  myReactionMessageId?: Uint8Array;
}

export interface StoreMessage extends Message {
  storeId?: string;
}

export interface MessageStoreState {
  messagesByContact: Map<string, StoreMessage[]>;
  reactionsByContact: Map<string, StoreMessage[]>;
  reactionGroupsCache: Map<string, ReactionGroup[]>;
  currentContactUserId: string | null;
  cleanupFn: (() => void) | null;
  isInitializing: boolean;
  /**
   * In-memory set of `storeId`s whose row has fired MESSAGE_SENT in
   * this app session. Drives the optimistic ✓ rendering for outgoing
   * rows whose DB status flag is technically still WAITING_SESSION /
   * READY (the SDK's fire-and-forget UPDATE may not have committed
   * yet). The MESSAGE_SENT event fires synchronously inside the SDK
   * send loop, *before* the background SQL UPDATE — so this set
   * shows the ✓ ~150 ms ahead of what the DB column says.
   *
   * Populated by the `onSent` handler in `messageStore.events.ts`,
   * NOT by `sendMessage` after `sdk.messages.send` resolves. Reason:
   * `send`'s promise resolves on queue, not on wire ack — if the peer
   * has no active session yet (invite pending, contact unreachable),
   * the row stays in WAITING_SESSION forever and MESSAGE_SENT is
   * never emitted. Marking eagerly produced phantom ✓ on undelivered
   * messages.
   *
   * Keyed by `storeId`, which `replaceOptimisticWithPersisted`
   * preserves across the optimistic→persisted swap so the same key
   * works for the row's whole UI lifetime.
   *
   * Lives in RAM only. On reload the set is empty and the UI falls
   * back to DB status — anything truly SENT shows ✓ from the column,
   * anything still pending re-renders as ⏳ until the SDK drains it.
   */
  optimisticallySentStoreIds: Set<string>;

  init: () => Promise<void>;
  setCurrentContact: (contactUserId: string | null) => Promise<void>;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToId?: number,
    forwardFromMessageId?: number
  ) => Promise<void>;
  /** Same array reference until the store replaces that contact’s list (Zustand-safe). */
  getMessagesForContact: (contactUserId: string) => StoreMessage[];
  getReactionsForMessage: (messageId: Uint8Array) => ReactionGroup[];
  deleteMessage: (contactUserId: string, messageId: number) => Promise<void>;
  editMessage: (
    contactUserId: string,
    messageId: number,
    newContent: string
  ) => Promise<void>;
  reactToMessage: (
    contactUserId: string,
    emoji: string,
    messageDbId: number
  ) => Promise<void>;
  removeReaction: (
    reactionDbId: number | undefined,
    reactionMessageId?: Uint8Array,
    reactionStoreId?: string,
    contactUserId?: string
  ) => Promise<void>;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}
