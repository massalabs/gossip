/**
 * Validation utilities tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import {
  validatePassword,
  validateUsernameFormat,
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
  validateUserIdFormat,
} from '../../src/utils/validation';

const VALIDATION_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(13));

describe('validation utilities', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

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

  describe('validateUsernameFormat', () => {
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

    it('should reject username shorter than 3 characters after trimming', () => {
      const result = validateUsernameFormat('  ab  ');
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
      const result = validateUsernameFormat('  user  ');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject username with internal spaces', () => {
      const result = validateUsernameFormat('user name');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username cannot contain spaces');
    });
  });

  describe('validateUsernameAvailability', () => {
    it('checks username availability case-insensitively', async () => {
      await db.userProfile.put({
        userId: VALIDATION_OWNER_USER_ID,
        username: 'Alice',
        security: {
          encKeySalt: new Uint8Array(),
          authMethod: 'password',
          mnemonicBackup: {
            encryptedMnemonic: new Uint8Array(),
            createdAt: new Date(),
            backedUp: false,
          },
        },
        session: new Uint8Array(),
        status: 'online',
        lastSeen: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await validateUsernameAvailability('alice', db);
      expect(result.valid).toBe(false);
    });
  });

  describe('validateUsernameFormatAndAvailability', () => {
    it('validates username format and availability', async () => {
      const invalid = await validateUsernameFormatAndAvailability('ab', db);
      expect(invalid.valid).toBe(false);

      const valid = await validateUsernameFormatAndAvailability(
        'validname',
        db
      );
      expect(valid.valid).toBe(true);
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
