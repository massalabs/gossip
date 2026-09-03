import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import i18n from '../../src/i18n';
import UnsupportedStorageReset from '../../src/components/UnsupportedStorageReset';

const mocks = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock('../../src/services/unsupportedStorageReset', () => ({
  isUnsupportedStorageResetConfirmed: () => false,
  resetUnsupportedSecureStorage: mocks.reset,
}));

describe('unsupported secure-storage reset', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.clearAllMocks();
    mocks.reset.mockResolvedValue(undefined);
  });

  it('requires a separate irreversible confirmation', async () => {
    await render(<UnsupportedStorageReset />);

    expect(page.getByText('Storage update required')).toBeVisible();
    await page.getByRole('button', { name: 'Reset local storage' }).click();
    expect(mocks.reset).not.toHaveBeenCalled();
    expect(
      page.getByText(/permanently deletes every Gossip account/i)
    ).toBeVisible();

    await page.getByRole('button', { name: 'Permanently reset' }).click();
    expect(mocks.reset).toHaveBeenCalledOnce();
  });

  it('permits cancellation before deletion', async () => {
    await render(<UnsupportedStorageReset />);
    await page.getByRole('button', { name: 'Reset local storage' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect(mocks.reset).not.toHaveBeenCalled();
    expect(
      page.getByRole('button', { name: 'Reset local storage' })
    ).toBeVisible();
  });
});
