/**
 * setupSdkEventHandlers — mute notification tests
 *
 * Verifies that MESSAGE_RECEIVED events do not trigger a push notification
 * when the corresponding discussion has mutedNotifications = true.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MessageDirection,
  MessageType,
  MessageStatus,
  DiscussionDirection,
  type Discussion,
  type Message,
  SdkEventType,
} from '@massalabs/gossip-sdk';

// ── mocks ────────────────────────────────────────────────────────────────────

const mockShowDiscussionNotification = vi.fn();

vi.mock('../../src/services/notifications', () => ({
  notificationService: {
    showDiscussionNotification: mockShowDiscussionNotification,
    showNewDiscussionNotification: vi.fn(),
  },
}));

const mockIsAppInForeground = vi.fn(async () => false);
vi.mock('../../src/utils/appState', () => ({
  isAppInForeground: () => mockIsAppInForeground(),
}));

vi.mock('../../src/sw-bridge', () => ({
  bridgeSet: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/preferences', () => ({
  setActiveSeekersInPreferences: vi.fn(async () => {}),
}));

const mockDiscussionStoreState = {
  contacts: [{ userId: 'contact-1', name: 'Alice' }],
  discussions: [] as Discussion[],
  currentContactUserId: null as string | null,
};

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: {
    getState: () => mockDiscussionStoreState,
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: {
    getState: () => ({
      currentContactUserId: mockDiscussionStoreState.currentContactUserId,
    }),
  },
}));

// ── helpers ───────────────────────────────────────────────────────────────────

type EventHandler = (...args: unknown[]) => unknown;

function createMockGossipSdk() {
  const handlers = new Map<string, EventHandler>();
  return {
    on: vi.fn((event: string, handler: EventHandler) => {
      handlers.set(event, handler);
    }),
    off: vi.fn(),
    _emit: (event: string, ...args: unknown[]) => {
      handlers.get(event)?.(...args);
    },
  };
}

const baseDiscussion: Discussion = {
  id: 1,
  ownerUserId: 'owner',
  contactUserId: 'contact-1',
  direction: DiscussionDirection.INITIATED,
  weAccepted: true,
  sendAnnouncement: null,
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
  mutedNotifications: false,
  messageRetentionDuration: null,
  retentionPolicySetAt: null,
  saturatedRetryDone: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const incomingMessage: Message = {
  id: 1,
  ownerUserId: 'owner',
  contactUserId: 'contact-1',
  content: 'Hello',
  type: MessageType.TEXT,
  direction: MessageDirection.INCOMING,
  status: MessageStatus.DELIVERED,
  timestamp: new Date(),
  metadata: null,
  replyTo: null,
  forwardOf: null,
  deleteOf: null,
  editOf: null,
  reactionOf: null,
};

// ── tests ─────────────────────────────────────────────────────────────────────

describe('setupSdkEventHandlers — mute notifications', () => {
  let sdk: ReturnType<typeof createMockGossipSdk>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockIsAppInForeground.mockResolvedValue(false);
    mockDiscussionStoreState.currentContactUserId = null;
    mockDiscussionStoreState.contacts = [
      { userId: 'contact-1', name: 'Alice' },
    ];
    mockDiscussionStoreState.discussions = [];

    sdk = createMockGossipSdk();
    // Import fresh each test so vi.mock() takes effect
    const { setupSdkEventHandlers } = await import('../../src/services/index');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setupSdkEventHandlers(sdk as any);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('shows a notification for an incoming message when not muted', async () => {
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: false },
    ];

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, incomingMessage);
    // Allow async handler to run
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).toHaveBeenCalledOnce();
    expect(mockShowDiscussionNotification).toHaveBeenCalledWith(
      'Alice',
      incomingMessage.content,
      'contact-1'
    );
  });

  it('suppresses the notification when mutedNotifications = true', async () => {
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: true },
    ];

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, incomingMessage);
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).not.toHaveBeenCalled();
  });

  it('does not notify when the user is already viewing that discussion', async () => {
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: false },
    ];
    mockDiscussionStoreState.currentContactUserId = 'contact-1';

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, incomingMessage);
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).not.toHaveBeenCalled();
  });

  it('does not notify when the app is in the foreground', async () => {
    mockIsAppInForeground.mockResolvedValue(true);
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: false },
    ];

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, incomingMessage);
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).not.toHaveBeenCalled();
  });

  it('does not notify for KEEP_ALIVE messages even when not muted', async () => {
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: false },
    ];

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, {
      ...incomingMessage,
      type: MessageType.KEEP_ALIVE,
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).not.toHaveBeenCalled();
  });

  it('does not notify for outgoing messages', async () => {
    mockDiscussionStoreState.discussions = [
      { ...baseDiscussion, mutedNotifications: false },
    ];

    sdk._emit(SdkEventType.MESSAGE_RECEIVED, {
      ...incomingMessage,
      direction: MessageDirection.OUTGOING,
    });
    await new Promise(r => setTimeout(r, 20));

    expect(mockShowDiscussionNotification).not.toHaveBeenCalled();
  });
});
