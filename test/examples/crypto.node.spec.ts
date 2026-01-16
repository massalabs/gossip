// Runs in NODE mode (no DOM, pure logic testing)
// Example: testing real app crypto utilities (userId encoding/decoding)

import { describe, it, expect } from 'vitest';
import { encodeUserId, decodeUserId, isValidUserId } from 'gossip-sdk';

describe('userId crypto utilities (node environment)', () => {
  it('encodes and decodes a 32-byte userId round-trip', () => {
    const bytes = new Uint8Array(32).map((_, i) => i);

    const encoded = encodeUserId(bytes);
    const decoded = decodeUserId(encoded);

    expect(encoded.startsWith('gossip1')).toBe(true);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });

  it('rejects invalid encoded userIds', () => {
    expect(isValidUserId('not-a-gossip-id')).toBe(false);
    expect(isValidUserId('gossip1')).toBe(false);
  });

  it('throws for wrong-length byte arrays', () => {
    const tooShort = new Uint8Array(16);
    const tooLong = new Uint8Array(64);

    expect(() => encodeUserId(tooShort)).toThrowError(
      /User ID must be exactly 32 bytes/
    );
    expect(() => encodeUserId(tooLong)).toThrowError(
      /User ID must be exactly 32 bytes/
    );
  });
});
