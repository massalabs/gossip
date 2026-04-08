import { SessionStatus, UserPublicKeys } from '../../wasm/bindings.js';
import { SessionModule } from '../../wasm/session.js';
import { Logger } from '../../utils/logs.js';
import { Result } from '../../utils/type.js';
import { EstablishSessionError } from '../announcement.js';
import { Queries } from '../../db/queries/index.js';
import { SdkEventType } from '../../core/SdkEventEmitter.js';
import type { Message } from '../../db/index.js';
import type { SendMessageResult } from './sessionMessage.js';
import { SessionAnnouncementService } from './sessionAnnouncement.js';
import { SessionMessageService } from './sessionMessage.js';
import { SdkEventEmitter } from '../../core/SdkEventEmitter.js';
import type { IMessageProtocol } from '../../api/messageProtocol/index.js';
import type { SdkConfig } from '../../config/sdk.js';
import { SessionRefreshService } from './sessionRefresh.js';
import { decodeUserId } from 'src/utils/userId.js';

interface PeriodicTimers {
  messages: ReturnType<typeof setInterval> | null;
  announcements: ReturnType<typeof setInterval> | null;
  sessionRefresh: ReturnType<typeof setInterval> | null;
  sessionStatus: ReturnType<typeof setInterval> | null;
}

const logger = new Logger('SessionsService');

export class SessionsService {
  private session: SessionModule;
  private refreshService?: SessionRefreshService;
  private announcementService: SessionAnnouncementService;
  private messageService: SessionMessageService;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private queries: Queries;
  private timers: PeriodicTimers = {
    messages: null,
    announcements: null,
    sessionRefresh: null,
    sessionStatus: null,
  };

  constructor(
    session: SessionModule,
    messageProtocol: IMessageProtocol,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig,
    queries: Queries
  ) {
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
    this.queries = queries;
    this.announcementService = new SessionAnnouncementService(
      messageProtocol,
      session,
      eventEmitter,
      config,
      queries
    );
    this.messageService = new SessionMessageService(
      messageProtocol,
      session,
      eventEmitter,
      config,
      queries
    );
    this.refreshService = new SessionRefreshService(
      // resetSession callback
      async (contactUserId: string): Promise<Result<Uint8Array, Error>> => {
        return await this.createOrRenew(contactUserId, new Uint8Array(0));
      },
      session,
      this.messageService,
      this.announcementService,
      eventEmitter,
      queries,
      config
    );
  }

  startPeriodicTask(): void {
    this.stopPeriodicTask();

    this.timers.messages = setInterval(async () => {
      try {
        await this.messageService.fetchMessages();
      } catch (error) {
        this.emitPeriodicError(error, 'message_polling');
      }
    }, this.config.polling.messagesIntervalMs);

    this.timers.announcements = setInterval(async () => {
      try {
        await this.announcementService.fetchAndProcessAnnouncements();
      } catch (error) {
        this.emitPeriodicError(error, 'announcement_polling');
      }
    }, this.config.polling.announcementsIntervalMs);

    this.timers.sessionRefresh = setInterval(async () => {
      try {
        await this.refreshService?.stateUpdate();
      } catch (error) {
        this.emitPeriodicError(error, 'session_update');
      }
    }, this.config.polling.sessionRefreshIntervalMs);

    this.timers.sessionStatus = setInterval(async () => {
      try {
        await this.refreshService?.refreshSessionsStatusEvent();
      } catch (error) {
        this.emitPeriodicError(error, 'session_status_polling');
      }
    }, this.config.polling.sessionRefreshIntervalMs);
  }

  stopPeriodicTask(): void {
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
  }

  private emitPeriodicError(error: unknown, source: string): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.eventEmitter.emit(SdkEventType.ERROR, err, source);
  }

  /** Get the session status with a contact */
  getStatus(contactUserId: string): SessionStatus {
    return this.session.peerSessionStatus(decodeUserId(contactUserId));
  }

  /**
   * Create or renew an outgoing encrypted session with a peer and queue the
   * announcement on the session row.
   */
  async createOrRenew(
    contactUserId: string,
    userData: Uint8Array
  ): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('createSessionForContact');
    const ownerUserId = this.session.userIdEncoded;

    // Check if the contact exists.
    const contact = await this.queries.contacts.getByOwnerAndUser(
      ownerUserId,
      contactUserId
    );
    if (!contact) {
      return { success: false, error: new Error('Contact not found') };
    }

    // Call sessionManager.establish_outgoing_session() to send an announcement to the contact.
    const announcement = await this.session.establishOutgoingSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      userData
    );
    if (announcement.length === 0) {
      log.error('empty announcement returned', { contactUserId });
      return {
        success: false,
        error: new Error(EstablishSessionError),
      };
    }

    const now = new Date();

    let sessionId: number;
    // If the session does not exist in db, create it. Otherwise, update it.
    const existingSession =
      await this.queries.sessions.getByContact(contactUserId);
    try {
      if (!existingSession) {
        sessionId = await this.queries.sessions.insert({
          contactUserId: contactUserId,
          announcement_bytes: announcement,
          when_to_send: now,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        sessionId = existingSession.id!;
        await this.queries.sessions.updateById(existingSession.id!, {
          announcement_bytes: announcement,
          when_to_send: now,
          updatedAt: now,
        });
      }
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to create or update session in db: ' + error),
      };
    }

    try {
      // Reset all messages in send queue to WAITING_SESSION for this contact.
      await this.queries.messages.resetSendQueue(ownerUserId, contactUserId);
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to reset send queue: ' + error),
      };
    }

    const updatedSession = await this.queries.sessions.getById(sessionId);
    if (!updatedSession) {
      return {
        success: false,
        error: new Error(
          (existingSession ? 'Updated' : 'Created') +
            'Session (' +
            contactUserId +
            ') not found'
        ),
      };
    }

    // emit event based on the session creation or renewal
    if (existingSession) {
      this.eventEmitter.emit(
        SdkEventType.SESSION_RENEWED,
        updatedSession as unknown as never
      );
    } else {
      this.eventEmitter.emit(
        SdkEventType.SESSION_CREATED,
        updatedSession as unknown as never
      );
    }

    try {
      await this.refreshService?.stateUpdate();
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to trigger state update: ' + error),
      };
    }

    return { success: true, data: announcement };
  }

  async sendMessage(message: Message): Promise<SendMessageResult> {
    return this.messageService.sendMessage(message);
  }
}
