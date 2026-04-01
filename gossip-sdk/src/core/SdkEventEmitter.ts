/**
 * SDK Event Emitter
 *
 * Type-safe event emitter for SDK events.
 */

import type { Message, Discussion, Contact } from '../db';
import type { SessionStatus } from '../wasm/bindings';

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
  SEEKERS_UPDATED = 'seekersUpdated',
  SESSION_STATUS_CHANGED = 'sessionStatusChanged',
  DISCUSSION_UPDATED = 'discussionUpdated',
  WRITE_CONFIRMED = 'writeConfirmed',
  WRITE_FAILED = 'writeFailed',
  MESSAGE_OPTIMISTIC = 'messageOptimistic',
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
  [SdkEventType.SEEKERS_UPDATED]: (seekers: Uint8Array[]) => void;
  [SdkEventType.SESSION_STATUS_CHANGED]: (
    contactUserId: string,
    status: SessionStatus
  ) => void;
  [SdkEventType.DISCUSSION_UPDATED]: (contactUserId: string) => void;
  [SdkEventType.WRITE_CONFIRMED]: (
    id: number,
    entityType: 'message' | 'discussion' | 'contact'
  ) => void;
  [SdkEventType.WRITE_FAILED]: (
    messageId: Uint8Array | undefined,
    entityType: 'message' | 'discussion' | 'contact',
    error: Error
  ) => void;
  [SdkEventType.MESSAGE_OPTIMISTIC]: (message: Message) => void;
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
    [SdkEventType.SEEKERS_UPDATED]: new Set<
      SdkEventHandlers[SdkEventType.SEEKERS_UPDATED]
    >(),
    [SdkEventType.SESSION_STATUS_CHANGED]: new Set<
      SdkEventHandlers[SdkEventType.SESSION_STATUS_CHANGED]
    >(),
    [SdkEventType.DISCUSSION_UPDATED]: new Set<
      SdkEventHandlers[SdkEventType.DISCUSSION_UPDATED]
    >(),
    [SdkEventType.WRITE_CONFIRMED]: new Set<
      SdkEventHandlers[SdkEventType.WRITE_CONFIRMED]
    >(),
    [SdkEventType.WRITE_FAILED]: new Set<
      SdkEventHandlers[SdkEventType.WRITE_FAILED]
    >(),
    [SdkEventType.MESSAGE_OPTIMISTIC]: new Set<
      SdkEventHandlers[SdkEventType.MESSAGE_OPTIMISTIC]
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
