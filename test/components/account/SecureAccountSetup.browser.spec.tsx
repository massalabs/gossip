import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import SecureAccountSetup from '../../../src/components/account/SecureAccountSetup';
import { stageAccount } from '../../../src/components/account/stagedAccount';
import { useAppStore } from '../../../src/stores/appStore';
import { STORAGE_KEYS } from '../../../src/utils/localStorage';

const persistedAppStore = useAppStore as typeof useAppStore & {
  persist: { rehydrate: () => Promise<void> };
};

async function rehydrateCreationGrant(expected: boolean): Promise<void> {
  const persistedValue = localStorage.getItem(STORAGE_KEYS.APP_STORE);
  if (!persistedValue) throw new Error('persisted app state missing');
  useAppStore.setState({ secureAccountCreationAllowed: !expected });
  localStorage.setItem(STORAGE_KEYS.APP_STORE, persistedValue);
  await persistedAppStore.persist.rehydrate();
  expect(useAppStore.getState().secureAccountCreationAllowed).toBe(expected);
}

const mocks = vi.hoisted(() => ({
  IncompleteOnboardingSlotCleanupError: class extends Error {},
  platform: 'web',
  checkBiometricAvailability: vi.fn(),
  configureBiometricLogin: vi.fn(),
  rollbackBiometric: vi.fn(),
  initializePreparedAccount: vi.fn(),
  rollbackInitializedAccounts: vi.fn(),
  preparePasswordAccount: vi.fn(),
  wipePreparedPasswordAccount: vi.fn(),
  logout: vi.fn(),
  stagedAccounts: [] as Array<{ passwordBytes: Uint8Array }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mocks.platform,
  },
}));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return {
    ...actual,
    validatePassword: () => ({ valid: true }),
  };
});

vi.mock('../../../src/services/biometricService', () => ({
  checkBiometricAvailability: mocks.checkBiometricAvailability,
  configureBiometricLoginWithRollback: mocks.configureBiometricLogin,
}));

vi.mock('../../../src/components/account/stagedAccount', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/components/account/stagedAccount')
  >('../../../src/components/account/stagedAccount');
  return {
    ...actual,
    stageAccount: (
      ...args: Parameters<typeof actual.stageAccount>
    ): ReturnType<typeof actual.stageAccount> => {
      const account = actual.stageAccount(...args);
      mocks.stagedAccounts.push(account);
      return account;
    },
  };
});

vi.mock('../../../src/stores/accountStore', () => ({
  IncompleteOnboardingSlotCleanupError:
    mocks.IncompleteOnboardingSlotCleanupError,
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      initializePreparedAccount: mocks.initializePreparedAccount,
      rollbackInitializedAccounts: mocks.rollbackInitializedAccounts,
      logout: mocks.logout,
    }),
}));

vi.mock('../../../src/stores/utils/auth', () => ({
  preparePasswordAccount: mocks.preparePasswordAccount,
  wipePreparedPasswordAccount: mocks.wipePreparedPasswordAccount,
}));

async function addAccount(username: string, password: string) {
  await userEvent.click(
    page.getByRole('button', { name: 'secure_setup.add_account' })
  );
  await expect
    .element(page.getByText('create.unique_password_title'))
    .toBeInTheDocument();
  await expect
    .element(page.getByText('create.unique_password_warning'))
    .toBeInTheDocument();
  await userEvent.fill(
    page.getByPlaceholder('create.enter_username'),
    username
  );
  await userEvent.fill(
    page.getByPlaceholder('create.enter_password'),
    password
  );
  await userEvent.fill(
    page.getByPlaceholder('create.confirm_password'),
    password
  );
  await userEvent.click(
    page.getByRole('button', { name: 'secure_setup.create_account' })
  );
  await userEvent.click(
    page.getByRole('button', { name: 'create.password_confirm_validate' })
  );
}

