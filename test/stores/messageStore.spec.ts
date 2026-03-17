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

// Mock sdkStore so getSdk() does not throw.
const mockSdk = {
  isSessionOpen: false,
  messages: {
    getVisibleMessages: vi.fn(async () => [] as Message[]),
    getReactions: vi.fn(async () => [] as Message[]),
    get: vi.fn(async () => undefined as unknown as Message | undefined),
    sendReaction: vi.fn(async () => ({ success: true })),
    deleteMessage: vi.fn(async () => true),
  },
  discussions: {
    list: vi.fn(async () => []),
  },
  on: vi.fn(),
  off: vi.fn(),
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
    // Reset store state
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      isSending: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    mockSdk.messages.sendReaction.mockClear();
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('sendReaction forwards emoji and messageId to sdk without deleting existing reactions', async () => {
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
      .sendReaction(contactUserId, '👍', messageWithId.id!);

    expect(mockSdk.messages.sendReaction).toHaveBeenCalledTimes(1);
    expect(mockSdk.messages.sendReaction).toHaveBeenCalledWith(
      contactUserId,
      '👍',
      messageWithId.messageId
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
      content: '😀',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const laterIncoming: Message = {
      ...earlierIncoming,
      id: 2,
      content: '😮',
      timestamp: new Date('2024-01-01T10:02:00Z'),
    };

    const earlierOutgoing: Message = {
      id: 3,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:03:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const laterOutgoing: Message = {
      ...earlierOutgoing,
      id: 4,
      content: '😂',
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

    const groups: ReactionGroup[] = useMessageStore
      .getState()
      .getReactionsForMessage(contactUserId, baseMessage.id!);

    // Only latest per user should be considered: 😮 (incoming) and 😂 (outgoing)
    const emojis = groups.map(g => g.emoji).sort();
    expect(emojis).toEqual(['😂', '😮']);

    const mine = groups.find(g => g.myReactionId != null);
    expect(mine?.emoji).toBe('😂');
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
      content: '🔥',
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
      content: '🔥',
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

    const groups: ReactionGroup[] = useMessageStore
      .getState()
      .getReactionsForMessage(contactUserId, baseMessage.id!);

    expect(groups).toHaveLength(1);
    expect(groups[0].emoji).toBe('🔥');
    expect(groups[0].count).toBe(2);
    expect(groups[0].myReactionId).toBe(outgoing.id);
  });

  it('removeReaction deletes all of the user outgoing reactions for a message', async () => {
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

    const reaction1: Message = {
      id: 101,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '😀',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    const reaction2: Message = {
      id: 102,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '😂',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:02:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    // Incoming reaction from peer should not be affected
    const incomingReaction: Message = {
      id: 103,
      ownerUserId: 'peer-user-id',
      contactUserId,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:03:00Z'),
      reactionOf: { originalMsgId: baseMessage.messageId! },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [baseMessage]]]),
    });

    // When removeReaction is called with the latest outgoing reaction id (tap on chip),
    // the store should delete *all* outgoing reactions for that original message.
    mockSdk.messages.get.mockResolvedValue(reaction2);
    mockSdk.messages.getReactions.mockResolvedValue([
      reaction1,
      reaction2,
      incomingReaction,
    ]);
    mockSdk.messages.deleteMessage.mockClear();

    await useMessageStore.getState().removeReaction(reaction2.id!);

    expect(mockSdk.messages.get).toHaveBeenCalledWith(reaction2.id);
    // Both outgoing reactions should be deleted, incoming left alone
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledTimes(2);
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(reaction1.id);
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(reaction2.id);
  });
});
