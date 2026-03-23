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
    send: vi.fn(async () => ({ success: true })),
    sendReaction: vi.fn(async () => ({ success: true })),
    deleteMessage: vi.fn(async () => true),
  },
  discussions: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
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

    useMessageStore.getState().removeReaction(contactUserId, reaction2.id!);

    // removeReaction is fire-and-forget — wait for the async SDK calls
    await vi.waitFor(() => {
      expect(mockSdk.messages.deleteMessage).toHaveBeenCalledTimes(2);
    });

    expect(mockSdk.messages.get).toHaveBeenCalledWith(reaction2.id);
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(reaction1.id);
    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(reaction2.id);
  });
});

describe('sendMessage optimistic flow', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('adds message to store immediately with negative id', async () => {
    // SDK send never resolves — simulates in-flight request
    mockSdk.discussions.get.mockReturnValue(
      new Promise(() => {}) as Promise<undefined>
    );

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Hello optimistic');

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgs).toHaveLength(1);
    expect(msgs![0].id).toBeLessThan(0);
    expect(msgs![0].content).toBe('Hello optimistic');
    expect(msgs![0].status).toBe(MessageStatus.SENT);
    expect(msgs![0].direction).toBe(MessageDirection.OUTGOING);
  });

  it('swaps negative id for real id on SDK success', async () => {
    const realMessage: Message = {
      id: 42,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Hello swap',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    };

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMessage,
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'Hello swap');

    // The fire-and-forget async block runs in the background.
    // Wait until the store has the swapped message with real id.
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].id).toBe(42);
    });
  });

  it('marks message as FAILED on SDK error instead of removing', async () => {
    mockSdk.discussions.get.mockRejectedValue(new Error('network error'));

    await useMessageStore.getState().sendMessage(contactUserId, 'Will fail');

    // After the fire-and-forget block catches the error, the message stays with FAILED status.
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].status).toBe(MessageStatus.FAILED);
      expect(msgs![0].content).toBe('Will fail');
      expect(msgs![0].id).toBeLessThan(0);
    });
  });

  it('retryMessage re-sends failed message and swaps id on success', async () => {
    // First: send a message that fails
    mockSdk.discussions.get.mockRejectedValue(new Error('network error'));

    await useMessageStore.getState().sendMessage(contactUserId, 'Retry me');

    // Wait for FAILED status
    let failedId: number;
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].status).toBe(MessageStatus.FAILED);
      failedId = msgs![0].id!;
    });

    // Now set up SDK to succeed on retry
    const realMessage: Message = {
      id: 77,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Retry me',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    };
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMessage,
    });

    // Retry
    useMessageStore.getState().retryMessage(contactUserId, failedId!);

    // Immediately after retry call, status should be SENT (pending)
    const msgsImmediate = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgsImmediate).toHaveLength(1);
    expect(msgsImmediate![0].status).toBe(MessageStatus.SENT);

    // Wait for the swap to complete
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].id).toBe(77);
    });
  });

  it('retryMessage marks FAILED again on second failure', async () => {
    // Send a message that fails
    mockSdk.discussions.get.mockRejectedValue(new Error('network error'));

    await useMessageStore.getState().sendMessage(contactUserId, 'Double fail');

    let failedId: number;
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].status).toBe(MessageStatus.FAILED);
      failedId = msgs![0].id!;
    });

    // Retry but SDK fails again
    mockSdk.discussions.get.mockRejectedValue(new Error('still broken'));

    useMessageStore.getState().retryMessage(contactUserId, failedId!);

    // Wait for FAILED status to return
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].status).toBe(MessageStatus.FAILED);
    });
  });

  it('preserves higher status on swap (no downgrade)', async () => {
    const realMessage: Message = {
      id: 99,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Status test',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION, // lower status from SDK
      timestamp: new Date(),
    };

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMessage,
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'Status test');

    // Wait for the swap
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs).toHaveLength(1);
      expect(msgs![0].id).toBe(99);
    });

    // Status should remain SENT (higher rank), not downgrade to WAITING_SESSION
    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgs![0].status).toBe(MessageStatus.SENT);
  });

  it('preserves optimistic timestamp during id swap', async () => {
    const optimisticTimestamp = new Date('2025-06-01T12:00:00.000Z');
    vi.setSystemTime(optimisticTimestamp);

    const sdkTimestamp = new Date('2025-06-01T12:00:00.500Z'); // 500ms later
    const realMessage: Message = {
      id: 77,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Timestamp test',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: sdkTimestamp,
    };

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMessage,
    });

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Timestamp test');

    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId);
      expect(msgs![0].id).toBe(77);
    });

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    // Timestamp must stay as the optimistic one, NOT the SDK's
    expect(msgs![0].timestamp.getTime()).toBe(optimisticTimestamp.getTime());

    vi.useRealTimers();
  });

  it('does not send when content is empty', async () => {
    await useMessageStore.getState().sendMessage(contactUserId, '   ');

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgs).toBeUndefined();
    expect(mockSdk.messages.send).not.toHaveBeenCalled();
  });

  it('does not send when session is closed', async () => {
    mockSdk.isSessionOpen = false;

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Should not send');

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgs).toBeUndefined();
    expect(mockSdk.messages.send).not.toHaveBeenCalled();
  });
});

