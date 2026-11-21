import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import AccountCreationForm from '../../../src/components/account/AccountCreationForm';
import ClassicAccountCreation from '../../../src/components/account/ClassicAccountCreation';
import SecureAccountCreation from '../../../src/components/account/SecureAccountCreation';

const mocks = vi.hoisted(() => ({
  initializeAccount: vi.fn(),
  loadAccount: vi.fn(),
  validateMnemonic: vi.fn<(mnemonic: string) => boolean>(),
  checkBiometricAvailability: vi.fn(),
  configureBiometricLoginWithRollback: vi.fn(),
  rollbackBiometric: vi.fn(),
  buildOnboardingAccount: vi.fn(),
  commitBuild: vi.fn(),
  abortBuild: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../../src/stores/accountStore', () => {
  const state = {
    initializeAccount: mocks.initializeAccount,
    loadAccount: mocks.loadAccount,
  };
  const useAccountStore = (
    selector: (state: Record<string, unknown>) => unknown
  ) => selector(state);
  useAccountStore.getState = () => state;
  return {
    IncompleteOnboardingSlotCleanupError: class extends Error {},
    useAccountStore,
  };
});

vi.mock('../../../src/services/biometricService', () => ({
  checkBiometricAvailability: mocks.checkBiometricAvailability,
  configureBiometricLoginWithRollback:
    mocks.configureBiometricLoginWithRollback,
}));

vi.mock('../../../src/components/account/commitOnboardingAccount', () => ({
  buildOnboardingAccount: mocks.buildOnboardingAccount,
}));

vi.mock('@massalabs/gossip-sdk', async () => {
  const actual = await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
    '@massalabs/gossip-sdk'
  );
  mocks.validateMnemonic.mockImplementation(actual.validateMnemonic);
  return {
    ...actual,
    validateMnemonic: mocks.validateMnemonic,
    validatePassword: (password: string) => ({
      valid: password === 'valid-password',
      error: 'invalid password',
    }),
  };
});

const DEFAULT_USERNAME = /^user-[a-z2-9]{4}$/;
const decoder = new TextDecoder();

async function enterPassword() {
  await userEvent.fill(
    page.getByPlaceholder('create.enter_password'),
    'valid-password'
  );
  await userEvent.fill(
    page.getByPlaceholder('create.confirm_password'),
    'valid-password'
  );
}

const FRESH_LOGIN = { mnemonic: 'the mnemonic', encryptionKey: { id: 'key' } };

/** Capture the secret at build time: the component wipes it afterwards. */
function recordBuiltPasswords(): string[] {
  const passwords: string[] = [];
  mocks.buildOnboardingAccount.mockImplementation(
    async (account: { passwordBytes: Uint8Array }) => {
      passwords.push(decoder.decode(account.passwordBytes));
      return { commit: mocks.commitBuild, abort: mocks.abortBuild };
    }
  );
  return passwords;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkBiometricAvailability.mockResolvedValue({ available: false });
  mocks.buildOnboardingAccount.mockResolvedValue({
    commit: mocks.commitBuild,
    abort: mocks.abortBuild,
  });
  mocks.commitBuild.mockResolvedValue(FRESH_LOGIN);
  mocks.abortBuild.mockResolvedValue(undefined);
  mocks.loadAccount.mockResolvedValue(undefined);
  mocks.rollbackBiometric.mockResolvedValue(undefined);
});

