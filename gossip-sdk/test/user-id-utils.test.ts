/**
 * User ID utility tests
 */

import { describe, it, expect } from 'vitest';
import { bech32 } from '@scure/base';
import {
  encodeUserId,
  decodeUserId,
  isValidUserId,
  formatUserId,
  generate as generateUserId,
} from '../src/utils/userId';

describe('userId utils', () => {
  describe('encodeUserId / decodeUserId', () => {
    it('encodes and decodes a 32-byte userId', () => {
      const bytes = new Uint8Array(32).fill(7);
      const encoded = encodeUserId(bytes);
      const decoded = decodeUserId(encoded);
      expect(decoded).toEqual(bytes);
    });

    it('throws on invalid length', () => {
      expect(() => encodeUserId(new Uint8Array(31))).toThrow(
        'User ID must be exactly 32 bytes'
      );
      expect(() => encodeUserId(new Uint8Array(64))).toThrow(
        'User ID must be exactly 32 bytes'
      );
    });

    it('throws on invalid prefix', () => {
      const bytes = new Uint8Array(32).fill(8);
      const invalid = bech32.encode('wrong', bech32.toWords(bytes));
      expect(() => decodeUserId(invalid)).toThrow('Invalid prefix');
    });
  });

  describe('isValidUserId', () => {
    it('validates userId format', () => {
      const encoded = encodeUserId(new Uint8Array(32).fill(1));
      expect(isValidUserId(encoded)).toBe(true);
      expect(isValidUserId('invalid')).toBe(false);
      expect(isValidUserId('gossip1')).toBe(false);
      expect(isValidUserId('not-a-gossip-id')).toBe(false);
    });
  });

  describe('formatUserId', () => {
    it('formats userId for display', () => {
      const encoded = encodeUserId(new Uint8Array(32).fill(2));
      const formatted = formatUserId(encoded, 4, 4);
      expect(formatted.startsWith('gossip1')).toBe(true);
      expect(formatted.includes('...')).toBe(true);
    });
  });

  describe('generateUserId (requires WASM)', () => {
    it('should generate a valid userId without password', async () => {
      const userId = await generateUserId();

      expect(userId).toBeTruthy();
      expect(typeof userId).toBe('string');
      expect(userId.startsWith('gossip1')).toBe(true);
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate a valid userId with password', async () => {
      const userId = await generateUserId('mypassword123');

      expect(userId).toBeTruthy();
      expect(typeof userId).toBe('string');
      expect(userId.startsWith('gossip1')).toBe(true);
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate same userId when called without password (deterministic)', async () => {
      // When no password is provided, the key derivation is deterministic
      const userId1 = await generateUserId();
      const userId2 = await generateUserId();

      expect(userId1).toBe(userId2);
    });

    it('should generate userId that can be decoded', async () => {
      const userId = await generateUserId();
      const decoded = decodeUserId(userId);

      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(decoded.length).toBe(32);
    });

    it('should generate different userIds with different passwords', async () => {
      const userId1 = await generateUserId('password1');
      const userId2 = await generateUserId('password2');

      expect(userId1).not.toBe(userId2);
    });

    it('should handle empty string password', async () => {
      const userId = await generateUserId('');

      expect(userId).toBeTruthy();
      expect(isValidUserId(userId)).toBe(true);
    });

    it('should generate valid 32-byte decoded ids', async () => {
      for (let i = 0; i < 5; i++) {
        const userId = await generateUserId();
        const decoded = decodeUserId(userId);
        expect(decoded.length).toBe(32);
      }
    });
  });
});
