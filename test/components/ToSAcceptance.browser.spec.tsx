// Runs in BROWSER mode (real Chromium via Playwright)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('../../TERMS_OF_SERVICE.md?raw', () => ({
  default: 'Terms of Service content.\n'.repeat(200),
}));

import ToSAcceptance from '../../src/components/ToSAcceptance';

/** Render inside a fixed-height container so the ToS content overflows */
function renderToS(onAccept: () => void) {
  return render(
    <div style={{ height: '400px', display: 'flex', flexDirection: 'column' }}>
      <ToSAcceptance onAccept={onAccept} />
    </div>
  );
}

/** Simulate scrolling the ToS div to the bottom */
function scrollToBottom() {
  const scrollDiv = document.querySelector(
    '[data-testid="tos-scroll-container"]'
  ) as HTMLDivElement;
  scrollDiv.scrollTop = scrollDiv.scrollHeight;
  scrollDiv.dispatchEvent(new Event('scroll', { bubbles: false }));
}

describe('ToSAcceptance', () => {
  let onAccept: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onAccept = vi.fn();
  });

  it('button is disabled before scrolling and checking', async () => {
    await renderToS(onAccept);

    const button = page.getByRole('button', { name: 'Accept & Continue' });
    await expect.element(button).toBeDisabled();
  });

  it('checkbox is disabled before scrolling to bottom', async () => {
    await renderToS(onAccept);

    const checkbox = page.getByRole('checkbox');
    await expect.element(checkbox).toBeDisabled();
  });

  it('checkbox enables after scrolling to bottom', async () => {
    await renderToS(onAccept);

    const checkbox = page.getByRole('checkbox');
    await expect.element(checkbox).toBeDisabled();

    scrollToBottom();

    await expect.element(checkbox).toBeEnabled();
  });

  it('full flow: scroll, check, accept calls onAccept', async () => {
    await renderToS(onAccept);

    scrollToBottom();

    // Check the checkbox
    const checkbox = page.getByRole('checkbox');
    await expect.element(checkbox).toBeEnabled();
    await userEvent.click(checkbox);
    await expect.element(checkbox).toBeChecked();

    // Click accept button
    const button = page.getByRole('button', { name: 'Accept & Continue' });
    await expect.element(button).toBeEnabled();
    await userEvent.click(button);

    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('unchecking checkbox disables button again', async () => {
    await renderToS(onAccept);

    scrollToBottom();

    // Check checkbox -> button enables
    const checkbox = page.getByRole('checkbox');
    await userEvent.click(checkbox);
    const button = page.getByRole('button', { name: 'Accept & Continue' });
    await expect.element(button).toBeEnabled();

    // Uncheck checkbox -> button disables
    await userEvent.click(checkbox);
    await expect.element(button).toBeDisabled();
  });
});