describe('AccountCreationForm', () => {
  it('asks only for a confirmed valid password', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(<AccountCreationForm onSubmit={onSubmit} />);

    const submit = page.getByRole('button', { name: 'create.title' });
    await expect
      .element(page.getByText('create.password_hint'))
      .toBeInTheDocument();
    expect(document.querySelectorAll('input').length).toBe(2);
    await expect.element(submit).toBeDisabled();

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

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ password: 'valid-password' });
    });
  });

  it('submits a validated, normalized mnemonic in import mode', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(<AccountCreationForm onSubmit={onSubmit} mode="import" />);

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
    await enterPassword();
    await userEvent.click(
      page.getByRole('button', { name: 'create.import_account' })
    );

    await vi.waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        password: 'valid-password',
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      });
    });
  });

  it('does not revalidate an unchanged mnemonic on unrelated renders', async () => {
    await render(<AccountCreationForm onSubmit={vi.fn()} mode="import" />);

    await userEvent.fill(
      page.getByLabelText('create.mnemonic_label'),
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    mocks.validateMnemonic.mockClear();

    await userEvent.fill(
      page.getByPlaceholder('create.enter_password'),
      'valid-password'
    );

    expect(mocks.validateMnemonic).not.toHaveBeenCalled();
  });
});

describe('AccountCreationForm for deniable accounts', () => {
  it('asks for a username and confirms the password is memorized', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(<AccountCreationForm onSubmit={onSubmit} multiAccount />);

    await expect
      .element(page.getByText('create.unique_password_title'))
      .toBeInTheDocument();
    const submit = page.getByRole('button', { name: 'create.title' });
    await enterPassword();
    await expect.element(submit).toBeDisabled();

    await userEvent.fill(
      page.getByPlaceholder('create.enter_username'),
      'alice'
    );
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

  it('offers recovery-phrase import through its tabs', async () => {
    const onSubmit = vi.fn(async () => {});
    await render(<AccountCreationForm onSubmit={onSubmit} multiAccount />);

    await userEvent.click(
      page.getByRole('button', { name: 'create.import_tab' })
    );
    await userEvent.fill(
      page.getByLabelText('create.mnemonic_label'),
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await userEvent.fill(
      page.getByPlaceholder('create.enter_username'),
      'restored'
    );
    await enterPassword();
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
});

describe('ClassicAccountCreation', () => {
  it('creates the account with a default username', async () => {
    const onComplete = vi.fn();
    mocks.initializeAccount.mockResolvedValue(undefined);
    await render(
      <ClassicAccountCreation onComplete={onComplete} onBack={vi.fn()} />
    );

    await enterPassword();
    await userEvent.click(page.getByRole('button', { name: 'create.title' }));

    await vi.waitFor(() => {
      expect(mocks.initializeAccount).toHaveBeenCalledWith(
        expect.stringMatching(DEFAULT_USERNAME),
        'valid-password'
      );
      expect(onComplete).toHaveBeenCalledOnce();
    });
  });
});

describe('SecureAccountCreation', () => {
  it('creates a biometric account and logs in without showing a form', async () => {
    mocks.checkBiometricAvailability.mockResolvedValue({ available: true });
    mocks.configureBiometricLoginWithRollback.mockResolvedValue({
      success: true,
      rollback: mocks.rollbackBiometric,
    });
    const committed = recordBuiltPasswords();
    const onComplete = vi.fn();
    const lease = { release: vi.fn() };

    await render(
      <SecureAccountCreation
        onComplete={onComplete}
        onBack={vi.fn()}
        creationModeLease={lease}
      />
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(document.querySelectorAll('input').length).toBe(0);

    expect(mocks.configureBiometricLoginWithRollback).toHaveBeenCalledOnce();
    const [secret, syncToICloud] =
      mocks.configureBiometricLoginWithRollback.mock.calls[0];
    expect(syncToICloud).toBe(false);
    // 32 random bytes, base64-encoded.
    expect(secret).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    const [account] = mocks.buildOnboardingAccount.mock.calls[0];
    expect(account.username).toMatch(DEFAULT_USERNAME);
    expect(account.passwordless).toBe(true);
    expect(mocks.commitBuild).toHaveBeenCalledWith(lease);
    expect(committed).toEqual([secret]);
    // The automatic login reuses what creation derived.
    expect(mocks.loadAccount).toHaveBeenCalledWith({
      type: 'password',
      password: secret,
      fresh: FRESH_LOGIN,
    });
    // The build starts while the biometric prompt is still open, not after.
    expect(
      mocks.buildOnboardingAccount.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.configureBiometricLoginWithRollback.mock.invocationCallOrder[0]
    );
    // The secret does not outlive creation.
    expect(account.passwordBytes.every((byte: number) => byte === 0)).toBe(
      true
    );
    expect(mocks.rollbackBiometric).not.toHaveBeenCalled();
  });

  it('falls back to a password when the biometric prompt is cancelled', async () => {
    mocks.checkBiometricAvailability.mockResolvedValue({ available: true });
    mocks.configureBiometricLoginWithRollback.mockResolvedValue({
      success: false,
      error: 'cancelled',
    });
    const committed = recordBuiltPasswords();
    const onComplete = vi.fn();

    await render(
      <SecureAccountCreation onComplete={onComplete} onBack={vi.fn()} />
    );

    await expect
      .element(page.getByPlaceholder('create.enter_password'))
      .toBeInTheDocument();
    // The account built during the prompt is thrown away, never committed.
    expect(mocks.abortBuild).toHaveBeenCalledOnce();
    expect(mocks.commitBuild).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole('button', { name: 'create.use_biometrics' }))
      .toBeInTheDocument();

    await enterPassword();
    await userEvent.click(page.getByRole('button', { name: 'create.title' }));

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(committed.at(-1)).toBe('valid-password');
    expect(mocks.commitBuild).toHaveBeenCalledOnce();
    expect(mocks.loadAccount).toHaveBeenCalledWith({
      type: 'password',
      password: 'valid-password',
      fresh: FRESH_LOGIN,
    });
  });

  it('goes straight to the password form without biometrics', async () => {
    await render(
      <SecureAccountCreation onComplete={vi.fn()} onBack={vi.fn()} />
    );

    await expect
      .element(page.getByPlaceholder('create.enter_password'))
      .toBeInTheDocument();
    expect(mocks.configureBiometricLoginWithRollback).not.toHaveBeenCalled();
    expect(
      page.getByRole('button', { name: 'create.use_biometrics' }).query()
    ).toBeNull();
  });

  it('undoes the biometric credential when account creation fails', async () => {
    mocks.checkBiometricAvailability.mockResolvedValue({ available: true });
    mocks.configureBiometricLoginWithRollback.mockResolvedValue({
      success: true,
      rollback: mocks.rollbackBiometric,
    });
    mocks.commitBuild.mockRejectedValue(new Error('disk full'));
    const onComplete = vi.fn();

    await render(
      <SecureAccountCreation onComplete={onComplete} onBack={vi.fn()} />
    );

    await expect.element(page.getByText('create.failed')).toBeInTheDocument();
    expect(mocks.rollbackBiometric).toHaveBeenCalledOnce();
    expect(mocks.loadAccount).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('still completes when automatic login fails after a durable creation', async () => {
    mocks.loadAccount.mockRejectedValue(new Error('offline'));
    const onComplete = vi.fn();

    await render(
      <SecureAccountCreation onComplete={onComplete} onBack={vi.fn()} />
    );

    await enterPassword();
    await userEvent.click(page.getByRole('button', { name: 'create.title' }));

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  });

  it('restores an identity from a recovery phrase with a password', async () => {
    mocks.checkBiometricAvailability.mockResolvedValue({ available: true });
    const onComplete = vi.fn();

    await render(
      <SecureAccountCreation
        onComplete={onComplete}
        onBack={vi.fn()}
        mode="import"
      />
    );

    await userEvent.fill(
      page.getByLabelText('create.mnemonic_label'),
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await enterPassword();
    await userEvent.click(
      page.getByRole('button', { name: 'create.import_account' })
    );

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(mocks.configureBiometricLoginWithRollback).not.toHaveBeenCalled();
    const [account] = mocks.buildOnboardingAccount.mock.calls[0];
    expect(account.mnemonicBytes).toBeDefined();
    expect(account.passwordless).toBeUndefined();
  });
});
