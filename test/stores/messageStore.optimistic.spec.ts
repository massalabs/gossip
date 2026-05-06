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
    deleteMessage: vi.fn(async (_id: number) => {
      // Real SDK will emit MESSAGE_DELETED_OPTIMISTIC — simulated per test
      return true;
    }),
    editMessage: vi.fn(async (_id: number, _content: string) => {
      // Real SDK will emit MESSAGE_EDITED_OPTIMISTIC — simulated per test
      return true;
    }),
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
  mockSdk.messages.deleteMessage.mockClear();
  mockSdk.messages.editMessage.mockClear();
  mockSdk.messages.getVisibleMessages.mockResolvedValue([]);
  mockSdk.messages.getReactions.mockResolvedValue([]);

  useMessageStore.getState().init();
});

afterEach(() => {
  useMessageStore.getState().cleanup();
});

// ---------------------------------------------------------------------------
// A) Delete via store optimistic handling
// ---------------------------------------------------------------------------

describe('delete via store', () => {
  it('deleteMessage optimistically marks message as DELETED', async () => {
    const message = makeMessage();
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    await useMessageStore.getState().deleteMessage(contactUserId, message.id!);

    expect(mockSdk.messages.deleteMessage).toHaveBeenCalledWith(message.id);

    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MessageType.DELETED);
    expect(msgs[0].content).toBe('[Message deleted]');
  });

  it('deleteMessage rolls back on SDK failure', async () => {
    const message = makeMessage({ content: 'Original content' });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    mockSdk.messages.deleteMessage.mockRejectedValueOnce(
      new Error('SDK error')
    );

    await useMessageStore.getState().deleteMessage(contactUserId, message.id!);

    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MessageType.TEXT);
    expect(msgs[0].content).toBe('Original content');
  });
});

// ---------------------------------------------------------------------------
// B) Edit via store optimistic handling
// ---------------------------------------------------------------------------

describe('edit via store', () => {
  it('editMessage optimistically patches content and metadata', async () => {
    const message = makeMessage();
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    await useMessageStore
      .getState()
      .editMessage(contactUserId, message.id!, 'Edited content');

    expect(mockSdk.messages.editMessage).toHaveBeenCalledWith(
      message.id,
      'Edited content'
    );

    const msgs = getMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('Edited content');
    expect(msgs[0].metadata).toEqual(expect.objectContaining({ edited: true }));
  });

  it('editMessage rolls back on SDK failure', async () => {
    const message = makeMessage({ content: 'Original' });
    useMessageStore.setState({
      ...useMessageStore.getState(),
      messagesByContact: new Map([[contactUserId, [message]]]),
    });

    mockSdk.messages.editMessage.mockRejectedValueOnce(new Error('SDK error'));

    await useMessageStore
      .getState()
      .editMessage(contactUserId, message.id!, 'New content');

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
// E) Acknowledge (SENT → DELIVERED) via SDK events
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
