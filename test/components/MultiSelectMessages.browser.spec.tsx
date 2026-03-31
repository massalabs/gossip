// Runs in BROWSER mode (real Chromium via Playwright)
// Tests multi-select message functionality: copy concatenation, delete outgoing-only filter,
// selection/deselection state management.
// Complements test/pages/Discussion.browser.spec.tsx which covers input-blocking and
// page-level integration.

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
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
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

/** Simple translation function matching the keys used in the hook */
const t = ((key: string) => {
  const translations: Record<string, string> = {
    copy_you: 'You',
    failed_to_copy_selected: 'Failed to copy',
    failed_to_delete_selected: 'Failed to delete',
  };
  return translations[key] ?? key;
}) as Parameters<typeof useDiscussionMessageSelection>[0]['t'];

/**
 * Wrapper component that exposes the hook return values through DOM elements
 * and action buttons, allowing the test to drive the hook state.
 */
function SelectionHarness({
  messages,
  discussionCustomName,
  contactName,
}: {
  messages: Message[];
  discussionCustomName?: string;
  contactName?: string;
}) {
  const {
    selectedMessageIds,
    isSelecting,
    canDeleteSelected,
    handleToggleSelect,
    handleClearSelection,
    handleCopySelected,
    handleDeleteSelected,
  } = useDiscussionMessageSelection({
    messages,
    discussionCustomName,
    contactName,
    gossip: mockGossip,
    t,
  });

  return (
    <div>
      <span data-testid="is-selecting">{String(isSelecting)}</span>
      <span data-testid="selected-count">{selectedMessageIds.size}</span>
      <span data-testid="can-delete">{String(canDeleteSelected)}</span>
      <span data-testid="selected-ids">
        {JSON.stringify(Array.from(selectedMessageIds).sort())}
      </span>

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

      <button type="button" data-testid="clear" onClick={handleClearSelection}>
        Clear
      </button>
      <button
        type="button"
        data-testid="copy"
        onClick={() => void handleCopySelected()}
      >
        Copy
      </button>
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

describe('MultiSelectMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMessage.mockResolvedValue(true);
  });

  describe('selection state management', () => {
    it('starts with no selection', async () => {
      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('0');
    });

    it('toggles a message into selection', async () => {
      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('1');
      await expect
        .element(page.getByTestId('selected-ids'))
        .toHaveTextContent('[1]');
    });

    it('selects multiple messages', async () => {
      const messages = [
        makeMessage({ id: 1 }),
        makeMessage({ id: 2 }),
        makeMessage({ id: 3 }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-3'));

      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('2');
      await expect
        .element(page.getByTestId('selected-ids'))
        .toHaveTextContent('[1,3]');
    });

    it('deselects a message by toggling it again', async () => {
      const messages = [makeMessage({ id: 1 }), makeMessage({ id: 2 })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));

      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('2');

      // Deselect message 1
      await userEvent.click(page.getByTestId('toggle-1'));

      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('1');
      await expect
        .element(page.getByTestId('selected-ids'))
        .toHaveTextContent('[2]');
    });

    it('deselecting all messages exits selection mode', async () => {
      const messages = [makeMessage({ id: 1 })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');

      // Toggle again to deselect
      await userEvent.click(page.getByTestId('toggle-1'));
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('0');
    });

    it('clear button resets all selection', async () => {
      const messages = [
        makeMessage({ id: 1 }),
        makeMessage({ id: 2 }),
        makeMessage({ id: 3 }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('toggle-3'));

      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('3');

      await userEvent.click(page.getByTestId('clear'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('0');
    });
  });

  describe('copy concatenation', () => {
    it('copies single selected message with sender label', async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      const messages = [
        makeMessage({
          id: 1,
          content: 'Hi there',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('copy'));

      // Wait for the async copy to complete and selection to clear
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(writeTextSpy).toHaveBeenCalledOnce();
      expect(writeTextSpy).toHaveBeenCalledWith('Alice\nHi there');

      writeTextSpy.mockRestore();
    });

    it('uses "You" label for outgoing messages', async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      const messages = [
        makeMessage({
          id: 1,
          content: 'My message',
          direction: MessageDirection.OUTGOING,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('copy'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(writeTextSpy).toHaveBeenCalledWith('You\nMy message');

      writeTextSpy.mockRestore();
    });

    it('concatenates multiple messages sorted by timestamp', async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      const messages = [
        makeMessage({
          id: 1,
          content: 'First message',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
        makeMessage({
          id: 2,
          content: 'Second message',
          direction: MessageDirection.OUTGOING,
          timestamp: new Date('2025-01-01T12:01:00Z'),
        }),
        makeMessage({
          id: 3,
          content: 'Third message',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:02:00Z'),
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      // Select all three
      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('toggle-3'));
      await userEvent.click(page.getByTestId('copy'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      const expected =
        'Alice\nFirst message\n\nYou\nSecond message\n\nAlice\nThird message';
      expect(writeTextSpy).toHaveBeenCalledWith(expected);

      writeTextSpy.mockRestore();
    });

    it('copies only selected messages, not all', async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      const messages = [
        makeMessage({
          id: 1,
          content: 'First',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
        makeMessage({
          id: 2,
          content: 'Second',
          direction: MessageDirection.OUTGOING,
          timestamp: new Date('2025-01-01T12:01:00Z'),
        }),
        makeMessage({
          id: 3,
          content: 'Third',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:02:00Z'),
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      // Select only first and third
      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-3'));
      await userEvent.click(page.getByTestId('copy'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      const expected = 'Alice\nFirst\n\nAlice\nThird';
      expect(writeTextSpy).toHaveBeenCalledWith(expected);

      writeTextSpy.mockRestore();
    });

    it('uses discussionCustomName over contactName when provided', async () => {
      const writeTextSpy = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      const messages = [
        makeMessage({
          id: 1,
          content: 'Hi',
          direction: MessageDirection.INCOMING,
          timestamp: new Date('2025-01-01T12:00:00Z'),
        }),
      ];
      render(
        <SelectionHarness
          messages={messages}
          contactName="Alice"
          discussionCustomName="Best Friend"
        />
      );

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('copy'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(writeTextSpy).toHaveBeenCalledWith('Best Friend\nHi');

      writeTextSpy.mockRestore();
    });

    it('clears selection after successful copy', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();

      const messages = [makeMessage({ id: 1 })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');

      await userEvent.click(page.getByTestId('copy'));

      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');
      await expect
        .element(page.getByTestId('selected-count'))
        .toHaveTextContent('0');

      vi.restoreAllMocks();
    });

    it('shows toast error and keeps selection when clipboard fails', async () => {
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
        new Error('Clipboard denied')
      );

      const messages = [makeMessage({ id: 1, content: 'Test' })];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('copy'));

      await vi.waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to copy');
      });

      // Selection should NOT be cleared on failure
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');

      vi.restoreAllMocks();
    });
  });

  describe('delete outgoing-only filter', () => {
    it('canDelete is false when no messages are selected', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('false');
    });

    it('canDelete is true when all selected messages are outgoing', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
        makeMessage({
          id: 2,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));

      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('true');
    });

    it('canDelete is false when any selected message is incoming', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
        makeMessage({
          id: 2,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));

      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('false');
    });

    it('canDelete is false when only incoming messages are selected', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.INCOMING,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));

      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('false');
    });

    it('canDelete updates dynamically when selection changes', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
        makeMessage({
          id: 2,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      // Select only outgoing -> can delete
      await userEvent.click(page.getByTestId('toggle-1'));
      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('true');

      // Add incoming -> can no longer delete
      await userEvent.click(page.getByTestId('toggle-2'));
      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('false');

      // Remove incoming -> can delete again
      await userEvent.click(page.getByTestId('toggle-2'));
      await expect
        .element(page.getByTestId('can-delete'))
        .toHaveTextContent('true');
    });

    it('delete calls gossip.messages.deleteMessage for each selected message', async () => {
      const messages = [
        makeMessage({
          id: 10,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
        makeMessage({
          id: 20,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-10'));
      await userEvent.click(page.getByTestId('toggle-20'));
      await userEvent.click(page.getByTestId('delete'));

      // Wait for async delete to complete
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(mockDeleteMessage).toHaveBeenCalledTimes(2);
      expect(mockDeleteMessage).toHaveBeenCalledWith(10);
      expect(mockDeleteMessage).toHaveBeenCalledWith(20);
    });

    it('delete clears selection after completion', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
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

    it('delete does nothing when canDelete is false', async () => {
      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.DELIVERED,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('delete'));

      await vi.waitFor(() => {
        expect(mockDeleteMessage).not.toHaveBeenCalled();
      });
      // Selection should remain (delete was a no-op)
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('true');
    });

    it('shows toast error on partial delete failure', async () => {
      mockDeleteMessage
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const messages = [
        makeMessage({
          id: 1,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
        makeMessage({
          id: 2,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
        }),
      ];
      render(<SelectionHarness messages={messages} contactName="Alice" />);

      await userEvent.click(page.getByTestId('toggle-1'));
      await userEvent.click(page.getByTestId('toggle-2'));
      await userEvent.click(page.getByTestId('delete'));

      // Wait for selection to clear (delete always clears even on partial failure)
      await expect
        .element(page.getByTestId('is-selecting'))
        .toHaveTextContent('false');

      expect(toast.error).toHaveBeenCalledWith('Failed to delete');
    });
  });
});
