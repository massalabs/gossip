import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useMessageStore,
  getStableKey,
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
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
      reactionsByContact: new Map(),
      currentContactUserId: null,
      isLoading: false,
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
      confirmedByContact: new Map([[contactUserId, [messageWithId]]]),
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
      confirmedByContact: new Map([[contactUserId, [baseMessage]]]),
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
      confirmedByContact: new Map([[contactUserId, [baseMessage]]]),
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
      confirmedByContact: new Map([[contactUserId, [baseMessage]]]),
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
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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

  it('adds message to optimistic layer immediately with negative id', async () => {
    // SDK send never resolves — simulates in-flight request
    mockSdk.discussions.get.mockReturnValue(
      new Promise(() => {}) as Promise<undefined>
    );

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Hello optimistic');

    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(opts).toHaveLength(1);
    expect(opts![0].id).toBeLessThan(0);
    expect(opts![0].content).toBe('Hello optimistic');
    expect(opts![0].status).toBe(MessageStatus.SENT);
    expect(opts![0].direction).toBe(MessageDirection.OUTGOING);

    // Merged view also shows it
    const merged = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('Hello optimistic');
  });

  it('keeps optimistic message after SDK success (removed on next poll)', async () => {
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

    // Wait for the fire-and-forget to set pendingToRealId (key transferred)
    await vi.waitFor(() => {
      // The stable key for real id 42 should now be seq-based (transferred)
      expect(getStableKey(42)).toMatch(/^msg-seq-/);
    });

    // Optimistic stays in the layer until the next poll cleans it up
    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(opts).toHaveLength(1);
    expect(opts![0].id).toBeLessThan(0);

    // Merged view still shows the message (optimistic, since confirmed is empty)
    const merged = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('Hello swap');
  });

  it('keeps message as pending (clock) on transient SDK error', async () => {
    // A throw from discussions.get() is a transient error — the SDK
    // may have persisted the message. Keep it optimistic (clock icon)
    // and let the SDK retry via stateUpdate.
    mockSdk.discussions.get.mockRejectedValue(new Error('network error'));

    await useMessageStore.getState().sendMessage(contactUserId, 'Will retry');

    // Wait for the fire-and-forget catch to run
    await vi.waitFor(() => {
      // Message should still be in the optimistic layer with SENT status (clock icon)
      const opts = useMessageStore
        .getState()
        .optimisticByContact.get(contactUserId);
      expect(opts).toHaveLength(1);
      expect(opts![0].status).toBe(MessageStatus.SENT);
      expect(opts![0].id).toBeLessThan(0);
    });
  });

  it('keeps message as pending when SDK cannot persist it', async () => {
    // SDK returns { success: false } with no message — programming/infra
    // error. Keep as pending (clock icon), don't mark FAILED.
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: false,
      error: 'Discussion not found',
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'Infra error');

    await vi.waitFor(() => {
      const opts = useMessageStore
        .getState()
        .optimisticByContact.get(contactUserId);
      expect(opts).toHaveLength(1);
      // Stays SENT (pending/clock), not FAILED
      expect(opts![0].status).toBe(MessageStatus.SENT);
      expect(opts![0].id).toBeLessThan(0);
    });
  });

  it('does not send when content is empty', async () => {
    await useMessageStore.getState().sendMessage(contactUserId, '   ');

    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(msgs).toHaveLength(0);
    expect(mockSdk.messages.send).not.toHaveBeenCalled();
  });

  it('does not send when session is closed', async () => {
    mockSdk.isSessionOpen = false;

    await useMessageStore
      .getState()
      .sendMessage(contactUserId, 'Should not send');

    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(msgs).toHaveLength(0);
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
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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

    // Verify optimistic message is in the optimistic layer
    const optsBefore = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(optsBefore).toHaveLength(1);
    expect(optsBefore![0].id).toBeLessThan(0);

    // Now call init() — poll returns empty DB (message not yet persisted)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // The optimistic message should survive the poll (it's in a separate layer)
    const optsAfter = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(optsAfter).toHaveLength(1);
    expect(optsAfter![0].id).toBeLessThan(0);
    expect(optsAfter![0].content).toBe('Optimistic survivor');

    // Merged view includes it
    const merged = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(merged).toHaveLength(1);
    expect(merged[0].content).toBe('Optimistic survivor');
  });
});

