// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
} from '@massalabs/gossip-sdk';

const mockSdk = {
  isSessionOpen: true,
  messages: {
    getVisibleMessages: vi.fn(async () => []),
    getReactions: vi.fn(async () => []),
    get: vi.fn(async () => undefined),
    send: vi.fn(async () => ({ success: true })),
    sendReaction: vi.fn(async () => ({ success: true })),
    deleteMessage: vi.fn(async () => true),
  },
  discussions: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ contactUserId: 'contact-1' })),
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

import { useMessageStore } from '../../src/stores/messageStore';

const TestHarness: React.FC<{ contactUserId: string }> = ({
  contactUserId,
}) => {
  // Subscribe to both layers so React re-renders when either changes
  const confirmed = useMessageStore(s => s.confirmedByContact);
  const optimistic = useMessageStore(s => s.optimisticByContact);
  const getMessages = useMessageStore(s => s.getMessagesForContact);
  // Force re-render dependency on both maps (Zustand shallow compare)
  void confirmed;
  void optimistic;
  const messages = getMessages(contactUserId);
  const sendMessage = useMessageStore(s => s.sendMessage);

  return (
    <div>
      <button onClick={() => sendMessage(contactUserId, 'Test message')}>
        Send
      </button>
      <ul>
        {messages.map((m, i) => (
          <li
            key={m.id ?? i}
            data-testid={`msg-${m.id}`}
            data-status={m.status}
          >
            {m.content} | id:{m.id} | status:{m.status}
          </li>
        ))}
      </ul>
    </div>
  );
};

describe('Optimistic messaging integration', () => {
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
    mockSdk.discussions.get.mockResolvedValue({ contactUserId });
  });

  afterEach(() => {
    useMessageStore.getState().cleanup();
  });

  it('message appears immediately after send with negative id', async () => {
    // SDK send never resolves
    mockSdk.messages.send.mockReturnValue(new Promise(() => {}));

    render(<TestHarness contactUserId={contactUserId} />);

    await userEvent.click(page.getByText('Send'));

    // Message should appear immediately
    const item = page.getByText(/Test message/);
    await expect.element(item).toBeInTheDocument();
    // Verify negative id in the rendered text
    expect(item.element().textContent).toMatch(/id:-\d+/);
    expect(item.element().textContent).toContain('status:sent');
  });

  it('message stays visible after SDK confirms (pending until poll)', async () => {
    const realMessage: Message = {
      id: 42,
      ownerUserId: 'test-user-id',
      contactUserId,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    };

    mockSdk.messages.send.mockResolvedValue({
      success: true,
      message: realMessage,
    });

    render(<TestHarness contactUserId={contactUserId} />);

    await userEvent.click(page.getByText('Send'));

    // Message stays visible with its optimistic id (pending until poll confirms)
    // It's NOT removed — the merge keeps it because confirmed doesn't have id=42 yet
    await vi.waitFor(async () => {
      const item = page.getByText(/Test message/);
      expect(item.element()).toBeTruthy();
    });
  });

  it('message stays pending (clock) on transient SDK error', async () => {
    // Transient errors (throws) keep the message as optimistic —
    // the SDK will retry via stateUpdate.
    mockSdk.messages.send.mockRejectedValue(new Error('Network error'));

    render(<TestHarness contactUserId={contactUserId} />);

    await userEvent.click(page.getByText('Send'));

    // Wait for the catch to run, then verify status stays SENT (not FAILED)
    await vi.waitFor(async () => {
      const items = page.getByRole('listitem');
      const el = items.element() as HTMLElement;
      expect(el.dataset.status).toBe('sent');
    });
  });

  it('message stays pending even for SDK { success: false }', async () => {
    // SDK returns { success: false } with no message — infra error.
    // Message stays pending (clock), no FAILED state.
    mockSdk.messages.send.mockResolvedValue({
      success: false,
      error: 'Discussion not found',
    });

    render(<TestHarness contactUserId={contactUserId} />);

    await userEvent.click(page.getByText('Send'));

    await vi.waitFor(async () => {
      const items = page.getByRole('listitem');
      const el = items.element() as HTMLElement;
      expect(el.dataset.status).toBe('sent');
    });
  });
});
