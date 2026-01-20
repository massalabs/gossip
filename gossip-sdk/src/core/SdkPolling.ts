/**
 * SDK Polling Manager
 *
 * Manages polling timers for messages, announcements, and session refresh.
 */

import type { SdkConfig } from '../config/sdk';
import type { Discussion } from '../db';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PollingCallbacks {
  /** Fetch messages from protocol */
  fetchMessages: () => Promise<void>;
  /** Fetch and process announcements */
  fetchAnnouncements: () => Promise<void>;
  /** Handle session refresh for active discussions */
  handleSessionRefresh: (discussions: Discussion[]) => Promise<void>;
  /** Get active discussions for session refresh */
  getActiveDiscussions: () => Promise<Discussion[]>;
  /** Called when a polling error occurs */
  onError: (error: Error, context: string) => void;
}

interface PollingTimers {
  messages: ReturnType<typeof setInterval> | null;
  announcements: ReturnType<typeof setInterval> | null;
  sessionRefresh: ReturnType<typeof setInterval> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling Manager Class
// ─────────────────────────────────────────────────────────────────────────────

export class SdkPolling {
  private timers: PollingTimers = {
    messages: null,
    announcements: null,
    sessionRefresh: null,
  };

  private callbacks: PollingCallbacks | null = null;

  /**
   * Start polling with the given configuration and callbacks.
   */
  start(config: SdkConfig, callbacks: PollingCallbacks): void {
    // Stop any existing timers first
    this.stop();

    this.callbacks = callbacks;

    console.log('[SdkPolling] Starting polling', {
      messagesIntervalMs: config.polling.messagesIntervalMs,
      announcementsIntervalMs: config.polling.announcementsIntervalMs,
      sessionRefreshIntervalMs: config.polling.sessionRefreshIntervalMs,
    });

    // Start message polling
    this.timers.messages = setInterval(async () => {
      try {
        await this.callbacks?.fetchMessages();
      } catch (error) {
        console.error('[SdkPolling] Message polling error:', error);
        this.callbacks?.onError(
          error instanceof Error ? error : new Error(String(error)),
          'message_polling'
        );
      }
    }, config.polling.messagesIntervalMs);

    // Start announcement polling
    this.timers.announcements = setInterval(async () => {
      try {
        await this.callbacks?.fetchAnnouncements();
      } catch (error) {
        console.error('[SdkPolling] Announcement polling error:', error);
        this.callbacks?.onError(
          error instanceof Error ? error : new Error(String(error)),
          'announcement_polling'
        );
      }
    }, config.polling.announcementsIntervalMs);

    // Start session refresh polling
    this.timers.sessionRefresh = setInterval(async () => {
      try {
        const discussions = await this.callbacks?.getActiveDiscussions();
        if (discussions && discussions.length > 0) {
          await this.callbacks?.handleSessionRefresh(discussions);
        }
      } catch (error) {
        console.error('[SdkPolling] Session refresh polling error:', error);
        this.callbacks?.onError(
          error instanceof Error ? error : new Error(String(error)),
          'session_refresh_polling'
        );
      }
    }, config.polling.sessionRefreshIntervalMs);
  }

  /**
   * Stop all polling timers.
   */
  stop(): void {
    if (this.timers.messages) {
      clearInterval(this.timers.messages);
      this.timers.messages = null;
    }
    if (this.timers.announcements) {
      clearInterval(this.timers.announcements);
      this.timers.announcements = null;
    }
    if (this.timers.sessionRefresh) {
      clearInterval(this.timers.sessionRefresh);
      this.timers.sessionRefresh = null;
    }

    this.callbacks = null;
  }

  /**
   * Check if polling is currently running.
   */
  isRunning(): boolean {
    return (
      this.timers.messages !== null ||
      this.timers.announcements !== null ||
      this.timers.sessionRefresh !== null
    );
  }
}
