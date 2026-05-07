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

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'message_item.double_tap_reply': 'Double-tap to reply',
        'message_item.actions_menu': 'Message actions',
        'message_item.reply': 'Reply',
        'message_item.forward': 'Forward',
        'message_item.copy': 'Copy',
        'message_item.delete': 'Delete',
        'message_item.share': 'Share',
        'message_item.edit': 'Edit',
        'message_item.more_emojis': 'More emojis',
      };
      return translations[key] ?? key;
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

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
    it('opens context menu on right-click', async () => {
      const onReplyTo = vi.fn();
      const onForward = vi.fn();
      render(
        <MessageItem
          message={makeMessage()}
          onReplyTo={onReplyTo}
          onForward={onForward}
        />
      );

      // Right-click the bubble to open context menu
      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });

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

      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });

      await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }));
      expect(onReplyTo).toHaveBeenCalledOnce();
    });

    it('Forward action calls onForward', async () => {
      const onForward = vi.fn();
      render(<MessageItem message={makeMessage()} onForward={onForward} />);

      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });

      await userEvent.click(page.getByRole('menuitem', { name: 'Forward' }));
      expect(onForward).toHaveBeenCalledOnce();
    });

    it('Copy action writes to clipboard', async () => {
      const writeText = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      render(<MessageItem message={makeMessage({ content: 'Copy me' })} />);

      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });

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

  describe('waiting-approval discussion (no onReplyTo / onEdit)', () => {
    // Discussion.tsx passes undefined for onReplyTo / onEdit when the session
    // is in SelfRequested (waiting approval). These tests lock the mechanism:
    // without those handlers, the actions must be absent and swipe-to-reply
    // must not fire. Forward / Share / Copy / Delete remain available.
    async function openContextMenu() {
      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });
    }

    it('hides Reply when onReplyTo is not provided', async () => {
      render(
        <MessageItem
          message={makeMessage()}
          onForward={vi.fn()}
          onDelete={vi.fn()}
        />
      );

      await openContextMenu();
      await expect
        .element(page.getByRole('menuitem', { name: 'Reply' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Forward' }))
        .toBeInTheDocument();
    });

    it('hides Edit for outgoing message when onEdit is not provided', async () => {
      render(
        <MessageItem
          message={makeMessage({ direction: MessageDirection.OUTGOING })}
          onForward={vi.fn()}
          onDelete={vi.fn()}
        />
      );

      await openContextMenu();
      await expect
        .element(page.getByRole('menuitem', { name: 'Edit' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Delete' }))
        .toBeInTheDocument();
    });

    it('does not trigger swipe-to-reply when onReplyTo is not provided', async () => {
      const onForward = vi.fn();
      render(<MessageItem message={makeMessage()} onForward={onForward} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
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
                clientX: 80,
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
                clientX: 80,
                clientY: 100,
              }),
            ],
          })
        );
      });
      // onReplyTo isn't provided at all, and we assert the forward handler
      // wasn't triggered either (left-swipe used to forward in older revs).
      expect(onForward).not.toHaveBeenCalled();
    });
  });

  describe('optimistic message (no id)', () => {
    async function openContextMenu() {
      const bubble = page
        .getByRole('button', { name: 'Double-tap to reply' })
        .element() as HTMLElement;
      await act(async () => {
        bubble.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        );
      });
    }

    it('hides Reply/Forward/Delete in context menu when id is missing', async () => {
      render(
        <MessageItem
          message={makeMessage({ id: undefined })}
          onReplyTo={vi.fn()}
          onForward={vi.fn()}
          onDelete={vi.fn()}
        />
      );

      await openContextMenu();
      await expect.element(page.getByRole('menu')).toBeInTheDocument();

      await expect
        .element(page.getByRole('menuitem', { name: 'Reply' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Forward' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Delete' }))
        .not.toBeInTheDocument();
    });

    it('treats id=0 as unconfirmed (DB auto-increment starts at 1)', async () => {
      // Regression lock: messageStore used to push `id: 0` as a placeholder
      // for optimistic peer messages; hasConfirmedId must reject it so the
      // id-dependent actions stay hidden until the real DB id arrives.
      render(
        <MessageItem
          message={makeMessage({
            id: 0,
            direction: MessageDirection.OUTGOING,
          })}
          onReplyTo={vi.fn()}
          onForward={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onReact={vi.fn()}
        />
      );

      await openContextMenu();
      await expect
        .element(page.getByRole('menuitem', { name: 'Reply' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Forward' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Edit' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('menuitem', { name: 'Delete' }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole('button', { name: 'More emojis' }))
        .not.toBeInTheDocument();
    });

    it('hides Edit in context menu for outgoing optimistic message', async () => {
      render(
        <MessageItem
          message={makeMessage({
            id: undefined,
            direction: MessageDirection.OUTGOING,
          })}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />
      );

      await openContextMenu();
      await expect
        .element(page.getByRole('menuitem', { name: 'Edit' }))
        .not.toBeInTheDocument();
    });

    it('still exposes Copy/Share (content-based actions)', async () => {
      render(
        <MessageItem
          message={makeMessage({ id: undefined, content: 'optimistic' })}
        />
      );

      await openContextMenu();
      await expect
        .element(page.getByRole('menuitem', { name: 'Copy' }))
        .toBeInTheDocument();
    });

    it('hides the reaction emoji row when id is missing', async () => {
      render(
        <MessageItem
          message={makeMessage({ id: undefined })}
          onReact={vi.fn()}
        />
      );

      await openContextMenu();
      // The "+" more-emojis button only renders when onOpenEmojiPicker is
      // provided, which MessageItem skips when the message has no id.
      await expect
        .element(page.getByRole('button', { name: 'More emojis' }))
        .not.toBeInTheDocument();
    });

    it('does not trigger swipe-to-reply when id is missing', async () => {
      const onReplyTo = vi.fn();
      render(
        <MessageItem
          message={makeMessage({ id: undefined })}
          onReplyTo={onReplyTo}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;
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
                clientX: 80,
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
                clientX: 80,
                clientY: 100,
              }),
            ],
          })
        );
      });

      expect(onReplyTo).not.toHaveBeenCalled();
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
