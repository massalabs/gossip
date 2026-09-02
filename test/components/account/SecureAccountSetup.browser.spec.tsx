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
  platform: 'web',
  checkBiometricAvailability: vi.fn(),
  configureBiometricLogin: vi.fn(),
  rollbackBiometric: vi.fn(),
  initializePreparedAccountsAtomically: vi.fn(),
  preparePasswordAccount: vi.fn(),
  wipePreparedPasswordAccount: vi.fn(),
  consumeCreationAuthority: vi.fn(),
  restoreCreationAuthority: vi.fn(),
  addAppListener: vi.fn(),
  appBackHandler: null as (() => void) | null,
  toast: vi.fn(),
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
  Capacitor: { getPlatform: () => mocks.platform },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: mocks.addAppListener },
}));

vi.mock('react-hot-toast', () => ({ default: mocks.toast }));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return { ...actual, validatePassword: () => ({ valid: true }) };
});

vi.mock('../../../src/services/portableImportAuthorization', () => ({
  consumeOnboardingCreationAuthority: mocks.consumeCreationAuthority,
  restoreOnboardingCreationAuthorityAfterRollback:
    mocks.restoreCreationAuthority,
}));

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
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      initializePreparedAccountsAtomically:
        mocks.initializePreparedAccountsAtomically,
    }),
}));

vi.mock('../../../src/stores/utils/auth', () => ({
  preparePasswordAccount: mocks.preparePasswordAccount,
  wipePreparedPasswordAccount: mocks.wipePreparedPasswordAccount,
}));

