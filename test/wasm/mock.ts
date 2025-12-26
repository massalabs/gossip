/**
 * Mock Session Module for Testing
 *
 * This file provides Vitest mocks for SessionModule and related WASM types.
 */

import { vi } from 'vitest';
import { blake3 } from '@noble/hashes/blake3';
import type {
  UserPublicKeys,
  UserSecretKeys,
  SessionStatus,
  AnnouncementResult,
  SendMessageOutput,
  ReceiveMessageOutput,
  EncryptionKey,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { UserProfile } from '../../src/db';

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
 *
 * This class implements the same interface as SessionModule to allow
 * it to be used as a drop-in replacement in tests without type casts.
 */
export class MockSessionModule {
  // Properties matching SessionModule's public interface exactly
  public ourPk: MockUserPublicKeys & UserPublicKeys;
  public ourSk: MockUserSecretKeys & UserSecretKeys;
  public userId: Uint8Array;
  public userIdEncoded: string;

  // Private properties matching SessionModule exactly
  // Note: TypeScript doesn't allow assigning classes with private properties of the same name
  // This is a known limitation. The mock will work at runtime but requires type handling.
  private sessionManager: unknown | null = null;
  private onPersist?: () => void;

  // Methods matching SessionModule's public interface exactly
  // Using vi.fn() to allow mocking in tests
  setOnPersist = vi.fn<(callback: () => void) => void>();
  load = vi.fn<(profile: UserProfile, encryptionKey: EncryptionKey) => void>();
  toEncryptedBlob = vi.fn<(key: EncryptionKey) => Uint8Array>(
    () => new Uint8Array(100)
  );
  cleanup = vi.fn<() => void>();
  establishOutgoingSession = vi.fn<
    (peerPk: UserPublicKeys, userData?: Uint8Array) => Uint8Array
  >(() => new Uint8Array(200));
  feedIncomingAnnouncement = vi.fn<
    (announcementBytes: Uint8Array) => AnnouncementResult | undefined
  >(() => undefined);
  getMessageBoardReadKeys = vi.fn<() => Array<Uint8Array>>(() => []);
  feedIncomingMessageBoardRead = vi.fn<
    (
      seeker: Uint8Array,
      ciphertext: Uint8Array
    ) => ReceiveMessageOutput | undefined
  >(() => undefined);
  sendMessage = vi.fn<
    (peerId: Uint8Array, message: Uint8Array) => SendMessageOutput | undefined
  >(() => {
    const seeker = new Uint8Array(32);
    const data = new Uint8Array(100);
    crypto.getRandomValues(seeker);
    crypto.getRandomValues(data);
    return { seeker, data } as SendMessageOutput;
  });
  peerList = vi.fn<() => Array<Uint8Array>>(() => []);
  peerSessionStatus = vi.fn<(peerId: Uint8Array) => SessionStatus>(() => 2); // NoSession
  peerDiscard = vi.fn<(peerId: Uint8Array) => void>();
  refresh = vi.fn<() => Array<Uint8Array>>(() => []);

  // Private method matching SessionModule
  private persistIfNeeded = vi.fn<() => void>();

  constructor(
    publicKeys?: MockUserPublicKeys,
    secretKeys?: MockUserSecretKeys
  ) {
    // Initialize with provided keys or create empty placeholders
    // Cast to satisfy type compatibility
    this.ourPk = (publicKeys ||
      new MockUserPublicKeys()) as MockUserPublicKeys & UserPublicKeys;
    this.ourSk = (secretKeys ||
      new MockUserSecretKeys()) as MockUserSecretKeys & UserSecretKeys;
    this.userId = this.ourPk.user_id;
    this.userIdEncoded = '';
  }
}
