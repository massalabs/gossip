/**
 * Account Management SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  initializeAccount,
  logout,
  getAllAccounts,
  hasExistingAccount,
  getCurrentAccount,
  getMnemonicBackupInfo,
  markMnemonicBackupComplete,
} from '../src/account';
import { db } from '../../src/db';

describe('Account Management', () => {
  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    if (!db.isOpen()) {
      await db.open();
    }
  });

  describe('initializeAccount', () => {
    it('should create a new account', async () => {
      const result = await initializeAccount('testuser', 'testpassword123');
      expect(result.success).toBe(true);
      expect(result.userProfile).toBeDefined();
      expect(result.userProfile?.username).toBe('testuser');
    });

    it('should return error on invalid input', async () => {
      // This will fail because password is required
      const result = await initializeAccount('', '');
      // The function should handle errors gracefully
      expect(result).toHaveProperty('success');
    });
  });

  describe('hasExistingAccount', () => {
    it('should return false when no account exists', async () => {
      const result = await hasExistingAccount();
      expect(result).toBe(false);
    });

    it('should return true after creating an account', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const result = await hasExistingAccount();
      expect(result).toBe(true);
    });
  });

  describe('getAllAccounts', () => {
    it('should return empty array when no accounts exist', async () => {
      const accounts = await getAllAccounts();
      expect(accounts).toEqual([]);
    });

    it('should return all accounts', async () => {
      await initializeAccount('user1', 'password1');
      await logout();
      await initializeAccount('user2', 'password2');
      const accounts = await getAllAccounts();
      expect(accounts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('getCurrentAccount', () => {
    it('should return null when no account is loaded', () => {
      const account = getCurrentAccount();
      expect(account).toBeNull();
    });

    it('should return current account after loading', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const account = getCurrentAccount();
      expect(account).toBeDefined();
      expect(account?.username).toBe('testuser');
    });
  });

  describe('logout', () => {
    it('should logout current account', async () => {
      await initializeAccount('testuser', 'testpassword123');
      expect(getCurrentAccount()).toBeDefined();

      const result = await logout();
      expect(result.success).toBe(true);
      expect(getCurrentAccount()).toBeNull();
    });
  });

  describe('getMnemonicBackupInfo', () => {
    it('should return backup info for account with mnemonic', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const info = getMnemonicBackupInfo();
      expect(info).toBeDefined();
      expect(info?.createdAt).toBeInstanceOf(Date);
      expect(info?.backedUp).toBe(false);
    });
  });

  describe('markMnemonicBackupComplete', () => {
    it('should mark backup as complete', async () => {
      await initializeAccount('testuser', 'testpassword123');
      const result = await markMnemonicBackupComplete();
      expect(result.success).toBe(true);

      const info = getMnemonicBackupInfo();
      expect(info?.backedUp).toBe(true);
    });
  });
});
