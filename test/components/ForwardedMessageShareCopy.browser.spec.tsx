// Runs in BROWSER mode (real Chromium via Playwright)
// Tests share/copy context menu behavior for forwarded messages in MessageItem.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
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
        'message_item.edit': 'Edit',
        'message_item.original_message': 'Original message',
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

const mockShareMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/services/shareService', () => ({
  shareMessage: (...args: unknown[]) => mockShareMessage(...args),
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

/** Open the context menu by clicking the message bubble. */
async function openContextMenu() {
  await userEvent.click(
    page.getByRole('button', { name: 'Double-tap to reply' })
  );
  // Wait for the 120ms touch-ready delay so menu items become clickable
  await new Promise(resolve => setTimeout(resolve, 150));
}

describe('Forwarded message share/copy', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  });

  describe('share action', () => {
    it('combines originalContent and content for forwarded messages', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: 'my comment',
            forwardOf: {
              originalContent: 'forwarded text',
              originalContactId: new Uint8Array(32),
            },
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Share' }));

      expect(mockShareMessage).toHaveBeenCalledOnce();
      expect(mockShareMessage).toHaveBeenCalledWith(
        'forwarded text\n\nmy comment'
      );
    });

    it('uses only originalContent when content is empty', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: '',
            forwardOf: {
              originalContent: 'forwarded text',
              originalContactId: new Uint8Array(32),
            },
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Share' }));

      expect(mockShareMessage).toHaveBeenCalledOnce();
      expect(mockShareMessage).toHaveBeenCalledWith('forwarded text');
    });

    it('uses only content for normal messages (no forwardOf)', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: 'plain message',
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Share' }));

      expect(mockShareMessage).toHaveBeenCalledOnce();
      expect(mockShareMessage).toHaveBeenCalledWith('plain message');
    });
  });

  describe('copy action', () => {
    it('combines originalContent and content for forwarded messages', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: 'my comment',
            forwardOf: {
              originalContent: 'forwarded text',
              originalContactId: new Uint8Array(32),
            },
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Copy' }));

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith('forwarded text\n\nmy comment');
    });

    it('uses only originalContent when content is empty', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: '',
            forwardOf: {
              originalContent: 'forwarded text',
              originalContactId: new Uint8Array(32),
            },
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Copy' }));

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith('forwarded text');
    });

    it('uses only content for normal messages (no forwardOf)', async () => {
      render(
        <MessageItem
          message={makeMessage({
            content: 'plain message',
          })}
        />
      );

      await openContextMenu();
      await userEvent.click(page.getByRole('menuitem', { name: 'Copy' }));

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith('plain message');
    });
  });
});
