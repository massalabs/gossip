import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useMessageStore } from '../../src/stores/messageStore';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  SdkEventType,
} from '@massalabs/gossip-sdk';

// ---------------------------------------------------------------------------
// Mock SDK with event emitter
// ---------------------------------------------------------------------------

type EventHandler = (payload: unknown) => void;
const listeners = new Map<string, Set<EventHandler>>();

function emit(event: string, payload: unknown) {
  const handlers = listeners.get(event);
  if (handlers) {
    for (const handler of handlers) handler(payload);
  }
}

const mockSdk = {
  isSessionOpen: true,
  messages: {
    getVisibleMessages: vi.fn(async () => [] as Message[]),
    getReactions: vi.fn(async () => [] as Message[]),
    get: vi.fn(async () => undefined as Message | undefined),
    send: vi.fn(async () => ({ success: true })),
    findMessageByMsgId: vi.fn(async () => undefined as Message | undefined),
    deleteMessage: vi.fn(async () => true),
    editMessage: vi.fn(async () => true),
  },
  discussions: { list: vi.fn(async () => []) },
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const contactUserId = 'contact-1';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    messageId: new Uint8Array(12).fill(1),
    ownerUserId: 'test-user-id',
    contactUserId,
    content: 'Hello world',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

function getMessages(): Message[] {
  return useMessageStore.getState().messagesByContact.get(contactUserId) ?? [];
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

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
  mockSdk.messages.deleteMessage.mockReset().mockResolvedValue(true);
  mockSdk.messages.editMessage.mockReset().mockResolvedValue(true);
  mockSdk.messages.send.mockReset().mockResolvedValue({ success: true });
  mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
  mockSdk.messages.getReactions.mockResolvedValue([]);

  useMessageStore.getState().init();
});

afterEach(() => {
  useMessageStore.getState().cleanup();
});

// ---------------------------------------------------------------------------
// A) Delete — store-action tests
// ---------------------------------------------------------------------------

describe('deleteMessage optimistic action', () => {
  it('marks message as DELETED in store immediately (before SDK resolves)', async () => {
    const message = makeMessage();

    // SDK never resolves during our check — use a deferred promise
    let resolveDelete!: (v: boolean) => void;
    mockSdk.messages.deleteMessage.mockImplementation(
      () =>
        new Promise<boolean>(r => {
          resolveDelete = r;
        })
    );

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    // Fire but don't await — we want to inspect state before SDK resolves
    const deletePromise = useMessageStore
      .getState()
      .deleteMessage(contactUserId, message.id!);

    // Store should already show DELETED while SDK is still pending
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MessageType.DELETED);
    expect(msgs[0].content).toBe('[Message deleted]');

    // Let SDK resolve so the promise settles cleanly
    resolveDelete(true);
    await deletePromise;
  });

  it('removes reactions from reactionsByContact for the deleted message', async () => {
    const message = makeMessage({
      id: 10,
      messageId: new Uint8Array(12).fill(10),
    });
    const reactionForTarget: Message = {
      id: 20,
      messageId: new Uint8Array(12).fill(20),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{1F44D}',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: new Uint8Array(12).fill(10) },
    };
    const reactionForOther: Message = {
      id: 30,
      messageId: new Uint8Array(12).fill(30),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u2764\uFE0F',
      type: MessageType.REACTION,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date('2024-01-01T10:02:00Z'),
      reactionOf: { originalMsgId: new Uint8Array(12).fill(99) },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
      reactionsByContact: new Map([
        [contactUserId, [reactionForTarget, reactionForOther]],
      ]),
    });

    await useMessageStore.getState().deleteMessage(contactUserId, message.id!);

    // The message should be marked as deleted
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MessageType.DELETED);

    // Only the reaction for the other message should remain
    const remainingReactions =
      useMessageStore.getState().reactionsByContact.get(contactUserId) ?? [];
    expect(remainingReactions).toHaveLength(1);
    expect(remainingReactions[0].content).toBe('\u2764\uFE0F');
    expect(remainingReactions[0].id).toBe(30);
  });

  it('rolls back on SDK failure (restores original message)', async () => {
    const message = makeMessage({ content: 'Original content' });

    mockSdk.messages.deleteMessage.mockRejectedValue(
      new Error('Network error')
    );

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    await expect(
      useMessageStore.getState().deleteMessage(contactUserId, message.id!)
    ).rejects.toThrow('Network error');

    // Should have rolled back to original
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MessageType.TEXT);
    expect(msgs[0].content).toBe('Original content');
  });

  it('removes all reactions when all reference the deleted message', async () => {
    const message = makeMessage({
      id: 10,
      messageId: new Uint8Array(12).fill(10),
    });
    const reaction: Message = {
      id: 20,
      messageId: new Uint8Array(12).fill(20),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '\u{1F44D}',
      type: MessageType.REACTION,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date('2024-01-01T10:01:00Z'),
      reactionOf: { originalMsgId: new Uint8Array(12).fill(10) },
    };

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
      reactionsByContact: new Map([[contactUserId, [reaction]]]),
    });

    await useMessageStore.getState().deleteMessage(contactUserId, message.id!);

    // When all reactions are removed, the contact entry should be deleted from the map
    const remainingReactions = useMessageStore
      .getState()
      .reactionsByContact.get(contactUserId);
    expect(remainingReactions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B) Edit — store-action tests
// ---------------------------------------------------------------------------

