/**
 * SDK Polling Manager
 *
 * Manages polling timers for messages, announcements, and session refresh.
 */

import type { SdkConfig } from '../config/sdk';
import { SdkEventEmitter, SdkEventType } from './SdkEventEmitter';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PollingCallbacks {
  /** Fetch messages from protocol */
  fetchMessages: () => Promise<void>;
  /** Fetch and process announcements */
  fetchAnnouncements: () => Promise<void>;
  /** Handle session refresh (state update) */
  handleSessionRefresh: () => Promise<void>;
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
  private eventEmitter: SdkEventEmitter | null = null;

  /**
   * Start polling with the given configuration and callbacks.
   */
  start(
    config: SdkConfig,
    callbacks: PollingCallbacks,
    eventEmitter: SdkEventEmitter
  ): void {
    // Stop any existing timers first
    this.stop();

    this.callbacks = callbacks;
    this.eventEmitter = eventEmitter;

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
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, err, 'message_polling');
      }
    }, config.polling.messagesIntervalMs);

    // Start announcement polling
    this.timers.announcements = setInterval(async () => {
      try {
        await this.callbacks?.fetchAnnouncements();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(
          SdkEventType.ERROR,
          err,
          'announcement_polling'
        );
      }
    }, config.polling.announcementsIntervalMs);

    // Start session refresh polling
    this.timers.sessionRefresh = setInterval(async () => {
      try {
        await this.callbacks?.handleSessionRefresh();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, err, 'session_update');
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
    this.eventEmitter = null;
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
