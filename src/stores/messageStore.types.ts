import type { Message } from '@massalabs/gossip-sdk';

export interface ReactionGroup {
  emoji: string;
  count: number;
  myReactionId?: number;
  myReactionMessageId?: Uint8Array;
}

export interface MessageStoreState {
  messagesByContact: Map<string, Message[]>;
  reactionsByContact: Map<string, Message[]>;
  reactionGroupsCache: Map<string, ReactionGroup[]>;
  currentContactUserId: string | null;
  cleanupFn: (() => void) | null;
  isInitializing: boolean;

  init: () => Promise<void>;
  setCurrentContact: (contactUserId: string | null) => void;
  sendMessage: (
    contactUserId: string,
    content: string,
    replyToMessageId?: number,
    forwardFromMessageId?: number
  ) => Promise<void>;
  getMessagesForContact: (contactUserId: string) => Message[];
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
  removeReaction: (reactionDbId: number) => Promise<void>;
  clearMessages: (contactUserId: string) => void;
  cleanup: () => void;
}
