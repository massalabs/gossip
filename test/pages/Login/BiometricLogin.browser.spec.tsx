import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import { ClassicLogin } from '../../../src/pages/Login/ClassicLogin';
import { SecureLogin } from '../../../src/pages/Login/SecureLogin';

const mocks = vi.hoisted(() => ({
  authenticateBiometricLogin: vi.fn(),
  checkBiometricAvailability: vi.fn(),
  handlePasswordAuth: vi.fn(),
  retryMessagingSessions: vi.fn(),
  resetMessagingSessions: vi.fn(),
  beginMessagingSessionRecovery: vi.fn(),
  messagingRecoveryRequired: false,
  loadAccount: vi.fn(),
  navigate: vi.fn(),
  setPassword: vi.fn(),
  userProfile: null as Record<string, unknown> | null,
  privateMigrationPhase: null as number | null,
  resetAllAccountStorage: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../../src/services/unsupportedStorageReset', () => ({
  isUnsupportedStorageVersionError: () => false,
  requestUnsupportedStorageReset: vi.fn(),
  resetAllAccountStorage: mocks.resetAllAccountStorage,
}));

vi.mock('../../../src/services/biometricService', () => ({
  authenticateBiometricLogin: mocks.authenticateBiometricLogin,
  checkBiometricAvailability: mocks.checkBiometricAvailability,
}));

vi.mock('../../../src/stores/accountStore', () => {
  const useAccountStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        loadAccount: mocks.loadAccount,
        privateMigrationPhase: mocks.privateMigrationPhase,
      }),
    { getState: () => ({ userProfile: mocks.userProfile }) }
  );
  return { useAccountStore };
});

vi.mock('../../../src/pages/Login/useLoginForm', () => ({
  useLoginForm: () => ({
    isLoading: false,
    password: '',
    setPassword: mocks.setPassword,
    passwordInputRef: { current: null },
    handlePasswordAuth: mocks.handlePasswordAuth,
    messagingRecoveryRequired: mocks.messagingRecoveryRequired,
    beginMessagingSessionRecovery: mocks.beginMessagingSessionRecovery,
    retryMessagingSessions: mocks.retryMessagingSessions,
    resetMessagingSessions: mocks.resetMessagingSessions,
    navigate: mocks.navigate,
  }),
}));

