// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MessageDirection, MessageStatus } from '@massalabs/gossip-sdk';

const mockNavigate = vi.fn();
const mockDeleteMessage = vi.fn().mockResolvedValue(undefined);
let mockMessages = [
  {
    id: 1,
    messageId: new Uint8Array(12).fill(1),
    content: 'Self note one',
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date('2025-01-01T12:00:00Z'),
  },
];

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: {} }),
  useNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    isSessionOpen: true,
    messages: { get: vi.fn().mockResolvedValue(null) },
    selfMessages: {
      getRetentionInfo: vi
        .fn()
        .mockResolvedValue({ duration: null, setAt: null }),
      setRetentionPolicy: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({
    messages: {
      get: vi.fn().mockResolvedValue(null),
      deleteMessage: vi.fn().mockResolvedValue(true),
    },
  }),
}));

vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: {
    use: {
      messages: () => mockMessages,
      reactions: () => new Map(),
      isLoading: () => false,
      loadMessages: () => vi.fn(),
      sendMessage: () => vi.fn(),
      editMessage: () => vi.fn(),
      deleteMessage: () => mockDeleteMessage,
      sendReaction: () => vi.fn(),
      removeReaction: () => vi.fn(),
      loadReactions: () => vi.fn(),
    },
  },
}));

vi.mock('../../src/components/ui/BackButton', () => ({
  default: () => <button type="button">Back</button>,
}));

vi.mock('../../src/components/discussions/SelectionHeader', () => ({
  default: ({
    count,
    onClear,
    onCopy,
    onDelete,
    canDelete,
  }: {
    count: number;
    onClear: () => void;
    onCopy: () => void;
    onDelete: () => void;
    canDelete?: boolean;
  }) => (
    <div data-testid="selection-header">
      <span data-testid="selection-count">{count}</span>
      <button type="button" aria-label="clear selection" onClick={onClear}>
        Clear
      </button>
      <button type="button" aria-label="copy selected" onClick={onCopy}>
        Copy
      </button>
      {canDelete ? (
        <button type="button" aria-label="delete selected" onClick={onDelete}>
          Delete
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../../src/components/discussions/MessageList', () => ({
  default: ({ onToggleSelect }: { onToggleSelect?: (id: number) => void }) => (
    <button
      type="button"
      onClick={() => onToggleSelect?.(1)}
      aria-label="toggle message selection"
    >
      Toggle selection
    </button>
  ),
}));

vi.mock('../../src/components/discussions/MessageInput', () => ({
  default: ({
    disabled,
    isSelecting,
  }: {
    disabled?: boolean;
    isSelecting?: boolean;
    onSend: (text: string) => void;
  }) => (
    <div data-testid="message-input">
      <span data-testid="input-disabled">
        {disabled ? 'disabled' : 'enabled'}
      </span>
      <span data-testid="input-selecting">
        {isSelecting ? 'selecting' : 'idle'}
      </span>
    </div>
  ),
}));

import SelfDiscussion from '../../src/pages/SelfDiscussion';

describe('SelfDiscussion message selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMessage.mockResolvedValue(undefined);
    mockMessages = [
      {
        id: 1,
        messageId: new Uint8Array(12).fill(1),
        content: 'Self note one',
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date('2025-01-01T12:00:00Z'),
      },
    ];
  });

  it('shows SelectionHeader with copy and delete buttons when a message is selected', async () => {
    await render(<SelfDiscussion />);

    // Initially no selection header
    await expect
      .element(page.getByTestId('selection-header'))
      .not.toBeInTheDocument();

    // Toggle selection on message id 1
    await userEvent.click(
      page.getByRole('button', { name: 'toggle message selection' })
    );

    // Selection header should appear
    await expect
      .element(page.getByTestId('selection-header'))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId('selection-count'))
      .toHaveTextContent('1');

    // Copy and delete buttons should be present
    await expect
      .element(page.getByRole('button', { name: 'copy selected' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'delete selected' }))
      .toBeInTheDocument();
  });

  it('disables MessageInput when selecting', async () => {
    await render(<SelfDiscussion />);

    // Initially input is enabled and idle
    await expect
      .element(page.getByTestId('input-disabled'))
      .toHaveTextContent('enabled');
    await expect
      .element(page.getByTestId('input-selecting'))
      .toHaveTextContent('idle');

    // Toggle selection
    await userEvent.click(
      page.getByRole('button', { name: 'toggle message selection' })
    );

    // Input should be disabled and in selecting state
    await expect
      .element(page.getByTestId('input-disabled'))
      .toHaveTextContent('disabled');
    await expect
      .element(page.getByTestId('input-selecting'))
      .toHaveTextContent('selecting');
  });

  it('returns to normal header when selection is cleared', async () => {
    await render(<SelfDiscussion />);

    // Toggle selection to enter selecting mode
    await userEvent.click(
      page.getByRole('button', { name: 'toggle message selection' })
    );
    await expect
      .element(page.getByTestId('selection-header'))
      .toBeInTheDocument();

    // Clear selection
    await userEvent.click(
      page.getByRole('button', { name: 'clear selection' })
    );

    // Selection header should be gone, normal header title visible
    await expect
      .element(page.getByTestId('selection-header'))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText('selfDiscussion.title'))
      .toBeInTheDocument();

    // Input should be re-enabled
    await expect
      .element(page.getByTestId('input-disabled'))
      .toHaveTextContent('enabled');
    await expect
      .element(page.getByTestId('input-selecting'))
      .toHaveTextContent('idle');
  });

  it('deletes selected self messages via the delete button', async () => {
    await render(<SelfDiscussion />);

    // Select message
    await userEvent.click(
      page.getByRole('button', { name: 'toggle message selection' })
    );
    await expect
      .element(page.getByTestId('selection-header'))
      .toBeInTheDocument();

    // Click delete
    await userEvent.click(
      page.getByRole('button', { name: 'delete selected' })
    );

    // deleteMessage should have been called with the message's id
    expect(mockDeleteMessage).toHaveBeenCalledWith(1);

    // Selection should be cleared after deletion
    await expect
      .element(page.getByTestId('selection-header'))
      .not.toBeInTheDocument();
  });
});
