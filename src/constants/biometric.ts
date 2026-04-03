/**
 * Fixed salt for biometric key derivation (WebAuthn PRF).
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

/** Fixed Secure Storage key for Capacitor biometric key (not userId-indexed for PD). */
export const BIOMETRIC_STORAGE_KEY = 'gossip-biometric';

/** localStorage key for the WebAuthn credential ID (not secret, just an identifier). */
export const WEBAUTHN_CREDENTIAL_ID_KEY = 'gossip-webauthn-credential-id';