// ── Helpers for reconciliation / ordering tests ──────────────────

function makeMessage(overrides: Partial<Message> & { id: number }): Message {
  return {
    ownerUserId: 'test-user-id',
    contactUserId: 'contact-1',
    content: `msg-${overrides.id}`,
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('reconciliation with polling', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('optimistic message survives poll until confirmed', async () => {
    // SDK send never resolves — simulates in-flight request
    mockSdk.discussions.get.mockReturnValue(
      new Promise(() => {}) as Promise<undefined>
    );

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Optimistic survivor');

    // Verify optimistic message is in store
    const msgsBeforePoll = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgsBeforePoll).toHaveLength(1);
    expect(msgsBeforePoll![0].id).toBeLessThan(0);

    // Now call init() — poll returns empty DB (message not yet persisted)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // The optimistic message should survive the poll
    const msgsAfterPoll = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgsAfterPoll).toHaveLength(1);
    expect(msgsAfterPoll![0].id).toBeLessThan(0);
    expect(msgsAfterPoll![0].content).toBe('Optimistic survivor');
  });

  it('failed messages are preserved during reconciliation', async () => {
    const failedMsg: Message = {
      id: -5,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Failed msg',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [failedMsg]]]),
    });

    // Poll returns empty — message not in DB
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId);
    expect(msgs).toHaveLength(1);
    expect(msgs![0].status).toBe(MessageStatus.FAILED);
    expect(msgs![0].id).toBe(-5);
  });
});

