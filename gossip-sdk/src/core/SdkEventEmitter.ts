/**
 * SDK Event Emitter
 *
 * Type-safe event emitter for SDK events.
 */

import type { Message, Discussion, Contact, DM } from '../db';
import type { SessionStatus } from '../wasm/bindings';

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

export enum SdkEventType {
  MESSAGE_RECEIVED = 'messageReceived',
  MESSAGE_SENT = 'messageSent',
  MSG_SEND_QUEUE = 'msgSendQueue',
  MESSAGE_READ = 'messageRead',
  MESSAGE_FAILED = 'messageFailed',
  SESSION_REQUESTED = 'sessionRequested',
  DM_REQUESTED = 'dmRequested',
  DM_ACCEPTED = 'dmAccepted',
  DM_UPDATED = 'dmUpdated',
  SESSION_CREATED = 'sessionCreated',
  SESSION_RENEWED = 'sessionRenewed',
  SESSION_ACCEPTED = 'sessionAccepted',
  ANNOUNCEMENT_RECEIVED = 'announcementReceived',
  SEEKERS_UPDATED = 'seekersUpdated',
  SESSION_STATUS_CHANGED = 'sessionStatusChanged',
  DISCUSSION_UPDATED = 'discussionUpdated',
  ERROR = 'error',
}

export interface SdkEventHandlers {
  [SdkEventType.MESSAGE_RECEIVED]: (message: Message) => void;
  [SdkEventType.MESSAGE_SENT]: (message: Message) => void;
  [SdkEventType.MSG_SEND_QUEUE]: (message: Message) => void;
  [SdkEventType.MESSAGE_READ]: (messageId: number) => void;
  [SdkEventType.MESSAGE_FAILED]: (message: Message, error: Error) => void;
  [SdkEventType.ANNOUNCEMENT_RECEIVED]: (
    contactUserId: string,
    contactName: string,
    message?: string
  ) => void;
  [SdkEventType.SESSION_REQUESTED]: (
    discussion: Discussion,
    contact: Contact
  ) => void;
  [SdkEventType.DM_REQUESTED]: (dm: DM, contact: Contact) => void;
  [SdkEventType.DM_ACCEPTED]: (dm: DM) => void;
  [SdkEventType.DM_UPDATED]: (dm: DM) => void;
  [SdkEventType.SESSION_CREATED]: (discussion: Discussion) => void;
  [SdkEventType.SESSION_RENEWED]: (discussion: Discussion) => void;
  [SdkEventType.SESSION_ACCEPTED]: (contactUserId: string) => void;
  [SdkEventType.SEEKERS_UPDATED]: (seekers: Uint8Array[]) => void;
  [SdkEventType.SESSION_STATUS_CHANGED]: (
    contactUserId: string,
    status: SessionStatus
  ) => void;
  [SdkEventType.DISCUSSION_UPDATED]: (contactUserId: string) => void;
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
    [SdkEventType.MSG_SEND_QUEUE]: new Set<
      SdkEventHandlers[SdkEventType.MSG_SEND_QUEUE]
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
    [SdkEventType.DM_REQUESTED]: new Set<
      SdkEventHandlers[SdkEventType.DM_REQUESTED]
    >(),
    [SdkEventType.DM_ACCEPTED]: new Set<
      SdkEventHandlers[SdkEventType.DM_ACCEPTED]
    >(),
    [SdkEventType.DM_UPDATED]: new Set<
      SdkEventHandlers[SdkEventType.DM_UPDATED]
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
    [SdkEventType.ANNOUNCEMENT_RECEIVED]: new Set<
      SdkEventHandlers[SdkEventType.ANNOUNCEMENT_RECEIVED]
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
