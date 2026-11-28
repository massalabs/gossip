import { logger } from '../utils/logs.js';
import { dlog } from '../utils/debugLog.js';
import { errFields, since } from '../utils/debugFields.js';
/**
 * SDK Polling Manager
 *
 * Manages polling timers for messages, announcements, and session refresh.
 */

import type { SdkConfig } from '../config/sdk.js';
import { SdkEventEmitter, SdkEventType } from './SdkEventEmitter.js';

const SESSION_STATUS_POLL_INTERVAL_MS = 3000;

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
  /** Check for session status changes and emit events */
  refreshSessionsStatusEvent: () => Promise<void>;
}

interface PollingTimers {
  messages: ReturnType<typeof setInterval> | null;
  announcements: ReturnType<typeof setInterval> | null;
  sessionRefresh: ReturnType<typeof setInterval> | null;
  sessionStatus: ReturnType<typeof setInterval> | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Polling Manager Class
// ─────────────────────────────────────────────────────────────────────────────

export class SdkPolling {
  private timers: PollingTimers = {
    messages: null,
    announcements: null,
    sessionRefresh: null,
    sessionStatus: null,
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

    dlog(
      'sdk',
      'sync.start',
      {
        messagesIntervalMs: config.polling.messagesIntervalMs,
        announcementsIntervalMs: config.polling.announcementsIntervalMs,
        sessionRefreshIntervalMs: config.polling.sessionRefreshIntervalMs,
      },
      { lvl: 'info' }
    );
    logger.info('[SdkPolling] Starting polling', {
      messagesIntervalMs: config.polling.messagesIntervalMs,
      announcementsIntervalMs: config.polling.announcementsIntervalMs,
      sessionRefreshIntervalMs: config.polling.sessionRefreshIntervalMs,
    });

    // Start message polling
    this.timers.messages = setInterval(async () => {
      const started = performance.now();
      try {
        await this.callbacks?.fetchMessages();
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'messages' },
          { dur: since(started) }
        );
      } catch (error) {
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'messages', ...errFields(error) },
          { lvl: 'error', dur: since(started) }
        );
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, {
          error: err,
          context: 'message_polling',
        });
      }
    }, config.polling.messagesIntervalMs);

    // Start announcement polling
    this.timers.announcements = setInterval(async () => {
      const started = performance.now();
      try {
        await this.callbacks?.fetchAnnouncements();
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'announcements' },
          { dur: since(started) }
        );
      } catch (error) {
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'announcements', ...errFields(error) },
          { lvl: 'error', dur: since(started) }
        );
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, {
          error: err,
          context: 'announcement_polling',
        });
      }
    }, config.polling.announcementsIntervalMs);

    // Start session refresh polling
    this.timers.sessionRefresh = setInterval(async () => {
      const started = performance.now();
      try {
        await this.callbacks?.handleSessionRefresh();
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'sessionRefresh' },
          { dur: since(started) }
        );
      } catch (error) {
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'sessionRefresh', ...errFields(error) },
          { lvl: 'error', dur: since(started) }
        );
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, {
          error: err,
          context: 'session_update',
        });
      }
    }, config.polling.sessionRefreshIntervalMs);

    // Start session status change polling (fixed 3s interval)
    this.timers.sessionStatus = setInterval(async () => {
      const started = performance.now();
      try {
        await this.callbacks?.refreshSessionsStatusEvent();
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'sessionStatus' },
          { dur: since(started) }
        );
      } catch (error) {
        dlog(
          'sdk',
          'sync.cycle',
          { loop: 'sessionStatus', ...errFields(error) },
          { lvl: 'error', dur: since(started) }
        );
        const err = error instanceof Error ? error : new Error(String(error));
        this.eventEmitter?.emit(SdkEventType.ERROR, {
          error: err,
          context: 'session_status_polling',
        });
      }
    }, SESSION_STATUS_POLL_INTERVAL_MS);
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
    if (this.timers.sessionStatus) {
      clearInterval(this.timers.sessionStatus);
      this.timers.sessionStatus = null;
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
      this.timers.sessionRefresh !== null ||
      this.timers.sessionStatus !== null
    );
  }
}
