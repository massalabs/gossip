import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BIOMETRIC_STORAGE_KEY } from '../../src/constants/biometric';

const mocks = vi.hoisted(() => ({
  platform: 'ios',
  authenticate: vi.fn(),
  checkBiometry: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => mocks.platform,
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    get: mocks.get,
    remove: mocks.remove,
    set: mocks.set,
  },
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => {
  class BiometryError extends Error {
    code: string;

    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }

  return {
    BiometricAuth: {
      authenticate: mocks.authenticate,
      checkBiometry: mocks.checkBiometry,
    },
    BiometryError,
    BiometryErrorType: {
      userCancel: 'userCancel',
      systemCancel: 'systemCancel',
      appCancel: 'appCancel',
      userFallback: 'userFallback',
      biometryLockout: 'biometryLockout',
    },
    BiometryType: {
      touchId: 1,
      faceId: 2,
      fingerprintAuthentication: 3,
      faceAuthentication: 4,
    },
  };
});

vi.mock('../../src/crypto/webauthn', () => ({
  isWebAuthnSupported: () => false,
  isPlatformAuthenticatorAvailable: () => false,
  isWebAuthnPrfSupported: () => false,
  createWebAuthnCredential: vi.fn(),
  authenticateWithWebAuthn: vi.fn(),
}));

import {
  authenticateBiometricLogin,
  configureBiometricLogin,
  configureBiometricLoginWithRollback,
} from '../../src/services/biometricService';

describe('native biometric password storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform = 'ios';
    mocks.authenticate.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(null);
    mocks.remove.mockResolvedValue(false);
    mocks.set.mockResolvedValue(undefined);
  });

  it('disables device credentials and stores only the password locally', async () => {
    const result = await configureBiometricLogin('account-password', false);

    expect(result).toEqual({ success: true });
    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        allowDeviceCredential: false,
        iosFallbackTitle: '',
      })
    );
    expect(mocks.remove).toHaveBeenNthCalledWith(
      1,
      BIOMETRIC_STORAGE_KEY,
      false
    );
    expect(mocks.remove).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      true
    );
    expect(mocks.set).toHaveBeenCalledWith(
      BIOMETRIC_STORAGE_KEY,
      'account-password',
      true,
      false
    );
  });

  it('stores the password in the synchronizable Keychain when selected', async () => {
    const result = await configureBiometricLogin('cloud-password', true);

    expect(result).toEqual({ success: true });
    expect(mocks.set).toHaveBeenCalledWith(
      BIOMETRIC_STORAGE_KEY,
      'cloud-password',
      true,
      true
    );
  });

  it('returns an opaque rollback that restores both iOS credential locations', async () => {
    mocks.get
      .mockResolvedValueOnce('previous-local')
      .mockResolvedValueOnce('previous-cloud');

    const result = await configureBiometricLoginWithRollback(
      'new-password',
      true
    );

    expect(result.success).toBe(true);
    expect(result.rollback).toEqual(expect.any(Function));
    await result.rollback?.();
    expect(mocks.set).toHaveBeenNthCalledWith(
      1,
      BIOMETRIC_STORAGE_KEY,
      'new-password',
      true,
      true
    );
    expect(mocks.set).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      'previous-local',
      true,
      false
    );
    expect(mocks.set).toHaveBeenNthCalledWith(
      3,
      BIOMETRIC_STORAGE_KEY,
      'previous-cloud',
      true,
      true
    );
  });

  it('restores an ISO-looking local credential when Android replacement fails', async () => {
    const previousPassword = '2025-01-01T00:00:00.000Z';
    mocks.platform = 'android';
    mocks.get.mockImplementation(async (_key, convertDate) =>
      convertDate ? new Date(previousPassword) : previousPassword
    );
    mocks.set
      .mockRejectedValueOnce(new Error('replacement failed'))
      .mockResolvedValueOnce(undefined);

    const result = await configureBiometricLogin('new-password', false);

    expect(result).toEqual({ success: false, error: 'replacement failed' });
    expect(mocks.set).toHaveBeenNthCalledWith(
      1,
      BIOMETRIC_STORAGE_KEY,
      'new-password',
      true,
      false
    );
    expect(mocks.set).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      previousPassword,
      true,
      false
    );
  });

  it('restores both iOS Keychain locations when replacement fails', async () => {
    mocks.get
      .mockResolvedValueOnce('previous-local')
      .mockResolvedValueOnce('previous-cloud');
    mocks.set
      .mockRejectedValueOnce(new Error('replacement failed'))
      .mockResolvedValue(undefined);

    const result = await configureBiometricLogin('new-password', true);

    expect(result).toEqual({ success: false, error: 'replacement failed' });
    expect(mocks.set).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      'previous-local',
      true,
      false
    );
    expect(mocks.set).toHaveBeenNthCalledWith(
      3,
      BIOMETRIC_STORAGE_KEY,
      'previous-cloud',
      true,
      true
    );
  });

  it('restores iOS credentials when removal fails partway through', async () => {
    mocks.get
      .mockResolvedValueOnce('previous-local')
      .mockResolvedValueOnce('previous-cloud');
    mocks.remove
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('removal failed'));

    const result = await configureBiometricLogin('new-password', true);

    expect(result).toEqual({ success: false, error: 'removal failed' });
    expect(mocks.set).toHaveBeenCalledWith(
      BIOMETRIC_STORAGE_KEY,
      'previous-local',
      true,
      false
    );
    expect(mocks.set).toHaveBeenCalledWith(
      BIOMETRIC_STORAGE_KEY,
      'previous-cloud',
      true,
      true
    );
  });

  it('reads an ISO-looking password without date coercion', async () => {
    const password = '2025-01-01T00:00:00.000Z';
    mocks.get.mockImplementation(async (_key, convertDate, syncFromICloud) => {
      if (syncFromICloud) return null;
      return convertDate ? new Date(password) : password;
    });

    const result = await authenticateBiometricLogin('capacitor');

    expect(mocks.get).toHaveBeenCalledWith(BIOMETRIC_STORAGE_KEY, false, false);
    expect(result).toEqual({ success: true, data: { password } });
  });

  it('finds a pre-profile password in the selected iCloud location', async () => {
    mocks.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('cloud-password');

    const result = await authenticateBiometricLogin('capacitor');

    expect(mocks.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ allowDeviceCredential: false })
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      1,
      BIOMETRIC_STORAGE_KEY,
      false,
      false
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      false,
      true
    );
    expect(result).toEqual({
      success: true,
      data: { password: 'cloud-password' },
    });
  });
});
