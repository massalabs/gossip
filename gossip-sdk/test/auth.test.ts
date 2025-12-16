/**
 * Authentication SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fetchPublicKeyByUserId, ensurePublicKeyPublished } from '../src/auth';
import { initializeAccount } from '../src/account';
import { getAccount } from '../src/utils';

describe('Authentication', () => {
  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    const { db } = await import('../../src/db');
    if (!db.isOpen()) {
      await db.open();
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
