import { describe, it, expect } from 'vitest';
import {
  encodeUserId,
  decodeUserId,
  isValidUserId,
  formatUserId,
} from '../../../src/utils/userId';

describe('utils/userId.ts', () => {
  describe('encodeUserId()', () => {
    it('should encode a valid 32-byte userId', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);

      expect(encoded).toBeTruthy();
      expect(typeof encoded).toBe('string');
      expect(encoded.startsWith('gossip1')).toBe(true);
    });

    it('should throw error for userId shorter than 32 bytes', () => {
      const userId = new Uint8Array(16).fill(1);

      expect(() => encodeUserId(userId)).toThrow(
        'User ID must be exactly 32 bytes, got 16'
      );
    });

    it('should throw error for userId longer than 32 bytes', () => {
      const userId = new Uint8Array(64).fill(1);

      expect(() => encodeUserId(userId)).toThrow(
        'User ID must be exactly 32 bytes, got 64'
      );
    });

    it('should throw error for empty userId', () => {
      const userId = new Uint8Array(0);

      expect(() => encodeUserId(userId)).toThrow(
        'User ID must be exactly 32 bytes, got 0'
      );
    });

    it('should encode different byte patterns uniquely', () => {
      const userId1 = new Uint8Array(32).fill(1);
      const userId2 = new Uint8Array(32).fill(2);
      const userId3 = new Uint8Array(32).fill(255);

      const encoded1 = encodeUserId(userId1);
      const encoded2 = encodeUserId(userId2);
      const encoded3 = encodeUserId(userId3);

      expect(encoded1).not.toBe(encoded2);
      expect(encoded2).not.toBe(encoded3);
      expect(encoded1).not.toBe(encoded3);
    });

    it('should encode all zeros', () => {
      const userId = new Uint8Array(32).fill(0);
      const encoded = encodeUserId(userId);

      expect(encoded).toBeTruthy();
      expect(encoded.startsWith('gossip1')).toBe(true);
    });

    it('should encode all 255s', () => {
      const userId = new Uint8Array(32).fill(255);
      const encoded = encodeUserId(userId);

      expect(encoded).toBeTruthy();
      expect(encoded.startsWith('gossip1')).toBe(true);
    });

    it('should encode mixed byte pattern', () => {
      const userId = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        userId[i] = i * 8;
      }
      const encoded = encodeUserId(userId);

      expect(encoded).toBeTruthy();
      expect(encoded.startsWith('gossip1')).toBe(true);
    });
  });

  describe('decodeUserId()', () => {
    it('should decode a valid encoded userId', () => {
      const original = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(original);
      const decoded = decodeUserId(encoded);

      expect(decoded).toEqual(original);
    });

    it('should throw error for invalid prefix', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);
      const withWrongPrefix = encoded.replace('gossip1', 'bitcoin1');

      // The bech32 library may throw checksum error before prefix validation
      expect(() => decodeUserId(withWrongPrefix)).toThrow();
    });

    it('should throw error for invalid checksum', () => {
      expect(() => decodeUserId('gossip1invalid')).toThrow();
    });

    it('should throw error for malformed string', () => {
      expect(() => decodeUserId('not-a-valid-bech32')).toThrow();
    });

    it('should throw error for empty string', () => {
      expect(() => decodeUserId('')).toThrow();
    });

    it('should round-trip encode/decode correctly', () => {
      const testCases = [
        new Uint8Array(32).fill(0),
        new Uint8Array(32).fill(255),
        new Uint8Array(32).fill(42),
        new Uint8Array(32).map((_, i) => i),
        new Uint8Array(32).map((_, i) => (i * 7) % 256),
      ];

      for (const original of testCases) {
        const encoded = encodeUserId(original);
        const decoded = decodeUserId(encoded);
        expect(decoded).toEqual(original);
      }
    });

    it('should throw error for string without separator', () => {
      expect(() => decodeUserId('gossipnoseparator')).toThrow();
    });

    it('should throw error for incomplete bech32', () => {
      expect(() => decodeUserId('gossip1')).toThrow();
    });
  });

  describe('isValidUserId()', () => {
    it('should return true for valid userId', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);

      expect(isValidUserId(encoded)).toBe(true);
    });

    it('should return false for invalid format', () => {
      expect(isValidUserId('invalid')).toBe(false);
    });

    it('should return false for wrong prefix', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);
      const withWrongPrefix = encoded.replace('gossip1', 'bitcoin1');

      expect(isValidUserId(withWrongPrefix)).toBe(false);
    });

    it('should return false for invalid checksum', () => {
      expect(isValidUserId('gossip1invalid')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidUserId('')).toBe(false);
    });

    it('should return false for malformed bech32', () => {
      expect(isValidUserId('not-bech32')).toBe(false);
    });

    it('should return true for multiple different valid userIds', () => {
      for (let i = 0; i < 10; i++) {
        const userId = new Uint8Array(32).fill(i);
        const encoded = encodeUserId(userId);
        expect(isValidUserId(encoded)).toBe(true);
      }
    });

    it('should return false for incomplete userId', () => {
      expect(isValidUserId('gossip1')).toBe(false);
    });

    it('should return false for null or undefined', () => {
      expect(isValidUserId(null as unknown as string)).toBe(false);
      expect(isValidUserId(undefined as unknown as string)).toBe(false);
    });
  });

  describe('formatUserId()', () => {
    it('should format long userId correctly with defaults', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);
      const formatted = formatUserId(encoded);

      expect(formatted).toContain('gossip1');
      expect(formatted).toContain('...');
    });

    it('should return empty string for empty input', () => {
      const formatted = formatUserId('');
      expect(formatted).toBe('');
    });

    it('should return original if no separator found', () => {
      const formatted = formatUserId('noseparator');
      expect(formatted).toBe('noseparator');
    });

    it('should return original if too short to format', () => {
      const formatted = formatUserId('gossip1short');
      expect(formatted).toBe('gossip1short');
    });

    it('should format with custom prefix chars', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);
      const formatted = formatUserId(encoded, 4, 6);

      expect(formatted).toContain('gossip1');
      expect(formatted).toContain('...');

      // Verify the prefix part after 'gossip1' has 4 chars
      const afterPrefix = formatted.split('gossip1')[1];
      const beforeEllipsis = afterPrefix.split('...')[0];
      expect(beforeEllipsis.length).toBe(4);
    });

    it('should format with custom suffix chars', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);
      const formatted = formatUserId(encoded, 8, 3);

      expect(formatted).toContain('gossip1');
      expect(formatted).toContain('...');

      // Verify the suffix part after '...' has 3 chars
      const afterEllipsis = formatted.split('...')[1];
      expect(afterEllipsis.length).toBe(3);
    });

    it('should handle various lengths', () => {
      const userId = new Uint8Array(32).fill(1);
      const encoded = encodeUserId(userId);

      const formatted1 = formatUserId(encoded, 10, 10);
      const formatted2 = formatUserId(encoded, 5, 5);
      const formatted3 = formatUserId(encoded, 15, 3);

      expect(formatted1).toContain('...');
      expect(formatted2).toContain('...');
      expect(formatted3).toContain('...');
    });

    it('should format different userIds differently', () => {
      const userId1 = new Uint8Array(32).fill(1);
      const userId2 = new Uint8Array(32).fill(2);

      const encoded1 = encodeUserId(userId1);
      const encoded2 = encodeUserId(userId2);

      const formatted1 = formatUserId(encoded1);
      const formatted2 = formatUserId(encoded2);

      expect(formatted1).not.toBe(formatted2);
    });

    it('should keep full string if exactly at boundary', () => {
      const shortId = 'gossip1' + 'a'.repeat(14);
      const formatted = formatUserId(shortId, 8, 6);
      expect(formatted).toBe(shortId);
    });
  });
});
