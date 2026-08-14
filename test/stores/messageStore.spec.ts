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
  encodeUserId,
  SELF_CONTACT_ID,
} from '@massalabs/gossip-sdk';
import { recomputeFullCache } from '../../src/stores/messageStore.helpers';
import {
  serializeForwardMessage,
  deserializeMessage,
} from '../../gossip-sdk/src/utils/messageSerialization';

// ---------------------------------------------------------------------------
// Mock SDK with event emitter so optimistic sends flow through the store
// ---------------------------------------------------------------------------

type EventHandler = (...args: unknown[]) => void;
const listeners = new Map<string, Set<EventHandler>>();

const mockSdk = {
  isSessionOpen: false,
  messages: {
    getVisibleMessages: vi.fn(async () => [] as Message[]),
    getReactions: vi.fn(async () => [] as Message[]),
    get: vi.fn(async () => undefined as unknown as Message | undefined),
    send: vi.fn(async (message: Omit<Message, 'id'>) => ({
      success: true,
      message: {
        ...message,
        id: Math.floor(Math.random() * 10000),
        messageId:
          message.messageId ?? crypto.getRandomValues(new Uint8Array(12)),
        status: MessageStatus.WAITING_SESSION,
      },
    })),
    findMessageByMsgId: vi.fn(async () => undefined as Message | undefined),
    deleteMessage: vi.fn(async () => true),
    editMessage: vi.fn(async () => true),
  },
  selfMessages: {
    get: vi.fn(async () => undefined as unknown as Message | undefined),
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

vi.mock('../../src/stores/accountStore', async () => {
  const { encodeUserId } = await import('@massalabs/gossip-sdk');
  const ownerUserId = encodeUserId(new Uint8Array(32).fill(1));
  return {
    useAccountStore: {
      getState: vi.fn(() => ({
        userProfile: { userId: ownerUserId },
      })),
    },
  };
});

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

    // removeReaction takes (reactionDbId, reactionMessageId?)
    await useMessageStore
      .getState()
      .removeReaction(reaction.id!, reaction.messageId);

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

describe('MessageStore forward resolution', () => {
  const contactUserId = encodeUserId(new Uint8Array(32).fill(7));

  beforeEach(() => {
    listeners.clear();
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
    mockSdk.messages.get.mockReset();
    mockSdk.selfMessages.get.mockReset();
    useMessageStore.getState().init();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('keeps same-conversation explicit Forward as forwardOf (not replyTo)', async () => {
    const originalMsgId = new Uint8Array(12).fill(9);
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue({
      id: 42,
      content: 'original text',
      contactUserId,
      messageId: originalMsgId,
      ownerUserId: 'test-user-id',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    } satisfies Message);

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, '', undefined, 42);

    expect(mockSdk.selfMessages.get).toHaveBeenCalledWith(42);
    expect(mockSdk.messages.get).toHaveBeenCalledWith(42);
    expect(mockSdk.messages.send).toHaveBeenCalledTimes(1);
    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.replyTo).toBeUndefined();
    expect(sent.forwardOf).toEqual({
      originalContent: 'original text',
      originalContactId: expect.any(Uint8Array),
    });
    expect(sent.forwardOf!.originalContactId).toEqual(
      new Uint8Array(32).fill(7)
    );
  });

  it('keeps Conversation → Conversation forward with peer originalContactId', async () => {
    const peerContactUserId = encodeUserId(new Uint8Array(32).fill(8));
    const originalMsgId = new Uint8Array(12).fill(4);
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue({
      id: 55,
      content: 'from another chat',
      contactUserId: peerContactUserId,
      messageId: originalMsgId,
      ownerUserId: 'peer-owner',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    } satisfies Message);

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'note', undefined, 55);

    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.replyTo).toBeUndefined();
    expect(sent.forwardOf?.originalContent).toBe('from another chat');
    expect(sent.forwardOf?.originalContactId).toEqual(
      new Uint8Array(32).fill(8)
    );
  });

  it('keeps Reply via replyToId unchanged (replyTo, not forwardOf)', async () => {
    const originalMsgId = new Uint8Array(12).fill(5);
    mockSdk.messages.get.mockResolvedValue({
      id: 99,
      content: 'quoted',
      contactUserId,
      messageId: originalMsgId,
      ownerUserId: 'test-user-id',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    } satisfies Message);

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'reply body', 99);

    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.forwardOf).toBeUndefined();
    expect(sent.replyTo).toEqual({ originalMsgId });
    expect(mockSdk.selfMessages.get).not.toHaveBeenCalled();
  });

  it('forwards user-authored Notes → conversation via selfMessages only (no plaintext JSON parse)', async () => {
    const ownerUserId = encodeUserId(new Uint8Array(32).fill(1));
    const ownerContactId = new Uint8Array(32).fill(1);
    // Simulate MessageService throwing if encrypted Notes forwardOf were parsed.
    mockSdk.messages.get.mockImplementation(async () => {
      throw new Error('encrypted Notes forwardOf must not hit MessageService');
    });
    mockSdk.selfMessages.get.mockResolvedValue({
      id: 77,
      content: 'decrypted notes text',
      contactUserId: SELF_CONTACT_ID,
      ownerUserId,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    } satisfies Message);

    await expect(
      useMessageStore.getState().sendMessage(contactUserId, '', undefined, 77)
    ).resolves.toBeUndefined();

    expect(mockSdk.selfMessages.get).toHaveBeenCalledWith(77);
    expect(mockSdk.messages.get).not.toHaveBeenCalled();
    expect(mockSdk.messages.send).toHaveBeenCalledTimes(1);
    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.replyTo).toBeUndefined();
    expect(sent.forwardOf).toEqual({
      originalContent: 'decrypted notes text',
      originalContactId: ownerContactId,
    });

    // Existing FORWARD wire format must round-trip for old and new clients.
    const messageId = new Uint8Array(12).fill(3);
    const wire = serializeForwardMessage(
      sent.forwardOf!.originalContent!,
      sent.content,
      messageId,
      sent.forwardOf!.originalContactId
    );
    const decoded = deserializeMessage(wire);
    expect(decoded.forwardOf?.originalContent).toBe('decrypted notes text');
    expect(decoded.forwardOf?.originalContactId).toEqual(ownerContactId);
  });

  it('re-forwards Conv→Notes (empty composer) using nested forwardOf.originalContent', async () => {
    const ownerUserId = encodeUserId(new Uint8Array(32).fill(1));
    const ownerContactId = new Uint8Array(32).fill(1);
    const peerContactId = new Uint8Array(32).fill(7);
    // After reload, selfMessages.get returns decrypted Note: empty content,
    // body only in forwardOf (as stored by Conv→Notes with no composer text).
    mockSdk.messages.get.mockImplementation(async () => {
      throw new Error('encrypted Notes forwardOf must not hit MessageService');
    });
    mockSdk.selfMessages.get.mockResolvedValue({
      id: 88,
      content: '',
      contactUserId: SELF_CONTACT_ID,
      ownerUserId,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      forwardOf: {
        originalContent: 'original conversation message',
        originalContactId: peerContactId,
      },
    } satisfies Message);

    await expect(
      useMessageStore.getState().sendMessage(contactUserId, '', undefined, 88)
    ).resolves.toBeUndefined();

    expect(mockSdk.selfMessages.get).toHaveBeenCalledWith(88);
    expect(mockSdk.messages.get).not.toHaveBeenCalled();
    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.replyTo).toBeUndefined();
    expect(sent.forwardOf?.originalContent).toBe(
      'original conversation message'
    );
    expect(sent.forwardOf?.originalContactId).toEqual(ownerContactId);

    const messageId = new Uint8Array(12).fill(6);
    const wire = serializeForwardMessage(
      sent.forwardOf!.originalContent!,
      sent.content,
      messageId,
      sent.forwardOf!.originalContactId
    );
    const decoded = deserializeMessage(wire);
    expect(decoded.forwardOf?.originalContent).toBe(
      'original conversation message'
    );
    expect(decoded.forwardOf?.originalContent?.length).toBeGreaterThan(0);
    expect(decoded.forwardOf?.originalContactId).toEqual(ownerContactId);
  });

  it('skips SELF_CONTACT_ID on init so encrypted Notes forwardOf never hits MessageService', async () => {
    useMessageStore.getState().cleanup();
    listeners.clear();
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      reactionGroupsCache: new Map(),
      currentContactUserId: null,
      cleanupFn: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.discussions.list.mockResolvedValue([
      { contactUserId: SELF_CONTACT_ID },
      { contactUserId },
    ]);
    mockSdk.messages.getVisibleMessages.mockImplementation(
      async (id: string) => {
        if (id === SELF_CONTACT_ID) {
          throw new Error(
            'getVisibleMessages(SELF) must not run after Conv→Notes'
          );
        }
        return [];
      }
    );
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await expect(useMessageStore.getState().init()).resolves.toBeUndefined();

    expect(mockSdk.messages.getVisibleMessages).toHaveBeenCalledWith(
      contactUserId
    );
    expect(mockSdk.messages.getVisibleMessages).not.toHaveBeenCalledWith(
      SELF_CONTACT_ID
    );
    expect(mockSdk.messages.getReactions).not.toHaveBeenCalledWith(
      SELF_CONTACT_ID
    );
  });

  it('re-forwards a forward-only DM with a non-empty wire payload', async () => {
    const originalMsgId = new Uint8Array(12).fill(4);
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue({
      id: 90,
      content: '',
      contactUserId,
      messageId: originalMsgId,
      ownerUserId: 'test-user-id',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      forwardOf: { originalContent: 'cited body' },
    } satisfies Message);

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, '', undefined, 90);

    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.forwardOf?.originalContent).toBe('cited body');
    const wire = serializeForwardMessage(
      sent.forwardOf!.originalContent!,
      sent.content,
      new Uint8Array(12).fill(6),
      sent.forwardOf!.originalContactId
    );
    expect(deserializeMessage(wire).forwardOf?.originalContent).toBe(
      'cited body'
    );
  });

  it('preserves a forwarded DM cited body and comment', async () => {
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue({
      id: 91,
      content: 'comment',
      contactUserId,
      messageId: new Uint8Array(12).fill(5),
      ownerUserId: 'test-user-id',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      forwardOf: { originalContent: 'cited body' },
    } satisfies Message);

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, '', undefined, 91);

    const sent = mockSdk.messages.send.mock.calls[0][0] as Message;
    expect(sent.forwardOf?.originalContent).toBe('cited body\n\ncomment');
  });

  it('fails closed when a forward source no longer exists', async () => {
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue(undefined);

    await expect(
      useMessageStore.getState().sendMessage(contactUserId, '', undefined, 999)
    ).rejects.toThrow('Forward target not found');

    expect(mockSdk.messages.send).not.toHaveBeenCalled();
    expect(
      useMessageStore.getState().getMessagesForContact(contactUserId)
    ).toHaveLength(0);
  });
});
