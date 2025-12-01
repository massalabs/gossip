import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
} from '../../../src/utils/validation';
import { db } from '../../../src/db';
import { userProfile } from '../../helpers';
import { Dexie, PromiseExtended } from 'dexie';

describe('utils/validation.ts - Database tests (requires IndexedDB)', () => {
  describe('validateUsernameAvailability()', () => {
    beforeEach(async () => {
      // Ensure DB is open and clear any existing profiles
      if (!db.isOpen()) {
        await db.open();
      }
      await db.userProfile.clear();
    });

    afterEach(async () => {
      // Clean up after tests
      await db.userProfile.clear();
      // Close the database to avoid "connection wants to delete" warnings
      db.close();
    });

    it('should accept username that does not exist', async () => {
      const result = await validateUsernameAvailability('newuser');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject username that already exists', async () => {
      // Create a user profile
      await db.userProfile.add(
        userProfile()
          .username('existinguser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      const result = await validateUsernameAvailability('existinguser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should reject username case-insensitively', async () => {
      // Create a user profile with lowercase username
      await db.userProfile.add(
        userProfile()
          .username('testuser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      // Try with uppercase
      const result = await validateUsernameAvailability('TestUser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should handle username with whitespace', async () => {
      // Create a user profile
      await db.userProfile.add(
        userProfile()
          .username('testuser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      // Try with whitespace
      const result = await validateUsernameAvailability('  testuser  ');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should return error when database connection fails', async () => {
      // Close the database to simulate an error
      if (db.isOpen()) {
        db.close();
      }

      // Mock the db to throw an error
      const originalOpen = db.open.bind(db);
      db.open = vi.fn(async () => {
        throw new Error('Database connection failed');
      }) as unknown as () => PromiseExtended<Dexie>;

      const result = await validateUsernameAvailability('testuser');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Database connection failed');

      // Restore
      db.open = originalOpen;
      await db.open();
    });
  });

  describe('validateUsernameFormatAndAvailability()', () => {
    beforeEach(async () => {
      if (!db.isOpen()) {
        await db.open();
      }
      await db.userProfile.clear();
    });

    afterEach(async () => {
      await db.userProfile.clear();
      db.close();
    });

    it('should reject if format is invalid', async () => {
      const result = await validateUsernameFormatAndAvailability('ab');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username must be at least 3 characters long');
    });

    it('should reject if format is valid but username exists', async () => {
      await db.userProfile.add(
        userProfile()
          .username('existinguser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      const result =
        await validateUsernameFormatAndAvailability('existinguser');
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should accept if format is valid and username is available', async () => {
      const result = await validateUsernameFormatAndAvailability('newuser123');
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
