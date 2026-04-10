/**
 * SDK Event Emitter
 *
 * Type-safe event emitter backed by mitt. The SdkEvents type map is the
 * single source of truth for all event names and their payload shapes.
 */

import mitt from 'mitt';
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
  WRITE_FAILED = 'writeFailed',
  MESSAGE_OPTIMISTIC = 'messageOptimistic',
  ERROR = 'error',

  // Semantic optimistic events
  MESSAGE_DELETED_OPTIMISTIC = 'messageDeletedOptimistic',
  MESSAGE_EDITED_OPTIMISTIC = 'messageEditedOptimistic',
  MESSAGE_DELETE_FAILED = 'messageDeleteFailed',
  MESSAGE_EDIT_FAILED = 'messageEditFailed',
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Payload Map
// ─────────────────────────────────────────────────────────────────────────────

export type SdkEvents = {
  [SdkEventType.MESSAGE_RECEIVED]: Omit<Message, 'id'> & { id?: number };
  [SdkEventType.MESSAGE_SENT]: Message;
  [SdkEventType.MESSAGE_READ]: number;
  [SdkEventType.MESSAGE_FAILED]: { message: Message; error: Error };
  [SdkEventType.SESSION_REQUESTED]: {
    discussion: Discussion;
    contact: Contact;
  };
  [SdkEventType.SESSION_CREATED]: Discussion;
  [SdkEventType.SESSION_RENEWED]: Discussion;
  [SdkEventType.SESSION_ACCEPTED]: string;
  [SdkEventType.SEEKERS_UPDATED]: Uint8Array[];
  [SdkEventType.SESSION_STATUS_CHANGED]: {
    contactUserId: string;
    status: SessionStatus;
  };
  [SdkEventType.DISCUSSION_UPDATED]: string;
  [SdkEventType.WRITE_FAILED]: {
    messageId: Uint8Array | undefined;
    entityType: 'message' | 'discussion' | 'contact';
    error: Error;
  };
  [SdkEventType.MESSAGE_OPTIMISTIC]: Message;
  [SdkEventType.ERROR]: { error: Error; context: string };

  // Semantic optimistic events
  [SdkEventType.MESSAGE_DELETED_OPTIMISTIC]: {
    contactUserId: string;
    messageDbId: number;
    originalMsgId: Uint8Array;
  };
  [SdkEventType.MESSAGE_EDITED_OPTIMISTIC]: {
    contactUserId: string;
    messageDbId: number;
    newContent: string;
    metadata: Record<string, unknown>;
  };
  [SdkEventType.MESSAGE_DELETE_FAILED]: {
    contactUserId: string;
    messageDbId: number;
    original: Message;
  };
  [SdkEventType.MESSAGE_EDIT_FAILED]: {
    contactUserId: string;
    messageDbId: number;
    original: Message;
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Backward-compat: re-export SdkEventHandlers derived from SdkEvents
// ─────────────────────────────────────────────────────────────────────────────

export type SdkEventHandlers = {
  [K in keyof SdkEvents]: (payload: SdkEvents[K]) => void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Event Emitter Class (mitt-backed)
// ─────────────────────────────────────────────────────────────────────────────

export class SdkEventEmitter {
  private bus = mitt<SdkEvents>();

  on<K extends keyof SdkEvents>(
    event: K,
    handler: (payload: SdkEvents[K]) => void
  ): void {
    this.bus.on(event, handler);
  }

  off<K extends keyof SdkEvents>(
    event: K,
    handler: (payload: SdkEvents[K]) => void
  ): void {
    this.bus.off(event, handler);
  }

  emit<K extends keyof SdkEvents>(event: K, payload: SdkEvents[K]): void {
    const handlers = this.bus.all.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          (handler as (p: SdkEvents[K]) => void)(payload);
        } catch (error) {
          console.error(
            `[SdkEventEmitter] Error in ${String(event)} handler:`,
            error
          );
        }
      }
    }
  }

  clear(): void {
    this.bus.all.clear();
  }
}