describe('password-only biometric login wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resetAllAccountStorage.mockResolvedValue(undefined);
    mocks.userProfile = null;
    mocks.privateMigrationPhase = null;
    mocks.messagingRecoveryRequired = false;
    mocks.checkBiometricAvailability.mockResolvedValue({
      available: true,
      method: 'webauthn',
    });
  });

  it('lets classic login discover the account from only the recovered password', async () => {
    const onAccountSelected = vi.fn();
    mocks.authenticateBiometricLogin.mockResolvedValue({
      success: true,
      data: { password: 'classic-password' },
    });
    mocks.loadAccount.mockResolvedValue(undefined);
    await render(
      <ClassicLogin
        onCreateNewAccount={vi.fn()}
        onAccountSelected={onAccountSelected}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'login.biometric' })
    );

    await vi.waitFor(() => {
      expect(mocks.loadAccount).toHaveBeenCalledWith({
        type: 'password',
        password: 'classic-password',
      });
      expect(onAccountSelected).toHaveBeenCalledOnce();
    });
    expect(mocks.loadAccount.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('keeps classic password login available after biometric cancellation', async () => {
    const onErrorChange = vi.fn();
    mocks.authenticateBiometricLogin.mockResolvedValue({
      success: false,
      error: 'cancelled',
    });
    await render(
      <ClassicLogin
        onCreateNewAccount={vi.fn()}
        onAccountSelected={vi.fn()}
        onErrorChange={onErrorChange}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'login.biometric' })
    );

    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenLastCalledWith(null);
    });
    await expect.element(page.getByPlaceholder('login.password')).toBeEnabled();
  });

  it('reports classic biometric lockout without removing password login', async () => {
    const onErrorChange = vi.fn();
    mocks.authenticateBiometricLogin.mockResolvedValue({
      success: false,
      error: 'biometric_locked',
    });
    await render(
      <ClassicLogin
        onCreateNewAccount={vi.fn()}
        onAccountSelected={vi.fn()}
        onErrorChange={onErrorChange}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'login.biometric' })
    );

    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenLastCalledWith('login.biometric_locked');
    });
    await expect.element(page.getByPlaceholder('login.password')).toBeEnabled();
  });

  it('requires final confirmation before resetting messaging sessions', async () => {
    mocks.messagingRecoveryRequired = true;
    await render(
      <SecureLogin onCreateNewAccount={vi.fn()} onAccountSelected={vi.fn()} />
    );

    await expect
      .element(page.getByText('session_recovery.title'))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole('button', { name: 'session_recovery.reset' })
    );
    await expect
      .element(page.getByText('session_recovery.confirm_body'))
      .toBeInTheDocument();
    expect(mocks.resetMessagingSessions).not.toHaveBeenCalled();
    await userEvent.click(
      page.getByRole('button', { name: 'session_recovery.confirm' })
    );
    expect(mocks.resetMessagingSessions).toHaveBeenCalledOnce();
  });

  it('blocks secure login controls behind exact migration progress', async () => {
    mocks.privateMigrationPhase = 3;
    await render(
      <SecureLogin onCreateNewAccount={vi.fn()} onAccountSelected={vi.fn()} />
    );

    await expect
      .element(page.getByText('private_migration.title'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('private_migration.phase_3'))
      .toBeInTheDocument();
    await expect
      .element(page.getByPlaceholder('login.password'))
      .not.toBeInTheDocument();
  });

  it('lets secure login discover the hidden slot from only the recovered password', async () => {
    const onAccountSelected = vi.fn();
    mocks.authenticateBiometricLogin.mockResolvedValue({
      success: true,
      data: { password: 'secure-password' },
    });
    mocks.loadAccount.mockImplementation(async () => {
      mocks.userProfile = { userId: 'hidden-profile' };
    });
    await render(
      <SecureLogin
        onCreateNewAccount={vi.fn()}
        onAccountSelected={onAccountSelected}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'login.biometric' })
    );

    await vi.waitFor(() => {
      expect(mocks.loadAccount).toHaveBeenCalledWith({
        type: 'password',
        password: 'secure-password',
      });
      expect(onAccountSelected).toHaveBeenCalledOnce();
    });
    expect(mocks.loadAccount.mock.calls[0][0]).not.toHaveProperty('userId');
  });

  it('requires a separated confirmation screen before wiping all accounts', async () => {
    await render(
      <SecureLogin onCreateNewAccount={vi.fn()} onAccountSelected={vi.fn()} />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'storage_reset.action' })
    );
    expect(mocks.resetAllAccountStorage).not.toHaveBeenCalled();

    const confirm = page.getByRole('button', {
      name: 'storage_reset.confirm',
    });
    const cancel = page.getByRole('button', { name: 'storage_reset.cancel' });
    await expect.element(confirm).toBeVisible();
    await expect.element(cancel).toBeVisible();
    expect((cancel.element().parentElement as HTMLElement).className).toContain(
      'pt-16'
    );

    await userEvent.click(confirm);
    expect(mocks.resetAllAccountStorage).toHaveBeenCalledOnce();
  });

  it('keeps secure password login available after biometric failure', async () => {
    const onErrorChange = vi.fn();
    mocks.authenticateBiometricLogin.mockResolvedValue({
      success: false,
      error: 'failed',
    });
    await render(
      <SecureLogin
        onCreateNewAccount={vi.fn()}
        onAccountSelected={vi.fn()}
        onErrorChange={onErrorChange}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'login.biometric' })
    );

    await vi.waitFor(() => {
      expect(onErrorChange).toHaveBeenLastCalledWith(
        'login.biometric_failed_use_password'
      );
    });
    await expect.element(page.getByPlaceholder('login.password')).toBeEnabled();
  });
});