describe('ordering and reference stability', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('rapid sends preserve chronological order', async () => {
    // SDK send never resolves — all stay optimistic
    mockSdk.discussions.get.mockReturnValue(
      new Promise(() => {}) as Promise<undefined>
    );

    for (let i = 0; i < 5; i++) {
      await useMessageStore
        .getState()
        .sendMessage(contactUserId, `Message ${i}`);
    }

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    expect(msgs).toHaveLength(5);

    // All have unique negative IDs
    const ids = msgs.map(m => m.id!);
    expect(new Set(ids).size).toBe(5);
    ids.forEach(id => expect(id).toBeLessThan(0));

    // Non-decreasing timestamps (chronological order)
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].timestamp.getTime()).toBeGreaterThanOrEqual(
        msgs[i - 1].timestamp.getTime()
      );
    }

    // Content in order
    for (let i = 0; i < 5; i++) {
      expect(msgs[i].content).toBe(`Message ${i}`);
    }
  });

  it('confirmed messages maintain order after id swap', async () => {
    const realMsg1: Message = makeMessage({
      id: 100,
      content: 'First',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });
    const realMsg2: Message = makeMessage({
      id: 101,
      content: 'Second',
      timestamp: new Date('2024-01-01T10:01:00Z'),
    });

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    let sendCount = 0;
    mockSdk.messages.send.mockImplementation(async () => {
      sendCount++;
      return {
        success: true,
        message: sendCount === 1 ? realMsg1 : realMsg2,
      };
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'First');
    await useMessageStore.getState().sendMessage(contactUserId, 'Second');

    // Wait for both swaps to complete
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId)!;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].id).toBe(100);
      expect(msgs[1].id).toBe(101);
    });

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;
    expect(msgs[0].content).toBe('First');
    expect(msgs[1].content).toBe('Second');
  });

  it('poll returns same data — returns same array reference (no re-render)', async () => {
    const dbMsg = makeMessage({
      id: 50,
      content: 'Hello from DB',
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    // Set up store with this message already in it
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [dbMsg]]]),
    });

    const refBefore = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Poll returns identical data
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([dbMsg]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const refAfter = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Same array reference — reconcile detected no changes
    expect(refAfter).toBe(refBefore);
  });

  it('poll with status upgrade returns new reference but preserves order', async () => {
    const msg1 = makeMessage({
      id: 60,
      content: 'First',
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });
    const msg2 = makeMessage({
      id: 61,
      content: 'Second',
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:01:00Z'),
    });

    // Store already has both messages
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [msg1, msg2]]]),
    });

    const originalMsg1Ref = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)![0];

    // Poll returns msg1 unchanged, msg2 upgraded to DELIVERED
    const msg2Upgraded = { ...msg2, status: MessageStatus.DELIVERED };
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([msg1, msg2Upgraded]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Order preserved
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe(60);
    expect(msgs[1].id).toBe(61);

    // Unchanged message is the SAME reference
    expect(msgs[0]).toBe(originalMsg1Ref);

    // Upgraded message has new status
    expect(msgs[1].status).toBe(MessageStatus.DELIVERED);
  });

  it('no duplicates when SDK confirms and poll returns same message', async () => {
    const realMsg: Message = makeMessage({
      id: 42,
      content: 'No dupes',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMsg,
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'No dupes');

    // Wait for SDK confirm (swap optimistic → real id=42)
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId)!;
      expect(msgs[0].id).toBe(42);
    });

    // Now poll also returns id=42
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([realMsg]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Exactly 1 message, no duplicate
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(42);
  });

  it('optimistic messages stay at correct position relative to DB messages during poll', async () => {
    const oldDbMsg = makeMessage({
      id: 10,
      content: 'Old DB message',
      timestamp: new Date('2024-01-01T09:00:00Z'),
    });
    const recentDbMsg = makeMessage({
      id: 11,
      content: 'Recent DB message',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    // Store has 2 DB messages + 1 optimistic (newest)
    const optimisticMsg: Message = {
      id: -999,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Optimistic newest',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T11:00:00Z'),
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([
        [contactUserId, [oldDbMsg, recentDbMsg, optimisticMsg]],
      ]),
    });

    // Poll returns only the 2 DB messages (optimistic not persisted yet)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([
      oldDbMsg,
      recentDbMsg,
    ]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // All 3 present: old, recent, optimistic
    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe(10);
    expect(msgs[1].id).toBe(11);
    expect(msgs[2].id).toBe(-999);
  });

  it('poll during in-flight send preserves message reference for existing messages', async () => {
    const contactUserId = 'contact-1';

    // Existing DB message
    const dbMsg = makeMessage({
      id: 1,
      content: 'Existing',
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [dbMsg]]]),
    });

    // SDK send never resolves — simulates in-flight send
    mockSdk.messages.send.mockReturnValue(new Promise(() => {}));
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });

    await useMessageStore.getState().sendMessage(contactUserId, 'New msg');

    const msgsBeforePoll = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;
    expect(msgsBeforePoll).toHaveLength(2);

    // Poll fires — returns only the DB message (optimistic not in DB yet)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([dbMsg]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgsAfterPoll = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Both messages should still be present
    expect(msgsAfterPoll).toHaveLength(2);
    expect(msgsAfterPoll[0].id).toBe(1);
    expect(msgsAfterPoll[1].id).toBeLessThan(0);

    // Key check: is the existing DB message the SAME reference? (no unnecessary re-render)
    expect(msgsAfterPoll[0]).toBe(msgsBeforePoll[0]);
  });

  it('race: poll with stale data does not drop recently-swapped message', async () => {
    const realMsg: Message = makeMessage({
      id: 42,
      content: 'Race msg',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMsg,
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'Race msg');

    // Wait for SDK confirm (swap to real id=42)
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId)!;
      expect(msgs[0].id).toBe(42);
    });

    // Poll returns EMPTY (stale data — hasn't caught up)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // Message survives thanks to pendingToRealId keeping it
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(42);
  });
});

