import { describe, it, expect } from 'vitest';
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
