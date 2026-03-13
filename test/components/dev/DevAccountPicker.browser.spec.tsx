// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';
import DevAccountPicker from '../../../src/components/dev/DevAccountPicker';

vi.mock('../../../src/stores/accountStore', () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ restoreAccountFromMnemonic: vi.fn() }),
}));

vi.mock('../../../src/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({ setIsInitialized: vi.fn() }),
  },
}));

describe('DevAccountPicker', () => {
  it('allows skipping to continue normal onboarding path', async () => {
    const onSkip = vi.fn();

    await render(
      <DevAccountPicker
        {...({
          accounts: [{ name: 'Alice', mnemonic: 'test mnemonic' }],
          onSkip,
        } as React.ComponentProps<typeof DevAccountPicker>)}
      />
    );

    await userEvent.click(
      page.getByRole('button', { name: /continue normal onboarding/i })
    );

    expect(onSkip).toHaveBeenCalledOnce();
  });
});