// ── Duplicate content bug ────────────────────────────────────────

describe('duplicate content messages', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      messagesByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('same-content optimistic messages are not falsely confirmed by a single DB match', async () => {
    // Simulate the real scenario: 3 identical messages sent within ms.
    // First one confirmed (id swapped), other two still in-flight.
    // A poll returns only the first from DB.
    // The fallback heuristic in isConfirmed() must NOT falsely match
    // the unconfirmed messages to the same DB message.

    const now = Date.now();

    // First message already confirmed in store (swapped to real id=100)
    const confirmedMsg: Message = makeMessage({
      id: 100,
      content: 'a',
      timestamp: new Date(now),
    });

    // Two optimistic messages still in-flight (SDK hasn't returned)
    const opt2: Message = {
      id: -2,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'a',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(now + 10), // 10ms later
    };
    const opt3: Message = {
      id: -3,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'a',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(now + 20), // 20ms later
    };

    // Store state: 1 confirmed + 2 optimistic
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [confirmedMsg, opt2, opt3]]]),
    });

    // Poll returns only the confirmed message from DB
    // (with matching timestamp — within 5s window)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([
      { ...confirmedMsg }, // fresh copy from DB
    ]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;

    // ALL 3 messages must survive: 1 confirmed (id=100) + 2 optimistic (id<0)
    expect(msgs).toHaveLength(3);
    expect(msgs.filter(m => m.id! > 0)).toHaveLength(1);
    expect(msgs.filter(m => m.id! < 0)).toHaveLength(2);
  });

  it('no duplicate ids when poll adds DB message before swap completes', async () => {
    // Race condition: poll returns real id=74 BEFORE the SDK send callback
    // runs the swap. After reconcile, store has [id=74(DB), id=-5(unconfirmed)].
    // Then swap tries to replace id=-5 with id=74 → must not create a duplicate.

    const now = Date.now();

    // Simulate post-reconcile state: DB message already in store + optimistic still present
    const dbMsg: Message = makeMessage({
      id: 74,
      content: 'race test',
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(now),
    });
    const optMsg: Message = {
      id: -5,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'race test',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(now),
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [dbMsg, optMsg]]]),
    });

    // Now simulate what sendMessage's fire-and-forget does after SDK returns:
    // It calls set() to swap the optimistic message.
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: { ...dbMsg },
    });

    // Trigger a real send — the store already has both messages,
    // and the send will try to swap id=-5 to id=74.
    // We do this by calling sendMessage which creates a NEW optimistic msg,
    // so instead let's test the swap logic directly by sending and
    // manipulating the store state before the swap runs.

    // Simpler approach: directly invoke sendMessage. The fire-and-forget
    // will find id=-5 does NOT exist (sendMessage creates a NEW optimistic id).
    // So let's just test via the store's internal swap logic.

    // Actually, the cleanest way: use sendMessage and set up the state
    // so that a poll-added message exists when the swap callback runs.
    // We can do this by sending, then injecting the DB message before
    // the SDK resolves.

    // Use a controlled promise for the SDK send
    let resolveSend!: (v: { success: boolean; message: Message }) => void;
    mockSdk.messages.send.mockReturnValue(
      new Promise(r => {
        resolveSend = r;
      })
    );

    // Reset store
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map(),
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'race test');

    // Store has one optimistic message
    const msgsAfterSend = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;
    expect(msgsAfterSend).toHaveLength(1);
    const optId = msgsAfterSend[0].id!;
    expect(optId).toBeLessThan(0);

    // Simulate poll adding the DB message (race: DB got it before SDK returned)
    const realDbMsg = makeMessage({
      id: 74,
      content: 'race test',
      status: MessageStatus.WAITING_SESSION,
      timestamp: msgsAfterSend[0].timestamp,
    });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([
        [contactUserId, [realDbMsg, msgsAfterSend[0]]],
      ]),
    });

    // Now resolve the SDK send — the swap callback will run
    resolveSend({ success: true, message: { ...realDbMsg } });

    // Wait for the swap to complete
    await vi.waitFor(() => {
      const msgs = useMessageStore
        .getState()
        .messagesByContact.get(contactUserId)!;
      // Must be exactly 1 message, NOT 2 with the same id
      expect(msgs).toHaveLength(1);
    });

    const finalMsgs = useMessageStore
      .getState()
      .messagesByContact.get(contactUserId)!;
    expect(finalMsgs[0].id).toBe(74);
    // Status should be SENT (preserved from optimistic, higher than WAITING_SESSION)
    expect(finalMsgs[0].status).toBe(MessageStatus.SENT);
  });
});

