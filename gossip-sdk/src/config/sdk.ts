/**
 * SDK Configuration
 *
 * Centralized configuration for the Gossip SDK.
 * All values have sensible defaults that can be overridden.
 */

/**
 * Protocol configuration for network requests
 */
export interface ProtocolConfig {
  /** API base URL (default: from environment or https://api.usegossip.com) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout: number;
  /** Number of retry attempts for failed requests (default: 3) */
  retryAttempts: number;
}

/**
 * Polling configuration for automatic message/announcement fetching
 */
export interface PollingConfig {
  /** Enable automatic polling (default: false) */
  enabled: boolean;
  /** Interval for fetching messages in milliseconds (default: 5000) */
  messagesIntervalMs: number;
  /** Interval for fetching announcements in milliseconds (default: 10000) */
  announcementsIntervalMs: number;
  /** Interval for session refresh/keep-alive in milliseconds (default: 30000) */
  sessionRefreshIntervalMs: number;
}

/**
 * Message fetching configuration
 */
export interface MessagesConfig {
  /** Delay between fetch iterations in milliseconds (default: 100) */
  fetchDelayMs: number;
  /** Maximum number of fetch iterations per call (default: 30) */
  maxFetchIterations: number;
  /**
   * Time window in milliseconds for duplicate detection (default: 30000 = 30 seconds).
   * Messages with same content from same sender within this window are considered duplicates.
   * This handles edge case where app crashes after network send but before DB update,
   * resulting in message being re-sent on restart.
   */
  deduplicationWindowMs: number;
  /** Delay before retrying a failed message send in ms (default: 5000 = 5 seconds) */
  retryDelayMs: number;
}

/**
 * Announcement configuration
 */
export interface AnnouncementsConfig {
  /** Maximum announcements to fetch per request (default: 500) */
  fetchLimit: number;
  /** Time before marking failed announcements as broken in ms (default: 3600000 = 1 hour) */
  brokenThresholdMs: number;
  /** Delay before retrying a failed announcement send in ms (default: 15000 = 15 seconds) */
  retryDelayMs: number;
}

/**
 * Session recovery configuration
 */
export interface SessionRecoveryConfig {
  /** Delay before retrying a killed session reset (default: 15 minutes) */
  killedRetryDelayMs: number;
  /** Jitter applied (default: 2 minutes) */
  JitterMs: number;
  /** Delay before retrying a saturated session reset (default: 5 minutes) */
  saturatedRetryDelayMs: number;
  /** Jitter applied to saturated session retry delay (default: 2 minutes) */
}

/**
 * Complete SDK configuration
 */
export interface SdkConfig {
  /** Network/protocol settings */
  protocol: ProtocolConfig;
  /** Automatic polling settings */
  polling: PollingConfig;
  /** Message fetching settings */
  messages: MessagesConfig;
  /** Announcement settings */
  announcements: AnnouncementsConfig;
  /** Session recovery settings */
  sessionRecovery: SessionRecoveryConfig;
}

/**
 * Default SDK configuration values
 */
export const defaultSdkConfig: SdkConfig = {
  protocol: {
    timeout: 10000,
    retryAttempts: 3,
  },
  polling: {
    enabled: false,
    messagesIntervalMs: 5000,
    announcementsIntervalMs: 10000,
    sessionRefreshIntervalMs: 10000, //30000,
  },
  messages: {
    fetchDelayMs: 100,
    maxFetchIterations: 30,
    deduplicationWindowMs: 30000, // 30 seconds
    retryDelayMs: 5000, // 5 seconds
  },
  announcements: {
    fetchLimit: 500,
    brokenThresholdMs: 60 * 60 * 1000, // 1 hour
    retryDelayMs: 15000, // 15 seconds
  },
  sessionRecovery: {
    killedRetryDelayMs: 15 * 60 * 1000,
    JitterMs: 2 * 60 * 1000,
    saturatedRetryDelayMs: 5 * 60 * 1000,
  },
};

/**
 * Deep merge partial config with defaults
 */
export function mergeConfig(partial?: DeepPartial<SdkConfig>): SdkConfig {
  if (!partial) return { ...defaultSdkConfig };

  return {
    protocol: {
      ...defaultSdkConfig.protocol,
      ...partial.protocol,
    },
    polling: {
      ...defaultSdkConfig.polling,
      ...partial.polling,
    },
    messages: {
      ...defaultSdkConfig.messages,
      ...partial.messages,
    },
    announcements: {
      ...defaultSdkConfig.announcements,
      ...partial.announcements,
    },
    sessionRecovery: {
      ...defaultSdkConfig.sessionRecovery,
      ...partial.sessionRecovery,
    },
  };
}

/**
 * Helper type for deep partial objects
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
