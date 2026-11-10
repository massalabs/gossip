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

  it('prompts once a first conversation appears', () => {
    const rerender = mount();
    mocks.discussions = [{}];
    rerender();
    mocks.discussions = [{}, {}];
    rerender();
    expect(mocks.requestPermission).toHaveBeenCalledOnce();
  });

  it('never prompts on web', () => {
    mocks.native = false;
    mocks.discussions = [{}];
    mount();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });
});
