/**
 * Wallet Operations SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getTokens,
  getFeeConfig,
  setFeeConfig,
  isWalletLoading,
  isWalletInitialized,
  getWalletError,
} from '../src/wallet';
import { initializeAccount } from '../src/account';
import { db } from '../src/db';

describe('Wallet Operations', () => {
  beforeEach(async () => {
    // Database is cleaned up by setup.ts afterEach hook
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

    it('should include MAS token', () => {
      const tokens = getTokens();
      const masToken = tokens.find(t => t.ticker === 'MAS');
      expect(masToken).toBeDefined();
      expect(masToken?.isNative).toBe(true);
    });
  });

  describe('getFeeConfig', () => {
    it('should return fee configuration', () => {
      const config = getFeeConfig();
      expect(config).toBeDefined();
      expect(config).toHaveProperty('type');
    });

    it('should return default preset configuration', () => {
      const config = getFeeConfig();
      expect(config.type).toBe('preset');
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

    it('should allow changing to standard preset', () => {
      const standardConfig = {
        type: 'preset' as const,
        preset: 'standard' as const,
      };

      setFeeConfig(standardConfig);
      const config = getFeeConfig();
      expect(config.preset).toBe('standard');
    });
  });

  describe('isWalletLoading', () => {
    it('should return boolean', () => {
      const loading = isWalletLoading();
      expect(typeof loading).toBe('boolean');
    });
  });

  describe('isWalletInitialized', () => {
    it('should return boolean', () => {
      const initialized = isWalletInitialized();
      expect(typeof initialized).toBe('boolean');
    });
  });

  describe('getWalletError', () => {
    it('should return null when no error', () => {
      const error = getWalletError();
      expect(error).toBeNull();
    });
  });
});
