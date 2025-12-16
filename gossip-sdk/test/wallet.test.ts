/**
 * Wallet Operations SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getTokens, getFeeConfig, setFeeConfig } from '../src/wallet';
import { initializeAccount } from '../src/account';

describe('Wallet Operations', () => {
  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    const { db } = await import('../../src/db');
    if (!db.isOpen()) {
      await db.open();
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
