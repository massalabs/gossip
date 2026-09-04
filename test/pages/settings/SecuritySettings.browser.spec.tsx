import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import SecuritySettings from '../../../src/pages/settings/SecuritySettings';

const mocks = vi.hoisted(() => ({
  platform: 'web',
  configureBiometricLogin: vi.fn(),
  navigate: vi.fn(),
  setAutoLockTimeout: vi.fn(),
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

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mocks.platform,
  },
}));

vi.mock('../../../src/stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      autoLockTimeout: null,
      setAutoLockTimeout: mocks.setAutoLockTimeout,
    }),
}));

vi.mock('../../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      configureBiometricLogin: mocks.configureBiometricLogin,
    }),
}));

describe('SecuritySettings biometric setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'web';
    mocks.configureBiometricLogin.mockResolvedValue(undefined);
  });

  it('always offers setup and verifies through the account store', async () => {
    await render(<SecuritySettings />);

    const setup = page.getByRole('button', {
      name: 'security.biometric_use_for_account',
    });
    await expect.element(setup).toBeInTheDocument();
    await userEvent.click(setup);
    await userEvent.fill(
      page.getByPlaceholder('security.biometric_password_placeholder'),
      'current-password'
    );
    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_password_continue',
      })
    );

    await vi.waitFor(() => {
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'current-password',
        false
      );
    });
    await expect
      .element(page.getByText('security.biometric_success'))
      .toBeVisible();
    await expect.element(setup).toBeInTheDocument();
  });

  it.each([
    ['biometric_setup.icloud_local', false],
    ['biometric_setup.icloud_enable', true],
  ] as const)('forwards iOS Keychain choice %s', async (choice, sync) => {
    mocks.platform = 'ios';
    await render(<SecuritySettings />);

    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_use_for_account',
      })
    );
    await userEvent.fill(
      page.getByPlaceholder('security.biometric_password_placeholder'),
      'current-password'
    );
    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_password_continue',
      })
    );
    await userEvent.click(page.getByRole('button', { name: choice }));

    await vi.waitFor(() => {
      expect(mocks.configureBiometricLogin).toHaveBeenCalledWith(
        'current-password',
        sync
      );
    });
  });

  it('clears the pending password when iOS Keychain choice is cancelled', async () => {
    mocks.platform = 'ios';
    await render(<SecuritySettings />);

    const setup = page.getByRole('button', {
      name: 'security.biometric_use_for_account',
    });
    await userEvent.click(setup);
    await userEvent.fill(
      page.getByPlaceholder('security.biometric_password_placeholder'),
      'current-password'
    );
    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_password_continue',
      })
    );
    await userEvent.keyboard('{Escape}');

    expect(mocks.configureBiometricLogin).not.toHaveBeenCalled();
    await userEvent.click(setup);
    await expect
      .element(page.getByPlaceholder('security.biometric_password_placeholder'))
      .toHaveValue('');
  });

  it('shows a generic password error without exposing credential ownership', async () => {
    mocks.configureBiometricLogin.mockRejectedValue(
      new Error('Authentication failed: invalid password')
    );
    await render(<SecuritySettings />);

    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_use_for_account',
      })
    );
    await userEvent.fill(
      page.getByPlaceholder('security.biometric_password_placeholder'),
      'wrong-password'
    );
    await userEvent.click(
      page.getByRole('button', {
        name: 'security.biometric_password_continue',
      })
    );

    await expect
      .element(page.getByText('security.biometric_password_invalid'))
      .toBeVisible();
    expect(document.body.textContent).not.toContain('currently linked:');
  });
});
