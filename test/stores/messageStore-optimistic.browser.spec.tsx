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
  const messages = useMessageStore(s => s.getMessagesForContact(contactUserId));
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

  it('message id swaps to positive after SDK confirms', async () => {
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

    // Wait for the swap
    await expect.element(page.getByTestId('msg-42')).toBeInTheDocument();
  });

  it('message shows FAILED status on SDK error', async () => {
    mockSdk.messages.send.mockRejectedValue(new Error('Network error'));

    render(<TestHarness contactUserId={contactUserId} />);

    await userEvent.click(page.getByText('Send'));

    // Wait for FAILED status
    await vi.waitFor(async () => {
      const items = page.getByRole('listitem');
      const el = items.element() as HTMLElement;
      expect(el.dataset.status).toBe('failed');
    });
  });
});
