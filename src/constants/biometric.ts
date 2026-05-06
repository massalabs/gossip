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

/**
 * Fixed Secure Storage key for Capacitor biometric secure-login discovery.
 * Intentionally singleton for PD: secure login must not expose account or
 * slot inventory, so only one secure-storage account may use biometrics.
 */
export const BIOMETRIC_STORAGE_KEY = 'gossip-biometric';

/**
 * Fixed localStorage key for the WebAuthn secure-login credential ID.
 * Singleton for the same PD reason as BIOMETRIC_STORAGE_KEY.
 */
export const WEBAUTHN_CREDENTIAL_ID_KEY = 'gossip-webauthn-credential-id';
