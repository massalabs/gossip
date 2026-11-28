// Runs in jsdom (unit project) — no browser runner needed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import enAuth from '../../src/i18n/locales/en/auth.json';
import frAuth from '../../src/i18n/locales/fr/auth.json';
import ruAuth from '../../src/i18n/locales/ru/auth.json';
import zhAuth from '../../src/i18n/locales/zh-CN/auth.json';

const mocks = vi.hoisted(() => ({
  state: {
    userProfile: null as unknown,
    sessionsResetNotice: false,
    acknowledgeSessionsResetNotice: vi.fn(async () => {
      mocks.state.sessionsResetNotice = false;
    }),
  },
  toast: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({ default: mocks.toast }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: typeof mocks.state) => unknown) =>
    selector(mocks.state),
}));

import { useSessionsResetNotice } from '../../src/hooks/useSessionsResetNotice';

function Harness() {
  useSessionsResetNotice();
  return null;
}

function mount() {
  const root = createRoot(document.createElement('div'));
  const render = () => act(() => root.render(<Harness />));
  render();
  return render;
}

describe('useSessionsResetNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.userProfile = null;
    mocks.state.sessionsResetNotice = false;
  });

  it('shows nothing outside an account, or without a reset', () => {
    mocks.state.sessionsResetNotice = true;
    const render = mount();
    mocks.state.userProfile = { userId: 'u' };
    mocks.state.sessionsResetNotice = false;
    render();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('shows the line once inside the account, then clears the mark', async () => {
    mocks.state.userProfile = { userId: 'u' };
    mocks.state.sessionsResetNotice = true;
    const render = mount();
    render();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(
      'private_migration.sessions_reset',
      expect.anything()
    );
    expect(mocks.state.acknowledgeSessionsResetNotice).toHaveBeenCalledOnce();
  });

  it('has the line in every language', () => {
    expect(enAuth.private_migration.sessions_reset).toBe(
      'Restored from a backup. Reconnecting to your contacts.'
    );
    for (const locale of [frAuth, ruAuth, zhAuth]) {
      expect(locale.private_migration.sessions_reset).toEqual(
        expect.any(String)
      );
      expect(locale.private_migration.sessions_reset).not.toBe(
        enAuth.private_migration.sessions_reset
      );
    }
  });
});
