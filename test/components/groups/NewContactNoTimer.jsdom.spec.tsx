import './matchMedia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import NewContact from '../../../src/pages/NewContact';
import { renderAt } from './render';

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
    handleSubmit: vi.fn(),
  }),
}));

describe('contact request screen', () => {
  let unmount: () => Promise<void> = async () => {};
  afterEach(() => unmount());

  it('offers no message timer: adding a contact starts no chat', async () => {
    const r = await renderAt(<NewContact />);
    unmount = r.unmount;
    expect(
      r.container.querySelector('[data-testid="contact-message-timer"]')
    ).toBeNull();
    expect(r.container.textContent).not.toContain(
      'groups:timer.contact_request_hint'
    );
    // The request's message and the username option stay.
    expect(r.container.textContent).toContain('new_contact.announcement_label');
    expect(r.container.textContent).toContain('new_contact.share_username');
  });
});
