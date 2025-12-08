/**
 * WASM Mock Helpers
 *
 * Provides mock implementations for WASM modules that can be used in vi.mock() calls.
 * These are designed to work with Vitest's hoisting behavior.
 *
 * Note: This file exports the mock class directly. For use in vi.mock() factory functions,
 * you should use vi.hoisted() to import it, or inline the class definition.
 */

/**
 * Mock UserPublicKeys class for testing
 * Simple mock class that only implements what we need for tests
 */
export class MockUserPublicKeysClass {
  kem_public_key = new Uint8Array(32);
  massa_public_key = new Uint8Array(32);
  dsa_verification_key = new Uint8Array(32);

  static from_bytes(bytes: Uint8Array) {
    const instance = new MockUserPublicKeysClass();
    if (bytes.length >= 96) {
      instance.dsa_verification_key = bytes.slice(0, 32);
      instance.kem_public_key = bytes.slice(32, 64);
      instance.massa_public_key = bytes.slice(64, 96);
    }
    return instance;
  }

  to_bytes() {
    const result = new Uint8Array(96);
    result.set(this.dsa_verification_key, 0);
    result.set(this.kem_public_key, 32);
    result.set(this.massa_public_key, 64);
    return result;
  }

  derive_id() {
    // Simple hash simulation - just return first 32 bytes of serialized data
    const serialized = this.to_bytes();
    return serialized.slice(0, 32);
  }

  free() {}
  [Symbol.dispose]() {}
}

/**
 * Factory function that returns the mock class
 * This can be used in vi.mock() factory functions with vi.hoisted()
 *
 * @example
 * const { getMockUserPublicKeys } = await vi.hoisted(async () => {
 *   return await import('./helpers/mock/wasm');
 * });
 * vi.mock('../../src/assets/generated/wasm/gossip_wasm', () => ({
 *   UserPublicKeys: getMockUserPublicKeys(),
 * }));
 */
export function getMockUserPublicKeys() {
  return MockUserPublicKeysClass;
}
