import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  validateUsernameFormat,
  validateUserIdFormat,
} from '../../../src/utils/validation';
import { encodeUserId } from '../../../src/utils/userId';

describe('utils/validation.ts', () => {
  describe('validatePassword()', () => {
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

  describe('validateUsernameFormat()', () => {
    it('should reject empty username', () => {
      const result = validateUsernameFormat('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username is required');
    });

    it('should reject username with only whitespace', () => {
      const result = validateUsernameFormat('   ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username is required');
    });

    it('should reject username shorter than 3 characters', () => {
      const result = validateUsernameFormat('ab');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username must be at least 3 characters long');
    });


    it('should accept username with exactly 3 characters', () => {
      const result = validateUsernameFormat('abc');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept valid username', () => {
      const result = validateUsernameFormat('validUser');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept username with numbers', () => {
      const result = validateUsernameFormat('user123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should accept username with special characters', () => {
      const result = validateUsernameFormat('user_name-123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should handle username with leading/trailing whitespace', () => {
      // The function checks trim().length, so whitespace is handled
      const result = validateUsernameFormat('  user  ');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });

  // Note: validateUsernameAvailability and validateUsernameFormatAndAvailability
  // tests are in validation-db.jsdom.spec.ts because they require IndexedDB

  describe('validateUserIdFormat()', () => {
    it('should reject empty userId', () => {
      const result = validateUserIdFormat('');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid format — must be a complete gossip1... address'
      );
    });

    it('should reject userId with invalid format', () => {
      const result = validateUserIdFormat('invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid format — must be a complete gossip1... address'
      );
    });

    it('should reject userId with wrong prefix', () => {
      const result = validateUserIdFormat(
        'bitcoin1qpzry9x8gf2tvdw0s3jn54khce6mua7l'
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid format — must be a complete gossip1... address'
      );
    });

    it('should reject userId with invalid checksum', () => {
      const result = validateUserIdFormat('gossip1invalid');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'Invalid format — must be a complete gossip1... address'
      );
    });

    it('should accept valid userId', () => {
      // Generate a valid userId for testing
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
      // Test with different byte patterns
      for (let i = 0; i < 5; i++) {
        const userId = encodeUserId(new Uint8Array(32).fill(i));
        const result = validateUserIdFormat(userId);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }
    });
  });
});
