import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BIOMETRIC_STORAGE_KEY } from '../../src/constants/biometric';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  checkBiometry: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
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
} from '../../src/services/biometricService';

describe('native biometric password storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      true,
      false
    );
    expect(mocks.get).toHaveBeenNthCalledWith(
      2,
      BIOMETRIC_STORAGE_KEY,
      true,
      true
    );
    expect(result).toEqual({
      success: true,
      data: { password: 'cloud-password' },
    });
  });
});
