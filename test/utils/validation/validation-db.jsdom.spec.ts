import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateUsernameAvailability,
  validateUsernameFormatAndAvailability,
  setDb,
  db,
} from 'gossip-sdk';
import { db as appDb } from '../../../src/db';
import { userProfile } from '../../helpers';
import { Dexie, PromiseExtended } from 'dexie';

describe('utils/validation.ts - Database tests (requires IndexedDB)', () => {
  // Configure SDK to use the app's db instance
  beforeEach(() => {
    setDb(appDb as unknown as Parameters<typeof setDb>[0]);
  });

  describe('validateUsernameAvailability()', () => {
    beforeEach(async () => {
      // Ensure DB is open and clear any existing profiles
      if (!appDb.isOpen()) {
        await appDb.open();
      }
      await appDb.userProfile.clear();
    });

    afterEach(async () => {
      // Clean up after tests
      if (appDb.isOpen()) {
        await appDb.userProfile.clear();
      }
    });

    it('should accept username that does not exist', async () => {
      const result = await validateUsernameAvailability('newuser', db);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject username that already exists', async () => {
      // Create a user profile
      await appDb.userProfile.add(
        userProfile()
          .username('existinguser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      const result = await validateUsernameAvailability('existinguser', db);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should reject username case-insensitively', async () => {
      // Create a user profile with lowercase username
      await appDb.userProfile.add(
        userProfile()
          .username('testuser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      // Try with uppercase
      const result = await validateUsernameAvailability('TestUser', db);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should handle username with whitespace', async () => {
      // Create a user profile
      await appDb.userProfile.add(
        userProfile()
          .username('testuser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      // Try with whitespace
      const result = await validateUsernameAvailability('  testuser  ', db);
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should return error when database connection fails', async () => {
      // Close the database to simulate an error
      if (appDb.isOpen()) {
        appDb.close();
      }

      // Mock the db to throw an error
      const originalOpen = appDb.open.bind(appDb);
      appDb.open = vi.fn(async () => {
        throw new Error('Database connection failed');
      }) as unknown as () => PromiseExtended<Dexie>;

      const result = await validateUsernameAvailability('testuser', db);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Database connection failed');

      // Restore
      appDb.open = originalOpen;
      await appDb.open();
    });
  });

  describe('validateUsernameFormatAndAvailability()', () => {
    beforeEach(async () => {
      if (!appDb.isOpen()) {
        await appDb.open();
      }
      await appDb.userProfile.clear();
    });

    afterEach(async () => {
      if (appDb.isOpen()) {
        await appDb.userProfile.clear();
      }
    });

    it('should reject if format is invalid', async () => {
      const result = await validateUsernameFormatAndAvailability('ab', db);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Username must be at least 3 characters long');
    });

    it('should reject if format is valid but username exists', async () => {
      await appDb.userProfile.add(
        userProfile()
          .username('existinguser')
          .userId('gossip1qpzry9x8gf2tvdw0s3jn54khce6mua7l')
          .build()
      );

      const result = await validateUsernameFormatAndAvailability(
        'existinguser',
        db
      );
      expect(result.valid).toBe(false);
      expect(result.error).toBe(
        'This username is already in use. Please choose another.'
      );
    });

    it('should accept if format is valid and username is available', async () => {
      const result = await validateUsernameFormatAndAvailability(
        'newuser123',
        db
      );
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
