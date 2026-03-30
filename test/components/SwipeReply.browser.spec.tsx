// Runs in BROWSER mode (real Chromium via Playwright)
// Tests swipe-left-to-reply gesture on MessageItem.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@massalabs/gossip-sdk';

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
        'message_item.sent_message': 'Sent message',
        'message_item.received_message': 'Received message',
        'message_item.add_reaction': 'Add reaction',
        'message_item.more_emojis': 'More emojis',
      };
      return translations[key] ?? key;
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({ isSessionOpen: false }),
}));

vi.mock('../../src/hooks/useMarkMessageAsRead', () => ({
  useMarkMessageAsRead: () => React.createRef(),
}));

import MessageItem from '../../src/components/discussions/MessageItem';

// ---------- Helpers ----------

function makeMessage(overrides?: Partial<Message>): Message {
  return {
    id: 42,
    msgId: 42,
    contactUserId: 'contact-1',
    ownerUserId: 'owner-1',
    content: 'Swipe me',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date('2025-01-01T12:00:00Z'),
    unread: false,
    ...overrides,
  } as Message;
}

/**
 * Simulate a horizontal swipe on an element by dispatching touch events.
 * deltaX < 0 = left swipe, deltaX > 0 = right swipe.
 */
function simulateSwipe(
  el: HTMLElement,
  deltaX: number,
  deltaY = 0,
  steps = 10
) {
  const startX = 200;
  const startY = 200;

  el.dispatchEvent(
    new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [
        new Touch({
          identifier: 0,
          target: el,
          clientX: startX,
          clientY: startY,
        }),
      ],
    })
  );

  for (let i = 1; i <= steps; i++) {
    const ratio = i / steps;
    el.dispatchEvent(
      new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [
          new Touch({
            identifier: 0,
            target: el,
            clientX: startX + deltaX * ratio,
            clientY: startY + deltaY * ratio,
          }),
        ],
      })
    );
  }

  el.dispatchEvent(
    new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      changedTouches: [
        new Touch({
          identifier: 0,
          target: el,
          clientX: startX + deltaX,
          clientY: startY + deltaY,
        }),
      ],
      touches: [],
    })
  );
}

// ---------- Tests ----------

describe('SwipeReply — swipe-left to reply', () => {
  let onReplyTo: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onReplyTo = vi.fn();
  });

  it('calls onReplyTo after a sufficient left swipe on incoming message', async () => {
    const msg = makeMessage();
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Swipe left by -200px (effective = -200 * 0.5 = -100, exceeds threshold 40)
    simulateSwipe(el, -200);

    expect(onReplyTo).toHaveBeenCalledOnce();
    expect(onReplyTo).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
  });

  it('calls onReplyTo after a sufficient left swipe on outgoing message', async () => {
    const msg = makeMessage({ direction: MessageDirection.OUTGOING });
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Outgoing: resistance=0.65, threshold=30, so -200*0.65 = -130 (clamped to -90 by max), exceeds 30
    simulateSwipe(el, -200);

    expect(onReplyTo).toHaveBeenCalledOnce();
  });

  it('does NOT trigger reply on a short swipe below threshold', async () => {
    const msg = makeMessage();
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Swipe left only -30px (effective = -30 * 0.5 = -15, below threshold 40)
    simulateSwipe(el, -30);

    expect(onReplyTo).not.toHaveBeenCalled();
  });

  it('does NOT trigger reply on a right swipe', async () => {
    const msg = makeMessage();
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Right swipe: clamped to 0 by Math.min(0, ...)
    simulateSwipe(el, 200);

    expect(onReplyTo).not.toHaveBeenCalled();
  });

  it('does NOT trigger reply on a vertical scroll gesture', async () => {
    const msg = makeMessage();
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Mostly vertical movement — should be rejected as scroll
    simulateSwipe(el, -20, 200);

    expect(onReplyTo).not.toHaveBeenCalled();
  });

  it('does not crash when onReplyTo is not provided', async () => {
    const msg = makeMessage();
    // No onReplyTo prop — canReply is false, swipe handlers should no-op
    render(<MessageItem message={msg} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    // Should not throw
    simulateSwipe(el, -200);

    expect(onReplyTo).not.toHaveBeenCalled();
  });

  it('passes the correct message object to onReplyTo', async () => {
    const msg = makeMessage({ content: 'Important message' });
    render(<MessageItem message={msg} onReplyTo={onReplyTo} reactions={[]} />);

    const listItem = page.getByRole('listitem');
    await expect.element(listItem).toBeInTheDocument();

    const el = listItem.element() as HTMLElement;
    simulateSwipe(el, -200);

    expect(onReplyTo).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        content: 'Important message',
      })
    );
  });
});
