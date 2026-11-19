// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { MessageDirection, MessageStatus } from '@massalabs/gossip-sdk';

const mockNavigate = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSetCurrentContact = vi.fn();
const mockDeleteMessage = vi.fn().mockResolvedValue(true);
let latestOnSend: ((text: string) => void | Promise<void>) | null = null;
const mockMessages = [
  {
    id: 1,
    msgId: 1,
    contactUserId: 'contact-1',
    ownerUserId: 'owner-1',
    content: 'Hello',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    timestamp: new Date('2025-01-01T12:00:00Z'),
    unread: false,
  },
];

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ userId: 'contact-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: null }),
}));

const mockMigrate = vi.fn().mockResolvedValue('g1');
const mockAcceptInvitation = vi.fn().mockResolvedValue('g1');
let mockInvitations: unknown[] = [];

vi.mock('../../src/hooks/useDiscussion', () => ({
  useDiscussion: () => ({
    discussion: {
      id: 1,
      contactUserId: 'contact-1',
      isArchive: true,
      archived: false,
      linkedGroupId: null,
      directChatOwed: false,
    },
    isLoading: false,
  }),
}));

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => ({
    messages: {
      get: vi.fn().mockResolvedValue(null),
      deleteMessage: mockDeleteMessage,
    },
    conversations: {
      migrate: mockMigrate,
      acceptInvitation: mockAcceptInvitation,
      setArchived: vi.fn().mockResolvedValue(undefined),
      declineInvitation: vi.fn().mockResolvedValue(undefined),
    },
  }),
}));

vi.mock('../../src/stores/groupStore', () => ({
  useGroupStore: (selector: (state: unknown) => unknown) =>
    selector({
      groups: [],
      invitations: mockInvitations,
      refresh: vi.fn().mockResolvedValue(undefined),
    }),
}));

vi.mock('../../src/hooks/useGroupMemberName', () => ({
  useGroupMemberName: () => (id: string) => id,
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: (selector: (state: unknown) => unknown) =>
    selector({
      contacts: [
        {
          userId: 'contact-1',
          ownerUserId: 'owner-1',
          name: 'Alice',
          publicKeys: new Uint8Array(),
          isOnline: false,
          lastSeen: new Date(),
          createdAt: new Date(),
        },
      ],
      sessionsStatuses: new Map(),
      patchDiscussion: vi.fn(),
    }),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      showDebugOption: false,
      pendingSharedContent: null,
      setPendingSharedContent: vi.fn(),
      setPendingForwardMessageId: vi.fn(),
    }),
}));

vi.mock('../../src/stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({ setHeaderIsScrolled: vi.fn() }),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: (selector: (state: unknown) => unknown) =>
    selector({
      setCurrentContact: mockSetCurrentContact,
      getMessagesForContact: () => mockMessages,
      isLoading: false,
      sendMessage: mockSendMessage,
    }),
}));

vi.mock('../../src/components/discussions/DiscussionHeader', () => ({
  default: () => <div>Discussion header</div>,
}));

vi.mock('../../src/components/discussions/SelectionHeader', () => ({
  default: ({
    count,
    onDelete,
    canDelete,
  }: {
    count: number;
    onDelete?: () => void;
    canDelete?: boolean;
  }) => (
    <div data-testid="selection-header">
      Selecting {count}
      {canDelete ? (
        <button type="button" aria-label="mock multi delete" onClick={onDelete}>
          Delete selected
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../../src/components/discussions/SessionIssueBanner', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/MessageSearch', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/ScrollToBottomButton', () => ({
  default: () => null,
}));

vi.mock('../../src/components/discussions/MessageList', () => ({
  default: React.forwardRef(function MockMessageList(
    {
      onToggleSelect,
    }: {
      onToggleSelect?: (messageId: number) => void;
    },
    _ref
  ) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect?.(1)}
        aria-label="toggle message selection"
      >
        Toggle selection
      </button>
    );
  }),
}));

vi.mock('../../src/components/discussions/MessageInput', () => ({
  default: ({
    onSend,
    disabled,
  }: {
    onSend: (text: string) => void;
    disabled?: boolean;
  }) => {
    latestOnSend = onSend;
    return (
      <div data-testid="message-input">
        <span>{disabled ? 'disabled' : 'enabled'}</span>
        <button
          type="button"
          aria-label="mock send"
          onClick={() => onSend('Test send')}
        >
          Send
        </button>
      </div>
    );
  },
}));

import Discussion from '../../src/pages/Discussion';

describe('Discussion: an archive (§5.12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    latestOnSend = null;
  });

  it('shows no composer, and offers Migrate and Archive', async () => {
    await render(<Discussion />);
    await expect
      .element(page.getByTestId('archive-footer'))
      .toBeInTheDocument();
    expect(latestOnSend).toBeNull();
    await expect
      .element(page.getByRole('button', { name: 'archive.archive' }))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole('button', { name: 'archive.migrate' })
    );
    await vi.waitFor(() =>
      expect(mockMigrate).toHaveBeenCalledWith('contact-1')
    );
    await vi.waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/group/g1', {
        replace: true,
      })
    );
  });

  it('shows the peer migration with Accept and Decline instead of Migrate', async () => {
    mockInvitations = [
      {
        epochId: 'e1',
        name: '',
        members: ['owner-1', 'contact-1'],
        owner: 'contact-1',
        receivedFrom: null,
        closedBefore: false,
        rejoins: null,
        migrateFrom: 0,
        migrationOf: 'contact-1',
      },
    ];
    try {
      await render(<Discussion />);
      await expect
        .element(page.getByRole('button', { name: 'invitation.accept' }))
        .toBeInTheDocument();
      expect(
        page.getByRole('button', { name: 'archive.migrate' }).elements()
      ).toHaveLength(0);
      await userEvent.click(
        page.getByRole('button', { name: 'invitation.accept' })
      );
      await vi.waitFor(() =>
        expect(mockAcceptInvitation).toHaveBeenCalledWith('e1')
      );
    } finally {
      mockInvitations = [];
    }
  });
});
