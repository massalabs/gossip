import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import AccountCreationForm from '../../../src/components/account/AccountCreationForm';
import ClassicAccountCreation from '../../../src/components/account/ClassicAccountCreation';
import SecureAccountCreation from '../../../src/components/account/SecureAccountCreation';

const mocks = vi.hoisted(() => ({
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

vi.mock('../../../src/stores/accountStore', () => ({
  IncompleteOnboardingSlotCleanupError: class extends Error {},
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      initializeAccount: mocks.initializeAccount,
      logout: mocks.logout,
    }),
}));

vi.mock('../../../src/services/biometricService', () => ({
  checkBiometricAvailability: vi.fn(async () => ({ available: false })),
  configureBiometricLogin: vi.fn(),
  configureBiometricLoginWithRollback: vi.fn(),
}));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  return {
    ...actual,
    validatePassword: (password: string) => ({
      valid: password === 'valid-password',
      error: 'invalid password',
    }),
  };
});

async function enterAndConfirmAccount() {
  await userEvent.fill(page.getByPlaceholder('create.enter_username'), 'alice');
  await userEvent.fill(
    page.getByPlaceholder('create.enter_password'),
    'valid-password'
  );
  await userEvent.fill(
    page.getByPlaceholder('create.confirm_password'),
    'valid-password'
  );
  await userEvent.click(page.getByRole('button', { name: 'create.title' }));
  await userEvent.click(
    page.getByRole('button', { name: 'create.password_confirm_validate' })
  );
}

describe('AccountCreationForm mandatory password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blocks invalid or mismatched passwords and submits confirmed credentials', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(<AccountCreationForm onSubmit={onSubmit} />);

    const submit = page.getByRole('button', { name: 'create.title' });
    await expect
      .element(page.getByText('create.unique_password_title'))
      .toBeInTheDocument();
    await expect
      .element(page.getByText('create.unique_password_warning'))
      .toBeInTheDocument();
    await expect.element(submit).toBeDisabled();

    await userEvent.fill(
      page.getByPlaceholder('create.enter_username'),
      'alice'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_password'),
      'invalid-password'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.confirm_password'),
      'invalid-password'
    );
    await expect.element(submit).toBeDisabled();

    await userEvent.fill(
      page.getByPlaceholder('create.enter_password'),
      'valid-password'
    );
    await expect.element(submit).toBeDisabled();
    await userEvent.fill(
      page.getByPlaceholder('create.confirm_password'),
      'valid-password'
    );
    await expect.element(submit).toBeEnabled();

    await userEvent.click(submit);
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(
      page.getByRole('button', { name: 'create.password_confirm_validate' })
    );

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        username: 'alice',
        password: 'valid-password',
      });
    });
  });

  it('stages a validated mnemonic through the individual account form', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(
      <AccountCreationForm onSubmit={onSubmit} allowMnemonicImport />
    );

    await userEvent.click(
      page.getByRole('button', { name: 'create.import_tab' })
    );
    const mnemonicInput = page.getByLabelText('create.mnemonic_label');
    await expect
      .element(mnemonicInput)
      .toHaveAttribute('aria-invalid', 'false');
    await expect
      .element(mnemonicInput)
      .toHaveAttribute('aria-describedby', 'account-mnemonic-error');
    await userEvent.fill(mnemonicInput, 'not a valid mnemonic');
    await expect.element(mnemonicInput).toHaveAttribute('aria-invalid', 'true');
    await userEvent.fill(
      mnemonicInput,
      'ABANDON abandon abandon abandon abandon abandon\nabandon abandon abandon abandon abandon about'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_username'),
      'restored'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_password'),
      'valid-password'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.confirm_password'),
      'valid-password'
    );
    await userEvent.click(
      page.getByRole('button', { name: 'create.import_account' })
    );
    await userEvent.click(
      page.getByRole('button', { name: 'create.password_confirm_import' })
    );

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        username: 'restored',
        password: 'valid-password',
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      });
    });
  });

  it('forwards confirmed credentials through classic account creation', async () => {
    const onComplete = vi.fn();
    mocks.initializeAccount.mockResolvedValue(undefined);
    await render(
      <ClassicAccountCreation onComplete={onComplete} onBack={vi.fn()} />
    );

    await enterAndConfirmAccount();

    await vi.waitFor(() => {
      expect(mocks.initializeAccount).toHaveBeenCalledWith(
        'alice',
        'valid-password'
      );
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });

  it('stages confirmed credentials through secure account creation', async () => {
    await render(
      <SecureAccountCreation onComplete={vi.fn()} onBack={vi.fn()} />
    );

    await enterAndConfirmAccount();

    await expect
      .element(page.getByText('secure_setup.title'))
      .toBeInTheDocument();
    expect(mocks.initializeAccount).not.toHaveBeenCalled();
  });
});
