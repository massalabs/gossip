/**
 * SDK Event Emitter — type-safe event bus backed by mitt.
 */

import mitt from 'mitt';
import type { Message, Discussion, Contact } from '../db';
import type { SessionStatus } from '../wasm/bindings';

export enum SdkEventType {
  MESSAGE_RECEIVED = 'messageReceived',
  MESSAGE_SENT = 'messageSent',
  MESSAGE_READ = 'messageRead',
  MESSAGE_FAILED = 'messageFailed',
  MESSAGE_DELETED = 'messageDeleted',
  MESSAGE_UPDATED = 'messageUpdated',
  SESSION_REQUESTED = 'sessionRequested',
  SESSION_CREATED = 'sessionCreated',
  SESSION_RENEWED = 'sessionRenewed',
  SESSION_ACCEPTED = 'sessionAccepted',
  SEEKERS_UPDATED = 'seekersUpdated',
  SESSION_STATUS_CHANGED = 'sessionStatusChanged',
  DISCUSSION_UPDATED = 'discussionUpdated',
  MESSAGE_ACKNOWLEDGED = 'messageAcknowledged',
  ERROR = 'error',
}

export type SdkEvents = {
  [SdkEventType.MESSAGE_RECEIVED]: Omit<Message, 'id'> & { id?: number };
  [SdkEventType.MESSAGE_SENT]: Message;
  [SdkEventType.MESSAGE_READ]: number;
  [SdkEventType.MESSAGE_FAILED]: { message: Message; error: Error };
  [SdkEventType.MESSAGE_DELETED]: { messages: Message[] };
  [SdkEventType.MESSAGE_UPDATED]: { messages: Message[] };
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
  [SdkEventType.DISCUSSION_UPDATED]: number;
  [SdkEventType.MESSAGE_ACKNOWLEDGED]: {
    contactUserId: string;
    messageDbId: number;
  };
  [SdkEventType.ERROR]: { error: Error; context: string };
};

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