function preparedAccount() {
  return {
    mnemonicBytes: new Uint8Array([1]),
    security: {
      formatVersion: 1,
      passwordKdfVersion: 1,
      mnemonicEncryptionVersion: 1,
      identityDerivationVersion: 1,
      authMethod: 'password' as const,
      encKeySalt: new Uint8Array(16).fill(2),
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array(32).fill(3),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    encryptedSession: new Uint8Array([4]),
  };
}

async function addAccount(username: string, password: string) {
  await userEvent.click(
    page.getByRole('button', { name: 'secure_setup.add_account' })
  );
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
    mocks.appBackHandler = null;
    mocks.addAppListener.mockImplementation(
      (event: string, handler: () => void) => {
        if (event === 'backButton') mocks.appBackHandler = handler;
        return Promise.resolve({ remove: vi.fn() });
      }
    );
    mocks.stagedAccounts.length = 0;
    useAppStore.getState().setSecureAccountCreationAllowed(true);
    mocks.checkBiometricAvailability.mockResolvedValue({
      available: true,
      method: 'webauthn',
    });
    mocks.rollbackBiometric.mockResolvedValue(undefined);
    mocks.configureBiometricLogin.mockResolvedValue({ success: true });
    mocks.preparePasswordAccount.mockImplementation(async () =>
      preparedAccount()
    );
    mocks.initializePreparedAccountsAtomically.mockResolvedValue(undefined);
    mocks.consumeCreationAuthority.mockReturnValue('creation-owner');
  });

  it('wipes staged passwords after an idle unmount', async () => {
    const account = stageAccount('alice', 'alice-password');
    const rendered = await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );

    await rendered.unmount();
    await vi.waitFor(() =>
      expect(account.passwordBytes.every(byte => byte === 0)).toBe(true)
    );
  });

  it('defers unmount wiping until an in-flight atomic commit releases credentials', async () => {
    const account = stageAccount('alice', 'alice-password');
    let releaseCommit!: () => void;
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.initializePreparedAccountsAtomically.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseCommit = resolve;
        })
    );
    const rendered = await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );
    await vi.waitFor(() =>
      expect(mocks.initializePreparedAccountsAtomically).toHaveBeenCalledOnce()
    );
    await rendered.unmount();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);

    releaseCommit();
    await vi.waitFor(() =>
      expect(account.passwordBytes.every(byte => byte === 0)).toBe(true)
    );
  });

  it('uses one durable commit for the complete staged account batch', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });

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

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(mocks.initializePreparedAccountsAtomically).toHaveBeenCalledOnce();
    expect(
      mocks.initializePreparedAccountsAtomically.mock.calls[0][0].map(
        (entry: { username: string; password: string }) => ({
          username: entry.username,
          password: entry.password,
        })
      )
    ).toEqual([
      { username: 'alice', password: 'alice-password' },
      { username: 'decoy', password: 'decoy-password' },
    ]);
    expect(useAppStore.getState().secureAccountCreationAllowed).toBe(false);
    await rehydrateCreationGrant(false);
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('configures only the selected biometric account after the atomic commit', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={vi.fn()}
      />
    );
    await addAccount('decoy', 'decoy-password');

    const alice = page.getByRole('button', { name: 'alice' });
    const decoy = page.getByRole('button', { name: 'decoy' });
    await userEvent.click(alice);
    await userEvent.click(decoy);
    await expect.element(alice).toHaveAttribute('aria-pressed', 'false');
    await expect.element(decoy).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.done' })
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(mocks.initializePreparedAccountsAtomically).toHaveBeenCalledOnce();
    expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
      'decoy-password',
      false
    );
    expect(
      mocks.initializePreparedAccountsAtomically.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.configureBiometricLogin.mock.invocationCallOrder[0]);
  });

  it('persists nothing when any RAM preflight fails', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.preparePasswordAccount
      .mockResolvedValueOnce(preparedAccount())
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

    await vi.waitFor(() =>
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed')
    );
    expect(mocks.initializePreparedAccountsAtomically).not.toHaveBeenCalled();
    for (const staged of mocks.stagedAccounts) {
      expect(staged.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  });

  it('restores onboarding after an atomic candidate failure', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onRestart = vi.fn();
    mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
    mocks.initializePreparedAccountsAtomically.mockRejectedValueOnce(
      new Error('candidate failed')
    );

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

    await vi.waitFor(() =>
      expect(onRestart).toHaveBeenCalledWith('secure_setup.batch_failed')
    );
    expect(mocks.restoreCreationAuthority).toHaveBeenCalledWith(
      'creation-owner'
    );
    expect(mocks.configureBiometricLogin).not.toHaveBeenCalled();
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('offers biometric retry after accounts are committed', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    mocks.configureBiometricLogin
      .mockResolvedValueOnce({
        success: false,
        error: 'replacement failed',
        rollback: mocks.rollbackBiometric,
      })
      .mockResolvedValueOnce({ success: true });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={vi.fn()}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );

    await expect
      .element(page.getByText('secure_setup.biometric_failed_title'))
      .toBeInTheDocument();
    expect(mocks.initializePreparedAccountsAtomically).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);

    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.retry_biometric' })
    );
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(mocks.rollbackBiometric).toHaveBeenCalledOnce();
    expect(mocks.configureBiometricLogin).toHaveBeenCalledTimes(2);
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it.each([
    ['secure_setup.retry_biometric', 2],
    ['secure_setup.continue_password_only', 1],
  ] as const)(
    'keeps %s recoverable when biometric rollback rejects',
    async (action, expectedConfigureCalls) => {
      const account = stageAccount('alice', 'alice-password');
      const onComplete = vi.fn();
      mocks.configureBiometricLogin
        .mockResolvedValueOnce({
          success: false,
          error: 'replacement failed',
          rollback: mocks.rollbackBiometric,
        })
        .mockResolvedValue({ success: true });
      mocks.rollbackBiometric.mockRejectedValueOnce(
        new Error('rollback temporarily unavailable')
      );

      await render(
        <SecureAccountSetup
          initialAccount={account}
          onComplete={onComplete}
          onRestart={vi.fn()}
        />
      );
      await userEvent.click(page.getByRole('button', { name: 'alice' }));
      await userEvent.click(
        page.getByRole('button', { name: 'secure_setup.skip' })
      );
      await expect
        .element(page.getByText('secure_setup.biometric_failed_title'))
        .toBeInTheDocument();

      await userEvent.click(page.getByRole('button', { name: action }));
      await expect
        .element(page.getByText('secure_setup.biometric_retry_failed'))
        .toBeInTheDocument();
      expect(onComplete).not.toHaveBeenCalled();
      expect(mocks.initializePreparedAccountsAtomically).toHaveBeenCalledOnce();
      expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);

      await userEvent.click(page.getByRole('button', { name: action }));
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(mocks.rollbackBiometric).toHaveBeenCalledTimes(2);
      expect(mocks.configureBiometricLogin).toHaveBeenCalledTimes(
        expectedConfigureCalls
      );
      expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
    }
  );

  it('allows password-only continuation after biometric failure', async () => {
    const account = stageAccount('alice', 'alice-password');
    const onComplete = vi.fn();
    mocks.configureBiometricLogin.mockResolvedValueOnce({
      success: false,
      error: 'replacement failed',
    });

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={onComplete}
        onRestart={vi.fn()}
      />
    );
    await userEvent.click(page.getByRole('button', { name: 'alice' }));
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );
    await expect
      .element(page.getByText('secure_setup.biometric_failed_title'))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole('button', {
        name: 'secure_setup.continue_password_only',
      })
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(mocks.configureBiometricLogin).toHaveBeenCalledOnce();
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });

  it('keeps Android finalization active and explains why Back is unavailable', async () => {
    const account = stageAccount('alice', 'alice-password');
    let releasePreparation!: () => void;
    mocks.platform = 'android';
    mocks.preparePasswordAccount.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          releasePreparation = () => resolve(preparedAccount());
        })
    );

    await render(
      <SecureAccountSetup
        initialAccount={account}
        onComplete={vi.fn()}
        onRestart={vi.fn()}
      />
    );
    await userEvent.click(
      page.getByRole('button', { name: 'secure_setup.skip' })
    );
    await vi.waitFor(() =>
      expect(mocks.preparePasswordAccount).toHaveBeenCalledOnce()
    );

    expect(mocks.addAppListener).toHaveBeenCalledWith(
      'backButton',
      expect.any(Function)
    );
    mocks.appBackHandler?.();
    expect(mocks.toast).toHaveBeenCalledWith(
      'secure_setup.finalization_cannot_cancel'
    );
    expect(mocks.initializePreparedAccountsAtomically).not.toHaveBeenCalled();
    releasePreparation();
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
    expect(mocks.initializePreparedAccountsAtomically).not.toHaveBeenCalled();
    expect(fillSpy).toHaveBeenCalledWith(0);
    fillSpy.mockRestore();
  });

  it.each([
    ['biometric_setup.icloud_local', false],
    ['biometric_setup.icloud_enable', true],
  ] as const)(
    'commits before applying iOS Keychain choice %s',
    async (choice, sync) => {
      const account = stageAccount('alice', 'alice-password');
      mocks.platform = 'ios';
      const onComplete = vi.fn();
      await render(
        <SecureAccountSetup
          initialAccount={account}
          onComplete={onComplete}
          onRestart={vi.fn()}
        />
      );
      await userEvent.click(page.getByRole('button', { name: 'alice' }));
      await userEvent.click(
        page.getByRole('button', { name: 'secure_setup.skip' })
      );
      await userEvent.click(page.getByRole('button', { name: choice }));

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'alice-password',
        sync
      );
      expect(
        mocks.initializePreparedAccountsAtomically.mock.invocationCallOrder[0]
      ).toBeLessThan(mocks.configureBiometricLogin.mock.invocationCallOrder[0]);
    }
  );

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
    expect(mocks.initializePreparedAccountsAtomically).not.toHaveBeenCalled();
    expect(account.passwordBytes.some(byte => byte !== 0)).toBe(true);
  });
});
