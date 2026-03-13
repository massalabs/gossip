// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MessageDirection, MessageStatus } from '@massalabs/gossip-sdk';

const mockNavigate = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSetCurrentContact = vi.fn();
let latestOnSend: ((text: string) => void | Promise<void>) | null = null;

vi.mock('react-router-dom', () => ({
  useParams: () => ({ userId: 'contact-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: null }),
}));

vi.mock('../../src/hooks/useDiscussion', () => ({
  useDiscussion: () => ({ discussion: null, isLoading: false }),
}));

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({
    messages: { get: vi.fn().mockResolvedValue(null) },
  }),
}));

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: (selector: (state: unknown) => unknown) =>
    selector({
      contacts: [
        {
          userId: 'contact-1',
          ownerUserId: 'owner-1',
          name: 'Alice',
          publicKeys: new Uint8Array(),
          isOnline: false,
          lastSeen: new Date(),
          createdAt: new Date(),
        },
      ],
    }),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      showDebugOption: false,
      pendingSharedContent: null,
      setPendingSharedContent: vi.fn(),
      setPendingForwardMessageId: vi.fn(),
    }),
}));

vi.mock('../../src/stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({ setHeaderIsScrolled: vi.fn() }),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: (selector: (state: unknown) => unknown) =>
    selector({
      setCurrentContact: mockSetCurrentContact,
      getMessagesForContact: () => [
        {
          id: 1,
          msgId: 1,
          contactUserId: 'contact-1',
          ownerUserId: 'owner-1',
          content: 'Hello',
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
          timestamp: new Date('2025-01-01T12:00:00Z'),
          unread: false,
        },
      ],
      isLoading: false,
      sendMessage: mockSendMessage,
    }),
}));

vi.mock('../../src/components/discussions/DiscussionHeader', () => ({
  default: () => <div>Discussion header</div>,
}));

vi.mock('../../src/components/discussions/SelectionHeader', () => ({
  default: ({ count }: { count: number }) => (
    <div data-testid="selection-header">Selecting {count}</div>
  ),
}));

vi.mock('../../src/components/discussions/SessionIssueBanner', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/MessageSearch', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/ScrollToBottomButton', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/MessageList', () => ({
  default: React.forwardRef(function MockMessageList(
    {
      onToggleSelect,
    }: {
      onToggleSelect?: (messageId: number) => void;
    },
    _ref
  ) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect?.(1)}
        aria-label="toggle message selection"
      >
        Toggle selection
      </button>
    );
  }),
}));

vi.mock('../../src/components/discussions/MessageInput', () => ({
  default: ({
    onSend,
    disabled,
  }: {
    onSend: (text: string) => void;
    disabled?: boolean;
  }) => {
    latestOnSend = onSend;
    return (
      <div data-testid="message-input">
        <span>{disabled ? 'disabled' : 'enabled'}</span>
        <button
          type="button"
          aria-label="mock send"
          onClick={() => onSend('Test send')}
        >
          Send
        </button>
      </div>
    );
  },
}));

import Discussion from '../../src/pages/Discussion';

describe('Discussion multi-select input behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue(undefined);
    latestOnSend = null;
  });

  it('hides input and blocks send while selecting', async () => {
    await render(<Discussion />);

    await userEvent.click(page.getByRole('button', { name: 'mock send' }));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);

    await userEvent.click(
      page.getByRole('button', { name: 'toggle message selection' })
    );

    await expect
      .element(page.getByTestId('selection-header'))
      .toBeInTheDocument();
    await expect.element(page.getByText('disabled')).toBeInTheDocument();

    await Promise.resolve(latestOnSend?.('Blocked send'));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});
