import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import PortableBackup from '../../src/pages/PortableBackup';

const mocks = vi.hoisted(() => ({
  sdk: { isSecureStorage: true },
  destination: { token: 'opaque-ios-token', name: 'ios.gossipbackup' },
  select: vi.fn(),
  export: vi.fn(),
  list: vi.fn(),
  cleanup: vi.fn(),
  forget: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios' },
  registerPlugin: () => ({}),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return { ...actual, useNavigate: () => vi.fn() };
});

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => mocks.sdk,
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ logout: vi.fn(), userProfile: { username: 'Alice' } }),
}));

vi.mock('../../src/services/portableBackup', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/portableBackup')
  >('../../src/services/portableBackup');
  return { ...actual, canStreamBrowserBackup: () => false };
});

vi.mock('../../src/services/portableBackupNative', () => ({
  selectNativeBackupDestination: mocks.select,
  exportNativeBackup: mocks.export,
  listInterruptedNativeBackups: mocks.list,
  cleanupInterruptedNativeBackups: mocks.cleanup,
  forgetInterruptedNativeBackups: mocks.forget,
  abandonNativeBackupDestination: mocks.abandon,
  isNativeBackupSelectionCancellation: () => false,
}));

describe('portable backup iOS page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.select.mockResolvedValue(mocks.destination);
    mocks.export.mockResolvedValue(undefined);
    mocks.list.mockResolvedValue([]);
    mocks.cleanup.mockResolvedValue({ cleaned: true, remaining: [] });
    mocks.forget.mockResolvedValue(undefined);
    mocks.abandon.mockResolvedValue(true);
  });

  it('uses the security-scoped native transport when browser streaming is unavailable', async () => {
    await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await expect.element(page.getByText('ios.gossipbackup')).toBeVisible();
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );

    await vi.waitFor(() => {
      expect(mocks.export).toHaveBeenCalledWith(
        mocks.sdk,
        mocks.destination,
        expect.objectContaining({
          notificationTitle: 'portable_backup.notification_title',
          verifying: 'portable_backup.verifying',
        }),
        expect.any(Function),
        expect.any(AbortSignal)
      );
    });
    await expect
      .element(page.getByText('portable_backup.success_title'))
      .toBeVisible();
  });
});
