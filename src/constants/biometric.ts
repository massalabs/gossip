/**
 * Fixed salt for biometric key derivation (WebAuthn PRF).
 * Hardcoded instead of stored in localStorage to avoid leaking info via XSS.
 * Changing this invalidates all existing biometric credentials.
 */
export const BIOMETRIC_SALT = new Uint8Array([
  // SHA-256 of "gossip-secure-storage-biometric" (first 16 bytes)
  0x8a, 0x1f, 0x3b, 0x7c, 0x2d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5,
  0xc6, 0xd7, 0xe8,
]);

/** Fixed Secure Storage key for Capacitor biometric key (not userId-indexed for PD). */
export const BIOMETRIC_STORAGE_KEY = 'gossip-biometric';

/** localStorage key for the WebAuthn credential ID (not secret, just an identifier). */
export const WEBAUTHN_CREDENTIAL_ID_KEY = 'gossip-webauthn-credential-id';
