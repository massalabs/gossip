// Tests for the useRetentionPolicy hook.
// Runs in jsdom (unit project) — no browser runner needed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useRetentionPolicy } from '../../src/hooks/useRetentionPolicy';

// --- Mock sdkStore ---
const mockGetRetentionInfo = vi.fn();
const mockSetRetentionPolicy = vi.fn();

const mockSdk = {
  isSessionOpen: true,
  selfMessages: {
    getRetentionInfo: mockGetRetentionInfo,
    setRetentionPolicy: mockSetRetentionPolicy,
  },
};

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => mockSdk,
}));

// --- Hook capture helper ---
// We render a minimal React tree that calls the hook and stores its return value
// so we can assert on it from outside React.

interface HookResult {
  current: ReturnType<typeof useRetentionPolicy> | null;
}

function renderHook(
  t: (key: string) => string,
  container: HTMLDivElement
): HookResult {
  const result: HookResult = { current: null };

  function Harness() {
    result.current = useRetentionPolicy(t);
    return null;
  }

  act(() => {
    createRoot(container).render(React.createElement(Harness));
  });

  return result;
}

// --- Tests ---

describe('useRetentionPolicy', () => {
  let container: HTMLDivElement;
  const t = (key: string) => key; // identity translator for tests

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    vi.useFakeTimers();
    mockGetRetentionInfo.mockReset();
    mockSetRetentionPolicy.mockReset();
    mockSdk.isSessionOpen = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches retention info on mount and sets state', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: 3600, setAt: 1000 });

    const result = renderHook(t, container);

    // Flush the promise from useEffect
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockGetRetentionInfo).toHaveBeenCalledOnce();
    expect(result.current?.retentionDuration).toBe(3600);
    expect(result.current?.retentionPolicySetAt).toBe(1000);
  });

  it('does not fetch retention info when session is not open', () => {
    mockSdk.isSessionOpen = false;

    renderHook(t, container);

    expect(mockGetRetentionInfo).not.toHaveBeenCalled();
  });

  it('handleSelectRetention calls SDK setRetentionPolicy and updates state', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: null, setAt: null });
    mockSetRetentionPolicy.mockResolvedValue(undefined);

    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    const result = renderHook(t, container);

    await act(async () => {
      await result.current!.handleSelectRetention(3600);
    });

    expect(mockSetRetentionPolicy).toHaveBeenCalledWith(3600);
    expect(result.current?.retentionDuration).toBe(3600);
    expect(result.current?.retentionPolicySetAt).toBe(now);
  });

  it('handleSelectRetention closes the modal', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: null, setAt: null });
    mockSetRetentionPolicy.mockResolvedValue(undefined);

    const result = renderHook(t, container);

    // Open the modal first
    act(() => {
      result.current!.setIsRetentionModalOpen(true);
    });
    expect(result.current?.isRetentionModalOpen).toBe(true);

    // handleSelectRetention should close it
    await act(async () => {
      await result.current!.handleSelectRetention(300);
    });

    expect(result.current?.isRetentionModalOpen).toBe(false);
  });

  it('handleSelectRetention(null) clears retentionPolicySetAt', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: 3600, setAt: 999 });
    mockSetRetentionPolicy.mockResolvedValue(undefined);

    const result = renderHook(t, container);

    // Wait for mount fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionPolicySetAt).toBe(999);

    // Disable retention
    await act(async () => {
      await result.current!.handleSelectRetention(null);
    });

    expect(result.current?.retentionDuration).toBeNull();
    expect(result.current?.retentionPolicySetAt).toBeNull();
  });

  it('retentionHeaderLabel returns correct label for known durations', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: 86400, setAt: 1000 });

    const customT = (key: string) => `translated:${key}`;
    const result = renderHook(customT, container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionHeaderLabel).toBe(
      'translated:settings.auto_delete_1d'
    );
  });

  it('retentionHeaderLabel returns null when no retention is set', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: null, setAt: null });

    const result = renderHook(t, container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionHeaderLabel).toBeNull();
  });

  it('retentionHeaderLabel returns null for unknown duration', async () => {
    // A duration not in the RETENTION_HEADER_LABELS map
    mockGetRetentionInfo.mockResolvedValue({ duration: 12345, setAt: 1000 });

    const result = renderHook(t, container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionHeaderLabel).toBeNull();
  });

  it('retentionInfo is non-null when both duration and setAt are set', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: 604800, setAt: 2000 });

    const result = renderHook(t, container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionInfo).toEqual({
      setAt: 2000,
      duration: 604800,
    });
  });

  it('retentionInfo is null when duration is null', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: null, setAt: null });

    const result = renderHook(t, container);

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.retentionInfo).toBeNull();
  });

  it('setIsRetentionModalOpen toggles the modal state', async () => {
    mockGetRetentionInfo.mockResolvedValue({ duration: null, setAt: null });

    const result = renderHook(t, container);

    // Let the mount-time fetch settle so it doesn't bleed into later assertions
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current?.isRetentionModalOpen).toBe(false);

    act(() => {
      result.current!.setIsRetentionModalOpen(true);
    });

    expect(result.current?.isRetentionModalOpen).toBe(true);

    act(() => {
      result.current!.setIsRetentionModalOpen(false);
    });

    expect(result.current?.isRetentionModalOpen).toBe(false);
  });
});
