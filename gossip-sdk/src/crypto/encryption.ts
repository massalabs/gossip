/**
 * High-level encryption utilities
 *
 * Provides convenient wrappers for encrypting and decrypting strings
 * using the WASM encryption primitives.
 */

import {
  decryptAead,
  encryptAead,
  EncryptionKey,
  generateNonce,
  Nonce,
} from '../wasm/encryption';

/**
 * Encrypt a plaintext string using AES-256-SIV
 *
 * @param plaintext - The string to encrypt
 * @param key - The encryption key (64 bytes)
 * @param salt - Optional salt/nonce bytes (will generate random if not provided)
 * @returns Object containing encrypted data and nonce bytes
 */
export async function encrypt(
  plaintext: string,
  key: EncryptionKey,
  salt?: Uint8Array
): Promise<{ encryptedData: Uint8Array; nonce: Uint8Array }> {
  const nonce = salt ? Nonce.from_bytes(salt) : await generateNonce();
  const encryptedData = await encryptAead(
    key,
    nonce,
    new TextEncoder().encode(plaintext),
    new Uint8Array()
  );
  return { encryptedData, nonce: nonce.to_bytes() };
}

/**
 * Decrypt encrypted data back to a string
 *
 * @param encryptedData - The encrypted data bytes
 * @param salt - The nonce/salt used during encryption
 * @param key - The encryption key (must match encryption key)
 * @returns The decrypted plaintext string
 * @throws Error if decryption fails (wrong key, corrupted data, etc.)
 */
export async function decrypt(
  encryptedData: Uint8Array,
  salt: Uint8Array,
  key: EncryptionKey
): Promise<string> {
  const plain = await decryptAead(
    key,
    Nonce.from_bytes(salt),
    encryptedData,
    new Uint8Array()
  );
  if (!plain) {
    throw new Error('Failed to decrypt data');
  }
  return new TextDecoder().decode(plain);
}

/**
 * Derive an encryption key from a seed string and nonce
 *
 * @param seedString - The seed string (e.g., password)
 * @param nonce - The nonce/salt for key derivation
 * @returns The derived encryption key
 */
export async function deriveKey(
  seedString: string,
  nonce: Uint8Array
): Promise<EncryptionKey> {
  return await EncryptionKey.from_seed(seedString, nonce);
}
