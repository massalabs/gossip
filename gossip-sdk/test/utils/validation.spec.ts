/**
 * Validation utilities tests
 */

import { describe, it, expect } from 'vitest';
import { encodeUserId } from '../../src/utils/userId';
import {
  validatePassword,
  validateUserIdFormat,
} from '../../src/utils/validation';

describe('validation utilities', () => {
  describe('validatePassword', () => {
    it('should reject empty password', () => {
      const result = validatePassword('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Password is required');
    });

    it('should reject password with only whitespace', () => {
      const result = validatePassword('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Password is required');
    });

    it('should reject password shorter than 8 characters', () => {
      const result = validatePassword('short');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Password must be at least 8 characters long');
    });

    it('should accept password with exactly 8 characters', () => {
      const result = validatePassword('12345678');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid password', () => {
      const result = validatePassword('validPassword123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept password with special characters', () => {
      const result = validatePassword('P@ssw0rd!#$%');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept very long password', () => {
      const result = validatePassword('a'.repeat(100));
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  describe('validateUserIdFormat', () => {
    const invalidUserIdMessage = 'Invalid format — must be a valid user ID';

    it('should reject empty userId', () => {
      const result = validateUserIdFormat('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(invalidUserIdMessage);
    });

    it('should reject userId with invalid format', () => {
      const result = validateUserIdFormat('invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(invalidUserIdMessage);
    });

    it('should reject userId with wrong prefix', () => {
      const result = validateUserIdFormat(
        'bitcoin1qpzry9x8gf2tvdw0s3jn54khce6mua7l'
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe(invalidUserIdMessage);
    });

    it('should reject userId with invalid checksum', () => {
      const result = validateUserIdFormat('gossip1invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(invalidUserIdMessage);
    });

    it('should accept valid userId', () => {
      const validUserId = encodeUserId(new Uint8Array(32).fill(1));
      const result = validateUserIdFormat(validUserId);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should handle userId with whitespace', () => {
      const validUserId = encodeUserId(new Uint8Array(32).fill(1));
      const result = validateUserIdFormat(`  ${validUserId}  `);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept multiple different valid userIds', () => {
      for (let i = 0; i < 5; i++) {
        const userId = encodeUserId(new Uint8Array(32).fill(i));
        const result = validateUserIdFormat(userId);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });
  });
});
