// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act } from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
} from '@massalabs/gossip-sdk';
import { Capacitor } from '@capacitor/core';

vi.mock('../../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({ isSessionOpen: false }),
}));

vi.mock('../../../src/hooks/useMarkMessageAsRead', () => ({
  useMarkMessageAsRead: () => React.createRef(),
}));

import MessageItem from '../../../src/components/discussions/MessageItem';

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 1,
    msgId: 1,
    contactUserId: 'contact-1',
    ownerUserId: 'owner-1',
    content: 'Hello world',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date('2025-01-01T12:00:00Z'),
    unread: false,
    ...overrides,
  } as Message;
}

describe('MessageItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('context menu', () => {
    it('opens context menu on click', async () => {
      const onReplyTo = vi.fn();
      const onForward = vi.fn();
      render(
        <MessageItem
          message={makeMessage()}
          onReplyTo={onReplyTo}
          onForward={onForward}
        />
      );

      // Click the bubble to open context menu
      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );

      const menu = page.getByRole('menu');
      await expect.element(menu).toBeInTheDocument();

      await expect
        .element(page.getByRole('menuitem', { name: 'Reply' }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Forward' }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Copy' }))
        .toBeInTheDocument();
    });

    it('Reply action calls onReplyTo', async () => {
      const onReplyTo = vi.fn();
      render(<MessageItem message={makeMessage()} onReplyTo={onReplyTo} />);

      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );

      await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }));
      expect(onReplyTo).toHaveBeenCalledOnce();
    });

    it('Forward action calls onForward', async () => {
      const onForward = vi.fn();
      render(<MessageItem message={makeMessage()} onForward={onForward} />);

      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );

      await userEvent.click(page.getByRole('menuitem', { name: 'Forward' }));
      expect(onForward).toHaveBeenCalledOnce();
    });

    it('Copy action writes to clipboard', async () => {
      const writeText = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      render(<MessageItem message={makeMessage({ content: 'Copy me' })} />);

      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );

      await userEvent.click(page.getByRole('menuitem', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith('Copy me');
      writeText.mockRestore();
    });

    it('shows hover arrow on desktop', async () => {
      render(<MessageItem message={makeMessage()} onReplyTo={vi.fn()} />);

      const btn = page.getByRole('button', { name: 'Message actions' });
      await expect.element(btn).toBeInTheDocument();
    });

    it('does not expose actions for deleted messages', async () => {
      render(
        <MessageItem
          message={makeMessage({ type: MessageType.DELETED })}
          onReplyTo={vi.fn()}
          onForward={vi.fn()}
        />
      );

      await expect
        .element(page.getByRole('button', { name: 'Double-tap to reply' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('button', { name: 'Message actions' }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
    });
  });

  describe('swipe gestures', () => {
    it('does not trigger left swipe forward anymore', async () => {
      const onForward = vi.fn();
      render(
        <MessageItem
          message={makeMessage()}
          onReplyTo={vi.fn()}
          onForward={onForward}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;

      // Simulate left swipe
      await act(async () => {
        el.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [
              new Touch({
                identifier: 0,
                target: el,
                clientX: 200,
                clientY: 100,
              }),
            ],
          })
        );
        el.dispatchEvent(
          new TouchEvent('touchmove', {
            bubbles: true,
            touches: [
              new Touch({
                identifier: 0,
                target: el,
                clientX: 100,
                clientY: 100,
              }),
            ],
          })
        );
        el.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            changedTouches: [
              new Touch({
                identifier: 0,
                target: el,
                clientX: 100,
                clientY: 100,
              }),
            ],
          })
        );
      });

      expect(onForward).not.toHaveBeenCalled();
    });
  });

  describe('multi-select', () => {
    it('does not toggle selection for deleted messages', async () => {
      const onToggleSelect = vi.fn();
      render(
        <MessageItem
          message={makeMessage({ type: MessageType.DELETED })}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={onToggleSelect}
        />
      );

      await userEvent.click(page.getByRole('listitem'));
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it('does not immediately deselect after Android long-press', async () => {
      const platformSpy = vi
        .spyOn(Capacitor, 'getPlatform')
        .mockReturnValue('android');
      const onToggleSelect = vi.fn();

      const SelectionHarness: React.FC = () => {
        const [selected, setSelected] = React.useState<Set<number>>(new Set());
        const toggle = (messageId: number) => {
          onToggleSelect(messageId);
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(messageId)) {
              next.delete(messageId);
            } else {
              next.add(messageId);
            }
            return next;
          });
        };

        return (
          <MessageItem
            message={makeMessage()}
            isSelecting={selected.size > 0}
            isSelected={selected.has(1)}
            onToggleSelect={toggle}
          />
        );
      };

      render(<SelectionHarness />);

      const row = page.getByRole('listitem').element() as HTMLElement;
      const bubble = page
        .getByRole('button', {
          name: 'Double-tap to reply',
        })
        .element() as HTMLElement;

      await act(async () => {
        row.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );
        await new Promise(resolve => setTimeout(resolve, 550));
        row.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            changedTouches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );

        // Emulate the synthesized click that can happen immediately after
        // long-press on Android.
        bubble.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      platformSpy.mockRestore();
    });

    it('does not toggle from checkbox during post-long-press suppression window', async () => {
      const platformSpy = vi
        .spyOn(Capacitor, 'getPlatform')
        .mockReturnValue('android');
      const onToggleSelect = vi.fn();

      const SelectionHarness: React.FC = () => {
        const [selected, setSelected] = React.useState<Set<number>>(new Set());
        const toggle = (messageId: number) => {
          onToggleSelect(messageId);
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(messageId)) {
              next.delete(messageId);
            } else {
              next.add(messageId);
            }
            return next;
          });
        };

        return (
          <MessageItem
            message={makeMessage()}
            isSelecting={selected.size > 0}
            isSelected={selected.has(1)}
            onToggleSelect={toggle}
          />
        );
      };

      render(<SelectionHarness />);
      const row = page.getByRole('listitem').element() as HTMLElement;

      await act(async () => {
        row.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );
        await new Promise(resolve => setTimeout(resolve, 550));
        row.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            changedTouches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );
      });

      const checkbox = row.querySelector(
        '[data-testid="select-checkbox"]'
      ) as HTMLElement;
      checkbox.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      platformSpy.mockRestore();
    });

    it('ignores duplicate long-press trigger in the same gesture window', async () => {
      const platformSpy = vi
        .spyOn(Capacitor, 'getPlatform')
        .mockReturnValue('android');
      const onToggleSelect = vi.fn();

      const SelectionHarness: React.FC = () => {
        const [selected, setSelected] = React.useState<Set<number>>(new Set());
        const toggle = (messageId: number) => {
          onToggleSelect(messageId);
          setSelected(prev => {
            const next = new Set(prev);
            if (next.has(messageId)) {
              next.delete(messageId);
            } else {
              next.add(messageId);
            }
            return next;
          });
        };

        return (
          <MessageItem
            message={makeMessage()}
            isSelecting={selected.size > 0}
            isSelected={selected.has(1)}
            onToggleSelect={toggle}
            onReplyTo={vi.fn()}
          />
        );
      };

      render(<SelectionHarness />);
      const row = page.getByRole('listitem').element() as HTMLElement;

      await act(async () => {
        row.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            touches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );
        await new Promise(resolve => setTimeout(resolve, 550));
        row.dispatchEvent(
          new TouchEvent('touchend', {
            bubbles: true,
            changedTouches: [
              new Touch({
                identifier: 0,
                target: row,
                clientX: 120,
                clientY: 80,
              }),
            ],
          })
        );

        // Simulate an extra contextmenu-triggered long-press callback.
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });

      expect(onToggleSelect).toHaveBeenCalledTimes(1);
      platformSpy.mockRestore();
    });

    it('shows selection checkbox when selecting is enabled', async () => {
      render(
        <MessageItem
          message={makeMessage()}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={vi.fn()}
        />
      );

      const listItem = page.getByRole('listitem').element() as HTMLElement;
      const checkbox = listItem.querySelector(
        '[data-testid="select-checkbox"]'
      ) as HTMLElement | null;
      expect(checkbox).toBeTruthy();
    });

    it('toggles selection on bubble click and does not open context menu', async () => {
      const onToggleSelect = vi.fn();
      render(
        <MessageItem
          message={makeMessage()}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={onToggleSelect}
          onReplyTo={vi.fn()}
          onForward={vi.fn()}
        />
      );

      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );

      expect(onToggleSelect).toHaveBeenCalledWith(1);
      await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
    });

    it('toggles selection on row click in selecting mode', async () => {
      const onToggleSelect = vi.fn();
      render(
        <MessageItem
          message={makeMessage()}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={onToggleSelect}
        />
      );

      await userEvent.click(page.getByRole('listitem'));
      expect(onToggleSelect).toHaveBeenCalledWith(1);
    });

    it('does not call onToggleSelect when message.id is missing', async () => {
      const onToggleSelect = vi.fn();
      render(
        <MessageItem
          message={makeMessage({ id: undefined })}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={onToggleSelect}
        />
      );

      await userEvent.click(
        page.getByRole('button', { name: 'Double-tap to reply' })
      );
      await userEvent.click(page.getByRole('listitem'));
      expect(onToggleSelect).not.toHaveBeenCalled();
    });

    it('calls onToggleSelect when message.id is 0', async () => {
      const onToggleSelect = vi.fn();
      render(
        <MessageItem
          message={makeMessage({ id: 0 })}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={onToggleSelect}
        />
      );

      await userEvent.click(page.getByRole('listitem'));
      expect(onToggleSelect).toHaveBeenCalledWith(0);
    });

    it('hides desktop message actions button while selecting', async () => {
      render(
        <MessageItem
          message={makeMessage()}
          isSelecting={true}
          isSelected={false}
          onToggleSelect={vi.fn()}
          onReplyTo={vi.fn()}
        />
      );

      await expect
        .element(page.getByRole('button', { name: 'Message actions' }))
        .not.toBeInTheDocument();
    });
  });
});