describe('editMessage optimistic action', () => {
  it('patches content and adds { edited: true } metadata in store immediately', async () => {
    const message = makeMessage();

    let resolveEdit!: (v: boolean) => void;
    mockSdk.messages.editMessage.mockImplementation(
      () =>
        new Promise<boolean>(r => {
          resolveEdit = r;
        })
    );

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    const editPromise = useMessageStore
      .getState()
      .editMessage(contactUserId, message.id!, 'Edited content');

    // Store should already show the edit while SDK is still pending
    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Edited content');
    expect(msgs[0].metadata).toEqual(expect.objectContaining({ edited: true }));

    resolveEdit(true);
    await editPromise;
  });

  it('rolls back on SDK failure (restores original content)', async () => {
    const message = makeMessage({ content: 'Original' });

    mockSdk.messages.editMessage.mockRejectedValue(new Error('Network error'));

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    await expect(
      useMessageStore
        .getState()
        .editMessage(contactUserId, message.id!, 'Edited')
    ).rejects.toThrow('Network error');

    // Should have rolled back to original
    const msgs = getMessages();
    expect(msgs[0].content).toBe('Original');
    expect(msgs[0].type).toBe(MessageType.TEXT);
  });
});

// ---------------------------------------------------------------------------
// C) Control message filtering
// ---------------------------------------------------------------------------

describe('control message filtering', () => {
  it('onSent is a no-op for messages with deleteOf (control messages)', () => {
    const message = makeMessage();
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    const contentBefore = getMessages()[0].content;

    // Fire MESSAGE_SENT for a delete control message (different messageId)
    emit(SdkEventType.MESSAGE_SENT, {
      id: 999,
      messageId: new Uint8Array(12).fill(99),
      ownerUserId: 'test-user-id',
      contactUserId,
      content: '',
      type: MessageType.DELETED,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      deleteOf: { originalMsgId: message.messageId! },
    } as Message);

    // State should not change — the control message has its own messageId
    expect(getMessages()[0].content).toBe(contentBefore);
    expect(getMessages()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D) Session event merge
// ---------------------------------------------------------------------------

describe('onSessionEvent merge', () => {
  it('preserves WAITING_SESSION messages not yet in DB', async () => {
    const persisted = makeMessage({ id: 1, status: MessageStatus.SENT });
    const optimistic = makeMessage({
      id: undefined,
      messageId: new Uint8Array(12).fill(42),
      content: 'Pending send',
      status: MessageStatus.WAITING_SESSION,
    });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [persisted, optimistic]]]),
      currentContactUserId: contactUserId,
    });

    // DB only returns the persisted message
    mockSdk.messages.getVisibleMessages.mockResolvedValue([persisted]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    // Trigger session event
    emit(SdkEventType.SESSION_CREATED, {
      contactUserId,
      id: 1,
    });

    // Wait for async handler
    await vi.waitFor(() => {
      const msgs = getMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(2);
    });

    const msgs = getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs.some(m => m.content === 'Pending send')).toBe(true);
    expect(msgs.some(m => m.id === 1)).toBe(true);
  });

  it('replaces confirmed messages with DB data', async () => {
    const stale = makeMessage({ id: 1, content: 'Old content' });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [stale]]]),
      currentContactUserId: contactUserId,
    });

    const fresh = makeMessage({ id: 1, content: 'Updated from DB' });
    mockSdk.messages.getVisibleMessages.mockResolvedValue([fresh]);
    mockSdk.messages.getReactions.mockResolvedValue([]);

    emit(SdkEventType.SESSION_CREATED, {
      contactUserId,
      id: 1,
    });

    await vi.waitFor(() => {
      expect(getMessages()[0].content).toBe('Updated from DB');
    });
  });
});

// ---------------------------------------------------------------------------
// E) Acknowledge (SENT -> DELIVERED) via SDK events
// ---------------------------------------------------------------------------

describe('acknowledge via SDK events', () => {
  it('MESSAGE_ACKNOWLEDGED updates message status from SENT to DELIVERED', () => {
    const message = makeMessage({ status: MessageStatus.SENT });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    // Simulate SDK emitting the acknowledge event
    emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
      contactUserId,
      messageDbId: message.id!,
    });

    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe(MessageStatus.DELIVERED);
  });

  it('MESSAGE_ACKNOWLEDGED is a no-op for messages not in state', () => {
    const message = makeMessage({ status: MessageStatus.SENT });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    // Emit for a different message id
    emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
      contactUserId,
      messageDbId: 999,
    });

    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].status).toBe(MessageStatus.SENT);
  });

  it('MESSAGE_ACKNOWLEDGED does not affect already DELIVERED messages', () => {
    const message = makeMessage({ status: MessageStatus.DELIVERED });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
      contactUserId,
      messageDbId: message.id!,
    });

    const msgs = getMessages();
    expect(msgs[0].status).toBe(MessageStatus.DELIVERED);
  });

  it('acknowledges multiple messages in sequence', () => {
    const msg1 = makeMessage({
      id: 1,
      messageId: new Uint8Array(12).fill(1),
      status: MessageStatus.SENT,
    });
    const msg2 = makeMessage({
      id: 2,
      messageId: new Uint8Array(12).fill(2),
      status: MessageStatus.SENT,
    });
    const msg3 = makeMessage({
      id: 3,
      messageId: new Uint8Array(12).fill(3),
      status: MessageStatus.SENT,
    });

    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [msg1, msg2, msg3]]]),
    });

    emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
      contactUserId,
      messageDbId: 1,
    });
    emit(SdkEventType.MESSAGE_ACKNOWLEDGED, {
      contactUserId,
      messageDbId: 3,
    });

    const msgs = getMessages();
    expect(msgs[0].status).toBe(MessageStatus.DELIVERED);
    expect(msgs[1].status).toBe(MessageStatus.SENT); // msg2 not acknowledged
    expect(msgs[2].status).toBe(MessageStatus.DELIVERED);
  });
});
