/**
 * Authentication SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fetchPublicKeyByUserId, ensurePublicKeyPublished } from '../src/auth';
import { initializeAccount } from '../src/account';
import { getSession, getSessionKeys } from '../src/utils';
import { db } from '@/db';

describe('Authentication', () => {
  beforeEach(async () => {
    // Database is cleaned up by setup.ts afterEach hook
    if (!db.isOpen()) {
      await db.open();
    }
  });

  describe('fetchPublicKeyByUserId', () => {
    it('should return error for non-existent user', async () => {
      const result = await fetchPublicKeyByUserId('gossip1nonexistent');
      expect(result.error).toBeDefined();
    });

    it('should handle invalid userId format gracefully', async () => {
      const result = await fetchPublicKeyByUserId('invalid-userid');
      expect(result.error).toBeDefined();
    });
  });

  describe('ensurePublicKeyPublished', () => {
    it('should publish public key for current user', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const session = getSession();
      const { ourPk } = getSessionKeys();

      if (ourPk && session) {
        // Should not throw
        await expect(
          ensurePublicKeyPublished(ourPk, session.userIdEncoded)
        ).resolves.not.toThrow();
      }
    });
  });
});
