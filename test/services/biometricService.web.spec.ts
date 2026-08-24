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
    expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBeNull();
    expect(
      JSON.parse(localStorage.getItem(WEBAUTHN_PASSWORD_KEY) ?? '{}')
    ).toEqual({
      version: 1,
      credentialId: 'credential-handle',
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

  it('atomically replaces the complete record and returns an opaque rollback', async () => {
    const previousRecord = JSON.stringify({
      version: 1,
      credentialId: 'previous-credential',
      salt: 'previous-salt',
      ciphertext: 'previous-ciphertext',
    });
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, previousRecord);
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'legacy-credential');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const result = await configureBiometricLoginWithRollback('new-password');

    expect(result.success).toBe(true);
    expect(result.rollback).toEqual(expect.any(Function));
    const replacementWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === WEBAUTHN_PASSWORD_KEY
    );
    expect(replacementWrites).toHaveLength(1);
    expect(JSON.parse(replacementWrites[0][1])).toMatchObject({
      version: 1,
      credentialId: 'credential-handle',
    });
    expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBeNull();

    await result.rollback?.();
    expect(localStorage.getItem(WEBAUTHN_PASSWORD_KEY)).toBe(previousRecord);
    setItemSpy.mockRestore();
  });

  it('preserves the previous complete record when the atomic commit fails', async () => {
    const previousRecord = JSON.stringify({
      version: 1,
      credentialId: 'previous-credential',
      salt: 'previous-salt',
      ciphertext: 'previous-ciphertext',
    });
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, previousRecord);
    const originalSetItem = Storage.prototype.setItem;
    let replacementRejected = false;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key: string, value: string) {
        if (
          !replacementRejected &&
          key === WEBAUTHN_PASSWORD_KEY &&
          value !== previousRecord
        ) {
          replacementRejected = true;
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
      expect(localStorage.getItem(WEBAUTHN_PASSWORD_KEY)).toBe(previousRecord);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('returns a retry when WebAuthn replacement restoration is interrupted', async () => {
    const previousRecord = JSON.stringify({
      version: 1,
      credentialId: 'previous-credential',
      salt: 'previous-salt',
      ciphertext: 'previous-ciphertext',
    });
    localStorage.setItem(WEBAUTHN_PASSWORD_KEY, previousRecord);
    const originalSetItem = Storage.prototype.setItem;
    let replacementRejected = false;
    let restorationFailed = false;
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(function (key: string, value: string) {
        if (
          !replacementRejected &&
          key === WEBAUTHN_PASSWORD_KEY &&
          value !== previousRecord
        ) {
          replacementRejected = true;
          throw new Error('credential write failed');
        }
        if (
          replacementRejected &&
          !restorationFailed &&
          key === WEBAUTHN_PASSWORD_KEY &&
          value === previousRecord
        ) {
          restorationFailed = true;
          throw new Error('restore failed');
        }
        originalSetItem.call(this, key, value);
      });

    try {
      const result = await configureBiometricLoginWithRollback('new-password');

      expect(result).toMatchObject({
        success: false,
        error: 'credential write failed',
        rollback: expect.any(Function),
      });
      await expect(result.rollback?.()).resolves.toBeUndefined();
      expect(localStorage.getItem(WEBAUTHN_PASSWORD_KEY)).toBe(previousRecord);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('keeps the committed record usable when legacy cleanup fails', async () => {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'legacy-credential');
    const originalRemoveItem = Storage.prototype.removeItem;
    const removeItemSpy = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(function (key: string) {
        if (key === WEBAUTHN_CREDENTIAL_ID_KEY) {
          throw new Error('legacy cleanup failed');
        }
        originalRemoveItem.call(this, key);
      });

    try {
      expect(await configureBiometricLogin('account-password')).toEqual({
        success: true,
      });
      expect(localStorage.getItem(WEBAUTHN_CREDENTIAL_ID_KEY)).toBe(
        'legacy-credential'
      );
      await expect(authenticateBiometricLogin('webauthn')).resolves.toEqual({
        success: true,
        data: { password: 'account-password' },
      });
      expect(mocks.authenticateWithWebAuthn).toHaveBeenCalledWith(
        'credential-handle',
        expect.any(Uint8Array)
      );
    } finally {
      removeItemSpy.mockRestore();
    }
  });

  it('rejects the obsolete split payload instead of pairing its legacy ID', async () => {
    localStorage.setItem(WEBAUTHN_CREDENTIAL_ID_KEY, 'legacy-credential');
    localStorage.setItem(
      WEBAUTHN_PASSWORD_KEY,
      JSON.stringify({
        version: 1,
        salt: btoa('encryption-salt'),
        ciphertext: btoa('ciphertext'),
      })
    );

    await expect(authenticateBiometricLogin('webauthn')).resolves.toEqual({
      success: false,
      error: 'Stored biometric password is invalid',
    });
    expect(mocks.authenticateWithWebAuthn).not.toHaveBeenCalled();
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
      localStorage.setItem(
        WEBAUTHN_PASSWORD_KEY,
        JSON.stringify({
          version: 1,
          credentialId: 'credential-handle',
          salt,
          ciphertext,
        })
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
