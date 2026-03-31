// Tests the useLinkShare hook extracted from ShareContact.
// Runs in jsdom (unit project) — no browser runner needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useLinkShare } from '../../src/hooks/useLinkShare';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/services/shareService', () => ({
  shareInvitation: vi.fn(),
  canShareInvitationViaOtherApp: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    error: vi.fn(),
  },
}));

import {
  shareInvitation,
  canShareInvitationViaOtherApp,
} from '../../src/services/shareService';
import toast from 'react-hot-toast';

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * A ref-bag that the harness component writes the hook's return value into
 * after each render so tests can read it synchronously.
 */
interface HookResult {
  copiedLink: boolean;
  isSharingLink: boolean;
  canShareViaOtherApp: boolean;
  handleCopyLink: () => Promise<void>;
  handleShareLink: () => Promise<void>;
}

function createHarness(
  deepLinkUrl: string,
  resultRef: { current: HookResult | null }
) {
  function Harness() {
    const result = useLinkShare(deepLinkUrl);
    resultRef.current = result;
    return null;
  }
  return Harness;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('useLinkShare', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let resultRef: { current: HookResult | null };

  const TEST_URL = 'https://gossip.app/invite/abc123';

  beforeEach(() => {
    vi.useFakeTimers();
    resultRef = { current: null };
    container = document.createElement('div');
    document.body.appendChild(container);

    // Default: sharing is available, clipboard succeeds
    vi.mocked(canShareInvitationViaOtherApp).mockReturnValue(true);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    // Unmount to trigger cleanup effects
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function render(url = TEST_URL) {
    const Harness = createHarness(url, resultRef);
    act(() => {
      root = createRoot(container);
      root.render(React.createElement(Harness));
    });
  }

  // -------------------------------------------------------------------------
  // canShareViaOtherApp — set from service
  // -------------------------------------------------------------------------

  it('sets canShareViaOtherApp=true when service returns true', () => {
    vi.mocked(canShareInvitationViaOtherApp).mockReturnValue(true);
    render();
    expect(resultRef.current!.canShareViaOtherApp).toBe(true);
  });

  it('sets canShareViaOtherApp=false when service returns false', () => {
    vi.mocked(canShareInvitationViaOtherApp).mockReturnValue(false);
    render();
    expect(resultRef.current!.canShareViaOtherApp).toBe(false);
  });

  // -------------------------------------------------------------------------
  // handleCopyLink — success path
  // -------------------------------------------------------------------------

  it('copies URL to clipboard and sets copiedLink=true', async () => {
    render();

    await act(async () => {
      await resultRef.current!.handleCopyLink();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TEST_URL);
    expect(resultRef.current!.copiedLink).toBe(true);
  });

  it('resets copiedLink to false after 2s timeout', async () => {
    render();

    await act(async () => {
      await resultRef.current!.handleCopyLink();
    });
    expect(resultRef.current!.copiedLink).toBe(true);

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(resultRef.current!.copiedLink).toBe(false);
  });

  it('does not reset copiedLink before 2s elapses', async () => {
    render();

    await act(async () => {
      await resultRef.current!.handleCopyLink();
    });

    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(resultRef.current!.copiedLink).toBe(true);
  });

  // -------------------------------------------------------------------------
  // handleCopyLink — failure path
  // -------------------------------------------------------------------------

  it('calls toast.error when clipboard write fails', async () => {
    const clipboardError = new Error('NotAllowedError');
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(clipboardError),
      },
    });
    render();

    await act(async () => {
      await resultRef.current!.handleCopyLink();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Failed to copy invitation link. Please try again.'
    );
    expect(resultRef.current!.copiedLink).toBe(false);
  });

  // -------------------------------------------------------------------------
  // handleShareLink — success path
  // -------------------------------------------------------------------------

  it('calls shareInvitation with the deepLinkUrl', async () => {
    vi.mocked(shareInvitation).mockResolvedValue(undefined);
    render();

    await act(async () => {
      await resultRef.current!.handleShareLink();
    });

    expect(shareInvitation).toHaveBeenCalledWith({ deepLinkUrl: TEST_URL });
  });

  it('sets isSharingLink=true during share and false after', async () => {
    let resolveFn!: () => void;
    vi.mocked(shareInvitation).mockReturnValue(
      new Promise<void>(res => {
        resolveFn = res;
      })
    );
    render();

    // Start without awaiting
    let sharePromise: Promise<void>;
    act(() => {
      sharePromise = resultRef.current!.handleShareLink();
    });

    // isSharingLink should be true while the promise is pending
    expect(resultRef.current!.isSharingLink).toBe(true);

    // Resolve the share and wait for effects to settle
    await act(async () => {
      resolveFn();
      await sharePromise;
    });

    expect(resultRef.current!.isSharingLink).toBe(false);
  });

  // -------------------------------------------------------------------------
  // handleShareLink — failure path
  // -------------------------------------------------------------------------

  it('calls toast.error and resets isSharingLink when shareInvitation throws', async () => {
    vi.mocked(shareInvitation).mockRejectedValue(new Error('share failed'));
    render();

    await act(async () => {
      await resultRef.current!.handleShareLink();
    });

    expect(toast.error).toHaveBeenCalledWith(
      'Failed to share invitation link. Please try again.'
    );
    expect(resultRef.current!.isSharingLink).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cleanup — clears timeout on unmount
  // -------------------------------------------------------------------------

  it('clears the copiedLink timeout on unmount', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    render();

    // Trigger copy to start the timeout
    await act(async () => {
      await resultRef.current!.handleCopyLink();
    });

    // Unmount before the 2s elapses
    act(() => {
      root.unmount();
    });

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
