// Runs in BROWSER mode (real Chromium via Playwright)
// Tests the onDeleteMessage override in useDiscussionMessageSelection:
// - When provided, handleDeleteSelected uses the custom handler instead of gossip.messages.deleteMessage
// - When not provided, the default gossip.messages.deleteMessage is used (existing behavior)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@massalabs/gossip-sdk';

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import toast from 'react-hot-toast';
import { useDiscussionMessageSelection } from '../../src/hooks/useDiscussionMessageSelection';

// ---------- Helpers ----------

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 1,
    msgId: 1,
    contactUserId: 'contact-1',
    ownerUserId: 'owner-1',
    content: 'Hello',
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.SENT,
    timestamp: new Date('2025-01-01T12:00:00Z'),
    unread: false,
    ...overrides,
  } as Message;
}

const mockDeleteMessage = vi.fn().mockResolvedValue(true);
const mockGossip = {
  messages: {
    deleteMessage: mockDeleteMessage,
  },
} as unknown as Parameters<typeof useDiscussionMessageSelection>[0]['gossip'];

const mockOnDeleteMessage = vi.fn().mockResolvedValue(true);

const t = ((key: string) => {
  const translations: Record<string, string> = {
    copy_you: 'You',
    failed_to_copy_selected: 'Failed to copy',
    failed_to_delete_selected: 'Failed to delete',
  };
  return translations[key] ?? key;
}) as Parameters<typeof useDiscussionMessageSelection>[0]['t'];

/**
 * Harness that exposes hook state through DOM elements.
 * Accepts an optional onDeleteMessage to test the override path.
 */
function SelectionHarness({
  messages,
  onDeleteMessage,
}: {
  messages: Message[];
  onDeleteMessage?: (messageId: number) => Promise<boolean>;
}) {
  const {
    selectedMessageIds,
    isSelecting,
    canDeleteSelected,
    handleToggleSelect,
    handleDeleteSelected,
  } = useDiscussionMessageSelection({
    messages,
    contactName: 'Alice',
    gossip: mockGossip,
    t,
    onDeleteMessage,
  });

  return (
    <div>
      <span data-testid="is-selecting">{String(isSelecting)}</span>
      <span data-testid="selected-count">{selectedMessageIds.size}</span>
      <span data-testid="can-delete">{String(canDeleteSelected)}</span>

      {messages.map(m => (
        <button
          key={m.id}
          type="button"
          data-testid={`toggle-${m.id}`}
          onClick={() => handleToggleSelect(m.id!)}
        >
          Toggle {m.id}
        </button>
      ))}

      <button
        type="button"
        data-testid="delete"
        onClick={() => void handleDeleteSelected()}
      >
        Delete
      </button>
    </div>
  );
}

// ---------- Tests ----------

describe('useDiscussionMessageSelection onDeleteMessage override', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMessage.mockResolvedValue(true);
    mockOnDeleteMessage.mockResolvedValue(true);
  });

  describe('with onDeleteMessage provided (self-discussion path)', () => {
    it('calls onDeleteMessage for each selected outgoing message', async () => {
      const messages = [
        makeMessage({ id: 10 }),
        makeMessage({ id: 20 }),
        makeMessage({ id: 30 }),
      ];
      render(
        <SelectionHarness
          messages={messages}
          onDeleteMessage={mockOnDeleteMessage}
        />
      );

      await userEvent.click(page.getByTestId('toggle-10'));
      await userEvent.click(page.getByTestId('toggle-20'));
      await userEvent.click(page.getByTestId('toggle-30'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(mockOnDeleteMessage).toHaveBeenCalledTimes(3);
      expect(mockOnDeleteMessage).toHaveBeenCalledWith(10);
      expect(mockOnDeleteMessage).toHaveBeenCalledWith(20);
      expect(mockOnDeleteMessage).toHaveBeenCalledWith(30);
    });

    it('does NOT call gossip.messages.deleteMessage when onDeleteMessage is provided', async () => {
      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(
        <SelectionHarness
          messages={messages}
          onDeleteMessage={mockOnDeleteMessage}
        />
      );

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(mockDeleteMessage).not.toHaveBeenCalled();
      expect(mockOnDeleteMessage).toHaveBeenCalledTimes(2);
    });

    it('clears selection after custom delete completes', async () => {
      const messages = [makeMessage({ id: 5 })];
      render(
        <SelectionHarness
          messages={messages}
          onDeleteMessage={mockOnDeleteMessage}
        />
      );

      await userEvent.click(page.getByTestId('toggle-5'));
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');

      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('0');
    });

    it('shows toast error when custom delete returns false', async () => {
      mockOnDeleteMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(
        <SelectionHarness
          messages={messages}
          onDeleteMessage={mockOnDeleteMessage}
        />
      );

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(toast.error).toHaveBeenCalledWith('Failed to delete');
    });

    it('shows toast error when custom delete throws', async () => {
      mockOnDeleteMessage
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('store failure'));

      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(
        <SelectionHarness
          messages={messages}
          onDeleteMessage={mockOnDeleteMessage}
        />
      );

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(toast.error).toHaveBeenCalledWith('Failed to delete');
    });
  });

  describe('without onDeleteMessage (default path)', () => {
    it('calls gossip.messages.deleteMessage when onDeleteMessage is not provided', async () => {
      const messages = [makeMessage({ id: 10 }), makeMessage({ id: 20 })];
      render(<SelectionHarness messages={messages} />);

      await userEvent.click(page.getByTestId('toggle-10'));
      await userEvent.click(page.getByTestId('toggle-20'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(mockDeleteMessage).toHaveBeenCalledTimes(2);
      expect(mockDeleteMessage).toHaveBeenCalledWith(10);
      expect(mockDeleteMessage).toHaveBeenCalledWith(20);
    });

    it('does NOT call onDeleteMessage when it is not provided', async () => {
      const messages = [makeMessage({ id: 1 })];
      render(<SelectionHarness messages={messages} />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('delete'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      // onDeleteMessage was never passed, so it should not be called
      expect(mockOnDeleteMessage).not.toHaveBeenCalled();
      expect(mockDeleteMessage).toHaveBeenCalledTimes(1);
    });
  });
});
