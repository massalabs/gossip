import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WEBAUTHN_CREDENTIAL_ID_KEY,
  WEBAUTHN_PASSWORD_KEY,
} from '../../src/constants/biometric';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => false,
    getPlatform: () => 'web',
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {},
}));

vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {},
  BiometryError: class BiometryError extends Error {},
  BiometryErrorType: {},
  BiometryType: {
    touchId: 1,
    faceId: 2,
    fingerprintAuthentication: 3,
    faceAuthentication: 4,
  },
}));

vi.mock('../../src/crypto/webauthn', async () => {
  const { encodeToBase64, generateEncryptionKeyFromSeed } =
    await vi.importActual<typeof import('@massalabs/gossip-sdk')>(
      '@massalabs/gossip-sdk'
    );
  const seed = encodeToBase64(new Uint8Array(32).fill(7));
  const deriveKey = (salt: Uint8Array) =>
    generateEncryptionKeyFromSeed(seed, salt);

  return {
    isWebAuthnSupported: () => true,
    isPlatformAuthenticatorAvailable: () => true,
    isWebAuthnPrfSupported: () => true,
    createWebAuthnCredential: async (salt: Uint8Array) => ({
      credentialId: 'anonymous-credential-handle',
      encryptionKey: await deriveKey(salt),
    }),
    authenticateWithWebAuthn: async (
      _credentialId: string,
      salt: Uint8Array
    ) => ({ encryptionKey: await deriveKey(salt) }),
  };
});

import {
  authenticateBiometricLogin,
  configureBiometricLogin,
} from '../../src/services/biometricService';

describe('WebAuthn biometric password encryption integration', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips the exact password with the real cipher without plaintext storage', async () => {
    const password = 'real cipher password 2026!';

    expect(await configureBiometricLogin(password)).toEqual({ success: true });

    const legacyCredentialRecord = localStorage.getItem(
      WEBAUTHN_CREDENTIAL_ID_KEY
    );
    const encryptedRecord = localStorage.getItem(WEBAUTHN_PASSWORD_KEY);
    expect(legacyCredentialRecord).toBeNull();
    expect(encryptedRecord).not.toContain(password);
    expect(JSON.parse(encryptedRecord ?? '{}')).toMatchObject({
      version: 1,
      credentialId: 'anonymous-credential-handle',
    });

    await expect(authenticateBiometricLogin('webauthn')).resolves.toEqual({
      success: true,
      data: { password },
    });
  });
});
