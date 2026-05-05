// Runs in BROWSER mode (real Chromium via Playwright)
// Tests emoji reaction badge display and interaction on message bubbles.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  MessageDirection,
  MessageStatus,
  type Message,
} from '@massalabs/gossip-sdk';
import type { ReactionGroup } from '../../src/stores/messageStore';
import { mockSelfMessagesService } from '../mocks/mockSelfMessagesService';

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
  useGossipSdk: () => ({
    isSessionOpen: false,
    selfMessages: mockSelfMessagesService,
  }),
}));

vi.mock('../../src/hooks/useMarkMessageAsRead', () => ({
  useMarkMessageAsRead: () => React.createRef(),
}));

import MessageItem from '../../src/components/discussions/MessageItem';

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

describe('EmojiReactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('reaction badge rendering', () => {
    it('renders no reaction badges when reactions array is empty', async () => {
      render(<MessageItem message={makeMessage()} reactions={[]} />);

      // The message should render, but no reaction buttons should appear
      // (the only buttons should be the bubble and the hover arrow)
      const listItem = page.getByRole('listitem');
      await expect.element(listItem).toBeInTheDocument();

      // Reaction badges are buttons inside the bubble — there should be
      // no button with emoji text content
      const el = listItem.element() as HTMLElement;
      const reactionButtons = el.querySelectorAll(
        '[data-testid="reactions-bar"] button'
      );
      expect(reactionButtons.length).toBe(0);
    });

    it('renders a single reaction badge with emoji only (count 1)', async () => {
      const reactions: ReactionGroup[] = [{ emoji: '👍', count: 1 }];

      render(<MessageItem message={makeMessage()} reactions={reactions} />);

      const listItem = page.getByRole('listitem');
      await expect.element(listItem).toBeInTheDocument();

      // Find buttons that contain the emoji
      const el = listItem.element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const thumbsUpBtn = buttons.find(btn => btn.textContent?.includes('👍'));
      expect(thumbsUpBtn).toBeTruthy();
      // Count of 1 should NOT show a number
      expect(thumbsUpBtn!.textContent).toBe('👍');
    });

    it('renders reaction badge with count when count > 1', async () => {
      const reactions: ReactionGroup[] = [{ emoji: '❤️', count: 5 }];

      render(<MessageItem message={makeMessage()} reactions={reactions} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const heartBtn = buttons.find(btn => btn.textContent?.includes('❤️'));
      expect(heartBtn).toBeTruthy();
      // Count > 1 should display the number after the emoji
      expect(heartBtn!.textContent).toBe('❤️5');
    });

    it('renders multiple reaction badges', async () => {
      const reactions: ReactionGroup[] = [
        { emoji: '👍', count: 3 },
        { emoji: '😂', count: 1 },
        { emoji: '❤️', count: 2 },
      ];

      render(<MessageItem message={makeMessage()} reactions={reactions} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));

      const thumbsUp = buttons.find(b => b.textContent?.includes('👍'));
      const laugh = buttons.find(b => b.textContent?.includes('😂'));
      const heart = buttons.find(b => b.textContent?.includes('❤️'));

      expect(thumbsUp).toBeTruthy();
      expect(thumbsUp!.textContent).toBe('👍3');

      expect(laugh).toBeTruthy();
      expect(laugh!.textContent).toBe('😂');

      expect(heart).toBeTruthy();
      expect(heart!.textContent).toBe('❤️2');
    });

    it('highlights own reaction with accent border', async () => {
      const reactions: ReactionGroup[] = [
        { emoji: '👍', count: 2, myReactionId: 42 },
        { emoji: '😂', count: 1 },
      ];

      render(<MessageItem message={makeMessage()} reactions={reactions} />);

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));

      const myReaction = buttons.find(b => b.textContent?.includes('👍'));
      const otherReaction = buttons.find(b => b.textContent?.includes('😂'));

      expect(myReaction).toBeTruthy();
      expect(otherReaction).toBeTruthy();

      // className check: no aria/data attribute distinguishes own reactions
      expect(myReaction!.className).toContain('border-accent');
      // Other reaction should have the default border class
      expect(otherReaction!.className).toContain('border-border');
    });

    it('renders reaction badges on outgoing messages', async () => {
      const reactions: ReactionGroup[] = [{ emoji: '🙏', count: 1 }];

      render(
        <MessageItem
          message={makeMessage({ direction: MessageDirection.OUTGOING })}
          reactions={reactions}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const prayBtn = buttons.find(b => b.textContent?.includes('🙏'));
      expect(prayBtn).toBeTruthy();
    });
  });

  describe('reaction badge interaction', () => {
    it('calls onToggleReaction when clicking a reaction badge', async () => {
      const onToggleReaction = vi.fn();
      const msg = makeMessage();
      const reactions: ReactionGroup[] = [{ emoji: '👍', count: 2 }];

      render(
        <MessageItem
          message={msg}
          reactions={reactions}
          onToggleReaction={onToggleReaction}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const thumbsUpBtn = buttons.find(b => b.textContent?.includes('👍'));
      expect(thumbsUpBtn).toBeTruthy();

      await userEvent.click(thumbsUpBtn!);

      expect(onToggleReaction).toHaveBeenCalledOnce();
      expect(onToggleReaction).toHaveBeenCalledWith(
        msg,
        '👍',
        undefined,
        undefined
      );
    });

    it('passes myReactionId when toggling own reaction', async () => {
      const onToggleReaction = vi.fn();
      const msg = makeMessage();
      const reactions: ReactionGroup[] = [
        { emoji: '❤️', count: 1, myReactionId: 99 },
      ];

      render(
        <MessageItem
          message={msg}
          reactions={reactions}
          onToggleReaction={onToggleReaction}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const heartBtn = buttons.find(b => b.textContent?.includes('❤️'));
      expect(heartBtn).toBeTruthy();

      await userEvent.click(heartBtn!);

      expect(onToggleReaction).toHaveBeenCalledOnce();
      expect(onToggleReaction).toHaveBeenCalledWith(msg, '❤️', 99, undefined);
    });

    it('does not open context menu when clicking a reaction badge', async () => {
      const onToggleReaction = vi.fn();
      const reactions: ReactionGroup[] = [{ emoji: '👍', count: 1 }];

      render(
        <MessageItem
          message={makeMessage()}
          reactions={reactions}
          onToggleReaction={onToggleReaction}
          onReplyTo={vi.fn()}
        />
      );

      const el = page.getByRole('listitem').element() as HTMLElement;
      const buttons = Array.from(el.querySelectorAll('button'));
      const thumbsUpBtn = buttons.find(b => b.textContent?.includes('👍'));

      await userEvent.click(thumbsUpBtn!);

      // Context menu should NOT open
      await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
      // But the toggle handler should have fired
      expect(onToggleReaction).toHaveBeenCalledOnce();
    });
  });
});
