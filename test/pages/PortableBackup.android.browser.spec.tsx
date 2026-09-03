import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import PortableBackup from '../../src/pages/PortableBackup';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  sdk: { isSecureStorage: true },
  destination: { token: 'opaque-token', name: 'android.gossipbackup' },
  select: vi.fn(),
  export: vi.fn(),
  interrupted: vi.fn(),
  cleanup: vi.fn(),
  forget: vi.fn(),
  abandon: vi.fn(),
  restart: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android' },
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
    selector({ logout: mocks.logout, userProfile: { username: 'Alice' } }),
}));

vi.mock('../../src/services/portableBackup', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/portableBackup')
  >('../../src/services/portableBackup');
  return {
    ...actual,
    canStreamBrowserBackup: () => false,
    restartAfterPortableBackup: mocks.restart,
  };
});

vi.mock('../../src/services/portableBackupNative', () => ({
  selectNativeBackupDestination: mocks.select,
  exportNativeBackup: mocks.export,
  listInterruptedNativeBackups: mocks.interrupted,
  cleanupInterruptedNativeBackups: mocks.cleanup,
  forgetInterruptedNativeBackups: mocks.forget,
  abandonNativeBackupDestination: mocks.abandon,
  isNativeBackupSelectionCancellation: () => false,
}));

describe('portable backup Android page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.select.mockResolvedValue(mocks.destination);
    mocks.export.mockResolvedValue(undefined);
    mocks.interrupted.mockResolvedValue([]);
    mocks.cleanup.mockResolvedValue({ cleaned: true, remaining: [] });
    mocks.forget.mockResolvedValue(undefined);
    mocks.abandon.mockResolvedValue(true);
    mocks.logout.mockResolvedValue(undefined);
  });

  it('uses the native picker and verified native exporter', async () => {
    await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await expect.element(page.getByText('android.gossipbackup')).toBeVisible();
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );

    await vi.waitFor(() => {
      expect(mocks.export).toHaveBeenCalledWith(
        mocks.sdk,
        mocks.destination,
        {
          notificationTitle: 'portable_backup.notification_title',
          preparing: 'portable_backup.preparing',
          writing: 'portable_backup.writing',
          verifying: 'portable_backup.verifying',
        },
        expect.any(Function),
        expect.any(AbortSignal)
      );
    });
    await expect
      .element(page.getByText('portable_backup.success_title'))
      .toBeVisible();
  });

  it('recovers an interrupted native output before retry', async () => {
    let resolve!: (outputs: (typeof mocks.destination)[]) => void;
    mocks.interrupted.mockReturnValue(
      new Promise<(typeof mocks.destination)[]>(done => {
        resolve = done;
      })
    );
    await render(<PortableBackup />);
    await act(async () => {
      resolve([mocks.destination]);
    });

    await expect
      .element(page.getByText('portable_backup.interrupted'))
      .toBeVisible();
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.retry' })
    );

    await vi.waitFor(() => expect(mocks.cleanup).toHaveBeenCalledOnce());
    expect(mocks.restart).toHaveBeenCalledOnce();
  });
});
