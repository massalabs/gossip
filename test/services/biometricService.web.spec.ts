import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEBAUTHN_CREDENTIAL_ID_KEY,
  WEBAUTHN_PASSWORD_KEY,
} from '../../src/constants/biometric';

const mocks = vi.hoisted(() => ({
  authenticateWithWebAuthn: vi.fn(),
  createWebAuthnCredential: vi.fn(),
  decrypt: vi.fn(),
  encrypt: vi.fn(),
  free: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {},
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => {
  class BiometryError extends Error {}
  return {
    BiometricAuth: {},
    BiometryError,
    BiometryErrorType: {},
    BiometryType: {},
  };
});

vi.mock('../../src/crypto/webauthn', () => ({
  isWebAuthnSupported: () => true,
  isPlatformAuthenticatorAvailable: () => true,
  isWebAuthnPrfSupported: () => true,
  createWebAuthnCredential: mocks.createWebAuthnCredential,
  authenticateWithWebAuthn: mocks.authenticateWithWebAuthn,
}));

vi.mock('@massalabs/gossip-sdk', () => ({
  decrypt: mocks.decrypt,
  encrypt: mocks.encrypt,
  generateNonce: vi.fn(async () => ({
    to_bytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  })),
  encodeToBase64: (value: Uint8Array) => btoa(String.fromCharCode(...value)),
  decodeFromBase64: (value: string) =>
    Uint8Array.from(atob(value), character => character.charCodeAt(0)),
}));

import {
  authenticateBiometricLogin,
  configureBiometricLogin,
} from '../../src/services/biometricService';

const encryptionKey = {
  __wbg_ptr: 1,
  free: mocks.free,
};

describe('WebAuthn biometric password storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.createWebAuthnCredential.mockResolvedValue({
      credentialId: 'credential-handle',
      encryptionKey,
    });
    mocks.authenticateWithWebAuthn.mockResolvedValue({ encryptionKey });
    mocks.encrypt.mockResolvedValue({
      encryptedData: new Uint8Array([9, 8, 7]),
    });
    mocks.decrypt.mockResolvedValue('account-password');
  });

  it('stores an encrypted password without passing an account identifier', async () => {
    const result = await configureBiometricLogin('account-password');

    expect(result).toEqual({ success: true });
    expect(mocks.createWebAuthnCredential).toHaveBeenCalledTimes(1);
    expect(mocks.createWebAuthnCredential.mock.calls[0]).toHaveLength(1);
    expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBe(
      'credential-handle'
    );
    expect(
      JSON.parse(localStorage.getItem(WEBAUTHN_PASSWORD_KEY) ?? '{}')
    ).toEqual({
      version: 1,
      salt: expect.any(String),
      ciphertext: expect.any(String),
    });
    expect(mocks.free).toHaveBeenCalledTimes(1);
  });

  it('uses WebAuthn PRF output to recover only the password', async () => {
    await configureBiometricLogin('account-password');
    mocks.free.mockClear();

    const result = await authenticateBiometricLogin('webauthn');

    expect(mocks.authenticateWithWebAuthn).toHaveBeenCalledWith(
      'credential-handle',
      expect.any(Uint8Array)
    );
    expect(result).toEqual({
      success: true,
      data: { password: 'account-password' },
    });
    expect(mocks.free).toHaveBeenCalledTimes(1);
  });
});
