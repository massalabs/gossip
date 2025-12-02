/**
 * Mock Session Module for Testing
 *
 * This file provides Vitest mocks for SessionModule and related WASM types.
 */

import { vi } from 'vitest';
import { blake3 } from '@noble/hashes/blake3';

/**
 * Mock UserPublicKeys class
 * Simplified version with only the essential properties for testing
 */
export class MockUserPublicKeys {
  kem_public_key = new Uint8Array(32);
  massa_public_key = new Uint8Array(32);
  dsa_verification_key = new Uint8Array(32);

  static from_bytes = vi.fn((bytes: Uint8Array) => {
    const instance = new MockUserPublicKeys();
    // Parse bytes into the actual WASM structure
    // The exact format depends on the WASM implementation
    if (bytes.length >= 96) {
      instance.dsa_verification_key = bytes.slice(0, 32);
      instance.kem_public_key = bytes.slice(32, 64);
      instance.massa_public_key = bytes.slice(64, 96);
    }
    return instance;
  });

  to_bytes = vi.fn(() => {
    // Serialize in the order: dsa_verification_key, kem_public_key, massa_public_key
    const result = new Uint8Array(96);
    result.set(this.dsa_verification_key, 0);
    result.set(this.kem_public_key, 32);
    result.set(this.massa_public_key, 64);
    return result;
  });

  derive_id = vi.fn(() => {
    // Derive user_id by hashing to_bytes() with Blake3 (matching Rust implementation)
    const serialized = this.to_bytes();
    const hashResult = blake3(serialized);
    return new Uint8Array(hashResult);
  });

  // Convenience getter for tests that access user_id directly
  get user_id(): Uint8Array {
    return this.derive_id();
  }

  free = vi.fn();
  [Symbol.dispose] = vi.fn();
}

/**
 * Mock UserSecretKeys class
 */
export class MockUserSecretKeys {
  kem_secret_key = new Uint8Array(32);
  dsa_signing_key = new Uint8Array(32);
  massa_secret_key = new Uint8Array(32);

  static from_bytes = vi.fn((bytes: Uint8Array) => {
    const instance = new MockUserSecretKeys();
    // Parse bytes into the actual WASM structure
    if (bytes.length >= 96) {
      instance.dsa_signing_key = bytes.slice(0, 32);
      instance.kem_secret_key = bytes.slice(32, 64);
      instance.massa_secret_key = bytes.slice(64, 96);
    }
    return instance;
  });

  to_bytes = vi.fn(() => {
    // Serialize in the order: dsa_signing_key, kem_secret_key, massa_secret_key
    const result = new Uint8Array(96);
    result.set(this.dsa_signing_key, 0);
    result.set(this.kem_secret_key, 32);
    result.set(this.massa_secret_key, 64);
    return result;
  });

  free = vi.fn();
  [Symbol.dispose] = vi.fn();
}

/**
 * Mock generateUserKeys function
 */
export const mockGenerateUserKeys = vi.fn(() => {
  const publicKeys = new MockUserPublicKeys();
  const secretKeys = new MockUserSecretKeys();

  // Generate random values for keys
  crypto.getRandomValues(publicKeys.dsa_verification_key);
  crypto.getRandomValues(publicKeys.kem_public_key);
  crypto.getRandomValues(publicKeys.massa_public_key);
  crypto.getRandomValues(secretKeys.dsa_signing_key);
  crypto.getRandomValues(secretKeys.kem_secret_key);
  crypto.getRandomValues(secretKeys.massa_secret_key);

  // user_id is now derived via derive_id() which hashes to_bytes() with Blake3

  return { publicKeys, secretKeys };
});

/**
 * Mock SessionModule class
 */
export class MockSessionModule {
  // Add minimal fields/methods to match SessionModule's public shape
  private sessionManager: unknown = null;
  persistIfNeeded = vi.fn();

  setOnPersist = vi.fn();
  load = vi.fn();
  toEncryptedBlob = vi.fn(() => new Uint8Array(100));
  cleanup = vi.fn();

  establishOutgoingSession = vi.fn(() => new Uint8Array(200));
  feedIncomingAnnouncement = vi.fn(() => undefined);
  getMessageBoardReadKeys = vi.fn((): Uint8Array[] => []);
  feedIncomingMessageBoardRead = vi.fn(() => undefined);
  sendMessage = vi.fn(() => {
    // Default mock returns a SendMessageOutput-like object
    const seeker = new Uint8Array(32);
    const data = new Uint8Array(100);
    crypto.getRandomValues(seeker);
    crypto.getRandomValues(data);
    return { seeker, data };
  });
  receiveMessage = vi.fn(() => undefined);
  peerList = vi.fn(() => []);
  peerSessionStatus = vi.fn(() => 2); // NoSession
  peerDiscard = vi.fn();
  refresh = vi.fn(() => []);
}
