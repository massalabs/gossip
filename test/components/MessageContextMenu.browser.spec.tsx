// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

import MessageContextMenu, {
  type MessageContextMenuItem,
} from '../../src/components/ui/MessageContextMenu';
import { DEFAULT_EMOJIS } from '../../src/components/ui/constants';

function makeItems(onClick?: () => void): MessageContextMenuItem[] {
  return [
    {
      label: 'Reply',
      icon: <span data-testid="icon-reply">R</span>,
      onClick: onClick ?? vi.fn(),
    },
    {
      label: 'Forward',
      icon: <span data-testid="icon-forward">F</span>,
      onClick: onClick ?? vi.fn(),
    },
    {
      label: 'Copy',
      icon: <span data-testid="icon-copy">C</span>,
      onClick: onClick ?? vi.fn(),
    },
    {
      label: 'Delete',
      icon: <span data-testid="icon-delete">D</span>,
      onClick: onClick ?? vi.fn(),
      danger: true,
    },
  ];
}

describe('MessageContextMenu', () => {
  let onClose: ReturnType<typeof vi.fn>;
  let onSelectEmoji: ReturnType<typeof vi.fn>;
  let onOpenEmojiPicker: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onClose = vi.fn();
    onSelectEmoji = vi.fn();
    onOpenEmojiPicker = vi.fn();
  });

  it('shows all action items when open', async () => {
    const items = makeItems();

    await render(
      <MessageContextMenu
        items={items}
        isOpen={true}
        onClose={onClose}
        isOutgoing={false}
        onSelectEmoji={onSelectEmoji}
        onOpenEmojiPicker={onOpenEmojiPicker}
      />
    );

    for (const item of items) {
      await expect
        .element(page.getByRole('menuitem', { name: item.label }))
        .toBeInTheDocument();
    }
  });

  it('shows emoji reaction bar with default emojis', async () => {
    await render(
      <MessageContextMenu
        items={makeItems()}
        isOpen={true}
        onClose={onClose}
        isOutgoing={false}
        onSelectEmoji={onSelectEmoji}
        onOpenEmojiPicker={onOpenEmojiPicker}
      />
    );

    for (const emoji of DEFAULT_EMOJIS) {
      await expect.element(page.getByText(emoji)).toBeInTheDocument();
    }
  });

  it('calls onSelectEmoji when emoji tapped', async () => {
    await render(
      <MessageContextMenu
        items={makeItems()}
        isOpen={true}
        onClose={onClose}
        isOutgoing={false}
        onSelectEmoji={onSelectEmoji}
        onOpenEmojiPicker={onOpenEmojiPicker}
      />
    );

    // Wait for the 120ms touch-ready delay so buttons become clickable
    await new Promise(resolve => setTimeout(resolve, 150));

    await userEvent.click(page.getByText('👍'));

    expect(onSelectEmoji).toHaveBeenCalledWith('👍');
    expect(onClose).toHaveBeenCalled();
  });

  it('is not rendered when isOpen is false', async () => {
    await render(
      <MessageContextMenu
        items={makeItems()}
        isOpen={false}
        onClose={onClose}
        isOutgoing={false}
        onSelectEmoji={onSelectEmoji}
        onOpenEmojiPicker={onOpenEmojiPicker}
      />
    );

    await expect
      .element(page.getByRole('menu', { name: 'Message actions' }))
      .not.toBeInTheDocument();

    await expect
      .element(page.getByTestId('context-menu-backdrop'))
      .not.toBeInTheDocument();
  });
});
