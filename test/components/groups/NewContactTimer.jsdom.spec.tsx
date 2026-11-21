import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import NewContact from '../../../src/pages/NewContact';
import { click, renderAt } from './render';

const tr = (key: string, o?: Record<string, unknown>) =>
  o && 'count' in o ? `${key}:${String(o.count)}` : key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tr }),
  initReactI18next: { type: '3rdParty', init: () => {} },
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock('../../../src/components/ui/Layout/PageLayout', () => ({
  default: ({
    header,
    children,
  }: {
    header: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const onTimer = vi.fn();
vi.mock('../../../src/hooks/useContactForm', () => ({
  useContactForm: () => ({
    generalError: null,
    name: { value: '', loading: false },
    userId: { value: '', loading: false },
    message: { value: '', loading: false },
    mnsState: {},
    shareUsername: false,
    customUsername: '',
    customUsernameError: undefined,
    messageTimer: 2_419_200_000,
    isSubmitting: false,
    canSubmit: false,
    hasUnsavedChanges: false,
    fileState: { isLoading: false, error: null },
    handleFileImport: vi.fn(),
    handleVerifiedContact: vi.fn(),
    handleNameChange: vi.fn(),
    handleUserIdChange: vi.fn(),
    handleMessageChange: vi.fn(),
    handleShareUsernameChange: vi.fn(),
    handleCustomUsernameChange: vi.fn(),
    handleMessageTimerChange: onTimer,
    handleSubmit: vi.fn(),
  }),
}));

describe('contact request screen', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(() => unmount());

  it('offers the timer of the chat founded once the request is accepted, the default pre-selected', async () => {
    const r = await renderAt(<NewContact />);
    unmount = r.unmount;
    expect(
      r.container.querySelector('[data-testid="contact-message-timer-value"]')
        ?.textContent
    ).toBe('groups:timer.month');
    await click(
      r.container.querySelector('[data-testid="contact-message-timer"]')
    );
    const option = Array.from(document.querySelectorAll('button')).find(
      b => b.textContent?.trim() === 'groups:timer.hours:8'
    );
    await click(option);
    expect(onTimer).toHaveBeenCalledWith(8 * 3_600_000);
  });
});
