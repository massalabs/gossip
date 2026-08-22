import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import AccountBackup from '../../../src/components/account/AccountBackup';

const mocks = vi.hoisted(() => ({
  showBackup: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ showBackup: mocks.showBackup }),
}));

describe('AccountBackup password gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps secrets hidden until the active account password succeeds', async () => {
    const mnemonic = 'test mnemonic must remain hidden';
    mocks.showBackup
      .mockRejectedValueOnce(new Error('Authentication failed'))
      .mockResolvedValueOnce({
        mnemonic,
        account: { privateKey: { toString: () => 'test-private-key' } },
      });
    await render(<AccountBackup onBack={vi.fn()} />);

    const show = page.getByRole('button', { name: 'backup.show_backup' });
    await expect.element(show).toBeDisabled();
    expect(document.body.textContent).not.toContain(mnemonic);

    const password = page.getByPlaceholder('backup.password_placeholder');
    await userEvent.fill(password, 'wrong-password');
    await userEvent.click(show);
    await expect.element(page.getByText('backup.show_failed')).toBeVisible();
    expect(document.body.textContent).not.toContain(mnemonic);

    await userEvent.fill(password, 'correct-password');
    await userEvent.click(show);
    await expect.element(page.getByText(mnemonic)).toBeVisible();
    expect(mocks.showBackup).toHaveBeenNthCalledWith(1, 'wrong-password');
    expect(mocks.showBackup).toHaveBeenNthCalledWith(2, 'correct-password');
  });
});
