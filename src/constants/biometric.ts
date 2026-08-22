/**
 * Fixed salt for WebAuthn PRF key derivation.
 * Derived at build time from a tagged string — not a secret, just a domain separator.
 * Changing the tag invalidates all existing biometric credentials.
 */
const BIOMETRIC_SALT_TAG = 'gossip-secure-storage-biometric-v1';

let _biometricSalt: Uint8Array | null = null;

export async function getBiometricSalt(): Promise<Uint8Array> {
  if (_biometricSalt) return _biometricSalt;
  const encoded = new TextEncoder().encode(BIOMETRIC_SALT_TAG);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  _biometricSalt = new Uint8Array(hash, 0, 16);
  return _biometricSalt;
}

/**
 * Fixed Secure Storage key for the singleton native biometric login password.
 * The stored value contains only a password, never an account/profile/slot
 * identifier, so normal login discovers the account without an association
 * oracle.
 */
export const BIOMETRIC_STORAGE_KEY = 'gossip-biometric';

/**
 * Fixed localStorage key for the singleton WebAuthn credential ID.
 * This is an authenticator handle, not a Gossip account identifier.
 */
export const WEBAUTHN_CREDENTIAL_ID_KEY = 'gossip-webauthn-credential-id';

/**
 * Fixed localStorage key for the password encrypted by the WebAuthn PRF key.
 * The versioned payload contains only ciphertext and cryptographic metadata;
 * it never identifies an account/profile/secure-storage slot.
 */
export const WEBAUTHN_PASSWORD_KEY = 'gossip-webauthn-password';
