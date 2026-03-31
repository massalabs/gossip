// Tests the useQRShare hook extracted from ShareContact.tsx.
// Runs in jsdom (unit project) — no browser runner needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useQRShare } from '../../src/hooks/useQRShare';

vi.mock('../../src/services/shareService', () => ({
  shareQRCode: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
  },
}));

import { shareQRCode } from '../../src/services/shareService';
import toast from 'react-hot-toast';

const mockShareQRCode = vi.mocked(shareQRCode);
const mockToastError = vi.mocked(toast.error);

// Ref-based harness: the hook result object is stored in a ref so callers
// always read the latest value without stale-closure issues.
interface HookRef {
  current: ReturnType<typeof useQRShare> | null;
}

function renderHook(container: HTMLDivElement): { ref: HookRef; root: Root } {
  const ref: HookRef = { current: null };

  function Harness() {
    const hook = useQRShare();
    ref.current = hook;
    return null;
  }

  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(React.createElement(Harness));
  });

  return { ref, root };
}

describe('useQRShare', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it('handleShareQR does nothing when qrDataUrl is null', async () => {
    const { ref } = renderHook(container);

    expect(ref.current!.qrDataUrl).toBeNull();

    await act(async () => {
      await ref.current!.handleShareQR('share');
    });

    expect(mockShareQRCode).not.toHaveBeenCalled();
  });

  it('handleShareQR calls shareQRCode with correct params when qrDataUrl is set', async () => {
    mockShareQRCode.mockResolvedValue(undefined);
    const { ref } = renderHook(container);

    act(() => {
      ref.current!.setQrDataUrl('data:image/png;base64,abc123');
    });

    await act(async () => {
      await ref.current!.handleShareQR('share');
    });

    expect(mockShareQRCode).toHaveBeenCalledOnce();
    expect(mockShareQRCode).toHaveBeenCalledWith({
      qrDataUrl: 'data:image/png;base64,abc123',
      fileName: 'contact-qr-code.png',
    });
  });

  it('handleShareQR sets isSharingQR=true during share and false after', async () => {
    let resolveShare!: () => void;
    const sharePromise = new Promise<void>(resolve => {
      resolveShare = resolve;
    });
    mockShareQRCode.mockReturnValue(sharePromise);

    const { ref } = renderHook(container);

    act(() => {
      ref.current!.setQrDataUrl('data:image/png;base64,xyz');
    });

    // Kick off handleShareQR without awaiting — it will be pending
    let shareResolved = false;
    let shareCallPromise!: Promise<void>;
    act(() => {
      shareCallPromise = ref.current!.handleShareQR('share');
      shareCallPromise.then(() => {
        shareResolved = true;
      });
    });

    // At this point shareQRCode has been called and is pending;
    // isSharingQR should be true
    expect(ref.current!.isSharingQR).toBe(true);
    expect(ref.current!.qrShareSource).toBe('share');

    // Resolve and wait for cleanup
    await act(async () => {
      resolveShare();
      await shareCallPromise;
    });

    expect(shareResolved).toBe(true);
    expect(ref.current!.isSharingQR).toBe(false);
  });

  it('handleShareQR handles failure with toast.error and resets isSharingQR', async () => {
    mockShareQRCode.mockRejectedValue(new Error('Network error'));
    const { ref } = renderHook(container);

    act(() => {
      ref.current!.setQrDataUrl('data:image/png;base64,fail');
    });

    await act(async () => {
      await ref.current!.handleShareQR('qr');
    });

    expect(mockToastError).toHaveBeenCalledOnce();
    expect(mockToastError).toHaveBeenCalledWith(
      'Failed to share QR code. Please try again.'
    );
    expect(ref.current!.isSharingQR).toBe(false);
  });

  it('setQrDataUrl updates qrDataUrl', () => {
    const { ref } = renderHook(container);

    expect(ref.current!.qrDataUrl).toBeNull();

    act(() => {
      ref.current!.setQrDataUrl('data:image/svg+xml;base64,test');
    });

    expect(ref.current!.qrDataUrl).toBe('data:image/svg+xml;base64,test');

    act(() => {
      ref.current!.setQrDataUrl(null);
    });

    expect(ref.current!.qrDataUrl).toBeNull();
  });
});
