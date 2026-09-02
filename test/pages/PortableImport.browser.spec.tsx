import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import PortableImport from '../../src/pages/PortableImport';

const mocks = vi.hoisted(() => {
  const preview = {
    userId: 'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s',
    username: 'Alice',
    avatar: null,
    createdAtMs: 1,
    passwordId: Symbol('password'),
  };
  let previews: (typeof preview)[] = [];
  const coordinator = {
    push: vi.fn().mockResolvedValue(undefined),
    finishValidation: vi.fn().mockResolvedValue(undefined),
    authenticate: vi.fn(async () => {
      previews = [preview];
      return preview;
    }),
    list: vi.fn(() => previews),
    remove: vi.fn(() => {
      previews = [];
      return true;
    }),
    install: vi.fn().mockResolvedValue(undefined),
    disposePasswords: vi.fn(),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return {
    sdk: {
      wasPortableImportInstalled: vi.fn().mockResolvedValue(false),
    },
    handle: { name: 'accounts.gossipbackup' },
    coordinator,
    begin: vi.fn().mockResolvedValue(coordinator),
    selectSource: vi.fn(),
    stream: vi.fn(),
    restart: vi.fn(),
    onBack: vi.fn(),
    reset: () => {
      previews = [];
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { name?: string; date?: string }) =>
      values?.name ? `${key}:${values.name}` : key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web' },
  registerPlugin: () => ({}),
}));

vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({ setIsInitialized: vi.fn() }),
  },
}));

vi.mock('../../src/hooks/useGossipSdk', () => ({
  useGossipSdk: () => mocks.sdk,
}));

vi.mock('../../src/components/avatar/UserProfileAvatar', () => ({
  default: () => <div data-testid="avatar" />,
}));

vi.mock('../../src/services/portableImportCoordinator', () => ({
  PortableImportCoordinator: { begin: mocks.begin },
}));

vi.mock('../../src/services/portableImportCleanup', () => ({
  markPortableImportCleanupPending: vi.fn(),
  blockPortableImportAccountOutputs: vi.fn().mockResolvedValue(undefined),
  unblockPortableImportAccountOutputs: vi.fn().mockResolvedValue(undefined),
  clearPortableImportCleanupPending: vi.fn(),
  runPortableImportPostCommitCleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/portableImportAuthorization', () => ({
  createOnboardingPortableImportAuthorization: () => ({
    claim: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
    isAuthorized: () => true,
    prepareCommit: vi.fn(),
    commitSuccess: vi.fn(),
  }),
}));

vi.mock('../../src/services/portableImport', () => ({
  canStreamBrowserImport: () => true,
  selectBrowserBackupSource: mocks.selectSource,
  streamBrowserBackupImport: mocks.stream,
}));

vi.mock('../../src/services/portableBackupNative', () => ({
  isNativeBackupSelectionCancellation: () => false,
  releaseNativeBackupSource: vi.fn(),
  selectNativeBackupSource: vi.fn(),
  startNativeImportProtection: vi.fn(),
  stopNativeImportProtection: vi.fn(),
  updateNativeImportProtection: vi.fn(),
  streamNativeBackupImport: vi.fn(),
}));

vi.mock('../../src/services/portableBackup', () => ({
  restartAfterPortableBackup: mocks.restart,
}));

describe('portable import onboarding page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reset();
    mocks.selectSource.mockResolvedValue(mocks.handle);
    mocks.coordinator.install.mockResolvedValue(undefined);
    mocks.coordinator.disposePasswords.mockImplementation(() => {});
    mocks.sdk.wasPortableImportInstalled.mockResolvedValue(false);
    mocks.stream.mockImplementation(
      async (
        _handle: unknown,
        receive: (chunk: Uint8Array) => Promise<void>,
        finish: () => Promise<void>,
        progress: (value: { readBytes: number; totalBytes: number }) => void
      ) => {
        progress({ readBytes: 0, totalBytes: 80 });
        await receive(new Uint8Array(80));
        progress({ readBytes: 80, totalBytes: 80 });
        await finish();
      }
    );
  });

  it('shows replacement, password, biometric, and possession warnings', async () => {
    await render(<PortableImport onBack={mocks.onBack} />);

    await expect.element(page.getByText('import.replace_title')).toBeVisible();
    await expect
      .element(page.getByText('import.password_notice'))
      .toBeVisible();
    await expect
      .element(page.getByText('import.biometric_notice'))
      .toBeVisible();
    await expect
      .element(page.getByText('import.possession_notice'))
      .toBeVisible();
  });

  it('validates, authenticates a preview, confirms, and installs', async () => {
    await render(<PortableImport onBack={mocks.onBack} />);
    await userEvent.click(
      page.getByRole('button', { name: 'import.choose_file' })
    );

    await expect
      .element(page.getByRole('heading', { name: 'import.load_account' }))
      .toBeVisible();
    await userEvent.fill(page.getByPlaceholder('import.password'), 'secret');
    await userEvent.click(page.getByRole('button', { name: 'import.load' }));
    await expect.element(page.getByText('Alice')).toBeVisible();
    expect(mocks.coordinator.authenticate).toHaveBeenCalledWith('secret');

    await userEvent.click(page.getByRole('button', { name: 'import.review' }));
    await expect
      .element(page.getByRole('heading', { name: 'import.confirm_title' }))
      .toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'import.confirm' }));

    expect(mocks.coordinator.install).toHaveBeenCalledOnce();
    await expect.element(page.getByText('import.success_title')).toBeVisible();
  });

  it('wipes retained passwords when installation and recovery probing both fail', async () => {
    mocks.coordinator.install.mockRejectedValueOnce(
      new Error('install failed')
    );
    mocks.sdk.wasPortableImportInstalled.mockRejectedValueOnce(
      new Error('probe failed')
    );

    await render(<PortableImport onBack={mocks.onBack} />);
    await userEvent.click(
      page.getByRole('button', { name: 'import.choose_file' })
    );
    await userEvent.fill(page.getByPlaceholder('import.password'), 'secret');
    await userEvent.click(page.getByRole('button', { name: 'import.load' }));
    await userEvent.click(page.getByRole('button', { name: 'import.review' }));
    await userEvent.click(page.getByRole('button', { name: 'import.confirm' }));

    await expect
      .element(page.getByText('import.retry_restart_title'))
      .toBeVisible();
    expect(mocks.coordinator.disposePasswords).toHaveBeenCalledOnce();
    expect(mocks.coordinator.cancel).not.toHaveBeenCalled();
  });

  it('wipes coordinator ownership and restarts the terminal browser runtime', async () => {
    await render(<PortableImport onBack={mocks.onBack} />);
    await userEvent.click(
      page.getByRole('button', { name: 'import.choose_file' })
    );
    await userEvent.click(page.getByRole('button', { name: 'Back' }));
    expect(mocks.coordinator.cancel).toHaveBeenCalledOnce();
    expect(mocks.restart).toHaveBeenCalledOnce();
    expect(mocks.onBack).not.toHaveBeenCalled();
  });
});
