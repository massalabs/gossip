// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import {
  SessionStatus,
  type Contact,
  type Discussion,
} from '@massalabs/gossip-sdk';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'list_item.pin_discussion': 'Pin',
        'list_item.unpin_discussion': 'Unpin',
        'list_item.edit_name': 'Edit Name',
        'list_item.edit_name_title': 'Edit discussion name',
        'common:save': 'Save',
      };
      return translations[key] ?? key;
    },
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Mock the discussion store
const mockSessionsStatuses = new Map<string, SessionStatus>();

vi.mock('../../../src/stores/discussionStore', () => ({
  useDiscussionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openNameModals: new Set(),
      setModalOpen: vi.fn(),
      sessionsStatuses: mockSessionsStatuses,
    }),
}));

import DiscussionListItem from '../../../src/components/discussions/DiscussionListItem';

function makeDiscussion(overrides?: Partial<Discussion>): Discussion {
  return {
    id: 1,
    contactUserId: 'user-1',
    customName: '',
    unreadCount: 0,
    lastAnnouncementMessage: '',
    weAccepted: true,
    ...overrides,
  } as Discussion;
}

function makeContact(overrides?: Partial<Contact>): Contact {
  return {
    userId: 'user-1',
    name: 'Alice',
    ...overrides,
  } as Contact;
}

const defaultProps = {
  onSelect: vi.fn(),
  onAccept: vi.fn(),
  onRefuse: vi.fn(),
  onEditName: vi.fn(),
};

describe('DiscussionListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionsStatuses.clear();
  });

  it('long-press on active item opens context menu', async () => {
    // Active (not pending)
    render(
      <DiscussionListItem
        discussion={makeDiscussion()}
        contact={makeContact()}
        lastMessage={undefined}
        {...defaultProps}
      />
    );

    const el = page.getByRole('button').element() as HTMLElement;

    // Trigger right-click (contextmenu) — equivalent to long-press
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );

    const menu = page.getByRole('menu');
    await expect.element(menu).toBeInTheDocument();

    await expect
      .element(page.getByRole('menuitem', { name: 'Edit Name' }))
      .toBeInTheDocument();
  });

  it('no context menu on pending items', async () => {
    mockSessionsStatuses.set('user-1', SessionStatus.PeerRequested);

    render(
      <DiscussionListItem
        discussion={makeDiscussion()}
        contact={makeContact()}
        lastMessage={undefined}
        {...defaultProps}
      />
    );

    // Find the inner div (not a button for pending items)
    const container = document.querySelector('.p-4') as HTMLElement;
    container.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );

    await expect.element(page.getByRole('menu')).not.toBeInTheDocument();
  });

  it('Edit Name opens modal, confirm calls onEditName', async () => {
    render(
      <DiscussionListItem
        discussion={makeDiscussion({ customName: 'Old Name' })}
        contact={makeContact()}
        lastMessage={undefined}
        {...defaultProps}
      />
    );

    const el = page.getByRole('button').element() as HTMLElement;
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );

    await userEvent.click(page.getByRole('menuitem', { name: 'Edit Name' }));

    // Modal should be open with input
    const input = page.getByRole('textbox');
    await expect.element(input).toBeInTheDocument();

    // Clear and type new name
    await userEvent.clear(input);
    await userEvent.type(input, 'New Name');

    // Click Save
    await userEvent.click(page.getByRole('button', { name: 'Save' }));

    expect(defaultProps.onEditName).toHaveBeenCalledOnce();
    // First arg is the discussion, second is the new name
    expect(defaultProps.onEditName.mock.calls[0][1]).toBe('New Name');
  });

  it('normal click still navigates', async () => {
    render(
      <DiscussionListItem
        discussion={makeDiscussion()}
        contact={makeContact()}
        lastMessage={undefined}
        {...defaultProps}
      />
    );

    await userEvent.click(page.getByRole('button'));
    expect(defaultProps.onSelect).toHaveBeenCalledOnce();
  });
});
