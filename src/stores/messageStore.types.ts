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
    reactionMessageId?: Uint8Array
  ) => Promise<void>;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}
