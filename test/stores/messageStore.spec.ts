import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useMessageStore,
  type ReactionGroup,
} from '../../src/stores/messageStore';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@massalabs/gossip-sdk';
import { recomputeFullCache } from '../../src/stores/messageStore.helpers';

// ---------------------------------------------------------------------------
// Mock SDK with event emitter
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;
const listeners = new Map<string, Set<EventHandler>>();

const mockSdk = {
  isSessionOpen: false,
  messages: {
    getVisibleMessages: vi.fn(async () => [] as Message[]),
    getReactions: vi.fn(async () => [] as Message[]),
    get: vi.fn(async () => undefined as unknown as Message | undefined),
    send: vi.fn(async () => ({ success: true as const })),
    findMessageByMsgId: vi.fn(async () => undefined as Message | undefined),
    deleteMessage: vi.fn(async () => true),
    editMessage: vi.fn(async () => true),
  },
  discussions: {
    list: vi.fn(async () => []),
  },
  on: vi.fn((event: string, handler: EventHandler) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(handler);
  }),
  off: vi.fn((event: string, handler: EventHandler) => {
    listeners.get(event)?.delete(handler);
  }),
};

vi.mock('../../src/stores/sdkStore', () => ({
  useSdkStore: {
    getState: vi.fn(() => ({ sdk: mockSdk, setSdk: vi.fn() })),
    use: { sdk: () => mockSdk },
  },
  getSdk: () => mockSdk,
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: {
    getState: vi.fn(() => ({
      userProfile: { userId: 'test-user-id' },
    })),
  },
}));

describe('MessageStore reactions', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    // Clear all event listeners
    listeners.clear();

    // Reset store state
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      reactionGroupsCache: new Map(),
      currentContactUserId: null,
      cleanupFn: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    mockSdk.messages.send.mockClear();
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);
    mockSdk.messages.deleteMessage.mockClear();

    // Initialize the store so event handlers are registered
    useMessageStore.getState().init();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('reactToMessage sends a reaction via sdk.messages.send', async () => {
    const messageWithId: Message = {
      id: 1,
      messageId: new Uint8Array(12).fill(1),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [messageWithId]]]),
    });

    await useMessageStore
      .getState()
      .reactToMessage(contactUserId, '\u{1F44D}', messageWithId.id!);

    expect(mockSdk.messages.send).toHaveBeenCalledTimes(1);
    expect(mockSdk.messages.send).toHaveBeenCalledWith(
      expect.objectContaining({
        contactUserId,
        content: '\u{1F44D}',
        type: MessageType.REACTION,
        direction: MessageDirection.OUTGOING,
        reactionOf: { originalMsgId: messageWithId.messageId },
      })
    );

    // No deleteMessage call should be made; the latest reaction wins by ordering.
    expect(mockSdk.messages.deleteMessage).not.toHaveBeenCalled();
  });

  it('getReactionsForMessage returns only the latest reaction per user (incoming/outgoing)', () => {
    const baseMessage: Message = {
      id: 10,
      messageId: new Uint8Array(12).fill(7),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Hi',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    };

    const earlierIncoming: Message = {
      id: 1,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{1F600}',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const laterIncoming: Message = {
      ...earlierIncoming,
      id: 2,
      content: '\u{1F62E}',
      timestamp: new Date('2024-01-01T10:02:00Z'),
    };

    const earlierOutgoing: Message = {
      id: 3,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{2764}\u{FE0F}',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:03:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const laterOutgoing: Message = {
      ...earlierOutgoing,
      id: 4,
      content: '\u{1F602}',
      timestamp: new Date('2024-01-01T10:04:00Z'),
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [baseMessage]]]),
      reactionsByContact: new Map([
        [
          contactUserId,
          [earlierIncoming, laterIncoming, earlierOutgoing, laterOutgoing],
        ],
      ]),
    });

    // Recompute the cache after setting state manually
    const state = useMessageStore.getState();
    useMessageStore.setState({
      reactionGroupsCache: recomputeFullCache(
        state.messagesByContact,
        state.reactionsByContact
      ),
    });

    const groups: ReactionGroup[] = useMessageStore
      .getState()
      .getReactionsForMessage(baseMessage.messageId!);

    // Only latest per user should be considered: 😮 (incoming) and 😂 (outgoing)
    const emojis = groups.map(g => g.emoji).sort();
    expect(emojis).toEqual(['\u{1F602}', '\u{1F62E}']);

    const mine = groups.find(g => g.myReactionId != null);
    expect(mine?.emoji).toBe('\u{1F602}');
    expect(mine?.myReactionId).toBe(laterOutgoing.id);
  });

  it('aggregates when both users react with the same emoji', () => {
    const baseMessage: Message = {
      id: 20,
      messageId: new Uint8Array(12).fill(3),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    };

    const incoming: Message = {
      id: 5,
      ownerUserId: 'peer-user-id',
      contactUserId,
      content: '\u{1F525}',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const outgoing: Message = {
      id: 6,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{1F525}',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:02:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [baseMessage]]]),
      reactionsByContact: new Map([[contactUserId, [incoming, outgoing]]]),
    });

    // Recompute the cache after setting state manually
    const state = useMessageStore.getState();
    useMessageStore.setState({
      reactionGroupsCache: recomputeFullCache(
        state.messagesByContact,
        state.reactionsByContact
      ),
    });

    const groups: ReactionGroup[] = useMessageStore
      .getState()
      .getReactionsForMessage(baseMessage.messageId!);

    expect(groups).toHaveLength(1);
    expect(groups[0].emoji).toBe('\u{1F525}');
    expect(groups[0].count).toBe(2);
    expect(groups[0].myReactionId).toBe(outgoing.id);
  });

  it('removeReaction deletes the reaction and removes it from state', async () => {
    const baseMessage: Message = {
      id: 30,
      messageId: new Uint8Array(12).fill(9),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Multi-reaction',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    };

    const reaction: Message = {
      id: 101,
      messageId: new Uint8Array(12).fill(11),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{1F600}',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    // Incoming reaction from peer should not be affected
    const incomingReaction: Message = {
      id: 103,
      messageId: new Uint8Array(12).fill(12),
      ownerUserId: 'peer-user-id',
      contactUserId,
      content: '\u{2764}\u{FE0F}',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:03:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [baseMessage]]]),
      reactionsByContact: new Map([
        [contactUserId, [reaction, incomingReaction]],
      ]),
    });

    mockSdk.messages.deleteMessage.mockClear();

    // removeReaction takes (reactionDbId)
    await useMessageStore.getState().removeReaction(reaction.id!);

    // The outgoing reaction should be deleted
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(reaction.id);

    // The incoming reaction should still be in state
    const remainingReactions =
      useMessageStore.getState().reactionsByContact.get(contactUserId) ?? [];
    expect(remainingReactions).toHaveLength(1);
    expect(remainingReactions[0].id).toBe(incomingReaction.id);
  });
});
