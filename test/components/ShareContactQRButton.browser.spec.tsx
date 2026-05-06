// Runs in BROWSER mode (real Chromium via Playwright)
// Tests the 3-column actions grid (Share, QR, File) on the ShareContact page,
// focusing on the QR button behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

// ---------- Mocks ----------

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
}));

const mockShareInvitation = vi.fn().mockResolvedValue(undefined);
const mockShareQRCode = vi.fn().mockResolvedValue(undefined);
const mockCanShareInvitationViaOtherApp = vi.fn().mockReturnValue(false);

vi.mock('../../src/services/shareService', () => ({
  shareInvitation: (...args: unknown[]) => mockShareInvitation(...args),
  shareQRCode: (...args: unknown[]) => mockShareQRCode(...args),
  canShareInvitationViaOtherApp: () => mockCanShareInvitationViaOtherApp(),
}));

const mockShareFileContact = vi.fn();
vi.mock('../../src/hooks/useFileShareContact', () => ({
  useFileShareContact: () => ({
    shareFileContact: mockShareFileContact,
    fileState: { fileContact: null, isLoading: false, error: null },
  }),
}));

vi.mock('../../src/utils/inviteUrl', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/utils/inviteUrl')>();
  return {
    ...actual,
    generateDeepLinkUrl: (userId: string, name?: string) =>
      `https://gossip.test/invite/${userId}${name ? `?name=${name}` : ''}`,
  };
});

// Mock ShareContactQR to control qrDataUrl via onQRCodeGenerated callback
let capturedOnQRCodeGenerated: ((url: string) => void) | undefined;
vi.mock('../../src/components/settings/ShareContactQR', () => ({
  default: ({
    onQRCodeGenerated,
  }: {
    deepLinkUrl: string;
    userId: string;
    mnsDomains?: string[];
    onQRCodeGenerated?: (url: string) => void;
  }) => {
    capturedOnQRCodeGenerated = onQRCodeGenerated;
    return <div data-testid="share-contact-qr" />;
  },
}));

// Mock UI components that are not under test
vi.mock('../../src/components/ui/PageHeader', () => ({
  default: ({ title, onBack }: { title: string; onBack: () => void }) => (
    <div data-testid="page-header" onClick={onBack}>
      {title}
    </div>
  ),
}));

vi.mock('../../src/components/ui/PageLayout', () => ({
  default: ({
    children,
  }: {
    header: React.ReactNode;
    children: React.ReactNode;
  }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('../../src/components/ui/BaseModal', () => ({
  default: ({
    isOpen,
    title,
    children,
  }: {
    isOpen: boolean;
    title?: string;
    onClose: () => void;
    children: React.ReactNode;
  }) =>
    isOpen ? (
      <div data-testid="base-modal">
        {title && <h2>{title}</h2>}
        {children}
      </div>
    ) : null,
}));

vi.mock('../../src/components/ui/ContactNameModal', () => ({
  default: () => null,
}));

vi.mock('../../src/components/ui/Toggle', () => ({
  default: () => <div data-testid="toggle" />,
}));

vi.mock('../../src/components/ui/Popover', () => ({
  default: () => <span data-testid="popover" />,
}));

vi.mock('../../src/components/utils', () => ({
  PopoverPosition: { TOP: 'top' },
}));

import ShareContact from '../../src/components/settings/ShareContact';

// ---------- Helpers ----------

const defaultProps = {
  onBack: vi.fn(),
  userId: 'gossip1testuser123',
  userName: 'TestUser',
  publicKey: { to_bytes: () => new Uint8Array(32) } as never,
};

// ---------- Tests ----------

describe('ShareContact - QR button in actions grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnQRCodeGenerated = undefined;
  });

  it('renders all three action buttons: Share, QR, and File', async () => {
    render(<ShareContact {...defaultProps} />);

    await expect
      .element(page.getByRole('button', { name: /^Share$/ }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: /^QR$/ }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: /^File$/ }))
      .toBeInTheDocument();
  });

  it('QR button is disabled when qrDataUrl is null (before QR generates)', async () => {
    render(<ShareContact {...defaultProps} />);

    const qrButton = page.getByRole('button', { name: /^QR$/ });
    await expect.element(qrButton).toBeInTheDocument();
    // QR data URL has not been generated yet, so QR button should be disabled
    expect(qrButton.element().hasAttribute('disabled')).toBe(true);
  });

  it('QR button becomes enabled after QR code is generated', async () => {
    render(<ShareContact {...defaultProps} />);

    // Simulate QR code generation
    expect(capturedOnQRCodeGenerated).toBeDefined();
    capturedOnQRCodeGenerated!('data:image/svg+xml;base64,fakeqrdata');

    // Wait for re-render -- the button should now be enabled
    await vi.waitFor(() => {
      const btn = page.getByRole('button', { name: /^QR$/ }).element();
      expect(btn.hasAttribute('disabled')).toBe(false);
    });
  });

  it('clicking QR button calls shareQRCode with the QR data URL', async () => {
    render(<ShareContact {...defaultProps} />);

    // Simulate QR code generation
    capturedOnQRCodeGenerated!('data:image/svg+xml;base64,fakeqrdata');

    const qrButton = page.getByRole('button', { name: /^QR$/ });
    await vi.waitFor(() => {
      expect(qrButton.element().hasAttribute('disabled')).toBe(false);
    });

    await userEvent.click(qrButton.element());

    expect(mockShareQRCode).toHaveBeenCalledOnce();
    expect(mockShareQRCode).toHaveBeenCalledWith({
      qrDataUrl: 'data:image/svg+xml;base64,fakeqrdata',
      fileName: 'contact-qr-code.png',
    });
  });

  it('Share button also calls shareQRCode when canShareViaOtherApp is false', async () => {
    mockCanShareInvitationViaOtherApp.mockReturnValue(false);

    render(<ShareContact {...defaultProps} />);

    // Simulate QR generation so buttons are enabled
    capturedOnQRCodeGenerated!('data:image/svg+xml;base64,fakeqrdata');

    const shareButton = page.getByRole('button', { name: /^Share$/ });
    await vi.waitFor(() => {
      expect(shareButton.element().hasAttribute('disabled')).toBe(false);
    });

    await userEvent.click(shareButton.element());

    expect(mockShareQRCode).toHaveBeenCalledOnce();
  });

  it('Share button calls shareInvitation when canShareViaOtherApp is true', async () => {
    mockCanShareInvitationViaOtherApp.mockReturnValue(true);

    render(<ShareContact {...defaultProps} />);

    const shareButton = page.getByRole('button', { name: /^Share$/ });
    await userEvent.click(shareButton.element());

    expect(mockShareInvitation).toHaveBeenCalledOnce();
    expect(mockShareInvitation).toHaveBeenCalledWith({
      deepLinkUrl: expect.stringContaining('gossip1testuser123'),
    });
  });

  it('File button opens the file share modal', async () => {
    render(<ShareContact {...defaultProps} />);

    const fileButton = page.getByRole('button', { name: /^File$/ });
    await userEvent.click(fileButton.element());

    await expect
      .element(page.getByText('Share invitation by file'))
      .toBeInTheDocument();
  });
});
