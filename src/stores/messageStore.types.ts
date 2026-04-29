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
   * In-memory set of `storeId`s for messages the current app session
   * just submitted via `sendMessage`. Drives the optimistic ✓
   * rendering for outgoing rows whose DB status is still
   * WAITING_SESSION / READY (the SDK keeps that status for
   * correctness until the wire confirms, but the UX commits to ✓
   * as soon as the row appears in the UI list).
   *
   * Keyed by `storeId` (not by DB row id) so the mark happens
   * SYNCHRONOUSLY at submit — before `addMessage` even runs — and the
   * ✓ shows on the very first paint after tap. `replaceOptimisticWith
   * Persisted` preserves the `storeId` after the DB row arrives, so
   * the same key works for the lifetime of the row.
   *
   * Lives in RAM only. On reload the set is empty and the UI falls
   * back to DB status — pending sends naturally re-render as ⏳ and
   * the SDK's send loop drains them. This matches the Telegram UX:
   * fresh sends look instant; reloads tell the truth.
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
