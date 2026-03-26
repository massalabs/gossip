import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAccountStore } from '../../src/stores/accountStore';

// Mock getSdk to avoid real SDK initialization
vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    isSessionOpen: false,
    closeSession: vi.fn(),
    clearAllTables: vi.fn(),
    profiles: {
      getCount: vi.fn(async () => 0),
    },
  }),
}));

// Simple spies for store cleanup functions – shared instances so we can assert call counts
const discussionCleanup = vi.fn();
const messageCleanup = vi.fn();
const selfClearMessages = vi.fn();

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: {
    getState: () => ({
      cleanup: discussionCleanup,
    }),
  },
}));

vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: {
    getState: () => ({
      cleanup: messageCleanup,
    }),
  },
}));

vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: {
    getState: () => ({
      clearMessages: selfClearMessages,
    }),
  },
}));

describe('AccountStore session cleanup', () => {
  beforeEach(() => {
    discussionCleanup.mockClear();
    messageCleanup.mockClear();
    selfClearMessages.mockClear();
  });

  it('clears discussion, message, and selfMessage stores on logout', async () => {
    const logout = useAccountStore.getState().logout;
    await logout();

    expect(discussionCleanup).toHaveBeenCalledTimes(1);
    expect(messageCleanup).toHaveBeenCalledTimes(1);
    expect(selfClearMessages).toHaveBeenCalledTimes(1);
  });

  it('clears discussion, message, and selfMessage stores on resetAccount', async () => {
    const resetAccount = useAccountStore.getState().resetAccount;
    await resetAccount();

    expect(discussionCleanup).toHaveBeenCalledTimes(1);
    expect(messageCleanup).toHaveBeenCalledTimes(1);
    expect(selfClearMessages).toHaveBeenCalledTimes(1);
  });
});

describe('AccountStore logout lockedByUser', () => {
  it('sets lockedByUser to true by default (manual lock)', async () => {
    await useAccountStore.getState().logout();

    expect(useAccountStore.getState().lockedByUser).toBe(true);
  });

  it('sets lockedByUser to false when explicitly passed (auto-lock)', async () => {
    await useAccountStore.getState().logout({ lockedByUser: false });

    expect(useAccountStore.getState().lockedByUser).toBe(false);
  });

  it('sets lockedByUser to true when explicitly passed', async () => {
    await useAccountStore.getState().logout({ lockedByUser: true });

    expect(useAccountStore.getState().lockedByUser).toBe(true);
  });
});
