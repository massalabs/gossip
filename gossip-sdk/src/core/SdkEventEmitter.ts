/**
 * SDK Event Emitter
 *
 * Type-safe event emitter for SDK events.
 */

import type { Message, Discussion, Contact } from '../db.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event Types
// ─────────────────────────────────────────────────────────────────────────────

export type SdkEventType =
  | 'message'
  | 'messageSent'
  | 'messageFailed'
  | 'discussionRequest'
  | 'discussionStatusChanged'
  | 'sessionBroken'
  | 'sessionRenewed'
  | 'error';

export interface SdkEventHandlers {
  message: (message: Message) => void;
  messageSent: (message: Message) => void;
  messageFailed: (message: Message, error: Error) => void;
  discussionRequest: (discussion: Discussion, contact: Contact) => void;
  discussionStatusChanged: (discussion: Discussion) => void;
  sessionBroken: (discussion: Discussion) => void;
  sessionRenewed: (discussion: Discussion) => void;
  error: (error: Error, context: string) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Emitter Class
// ─────────────────────────────────────────────────────────────────────────────

export class SdkEventEmitter {
  private handlers = {
    message: new Set<SdkEventHandlers['message']>(),
    messageSent: new Set<SdkEventHandlers['messageSent']>(),
    messageFailed: new Set<SdkEventHandlers['messageFailed']>(),
    discussionRequest: new Set<SdkEventHandlers['discussionRequest']>(),
    discussionStatusChanged: new Set<
      SdkEventHandlers['discussionStatusChanged']
    >(),
    sessionBroken: new Set<SdkEventHandlers['sessionBroken']>(),
    sessionRenewed: new Set<SdkEventHandlers['sessionRenewed']>(),
    error: new Set<SdkEventHandlers['error']>(),
  };

  /**
   * Register an event handler
   */
  on<K extends SdkEventType>(event: K, handler: SdkEventHandlers[K]): void {
    (this.handlers[event] as Set<SdkEventHandlers[K]>).add(handler);
  }

  /**
   * Remove an event handler
   */
  off<K extends SdkEventType>(event: K, handler: SdkEventHandlers[K]): void {
    (this.handlers[event] as Set<SdkEventHandlers[K]>).delete(handler);
  }

  /**
   * Emit an event to all registered handlers
   */
  emit<K extends SdkEventType>(
    event: K,
    ...args: Parameters<SdkEventHandlers[K]>
  ): void {
    const handlers = this.handlers[event] as Set<SdkEventHandlers[K]>;
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
