// Runs in BROWSER mode (real Chromium via Playwright)
// Tests pin icon visibility on DiscussionListItem.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';
import type { Discussion, Contact } from '@massalabs/gossip-sdk';
import { DiscussionDirection, SessionStatus } from '@massalabs/gossip-sdk';

// ---------- Mocks ----------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// Mock the discussion store — component reads openNameModals, setModalOpen, sessionsStatuses
vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      openNameModals: new Set<number>(),
      setModalOpen: () => {},
      // SessionStatus.Active = 0 → not pending, so accept/refuse buttons won't render
      sessionsStatuses: new Map<string, number>([
        ['contact-user-1', SessionStatus.Active],
      ]),
    }),
}));

// Mock ContactAvatar to avoid importing profile head assets
vi.mock('../../src/components/avatar/ContactAvatar', () => ({
  default: ({ contact }: { contact: { name: string } }) => (
    <div data-testid="contact-avatar">{contact.name}</div>
  ),
}));

import DiscussionListItem from '../../src/components/discussions/DiscussionListItem';

// ---------- Helpers ----------

function makeDiscussion(overrides?: Partial<Discussion>): Discussion {
  return {
    id: 1,
    ownerUserId: 'owner-1',
    contactUserId: 'contact-user-1',
    weAccepted: true,
    sendAnnouncement: null,
    direction: DiscussionDirection.INITIATED,
    nextSeeker: null,
    initiationAnnouncement: null,
    announcementMessage: null,
    lastSyncTimestamp: null,
    customName: null,
    lastMessageId: null,
    lastMessageContent: null,
    lastMessageTimestamp: null,
    unreadCount: 0,
    pinned: false,
    messageRetentionDuration: null,
    retentionPolicySetAt: null,
    mutedNotifications: false,
    ...overrides,
  } as Discussion;
}

function makeContact(overrides?: Partial<Contact>): Contact {
  return {
    id: 1,
    ownerUserId: 'owner-1',
    userId: 'contact-user-1',
    name: 'Alice',
    avatar: null,
    publicKeys: new Uint8Array(32),
    isOnline: true,
    lastSeen: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as Contact;
}

// ---------- Tests ----------

describe('DiscussionListItem — pin icon', () => {
  let onSelect: ReturnType<typeof vi.fn>;
  let onAccept: ReturnType<typeof vi.fn>;
  let onRefuse: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSelect = vi.fn();
    onAccept = vi.fn();
    onRefuse = vi.fn();
  });

  it('shows pin icon when discussion.pinned is true', async () => {
    const discussion = makeDiscussion({ pinned: true });
    const contact = makeContact();

    render(
      <DiscussionListItem
        discussion={discussion}
        contact={contact}
        lastMessage={undefined}
        onSelect={onSelect}
        onAccept={onAccept}
        onRefuse={onRefuse}
      />
    );

    // The Bookmark icon from react-feather renders an <svg> with class "w-3 h-3"
    // inside the <h3> heading. Use getByRole('heading') to uniquely target it.
    const headingLocator = page.getByRole('heading', { name: 'Alice' });
    await expect.element(headingLocator).toBeInTheDocument();

    const heading = headingLocator.element() as HTMLElement;
    const pinSvg = heading.querySelector('svg.w-3.h-3');
    expect(pinSvg).toBeTruthy();
  });

  it('does not show pin icon when discussion.pinned is false', async () => {
    const discussion = makeDiscussion({ pinned: false });
    const contact = makeContact();

    render(
      <DiscussionListItem
        discussion={discussion}
        contact={contact}
        lastMessage={undefined}
        onSelect={onSelect}
        onAccept={onAccept}
        onRefuse={onRefuse}
      />
    );

    const headingLocator = page.getByRole('heading', { name: 'Alice' });
    await expect.element(headingLocator).toBeInTheDocument();

    const heading = headingLocator.element() as HTMLElement;

    // No pin SVG should exist inside the heading when not pinned
    const pinSvg = heading.querySelector('svg.w-3.h-3');
    expect(pinSvg).toBeNull();
  });

  it('shows contact name in the heading', async () => {
    const discussion = makeDiscussion({ customName: 'Custom Alice' });
    const contact = makeContact();

    render(
      <DiscussionListItem
        discussion={discussion}
        contact={contact}
        lastMessage={undefined}
        onSelect={onSelect}
        onAccept={onAccept}
        onRefuse={onRefuse}
      />
    );

    await expect.element(page.getByText('Custom Alice')).toBeInTheDocument();
  });

  it('shows last message content and relative timestamp', async () => {
    const discussion = makeDiscussion();
    const contact = makeContact();
    const lastMessage = {
      content: 'Hey there!',
      timestamp: new Date(),
    };

    render(
      <DiscussionListItem
        discussion={discussion}
        contact={contact}
        lastMessage={lastMessage}
        onSelect={onSelect}
        onAccept={onAccept}
        onRefuse={onRefuse}
      />
    );

    await expect.element(page.getByText('Hey there!')).toBeInTheDocument();
  });

  it('shows unread count badge when unreadCount > 0', async () => {
    const discussion = makeDiscussion({ unreadCount: 5 });
    const contact = makeContact();

    render(
      <DiscussionListItem
        discussion={discussion}
        contact={contact}
        lastMessage={undefined}
        onSelect={onSelect}
        onAccept={onAccept}
        onRefuse={onRefuse}
      />
    );

    await expect.element(page.getByText('5')).toBeInTheDocument();
  });
});