describe('ordering and reference stability', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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
      .getMessagesForContact(contactUserId);

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

  it('poll returns same data — returns same array reference (no re-render)', async () => {
    const dbMsg = makeMessage({
      id: 50,
      content: 'Hello from DB',
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    // Set up store with this message already in confirmed layer
    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [dbMsg]]]),
    });

    const refBefore = useMessageStore
      .getState()
      .confirmedByContact.get(contactUserId)!;

    // Poll returns identical data
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([dbMsg]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const refAfter = useMessageStore
      .getState()
      .confirmedByContact.get(contactUserId)!;

    // Same array reference — confirmedChanged detected no changes
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

    // Store already has both messages in confirmed layer
    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [msg1, msg2]]]),
    });

    // Poll returns msg1 unchanged, msg2 upgraded to DELIVERED
    const msg2Upgraded = { ...msg2, status: MessageStatus.DELIVERED };
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([msg1, msg2Upgraded]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    const msgs = useMessageStore
      .getState()
      .confirmedByContact.get(contactUserId)!;

    // Order preserved
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe(60);
    expect(msgs[1].id).toBe(61);

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

    // Wait for SDK confirm (pendingToRealId set, key transferred)
    await vi.waitFor(() => {
      expect(getStableKey(42)).toMatch(/^msg-seq-/);
    });

    // Optimistic still present (stays until poll cleanup)
    const optsBefore = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(optsBefore).toHaveLength(1);

    // Now poll returns id=42 in confirmed — triggers cleanup
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([realMsg]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // After poll: optimistic cleaned up, confirmed has the real message
    const optsAfter = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(optsAfter ?? []).toHaveLength(0);

    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);

    // Exactly 1 message, no duplicate
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(42);
  });

  it('optimistic messages stay at correct position relative to DB messages in merged view', async () => {
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

    // Optimistic message (newest)
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
      confirmedByContact: new Map([[contactUserId, [oldDbMsg, recentDbMsg]]]),
      optimisticByContact: new Map([[contactUserId, [optimisticMsg]]]),
    });

    // Poll returns only the 2 DB messages (optimistic not persisted yet)
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([
      oldDbMsg,
      recentDbMsg,
    ]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // Merged view should show all 3: old, recent, optimistic
    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);

    expect(msgs).toHaveLength(3);
    expect(msgs[0].id).toBe(10);
    expect(msgs[1].id).toBe(11);
    expect(msgs[2].id).toBe(-999);
  });
});

// ── mergeMessages behavior ───────────────────────────────────────

describe('mergeMessages via getMessagesForContact', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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

  it('returns confirmed directly when no optimistic', () => {
    const msg1 = makeMessage({
      id: 1,
      content: 'confirmed only',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [msg1]]]),
    });

    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(1);

    // When no optimistic, should return the confirmed array directly
    const confirmedRef = useMessageStore
      .getState()
      .confirmedByContact.get(contactUserId)!;
    expect(msgs).toBe(confirmedRef);
  });

  it('returns empty array when no messages for contact', () => {
    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(msgs).toHaveLength(0);
  });

  it('poll and send are independent (no guard needed)', async () => {
    // DB has one message
    const dbMsg = makeMessage({
      id: 1,
      content: 'DB msg',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [dbMsg]]]),
    });

    // Send a message (SDK never resolves — stays optimistic)
    mockSdk.discussions.get.mockReturnValue(
      new Promise(() => {}) as Promise<undefined>
    );

    await useMessageStore.getState().sendMessage(contactUserId, 'Optimistic');

    // Optimistic layer has the new message
    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(opts).toHaveLength(1);

    // Confirmed layer is untouched
    const confirmed = useMessageStore
      .getState()
      .confirmedByContact.get(contactUserId);
    expect(confirmed).toHaveLength(1);
    expect(confirmed![0].id).toBe(1);

    // Merged view has both
    const merged = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe(1); // DB msg first (earlier timestamp)
    expect(merged[1].id).toBeLessThan(0); // Optimistic second
  });

  it('excludes optimistic when confirmed has the mapped real id', async () => {
    // Simulate: sendMessage completed, optimistic still present, confirmed
    // now has the real message. The merge should exclude the optimistic.
    const realMsg = makeMessage({
      id: 42,
      content: 'real msg',
      timestamp: new Date('2024-01-01T10:00:00Z'),
    });

    // Go through the real sendMessage flow so pendingToRealId is set
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMsg,
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'real msg');

    // Wait for SDK confirm (pendingToRealId set, key transferred)
    await vi.waitFor(() => {
      expect(getStableKey(42)).toMatch(/^msg-seq-/);
    });

    // Optimistic is still in the layer (new behavior)
    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(opts).toHaveLength(1);

    // Simulate poll adding the confirmed message to confirmed layer
    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [realMsg]]]),
    });

    // Merged view: optimistic is excluded because pendingToRealId maps it
    // to id=42 which exists in confirmed. Only the confirmed version shows.
    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(42);
  });
});

