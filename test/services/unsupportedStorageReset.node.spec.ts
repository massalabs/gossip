import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
  registerPlugin: () => ({}),
}));

import { isUnsupportedStorageVersionError } from '../../src/services/unsupportedStorageReset';

describe('unsupported secure-storage reset classification', () => {
  it('accepts only the secure-storage version failure', () => {
    expect(
      isUnsupportedStorageVersionError({ code: 'UNSUPPORTED_VERSION' })
    ).toBe(true);
    const browserError = new Error('unsupported version');
    browserError.name = 'UNSUPPORTED_VERSION';
    expect(isUnsupportedStorageVersionError(browserError)).toBe(true);
    expect(
      isUnsupportedStorageVersionError(
        new Error('unsupported portable backup version')
      )
    ).toBe(false);
    expect(
      isUnsupportedStorageVersionError(new Error('unsupported version'))
    ).toBe(false);
  });
});
