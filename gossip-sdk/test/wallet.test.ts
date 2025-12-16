/**
 * Wallet Operations SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getTokens, getFeeConfig, setFeeConfig } from '../src/wallet';
import { initializeAccount } from '../src/account';

describe('Wallet Operations', () => {
  beforeEach(async () => {
    // Clean up database before each test
    try {
      const { db } = await import('../../src/db');
      await db.delete();
    } catch (_) {
      // Ignore errors
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
  });

  describe('getTokens', () => {
    it('should return list of tokens', () => {
      const tokens = getTokens();
      expect(Array.isArray(tokens)).toBe(true);
    });
  });

  describe('getFeeConfig', () => {
    it('should return fee configuration', () => {
      const config = getFeeConfig();
      expect(config).toBeDefined();
      expect(config).toHaveProperty('type');
    });
  });

  describe('setFeeConfig', () => {
    it('should set fee configuration', () => {
      const newConfig = {
        type: 'preset' as const,
        preset: 'fast' as const,
      };

      setFeeConfig(newConfig);
      const config = getFeeConfig();
      expect(config).toEqual(newConfig);
    });
  });
});
