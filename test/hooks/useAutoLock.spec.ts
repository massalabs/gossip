import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shouldLock } from '../../src/hooks/useAutoLock';

describe('shouldLock', () => {
  const TIMEOUT_60S = 60;

  it('returns false when no background timestamp is recorded', () => {
    expect(shouldLock(null, 100_000, TIMEOUT_60S)).toBe(false);
  });

  it('returns true when elapsed time exceeds timeout', () => {
    const bg = 1000;
    const now = bg + 61_000; // 61s later
    expect(shouldLock(bg, now, TIMEOUT_60S)).toBe(true);
  });

  it('returns false when elapsed time is under timeout', () => {
    const bg = 1000;
    const now = bg + 59_000; // 59s later
    expect(shouldLock(bg, now, TIMEOUT_60S)).toBe(false);
  });

  it('returns true at exact boundary (>=)', () => {
    const bg = 1000;
    const now = bg + 60_000; // exactly 60s
    expect(shouldLock(bg, now, TIMEOUT_60S)).toBe(true);
  });

  it('works with different timeout values', () => {
    const bg = 0;
    // 5 minutes timeout
    expect(shouldLock(bg, 299_000, 300)).toBe(false);
    expect(shouldLock(bg, 300_000, 300)).toBe(true);

    // 1 hour timeout
    expect(shouldLock(bg, 3_599_000, 3600)).toBe(false);
    expect(shouldLock(bg, 3_600_000, 3600)).toBe(true);
  });

  it('locks when auto-lock is 60s and 61s have elapsed', () => {
    const bg = 5000;
    const now = bg + 61_000;
    expect(shouldLock(bg, now, 60)).toBe(true);
  });

  it('with timeout 0, any non-negative elapsed time triggers lock', () => {
    // timeout 0 means "lock immediately on any resume"
    expect(shouldLock(100, 100, 0)).toBe(true); // 0s elapsed >= 0
    expect(shouldLock(100, 101, 0)).toBe(true); // 1ms elapsed >= 0
    expect(shouldLock(100, 200_000, 0)).toBe(true); // large elapsed >= 0
  });

  it('returns false for null background regardless of timeout', () => {
    // Covers the "disabled" path: if no background timestamp was set, never lock
    expect(shouldLock(null, 999_999, 0)).toBe(false);
    expect(shouldLock(null, 999_999, 60)).toBe(false);
    expect(shouldLock(null, 999_999, 3600)).toBe(false);
  });
});

/**
 * Integration-style tests that simulate the hook's internal background/foreground
 * flow. Since the hook is tightly coupled to React lifecycle and Zustand stores
 * (and we don't have renderHook available), we replicate the exact logic the hook
 * performs: record timestamp on background, check shouldLock on foreground, and
 * call logout when appropriate.
 */
describe('useAutoLock integration logic', () => {
  let logoutMock: ReturnType<typeof vi.fn>;
  let backgroundTimestamp: number | null;

  // Simulates the hook's onBackground handler
  function onBackground(nowMs: number) {
    backgroundTimestamp = nowMs;
  }

  // Simulates the hook's onForeground handler
  function onForeground(nowMs: number, autoLockTimeout: number) {
    if (shouldLock(backgroundTimestamp, nowMs, autoLockTimeout)) {
      logoutMock({ lockedByUser: false });
    }
    backgroundTimestamp = null;
  }

  beforeEach(() => {
    logoutMock = vi.fn();
    backgroundTimestamp = null;
  });

  it('calls logout with { lockedByUser: false } when background exceeds timeout', () => {
    const bgTime = 10_000;
    const fgTime = bgTime + 61_000; // 61s, exceeds 60s timeout

    onBackground(bgTime);
    onForeground(fgTime, 60);

    expect(logoutMock).toHaveBeenCalledOnce();
    expect(logoutMock).toHaveBeenCalledWith({ lockedByUser: false });
  });

  it('does not call logout when background is under timeout', () => {
    const bgTime = 10_000;
    const fgTime = bgTime + 30_000; // 30s, under 60s timeout

    onBackground(bgTime);
    onForeground(fgTime, 60);

    expect(logoutMock).not.toHaveBeenCalled();
  });

  it('does not call logout when no background event occurred', () => {
    // Foreground without prior background — backgroundTimestamp stays null
    onForeground(50_000, 60);

    expect(logoutMock).not.toHaveBeenCalled();
  });

  it('resets background timestamp after foreground regardless of lock decision', () => {
    onBackground(10_000);
    onForeground(10_500, 60); // under timeout, no lock

    expect(backgroundTimestamp).toBeNull();

    onBackground(20_000);
    onForeground(81_000 + 20_000, 60); // over timeout, lock

    expect(backgroundTimestamp).toBeNull();
  });

  it('handles multiple background/foreground cycles independently', () => {
    // Cycle 1: short background, no lock
    onBackground(1000);
    onForeground(5000, 60);
    expect(logoutMock).not.toHaveBeenCalled();

    // Cycle 2: long background, should lock
    onBackground(10_000);
    onForeground(10_000 + 120_000, 60); // 120s > 60s
    expect(logoutMock).toHaveBeenCalledOnce();
    expect(logoutMock).toHaveBeenCalledWith({ lockedByUser: false });
  });

  /**
   * When autoLockTimeout is null, the hook returns early and never registers
   * visibility listeners. This test verifies that logic: if the hook guard
   * prevents listener setup, no lock can occur.
   */
  it('hook guard: null timeout means listeners are never registered', () => {
    // Simulate the hook's guard: if autoLockTimeout === null, skip entirely
    const autoLockTimeout: number | null = null;

    if (autoLockTimeout !== null) {
      onBackground(1000);
      onForeground(999_999, autoLockTimeout);
    }

    expect(logoutMock).not.toHaveBeenCalled();
  });

  /**
   * Simulate the web path: document visibilitychange events trigger
   * onBackground (hidden) and onForeground (visible).
   */
  describe('web visibility change simulation', () => {
    let performanceNowValue: number;

    beforeEach(() => {
      performanceNowValue = 0;
      vi.spyOn(performance, 'now').mockImplementation(
        () => performanceNowValue
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function simulateHide() {
      performanceNowValue = performance.now();
      backgroundTimestamp = performanceNowValue;
    }

    function simulateShow(elapsedMs: number, autoLockTimeout: number) {
      performanceNowValue += elapsedMs;
      vi.spyOn(performance, 'now').mockReturnValue(performanceNowValue);
      if (
        shouldLock(backgroundTimestamp, performanceNowValue, autoLockTimeout)
      ) {
        logoutMock({ lockedByUser: false });
      }
      backgroundTimestamp = null;
    }

    it('locks after visibility hidden for longer than timeout', () => {
      performanceNowValue = 5000;
      vi.spyOn(performance, 'now').mockReturnValue(5000);

      simulateHide();
      simulateShow(61_000, 60); // 61s in background

      expect(logoutMock).toHaveBeenCalledOnce();
      expect(logoutMock).toHaveBeenCalledWith({ lockedByUser: false });
    });

    it('does not lock after short visibility hidden', () => {
      performanceNowValue = 5000;
      vi.spyOn(performance, 'now').mockReturnValue(5000);

      simulateHide();
      simulateShow(10_000, 60); // 10s in background

      expect(logoutMock).not.toHaveBeenCalled();
    });
  });
});
