import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import SecureAccountSetup from '../../../src/components/account/SecureAccountSetup';
import { stageAccount } from '../../../src/components/account/stagedAccount';

const mocks = vi.hoisted(() => ({
  checkBiometricAvailability: vi.fn(),
  configureBiometricLogin: vi.fn(),
  initializeAccount: vi.fn(),
  logout: vi.fn(),
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
    getPlatform: () => 'web',
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
  configureBiometricLogin: mocks.configureBiometricLogin,
}));

vi.mock('../../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      initializeAccount: mocks.initializeAccount,
      logout: mocks.logout,
    }),
}));

describe('SecureAccountSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkBiometricAvailability.mockResolvedValue({
      available: true,
      method: 'webauthn',
    });
    mocks.configureBiometricLogin.mockResolvedValue({ success: true });
    mocks.initializeAccount.mockResolvedValue(undefined);
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
      expect(mocks.initializeAccount).toHaveBeenCalledTimes(2);
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
      expect(mocks.initializeAccount).toHaveBeenCalledWith(
        'alice',
        'alice-password'
      );
      expect(onComplete).toHaveBeenCalledOnce();
    });
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
      expect(onRestart).toHaveBeenCalledWith('cancelled');
    });
    expect(mocks.initializeAccount).not.toHaveBeenCalled();
    expect(account.passwordBytes.every(byte => byte === 0)).toBe(true);
  });
});