// ── Optimistic reactions ─────────────────────────────────────────

describe('optimistic reactions', () => {
  const contactUserId = 'contact-1';
  const messageId = new Uint8Array(12).fill(42);

  /** A confirmed text message that reactions target. */
  const baseMessage: Message = {
    id: 1,
    messageId,
    ownerUserId: 'test-user-id',
    contactUserId,
    content: 'Hello',
    type: MessageType.TEXT,
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date('2024-01-01T10:00:00Z'),
  };

  beforeEach(() => {
    useMessageStore.setState({
      messagesByContact: new Map([[contactUserId, [baseMessage]]]),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
      pollTimer: null,
      eventHandler: null,
      cancelDebounce: null,
      isInitializing: false,
    } as unknown as ReturnType<(typeof useMessageStore)['getState']>);

    mockSdk.isSessionOpen = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('reaction appears immediately in store with negative id', () => {
    // SDK sendReaction never resolves — simulates in-flight request
    mockSdk.messages.sendReaction.mockReturnValue(new Promise(() => {}));

    useMessageStore
      .getState()
      .sendReaction(contactUserId, '👍', baseMessage.id!);

    const reactions = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactions).toHaveLength(1);
    expect(reactions![0].id).toBeLessThan(0);
    expect(reactions![0].content).toBe('👍');
    expect(reactions![0].type).toBe(MessageType.REACTION);
    expect(reactions![0].direction).toBe(MessageDirection.OUTGOING);
    expect(reactions![0].reactionOf?.originalMsgId).toEqual(messageId);
  });

  it('reaction swaps to real id on SDK success', async () => {
    const realReaction: Message = {
      id: 99,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '❤️',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      reactionOf: { originalMsgId: messageId },
    };

    mockSdk.messages.sendReaction.mockResolvedValue({
      success: true,
      message: realReaction,
    });

    useMessageStore
      .getState()
      .sendReaction(contactUserId, '❤️', baseMessage.id!);

    // Immediately: optimistic reaction with negative id
    const reactionsImmediate = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactionsImmediate).toHaveLength(1);
    expect(reactionsImmediate![0].id).toBeLessThan(0);

    // After fire-and-forget resolves: swapped to real id
    await vi.waitFor(() => {
      const reactions = useMessageStore
        .getState()
        .reactionsByContact.get(contactUserId);
      expect(reactions).toHaveLength(1);
      expect(reactions![0].id).toBe(99);
    });
  });

  it('reaction is rolled back on SDK error', async () => {
    mockSdk.messages.sendReaction.mockRejectedValue(new Error('network error'));

    useMessageStore
      .getState()
      .sendReaction(contactUserId, '😂', baseMessage.id!);

    // Immediately: optimistic reaction exists
    const reactionsImmediate = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactionsImmediate).toHaveLength(1);
    expect(reactionsImmediate![0].id).toBeLessThan(0);
    expect(reactionsImmediate![0].content).toBe('😂');

    // After error: reaction is rolled back (removed)
    await vi.waitFor(() => {
      const reactions = useMessageStore
        .getState()
        .reactionsByContact.get(contactUserId);
      expect(reactions).toHaveLength(0);
    });
  });

  it('optimistic reaction survives poll until confirmed', async () => {
    // SDK sendReaction never resolves — stays optimistic
    mockSdk.messages.sendReaction.mockReturnValue(new Promise(() => {}));

    useMessageStore
      .getState()
      .sendReaction(contactUserId, '🔥', baseMessage.id!);

    // Verify optimistic reaction is in store
    const reactionsBefore = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactionsBefore).toHaveLength(1);
    expect(reactionsBefore![0].id).toBeLessThan(0);

    // Poll returns empty reactions from DB
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([baseMessage]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // Optimistic reaction survives the poll
    const reactionsAfter = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactionsAfter).toHaveLength(1);
    expect(reactionsAfter![0].id).toBeLessThan(0);
    expect(reactionsAfter![0].content).toBe('🔥');
  });

  it('removeReaction removes from store immediately', () => {
    // Set up a confirmed reaction in the store
    const confirmedReaction: Message = {
      id: 50,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      reactionOf: { originalMsgId: messageId },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      reactionsByContact: new Map([[contactUserId, [confirmedReaction]]]),
    });

    // Mock SDK calls to never resolve (so we only test the synchronous removal)
    mockSdk.messages.get.mockReturnValue(new Promise(() => {}));

    useMessageStore.getState().removeReaction(contactUserId, 50);

    // Reaction is gone immediately
    const reactions = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactions).toHaveLength(0);
  });

  it('removeReaction rolls back on SDK delete error', async () => {
    const confirmedReaction: Message = {
      id: 50,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '👍',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      reactionOf: { originalMsgId: messageId },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      reactionsByContact: new Map([[contactUserId, [confirmedReaction]]]),
    });

    // SDK get rejects — triggers rollback
    mockSdk.messages.get.mockRejectedValue(new Error('db error'));

    useMessageStore.getState().removeReaction(contactUserId, 50);

    // Immediately: removed from store
    const reactionsImmediate = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactionsImmediate).toHaveLength(0);

    // After error: rolled back (re-added)
    await vi.waitFor(() => {
      const reactions = useMessageStore
        .getState()
        .reactionsByContact.get(contactUserId);
      expect(reactions).toHaveLength(1);
      expect(reactions![0].id).toBe(50);
      expect(reactions![0].content).toBe('👍');
    });
  });

  it('removing optimistic reaction (negative id) does not call SDK', () => {
    // Add an optimistic reaction directly to the store
    const optimisticReaction: Message = {
      id: -77,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '😮',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      reactionOf: { originalMsgId: messageId },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      reactionsByContact: new Map([[contactUserId, [optimisticReaction]]]),
    });

    useMessageStore.getState().removeReaction(contactUserId, -77);

    // Reaction is removed from store
    const reactions = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(reactions).toHaveLength(0);

    // No SDK calls — negative id means no DB row to delete
    expect(mockSdk.messages.get).not.toHaveBeenCalled();
    expect(mockSdk.messages.deleteMessage).not.toHaveBeenCalled();
  });
});
