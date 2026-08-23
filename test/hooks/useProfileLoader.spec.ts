import { describe, expect, it } from 'vitest';
import { shouldInitializeSecureStorage } from '../../src/hooks/useProfileLoader';

describe('secure-storage startup routing', () => {
  it('keeps a dummy-only rolled-back store in onboarding after relaunch', () => {
    expect(shouldInitializeSecureStorage('locked', true)).toBe(false);
  });

  it('routes a completed account store to login after relaunch', () => {
    expect(shouldInitializeSecureStorage('locked', false)).toBe(true);
  });

  it('never treats empty or unlocked startup state as logged out', () => {
    expect(shouldInitializeSecureStorage('empty', false)).toBe(false);
    expect(shouldInitializeSecureStorage('unlocked', false)).toBe(false);
    expect(shouldInitializeSecureStorage(null, false)).toBe(false);
  });
});
