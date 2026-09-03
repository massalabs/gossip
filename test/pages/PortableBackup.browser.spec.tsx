import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import PortableBackup from '../../src/pages/PortableBackup';
import { PortableBackupCleanupRequiredError } from '../../src/services/portableBackup';

const mocks = vi.hoisted(() => ({
  sdk: { isSecureStorage: true },
  logout: vi.fn(),
  navigate: vi.fn(),
  authenticated: true,
  destination: { name: 'accounts.gossipbackup' },
  selectDestination: vi.fn(),
  exportBackup: vi.fn(),
  restart: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-router-dom', async () => {
  const actual =
    await vi.importActual<typeof import('react-router-dom')>(
      'react-router-dom'
    );
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => mocks.sdk,
}));

vi.mock('../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      logout: mocks.logout,
      userProfile: mocks.authenticated ? { username: 'Alice' } : null,
    }),
}));

vi.mock('../../src/services/portableBackup', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/services/portableBackup')
  >('../../src/services/portableBackup');
  return {
    ...actual,
    canStreamBrowserBackup: () => true,
    selectBrowserBackupDestination: mocks.selectDestination,
    exportBrowserBackup: mocks.exportBackup,
    restartAfterPortableBackup: mocks.restart,
  };
});

describe('portable backup page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    mocks.authenticated = true;
    mocks.sdk.isSecureStorage = true;
    mocks.logout.mockResolvedValue(undefined);
    mocks.selectDestination.mockResolvedValue(mocks.destination);
    mocks.exportBackup.mockImplementation(
      async (
        _sdk: unknown,
        _destination: unknown,
        onProgress: (value: {
          phase: 'writing' | 'verifying';
          processedBytes: number;
          totalBytes: number;
        }) => void
      ) => {
        onProgress({ phase: 'writing', processedBytes: 2, totalBytes: 4 });
        onProgress({ phase: 'verifying', processedBytes: 4, totalBytes: 4 });
      }
    );
  });

  it('disables portable export outside the secure-storage backend', async () => {
    mocks.sdk.isSecureStorage = false;
    await render(<PortableBackup />);

    await expect
      .element(page.getByText('portable_backup.unsupported'))
      .toBeVisible();
    await expect
      .element(
        page.getByRole('button', {
          name: 'portable_backup.choose_destination',
        })
      )
      .not.toBeInTheDocument();
  });

  it('requires destination selection before the single export confirmation', async () => {
    await render(<PortableBackup />);

    const confirm = page.getByRole('button', {
      name: 'portable_backup.export',
    });
    await expect.element(confirm).toBeDisabled();
    await expect
      .element(page.getByText('portable_backup.important'))
      .toBeVisible();

    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );

    await expect.element(confirm).toBeEnabled();
    await expect.element(page.getByText('accounts.gossipbackup')).toBeVisible();
  });

  it('exports to the selected handle and retains success until login continuation', async () => {
    await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );

    await vi.waitFor(() => {
      expect(mocks.exportBackup).toHaveBeenCalledWith(
        mocks.sdk,
        mocks.destination,
        expect.any(Function),
        expect.any(AbortSignal)
      );
    });
    await expect
      .element(page.getByText('portable_backup.success_title'))
      .toBeVisible();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();

    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.continue_login' })
    );
    await vi.waitFor(() => {
      expect(mocks.logout).toHaveBeenCalledWith({ lockedByUser: true });
    });
    expect(mocks.restart).toHaveBeenCalledWith('/welcome');
  });

  it('restarts at login even when terminal-state logout cleanup fails', async () => {
    mocks.logout.mockRejectedValueOnce(new Error('cleanup failed'));
    await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );
    await expect
      .element(page.getByText('portable_backup.success_title'))
      .toBeVisible();

    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.continue_login' })
    );
    await vi.waitFor(() => {
      expect(mocks.restart).toHaveBeenCalledWith('/welcome');
    });
  });

  it('restores manual cleanup recovery and clears it before retry restart', async () => {
    window.sessionStorage.setItem(
      'gossip:portable-backup-result',
      'cleanup-required'
    );
    await render(<PortableBackup />);

    await expect
      .element(page.getByText('portable_backup.cleanup_required'))
      .toBeVisible();
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.retry' })
    );
    expect(window.sessionStorage.getItem('gossip:portable-backup-result')).toBe(
      null
    );
    expect(mocks.restart).toHaveBeenCalledWith('/backup');
  });

  it('aborts on unmount, persists cleanup outcome, then restarts', async () => {
    let observedSignal: AbortSignal | undefined;
    mocks.exportBackup.mockImplementationOnce(
      async (
        _sdk: unknown,
        _destination: unknown,
        _progress: unknown,
        signal: AbortSignal
      ) => {
        observedSignal = signal;
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('cancelled', 'AbortError')),
            { once: true }
          )
        );
      }
    );
    const rendered = await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );
    await vi.waitFor(() => expect(observedSignal).toBeInstanceOf(AbortSignal));

    rendered.unmount();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
    await vi.waitFor(() => {
      expect(mocks.restart).toHaveBeenCalledWith('/backup');
    });
    expect(window.sessionStorage.getItem('gossip:portable-backup-result')).toBe(
      'failed'
    );
  });

  it('shows the manual deletion state without logging sensitive details', async () => {
    mocks.exportBackup.mockRejectedValueOnce(
      new PortableBackupCleanupRequiredError('cleanup', new Error('failure'))
    );
    await render(<PortableBackup />);
    await userEvent.click(
      page.getByRole('button', {
        name: 'portable_backup.choose_destination',
      })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'portable_backup.export' })
    );

    await expect
      .element(page.getByText('portable_backup.cleanup_required'))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'portable_backup.retry' }))
      .toBeVisible();
    await expect
      .element(
        page.getByRole('button', { name: 'portable_backup.continue_login' })
      )
      .toBeVisible();
  });
});
