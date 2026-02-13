/**
 * SDK Event Emitter
 *
 * Type-safe event emitter for SDK events.
 */

import type { Message, Discussion, Contact } from '../db';

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

export enum SdkEventType {
  MESSAGE_RECEIVED = 'messageReceived',
  MESSAGE_SENT = 'messageSent',
  MESSAGE_READ = 'messageRead',
  MESSAGE_FAILED = 'messageFailed',
  SESSION_REQUESTED = 'sessionRequested',
  SESSION_CREATED = 'sessionCreated',
  SESSION_RENEWED = 'sessionRenewed',
  SESSION_ACCEPTED = 'sessionAccepted',
  ERROR = 'error',
}

export interface SdkEventHandlers {
  [SdkEventType.MESSAGE_RECEIVED]: (message: Message) => void;
  [SdkEventType.MESSAGE_SENT]: (message: Message) => void;
  [SdkEventType.MESSAGE_READ]: (messageId: number) => void;
  [SdkEventType.MESSAGE_FAILED]: (message: Message, error: Error) => void;
  [SdkEventType.SESSION_REQUESTED]: (
    discussion: Discussion,
    contact: Contact
  ) => void;
  [SdkEventType.SESSION_CREATED]: (discussion: Discussion) => void;
  [SdkEventType.SESSION_RENEWED]: (discussion: Discussion) => void;
  [SdkEventType.SESSION_ACCEPTED]: (contactUserId: string) => void;
  [SdkEventType.ERROR]: (error: Error, context: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Emitter Class
// ─────────────────────────────────────────────────────────────────────────────

export class SdkEventEmitter {
  private handlers: {
    [K in SdkEventType]: Set<SdkEventHandlers[K]>;
  } = {
    [SdkEventType.MESSAGE_RECEIVED]: new Set<
      SdkEventHandlers[SdkEventType.MESSAGE_RECEIVED]
    >(),
    [SdkEventType.MESSAGE_SENT]: new Set<
      SdkEventHandlers[SdkEventType.MESSAGE_SENT]
    >(),
    [SdkEventType.MESSAGE_READ]: new Set<
      SdkEventHandlers[SdkEventType.MESSAGE_READ]
    >(),
    [SdkEventType.MESSAGE_FAILED]: new Set<
      SdkEventHandlers[SdkEventType.MESSAGE_FAILED]
    >(),
    [SdkEventType.SESSION_REQUESTED]: new Set<
      SdkEventHandlers[SdkEventType.SESSION_REQUESTED]
    >(),
    [SdkEventType.SESSION_CREATED]: new Set<
      SdkEventHandlers[SdkEventType.SESSION_CREATED]
    >(),
    [SdkEventType.SESSION_RENEWED]: new Set<
      SdkEventHandlers[SdkEventType.SESSION_RENEWED]
    >(),
    [SdkEventType.SESSION_ACCEPTED]: new Set<
      SdkEventHandlers[SdkEventType.SESSION_ACCEPTED]
    >(),
    [SdkEventType.ERROR]: new Set<SdkEventHandlers[SdkEventType.ERROR]>(),
  };

  /**
   * Register an event handler
   */
  on<K extends keyof SdkEventHandlers>(
    event: K,
    handler: SdkEventHandlers[K]
  ): void {
    (this.handlers[event as SdkEventType] as Set<SdkEventHandlers[K]>).add(
      handler
    );
  }

  /**
   * Remove an event handler
   */
  off<K extends keyof SdkEventHandlers>(
    event: K,
    handler: SdkEventHandlers[K]
  ): void {
    (this.handlers[event as SdkEventType] as Set<SdkEventHandlers[K]>).delete(
      handler
    );
  }

  /**
   * Emit an event to all registered handlers
   */
  emit<K extends keyof SdkEventHandlers>(
    event: K,
    ...args: Parameters<SdkEventHandlers[K]>
  ): void {
    const handlers = this.handlers[event as SdkEventType] as Set<
      SdkEventHandlers[K]
    >;
    handlers.forEach(handler => {
      try {
        (handler as (...args: Parameters<SdkEventHandlers[K]>) => void)(
          ...args
        );
      } catch (error) {
        console.error(`[SdkEventEmitter] Error in ${event} handler:`, error);
      }
    });
  }

  /**
   * Remove all handlers for all events
   */
  clear(): void {
    Object.values(this.handlers).forEach(set => set.clear());
  }
}
