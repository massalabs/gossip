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
  generateNonce: vi.fn(),
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
  generateNonce: mocks.generateNonce,
  encodeToBase64: (value: Uint8Array) => btoa(String.fromCharCode(...value)),
  decodeFromBase64: (value: string) =>
    Uint8Array.from(atob(value), character => character.charCodeAt(0)),
}));

import {
  authenticateBiometricLogin,
  configureBiometricLogin,
  configureBiometricLoginWithRollback,
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
    mocks.generateNonce.mockResolvedValue({
      to_bytes: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
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

  it('frees the acquired key when nonce generation fails', async () => {
    mocks.generateNonce.mockRejectedValue(new Error('nonce failed'));

    const result = await configureBiometricLogin('account-password');

    expect(result).toEqual({ success: false, error: 'nonce failed' });
    expect(mocks.free).toHaveBeenCalledOnce();
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it('returns an opaque rollback that restores the previous credential pair', async () => {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'previous-credential');
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, 'previous-payload');

    const result = await configureBiometricLoginWithRollback('new-password');

    expect(result.success).toBe(true);
    expect(result.rollback).toEqual(expect.any(Function));
    expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBe(
      'credential-handle'
    );
    await result.rollback?.();
    expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBe(
      'previous-credential'
    );
    expect(localStorage.getItem(WEBAUTHN_PASSWORD_KEY)).toBe(
      'previous-payload'
    );
  });

  it('restores the previous credential pair after a partial storage write', async () => {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'previous-credential');
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, 'previous-payload');
    const originalSetItem = Storage.prototype.setItem;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key: string, value: string) {
        if (
          key === WEBAUTHN_CREDENTIAL_ID_KEY &&
          value === 'credential-handle'
        ) {
          throw new Error('credential write failed');
        }
        originalSetItem.call(this, key, value);
      });

    try {
      const result = await configureBiometricLogin('new-password');

      expect(result).toEqual({
        success: false,
        error: 'credential write failed',
      });
      expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBe(
        'previous-credential'
      );
      expect(localStorage.getItem(WEBAUTHN_PASSWORD_KEY)).toBe(
        'previous-payload'
      );
    } finally {
      setItemSpy.mockRestore();
    }
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

  it.each([
    ['salt', '%%%invalid%%%', btoa('ciphertext')],
    ['ciphertext', btoa('encryption-salt'), '%%%invalid%%%'],
  ])(
    'cleans up the acquired key when the stored %s is malformed',
    async (_field, salt, ciphertext) => {
      localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'credential-handle');
      localStorage.setItem(
        WEBAUTHN_PASSWORD_KEY,
        JSON.stringify({ version: 1, salt, ciphertext })
      );
      const fillSpy = vi.spyOn(Uint8Array.prototype, 'fill');

      const result = await authenticateBiometricLogin('webauthn');

      expect(result).toEqual({
        success: false,
        error: 'Stored biometric password is invalid',
      });
      expect(mocks.decrypt).not.toHaveBeenCalled();
      expect(mocks.free).toHaveBeenCalledTimes(1);
      if (_field === 'ciphertext') {
        expect(fillSpy).toHaveBeenCalledWith(0);
      }
      fillSpy.mockRestore();
    }
  );
});