// ── Stable keys (clientSeq) ──────────────────────────────────────

describe('getStableKey', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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

  it('returns stable key for optimistic message', async () => {
    mockSdk.messages.send.mockReturnValue(new Promise(() => {}));
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });

    await useMessageStore.getState().sendMessage(contactUserId, 'key test');

    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId)!;
    const optId = opts[0].id!;

    // Optimistic message should have a seq-based key
    const key = getStableKey(optId);
    expect(key).toMatch(/^msg-seq-\d+$/);
  });

  it('key stays the same after optimistic is removed and real id is assigned', async () => {
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: makeMessage({
        id: 42,
        content: 'key test',
        timestamp: new Date(),
      }),
    });

    await useMessageStore.getState().sendMessage(contactUserId, 'key test');

    // Capture key for optimistic message before SDK resolves
    const optsBefore = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId)!;
    const keyBefore = getStableKey(optsBefore[0].id!);

    // Wait for SDK success (pendingToRealId set, key transferred to real id)
    await vi.waitFor(() => {
      expect(getStableKey(42)).toMatch(/^msg-seq-/);
    });

    // Optimistic still present (stays until poll)
    const optsAfter = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId);
    expect(optsAfter).toHaveLength(1);

    // Key for real id=42 must be the SAME (stable key transferred)
    const keyAfter = getStableKey(42);
    expect(keyAfter).toBe(keyBefore);
  });

  it('each message gets a unique stable key', async () => {
    mockSdk.messages.send.mockReturnValue(new Promise(() => {}));
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });

    await useMessageStore.getState().sendMessage(contactUserId, 'a');
    await useMessageStore.getState().sendMessage(contactUserId, 'a');
    await useMessageStore.getState().sendMessage(contactUserId, 'a');

    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId)!;

    const keys = opts.map(m => getStableKey(m.id!));
    // All keys unique even though content is identical
    expect(new Set(keys).size).toBe(3);
    // All are seq-based
    keys.forEach(k => expect(k).toMatch(/^msg-seq-\d+$/));
  });

  it('incoming messages use plain id key (no seq)', () => {
    // Incoming messages never go through optimistic flow
    const key = getStableKey(99);
    expect(key).toBe('msg-99');
  });

  it('cleanup clears all seq mappings', async () => {
    mockSdk.messages.send.mockReturnValue(new Promise(() => {}));
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });

    await useMessageStore.getState().sendMessage(contactUserId, 'test');

    const opts = useMessageStore
      .getState()
      .optimisticByContact.get(contactUserId)!;
    const optId = opts[0].id!;

    // Before cleanup: seq key
    expect(getStableKey(optId)).toMatch(/^msg-seq-/);

    useMessageStore.getState().cleanup();

    // After cleanup: falls back to plain id key
    expect(getStableKey(optId)).toBe(`msg-${optId}`);
  });
});

// ── Duplicate content bug ────────────────────────────────────────

describe('duplicate content messages', () => {
  const contactUserId = 'contact-1';

  beforeEach(() => {
    useMessageStore.setState({
      confirmedByContact: new Map(),
      optimisticByContact: new Map(),
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

  it('same-content optimistic messages are independent from confirmed messages', async () => {
    // Scenario: 3 identical messages sent within ms.
    // First one confirmed (removed from optimistic, added to confirmed via poll),
    // other two still in-flight in optimistic layer.

    const now = Date.now();

    // First message already confirmed in DB
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

    // Store state: 1 confirmed + 2 optimistic (separate layers)
    useMessageStore.setState({
      ...useMessageStore.getState(),
      confirmedByContact: new Map([[contactUserId, [confirmedMsg]]]),
      optimisticByContact: new Map([[contactUserId, [opt2, opt3]]]),
    });

    // Poll returns only the confirmed message from DB
    mockSdk.discussions.list.mockResolvedValue([{ contactUserId }]);
    mockSdk.messages.getVisibleMessages.mockResolvedValue([
      { ...confirmedMsg }, // fresh copy from DB
    ]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    await useMessageStore.getState().init();

    // Merged view: ALL 3 messages must be present
    const msgs = useMessageStore
      .getState()
      .getMessagesForContact(contactUserId);

    expect(msgs).toHaveLength(3);
    expect(msgs.filter(m => m.id! > 0)).toHaveLength(1);
    expect(msgs.filter(m => m.id! < 0)).toHaveLength(2);
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
      confirmedByContact: new Map([[contactUserId, [baseMessage]]]),
      optimisticByContact: new Map(),
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