describe('SecureAccountSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'web';
    mocks.stagedAccounts.length = 0;
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    mocks.checkBiometricAvailability.mockResolvedValue({
      available: true,
      method: 'webauthn',
    });
    mocks.rollbackBiometric.mockResolvedValue(undefined);
    mocks.configureBiometricLogin.mockResolvedValue({
      success: true,
      rollback: mocks.rollbackBiometric,
    });
    mocks.preparePasswordAccount.mockImplementation(async () => ({
      mnemonicBytes: new Uint8Array([1]),
      security: {
        authMethod: 'password',
        encKeySalt: new Uint8Array([2]),
        mnemonicBackup: {
          encryptedMnemonic: new Uint8Array([3]),
          createdAt: new Date(),
          backedUp: false,
        },
      },
      encryptedSession: new Uint8Array([4]),
    }));
    mocks.initializePreparedAccount.mockResolvedValue(undefined);
    mocks.rollbackInitializedAccounts.mockResolvedValue({
      failedPasswordIndexes: [],
      lockFailed: false,
    });
    mocks.logout.mockResolvedValue(undefined);
  });

  it('keeps biometric account selection mutually exclusive', async () => {
    const account = stageAccount('alice', 'alice-password');

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.add_account' })
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_username'),
      'decoy'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_password'),
      'decoy-password'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.confirm_password'),
      'decoy-password'
    );
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.create_account' })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'create.password_confirm_validate' })
    );

    const alice = page.getByRole('button', { name: 'alice' });
    const decoy = page.getByRole('button', { name: 'decoy' });
    await userEvent.click(alice);
    await expect.element(alice).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(decoy);
    await expect.element(alice).toHaveAttribute('aria-pressed', 'false');
    await expect.element(decoy).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );
    await vi.waitFor(() => {
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'decoy-password',
        false
      );
      expect(mocks.initializePreparedAccount).toHaveBeenCalledTimes(2);
      expect(mocks.logout).toHaveBeenCalledWith({ lockedByUser: false });
    });
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('registers the selected password, persists, and wipes it', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={vi.fn()}
      />
    );

    const accountChoice = page.getByRole('button', { name: 'alice' });
    await expect.element(accountChoice).toBeInTheDocument();
    await userEvent.click(accountChoice);
    await expect.element(accountChoice).toHaveAttribute('aria-pressed', 'true');

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await vi.waitFor(() => {
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'alice-password',
        false
      );
      expect(mocks.initializePreparedAccount).toHaveBeenCalledWith(
        'alice',
        'alice-password',
        expect.any(Object)
      );
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
    await rehydrateCreationGrant(false);
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('wipes staged passwords and restarts when biometric setup fails', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.configureBiometricLogin.mockResolvedValue({
      success: false,
      error: 'cancelled',
    });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );

    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await vi.waitFor(() => {
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(mocks.initializePreparedAccount).not.toHaveBeenCalled();
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('retains cleanup recovery when failed biometric setup needs restoration', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.rollbackBiometric
      .mockRejectedValueOnce(new Error('restore still unavailable'))
      .mockResolvedValueOnce(undefined);
    mocks.configureBiometricLogin.mockResolvedValue({
      success: false,
      error: 'replacement failed',
      rollback: mocks.rollbackBiometric,
    });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await expect
      .element(page.getByText('secure_setup.cleanup_failed', { exact: true }))
      .toBeInTheDocument();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);
    expect(mocks.initializePreparedAccount).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_cleanup' })
    );
    await vi.waitFor(() => {
      expect(mocks.rollbackBiometric).toHaveBeenCalledTimes(2);
      expect(mocks.logout).toHaveBeenCalledOnce();
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('persists nothing when any RAM preflight fails', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.preparePasswordAccount
      .mockResolvedValueOnce({
        mnemonicBytes: new Uint8Array([1]),
        security: {
          authMethod: 'password',
          encKeySalt: new Uint8Array([2]),
          mnemonicBackup: {
            encryptedMnemonic: new Uint8Array([3]),
            createdAt: new Date(),
            backedUp: false,
          },
        },
        encryptedSession: new Uint8Array([4]),
      })
      .mockRejectedValueOnce(new Error('RAM verification failed'));

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );
    await addAccount('decoy', 'decoy-password');
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );

    await vi.waitFor(() => {
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(mocks.initializePreparedAccount).not.toHaveBeenCalled();
    expect(mocks.configureBiometricLogin).not.toHaveBeenCalled();
    expect(mocks.wipePreparedPasswordAccount).toHaveBeenCalledOnce();
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  });

  it('restarts after the first persistence failure and wipes credentials', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    const onRestart = vi.fn();
    mocks.initializePreparedAccount.mockRejectedValue(
      new Error('first failed')
    );

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={onRestart}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await vi.waitFor(() => {
      expect(mocks.rollbackBiometric).toHaveBeenCalledOnce();
      expect(mocks.logout).toHaveBeenCalledWith({ lockedByUser: false });
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.initializePreparedAccount).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(true);
    await rehydrateCreationGrant(true);
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('rolls back the entire batch after a later persistence failure', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    const onRestart = vi.fn();
    mocks.initializePreparedAccount
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second failed'));

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={onRestart}
      />
    );
    await addAccount('decoy', 'decoy-password');
    await addAccount('backup', 'backup-password');
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );

    await vi.waitFor(() => {
      expect(mocks.rollbackInitializedAccounts).toHaveBeenCalledWith([
        'alice-password',
      ]);
      expect(mocks.rollbackBiometric).toHaveBeenCalledOnce();
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.initializePreparedAccount).toHaveBeenCalledTimes(2);
    expect(
      mocks.initializePreparedAccount.mock.calls.some(
        ([username]) => username === 'backup'
      )
    ).toBe(false);
    expect(mocks.stagedAccounts).toHaveLength(3);
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  });

  it('retains credentials and retries only the slots left after incomplete rollback', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.initializePreparedAccount
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new mocks.IncompleteOnboardingSlotCleanupError('second failed')
      );
    mocks.rollbackInitializedAccounts.mockResolvedValueOnce({
      failedPasswordIndexes: [1],
      lockFailed: false,
    });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );
    await addAccount('decoy', 'decoy-password');
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );

    await expect
      .element(page.getByText('secure_setup.cleanup_failed', { exact: true }))
      .toBeInTheDocument();
    expect(mocks.rollbackInitializedAccounts).toHaveBeenNthCalledWith(1, [
      'alice-password',
      'decoy-password',
    ]);
    expect(onRestart).not.toHaveBeenCalled();
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.some(byte => byte !== 0)).toBe(true);
    }

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_cleanup' })
    );
    await vi.waitFor(() => {
      expect(mocks.rollbackInitializedAccounts).toHaveBeenNthCalledWith(2, [
        'decoy-password',
      ]);
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  });

  it('retains credentials until prior biometric restoration can be retried', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.initializePreparedAccount.mockRejectedValue(
      new Error('first failed')
    );
    mocks.rollbackBiometric
      .mockRejectedValueOnce(new Error('biometric restore failed'))
      .mockResolvedValueOnce(undefined);

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await expect
      .element(page.getByText('secure_setup.cleanup_failed', { exact: true }))
      .toBeInTheDocument();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_cleanup' })
    );
    await vi.waitFor(() => {
      expect(mocks.rollbackBiometric).toHaveBeenCalledTimes(2);
      expect(mocks.logout).toHaveBeenCalledOnce();
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('retains credentials until failure-path locking can be retried', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.initializePreparedAccount.mockRejectedValue(
      new Error('first failed')
    );
    mocks.logout
      .mockRejectedValueOnce(new Error('lock failed'))
      .mockResolvedValueOnce(undefined);

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={onRestart}
      />
    );
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await expect
      .element(page.getByText('secure_setup.cleanup_failed', { exact: true }))
      .toBeInTheDocument();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);
    expect(onRestart).not.toHaveBeenCalled();

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_cleanup' })
    );
    await vi.waitFor(() => {
      expect(mocks.logout).toHaveBeenCalledTimes(2);
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed');
    });
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('retries only locking when logout fails after account persistence', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.logout
      .mockRejectedValueOnce(new Error('lock failed'))
      .mockResolvedValueOnce(undefined);

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={vi.fn()}
      />
    );
    await addAccount('decoy', 'decoy-password');
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );

    await expect
      .element(page.getByText('secure_setup.lock_failed', { exact: true }))
      .toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(mocks.initializePreparedAccount).toHaveBeenCalledTimes(2);
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.every(byte => byte === 0)).toBe(true);
    }

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_lock' })
    );

    await vi.waitFor(() => {
      expect(mocks.logout).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(mocks.initializePreparedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.configureBiometricLogin).not.toHaveBeenCalled();
  });

  it('stops account entry at the three-slot maximum', async () => {
    const account = stageAccount('alice', 'alice-password');
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );
    await addAccount('decoy', 'decoy-password');
    await addAccount('backup', 'backup-password');

    await expect
      .element(page.getByText('secure_setup.max_reached'))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'secure_setup.add_account' }))
      .not.toBeInTheDocument();
  });

  it('rejects a duplicate staged password before persistence', async () => {
    const account = stageAccount('alice', 'shared-password');
    const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );
    await addAccount('decoy', 'shared-password');

    await expect
      .element(page.getByText('secure_setup.password_in_use'))
      .toBeInTheDocument();
    expect(mocks.initializePreparedAccount).not.toHaveBeenCalled();
    expect(fillSpy).toHaveBeenCalledWith(0);
    fillSpy.mockRestore();
  });

  it.each([
    ['biometric_setup.icloud_local', false],
    ['biometric_setup.icloud_enable', true],
  ] as const)('forwards iOS Keychain choice %s', async (choice, sync) => {
    const account = stageAccount('alice', 'alice-password');
    mocks.platform = 'ios';

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );
    await userEvent.click(page.getByRole('button', { name: choice }));

    await vi.waitFor(() => {
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'alice-password',
        sync
      );
      expect(mocks.initializePreparedAccount).toHaveBeenCalledOnce();
    });
  });

  it('cancels iOS Keychain choice without configuring or persisting', async () => {
    const account = stageAccount('alice', 'alice-password');
    mocks.platform = 'ios';

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );
    await userEvent.keyboard('{Escape}');

    await expect
      .element(page.getByText('biometric_setup.icloud_title'))
      .not.toBeInTheDocument();
    expect(mocks.configureBiometricLogin).not.toHaveBeenCalled();
    expect(mocks.initializePreparedAccount).not.toHaveBeenCalled();
  });
});
