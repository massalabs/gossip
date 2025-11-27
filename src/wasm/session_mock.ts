/**
 * Mock Session Module for Testing
 *
 * This file provides Vitest mocks for SessionModule and related WASM types.
 */

import { vi } from 'vitest';

/**
 * Mock UserPublicKeys class
 * Simplified version with only the essential properties for testing
 */
export class MockUserPublicKeys {
  user_id = new Uint8Array(32);
  identity_key = new Uint8Array(32);
  prekey = new Uint8Array(32);
  prekey_signature = new Uint8Array(64);
  kem_public_key = new Uint8Array(32);
  massa_public_key = new Uint8Array(32);
  dsa_verification_key = new Uint8Array(32);

  static from_bytes = vi.fn((bytes: Uint8Array) => {
    const instance = new MockUserPublicKeys();
    if (bytes.length >= 160) {
      instance.user_id = bytes.slice(0, 32);
      instance.identity_key = bytes.slice(32, 64);
      instance.prekey = bytes.slice(64, 96);
      instance.prekey_signature = bytes.slice(96, 160);
    }
    return instance;
  });

  to_bytes = vi.fn(() => {
    const result = new Uint8Array(160);
    result.set(this.user_id, 0);
    result.set(this.identity_key, 32);
    result.set(this.prekey, 64);
    result.set(this.prekey_signature, 96);
    return result;
  });

  derive_id = vi.fn(() => this.user_id);
  free = vi.fn();
  [Symbol.dispose] = vi.fn();
}

/**
 * Mock UserSecretKeys class
 */
export class MockUserSecretKeys {
  identity_key = new Uint8Array(32);
  prekey = new Uint8Array(32);
  kem_secret_key = new Uint8Array(32);
  dsa_signing_key = new Uint8Array(32);
  massa_secret_key = new Uint8Array(32);

  static from_bytes = vi.fn((bytes: Uint8Array) => {
    const instance = new MockUserSecretKeys();
    if (bytes.length >= 64) {
      instance.identity_key = bytes.slice(0, 32);
      instance.prekey = bytes.slice(32, 64);
    }
    return instance;
  });

  to_bytes = vi.fn(() => {
    const result = new Uint8Array(64);
    result.set(this.identity_key, 0);
    result.set(this.prekey, 32);
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
  crypto.getRandomValues(publicKeys.user_id);
  crypto.getRandomValues(publicKeys.identity_key);
  crypto.getRandomValues(publicKeys.prekey);
  crypto.getRandomValues(publicKeys.prekey_signature);
  crypto.getRandomValues(secretKeys.identity_key);
  crypto.getRandomValues(secretKeys.prekey);

  return { publicKeys, secretKeys };
});

/**
 * Mock SessionModule class
 */
export class MockSessionModule {
  setOnPersist = vi.fn();
  load = vi.fn();
  toEncryptedBlob = vi.fn(() => new Uint8Array(100));
  cleanup = vi.fn();

  establishOutgoingSession = vi.fn(() => new Uint8Array(200));
  feedIncomingAnnouncement = vi.fn(() => undefined);
  getMessageBoardReadKeys = vi.fn(() => []);
  feedIncomingMessageBoardRead = vi.fn(() => undefined);
  sendMessage = vi.fn(() => undefined);
  peerList = vi.fn(() => []);
  peerSessionStatus = vi.fn(() => 2); // NoSession
  peerDiscard = vi.fn();
  refresh = vi.fn(() => []);
}
