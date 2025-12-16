/**
 * Authentication SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fetchPublicKeyByUserId, ensurePublicKeyPublished } from '../src/auth';
import { initializeAccount } from '../src/account';
import { getAccount } from '../src/utils';

describe('Authentication', () => {
  beforeEach(async () => {
    // Clean up database before each test
    try {
      const { db } = await import('../../src/db');
      await db.delete();
    } catch (_) {
      // Ignore errors
    }
  });

  describe('fetchPublicKeyByUserId', () => {
    it('should return error for non-existent user', async () => {
      const result = await fetchPublicKeyByUserId('gossip1nonexistent');
      expect(result.error).toBeDefined();
    });
  });

  describe('ensurePublicKeyPublished', () => {
    it('should publish public key for current user', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const account = getAccount();

      if (account.ourPk && account.userProfile) {
        await expect(
          ensurePublicKeyPublished(account.ourPk, account.userProfile.userId)
        ).resolves.not.toThrow();
      }
    });
  });
});
