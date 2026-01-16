/**
 * Encryption, Keys, and AEAD Support
 *
 * This file provides proxy functions for EncryptionKey, Nonce classes,
 * and AEAD (Authenticated Encryption with Additional Data) operations,
 * ensuring proper initialization before calling any WASM functions.
 */

import { ensureWasmInitialized } from './loader';
import {
  EncryptionKey,
  Nonce,
  aead_encrypt as _aead_encrypt,
  aead_decrypt as _aead_decrypt,
} from '../assets/generated/wasm/gossip_wasm';

// Re-export classes
export { EncryptionKey, Nonce };

/**
 * Generate a new random encryption key (64 bytes)
 * This ensures WASM is initialized before calling
 */
export async function generateEncryptionKey(): Promise<EncryptionKey> {
  await ensureWasmInitialized();
  return EncryptionKey.generate();
}

/**
 * Generate a deterministic encryption key (64 bytes) from a seed string.
 * This ensures WASM is initialized before calling.
 */
export async function generateEncryptionKeyFromSeed(
  seed: string,
  salt: Uint8Array
): Promise<EncryptionKey> {
  await ensureWasmInitialized();
  return EncryptionKey.from_seed(seed, salt);
}

/**
 * Create an encryption key from raw bytes (must be 64 bytes)
 * This ensures WASM is initialized before calling
 */
export async function encryptionKeyFromBytes(
  bytes: Uint8Array
): Promise<EncryptionKey> {
  await ensureWasmInitialized();
  return EncryptionKey.from_bytes(bytes);
}

/**
 * Generate a new random nonce (16 bytes)
 * This ensures WASM is initialized before calling
 */
export async function generateNonce(): Promise<Nonce> {
  await ensureWasmInitialized();
  return Nonce.generate();
}

/**
 * Create a nonce from raw bytes (must be 16 bytes)
 * This ensures WASM is initialized before calling
 */
export async function nonceFromBytes(bytes: Uint8Array): Promise<Nonce> {
  await ensureWasmInitialized();
  return Nonce.from_bytes(bytes);
}

/**
 * Encrypt data using AES-256-SIV authenticated encryption
 * This ensures WASM is initialized before calling
 *
 * @param key - The encryption key (64 bytes)
 * @param nonce - The nonce (16 bytes, should be unique per encryption)
 * @param plaintext - The data to encrypt
 * @param aad - Additional authenticated data (not encrypted, but authenticated)
 * @returns The ciphertext with authentication tag appended
 */
export async function encryptAead(
  key: EncryptionKey,
  nonce: Nonce,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  await ensureWasmInitialized();
  return _aead_encrypt(key, nonce, plaintext, aad);
}

/**
 * Decrypt data using AES-256-SIV authenticated encryption
 * This ensures WASM is initialized before calling
 *
 * @param key - The encryption key (64 bytes, must match encryption key)
 * @param nonce - The nonce (16 bytes, must match encryption nonce)
 * @param ciphertext - The encrypted data with authentication tag
 * @param aad - Additional authenticated data (must match encryption AAD)
 * @returns The decrypted plaintext, or undefined if authentication fails
 */
export async function decryptAead(
  key: EncryptionKey,
  nonce: Nonce,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array | undefined> {
  await ensureWasmInitialized();
  return _aead_decrypt(key, nonce, ciphertext, aad);
}
