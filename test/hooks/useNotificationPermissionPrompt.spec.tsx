// Runs in jsdom (unit project) — no browser runner needed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const mocks = vi.hoisted(() => ({
  native: true,
  discussions: [] as unknown[],
  requestPermission: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));

vi.mock('@massalabs/gossip-sdk', () => ({ SELF_CONTACT_ID: '__self__' }));

vi.mock('../../src/services/notifications', () => ({
  notificationService: { requestPermission: mocks.requestPermission },
}));

vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: (
    selector: (state: { discussions: unknown[] }) => unknown
  ) => selector({ discussions: mocks.discussions }),
}));

import { useNotificationPermissionPrompt } from '../../src/hooks/useNotificationPermissionPrompt';

function Harness() {
  useNotificationPermissionPrompt();
  return null;
}

function mount() {
  const root = createRoot(document.createElement('div'));
  const render = () => act(() => root.render(<Harness />));
  render();
  return render;
}

describe('useNotificationPermissionPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native = true;
    mocks.discussions = [];
  });

  it('does not prompt before the first conversation exists', () => {
    mount();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it('does not count the notes-to-self discussion', () => {
    mocks.discussions = [{ contactUserId: '__self__' }];
    mount();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it('prompts once a first conversation appears', () => {
    const rerender = mount();
    mocks.discussions = [{ contactUserId: 'gossip1bob' }];
    rerender();
    mocks.discussions = [
      { contactUserId: 'gossip1bob' },
      { contactUserId: 'gossip1carol' },
    ];
    rerender();
    expect(mocks.requestPermission).toHaveBeenCalledOnce();
  });

  it('never prompts on web', () => {
    mocks.native = false;
    mocks.discussions = [{ contactUserId: 'gossip1bob' }];
    mount();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });
});
