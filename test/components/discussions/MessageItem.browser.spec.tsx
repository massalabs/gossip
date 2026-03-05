// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@massalabs/gossip-sdk';

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

      const msg = page.getByRole('listitem');
      const el = msg.element() as HTMLElement;

      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
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

      const el = page.getByRole('listitem').element() as HTMLElement;
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );

      await userEvent.click(page.getByRole('menuitem', { name: 'Reply' }));
      expect(onReplyTo).toHaveBeenCalledOnce();
    });

    it('Forward action calls onForward', async () => {
      const onForward = vi.fn();
      render(<MessageItem message={makeMessage()} onForward={onForward} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );

      await userEvent.click(page.getByRole('menuitem', { name: 'Forward' }));
      expect(onForward).toHaveBeenCalledOnce();
    });

    it('Copy action writes to clipboard', async () => {
      const writeText = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue();

      render(<MessageItem message={makeMessage({ content: 'Copy me' })} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
      el.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
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

      expect(onForward).not.toHaveBeenCalled();
    });
  });
});
