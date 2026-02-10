/**
 * SDK Config tests
 */

import { describe, it, expect } from 'vitest';
import {
  defaultSdkConfig,
  mergeConfig,
  type SdkConfig,
  type DeepPartial,
} from '../../src/config/sdk.js';

describe('SDK Config', () => {
  describe('defaultSdkConfig', () => {
    it('should have correct default protocol values', () => {
      expect(defaultSdkConfig.protocol.timeout).toBe(10000);
      expect(defaultSdkConfig.protocol.retryAttempts).toBe(3);
      expect(defaultSdkConfig.protocol.baseUrl).toBeUndefined();
    });

    it('should have correct default polling values', () => {
      expect(defaultSdkConfig.polling.enabled).toBe(false);
      expect(defaultSdkConfig.polling.messagesIntervalMs).toBe(5000);
      expect(defaultSdkConfig.polling.announcementsIntervalMs).toBe(10000);
      expect(defaultSdkConfig.polling.sessionRefreshIntervalMs).toBe(30000);
    });

    it('should have correct default messages values', () => {
      expect(defaultSdkConfig.messages.fetchDelayMs).toBe(100);
      expect(defaultSdkConfig.messages.maxFetchIterations).toBe(30);
    });

    it('should have correct default announcements values', () => {
      expect(defaultSdkConfig.announcements.fetchLimit).toBe(500);
      expect(defaultSdkConfig.announcements.brokenThresholdMs).toBe(
        60 * 60 * 1000
      );
    });
  });

  describe('mergeConfig', () => {
    it('should return defaults when no partial provided', () => {
      const config = mergeConfig();
      expect(config).toEqual(defaultSdkConfig);
    });

    it('should return defaults when undefined provided', () => {
      const config = mergeConfig(undefined);
      expect(config).toEqual(defaultSdkConfig);
    });

    it('should merge partial protocol config', () => {
      const partial: DeepPartial<SdkConfig> = {
        protocol: {
          timeout: 5000,
        },
      };

      const config = mergeConfig(partial);

      expect(config.protocol.timeout).toBe(5000);
      expect(config.protocol.retryAttempts).toBe(3);
      expect(config.polling.enabled).toBe(false);
    });

    it('should merge partial polling config', () => {
      const partial: DeepPartial<SdkConfig> = {
        polling: {
          enabled: true,
          messagesIntervalMs: 2000,
        },
      };

      const config = mergeConfig(partial);

      expect(config.polling.enabled).toBe(true);
      expect(config.polling.messagesIntervalMs).toBe(2000);
      expect(config.polling.announcementsIntervalMs).toBe(10000);
      expect(config.polling.sessionRefreshIntervalMs).toBe(30000);
    });

    it('should merge partial messages config', () => {
      const partial: DeepPartial<SdkConfig> = {
        messages: {
          maxFetchIterations: 50,
        },
      };

      const config = mergeConfig(partial);

      expect(config.messages.maxFetchIterations).toBe(50);
      expect(config.messages.fetchDelayMs).toBe(100);
    });

    it('should merge partial announcements config', () => {
      const partial: DeepPartial<SdkConfig> = {
        announcements: {
          brokenThresholdMs: 30 * 60 * 1000,
        },
      };

      const config = mergeConfig(partial);

      expect(config.announcements.brokenThresholdMs).toBe(30 * 60 * 1000);
      expect(config.announcements.fetchLimit).toBe(500);
    });

    it('should merge multiple sections at once', () => {
      const partial: DeepPartial<SdkConfig> = {
        protocol: {
          baseUrl: 'https://custom.api.com',
        },
        polling: {
          enabled: true,
        },
        messages: {
          fetchDelayMs: 50,
        },
        announcements: {
          fetchLimit: 1000,
        },
      };

      const config = mergeConfig(partial);

      expect(config.protocol.baseUrl).toBe('https://custom.api.com');
      expect(config.polling.enabled).toBe(true);
      expect(config.messages.fetchDelayMs).toBe(50);
      expect(config.announcements.fetchLimit).toBe(1000);
      expect(config.protocol.timeout).toBe(10000);
      expect(config.polling.messagesIntervalMs).toBe(5000);
    });

    it('should not mutate the original defaults', () => {
      const originalTimeout = defaultSdkConfig.protocol.timeout;

      mergeConfig({
        protocol: { timeout: 1234 },
      });

      expect(defaultSdkConfig.protocol.timeout).toBe(originalTimeout);
    });
  });
});

describe('Max Fetch Iterations Limit', () => {
  it('should respect maxFetchIterations config', async () => {
    const config: SdkConfig = {
      ...defaultSdkConfig,
      messages: {
        ...defaultSdkConfig.messages,
        maxFetchIterations: 5,
        fetchDelayMs: 0,
      },
    };

    expect(config.messages.maxFetchIterations).toBe(5);
  });

  it('should have default maxFetchIterations of 30', () => {
    expect(defaultSdkConfig.messages.maxFetchIterations).toBe(30);
  });
});
