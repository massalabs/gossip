import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  Message,
  MessageDirection,
  MessageStatus,
  MessageType,
  encodeUserId,
} from '@massalabs/gossip-sdk';

let resolveGetMessages: ((messages: Message[]) => void) | null = null;
let resolveSend: ((message: Message) => void) | null = null;

const mockSdk = {
  isSessionOpen: true,
  messages: {
    get: vi.fn(async () => undefined as Message | undefined),
  },
  selfMessages: {
    get: vi.fn(async () => undefined as Message | undefined),
    getMessages: vi.fn(
      () =>
        new Promise<Message[]>(resolve => {
          resolveGetMessages = resolve;
        })
    ),
    getReactions: vi.fn(async () => []),
    send: vi.fn(
      () =>
        new Promise<Message>(resolve => {
          resolveSend = resolve;
        })
    ),
    editMessage: vi.fn(async () => true),
    deleteMessage: vi.fn(async () => true),
    sendReaction: vi.fn(async () => ({ id: 1 })),
    removeReaction: vi.fn(async () => true),
  },
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

import { useSelfMessageStore } from '../../src/stores/selfMessageStore';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 1,
    messageId: new Uint8Array(12).fill(1),
    ownerUserId: 'test-user-id',
    contactUserId: '__self__',
    content: 'hello',
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date('2024-01-01T10:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  useSelfMessageStore.setState({
    messages: [],
    reactions: new Map(),
    isLoading: false,
    isSending: false,
  });
  resolveGetMessages = null;
  resolveSend = null;
  vi.clearAllMocks();
  mockSdk.messages.get.mockReset();
  mockSdk.messages.get.mockResolvedValue(undefined);
  mockSdk.selfMessages.get.mockReset();
  mockSdk.selfMessages.get.mockResolvedValue(undefined);
});

describe('selfMessageStore.loadMessages', () => {
  it('preserves in-flight optimistic messages (no id) when reloading', async () => {
    const persisted = makeMessage({ id: 10, content: 'from db' });
    useSelfMessageStore.setState({
      messages: [
        makeMessage({
          id: undefined as unknown as number,
          content: 'pending forward',
        }),
      ],
    });

    const loadPromise = useSelfMessageStore.getState().loadMessages();
    resolveGetMessages!([persisted]);
    await loadPromise;

    const messages = useSelfMessageStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages.some(m => m.id === 10)).toBe(true);
    expect(
      messages.some(m => m.id == null && m.content === 'pending forward')
    ).toBe(true);
  });

  it('does not duplicate persisted messages already in state', async () => {
    const persisted = makeMessage({ id: 10, content: 'from db' });
    useSelfMessageStore.setState({ messages: [persisted] });

    const loadPromise = useSelfMessageStore.getState().loadMessages();
    resolveGetMessages!([persisted]);
    await loadPromise;

    const messages = useSelfMessageStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe(10);
  });
});

describe('selfMessageStore.sendMessage + concurrent loadMessages', () => {
  it('does not lose an optimistic message when loadMessages resolves mid-send', async () => {
    // Start a send: optimistic added, SDK.send pending
    const sendPromise = useSelfMessageStore.getState().sendMessage('hi');
    // After the optimistic set(), messages length should be 1
    expect(useSelfMessageStore.getState().messages).toHaveLength(1);
    expect(useSelfMessageStore.getState().messages[0].id).toBeUndefined();

    // Concurrently load from DB — DB is empty (message not persisted yet)
    const loadPromise = useSelfMessageStore.getState().loadMessages();
    resolveGetMessages!([]);
    await loadPromise;

    // Optimistic must survive the concurrent load
    expect(useSelfMessageStore.getState().messages).toHaveLength(1);
    expect(useSelfMessageStore.getState().messages[0].id).toBeUndefined();

    // Now SDK.send resolves with the persisted message
    const persisted = makeMessage({ id: 42, content: 'hi' });
    resolveSend!(persisted);
    await sendPromise;

    const final = useSelfMessageStore.getState().messages;
    expect(final).toHaveLength(1);
    expect(final[0].id).toBe(42);
  });
});

describe('selfMessageStore forwarding', () => {
  it('forwards Note -> Note from decrypted selfMessages content', async () => {
    mockSdk.selfMessages.get.mockResolvedValue(
      makeMessage({ id: 77, content: 'decrypted note' })
    );
    mockSdk.messages.get.mockRejectedValue(
      new Error('encrypted Notes must not use messages.get')
    );
    mockSdk.selfMessages.send.mockResolvedValueOnce(
      makeMessage({
        id: 78,
        content: '',
        forwardOf: { originalContent: 'decrypted note' },
      })
    );

    await useSelfMessageStore.getState().sendMessage('', 77);

    expect(mockSdk.selfMessages.get).toHaveBeenCalledWith(77);
    expect(mockSdk.messages.get).not.toHaveBeenCalled();
    expect(mockSdk.selfMessages.send).toHaveBeenCalledWith('', {
      forwardOf: { originalContent: 'decrypted note' },
    });
  });
});

describe('selfMessageStore forwarded-message flattening', () => {
  it('preserves cited content and comment for DM -> Note', async () => {
    const peerId = encodeUserId(new Uint8Array(32).fill(7));
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue(
      makeMessage({
        id: 80,
        contactUserId: peerId,
        content: 'comment',
        forwardOf: { originalContent: 'cited body' },
      })
    );
    mockSdk.selfMessages.send.mockResolvedValueOnce(
      makeMessage({ id: 81, content: '' })
    );

    await useSelfMessageStore.getState().sendMessage('', 80);

    expect(mockSdk.selfMessages.send).toHaveBeenCalledWith('', {
      forwardOf: {
        originalContent: 'cited body\n\ncomment',
        originalContactId: new Uint8Array(32).fill(7),
      },
    });
  });

  it('fails closed when the source no longer exists', async () => {
    mockSdk.selfMessages.get.mockResolvedValue(undefined);
    mockSdk.messages.get.mockResolvedValue(undefined);

    await expect(
      useSelfMessageStore.getState().sendMessage('', 999)
    ).rejects.toThrow('Forward target not found');

    expect(mockSdk.selfMessages.send).not.toHaveBeenCalled();
    expect(useSelfMessageStore.getState().messages).toHaveLength(0);
  });
});
