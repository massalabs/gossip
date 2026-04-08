import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
  type Message,
  type DM,
} from '../../db/index.js';
import type { DMRow } from '../../db/queries/index.js';
import { Queries } from '../../db/queries/index.js';
import { SdkEventEmitter, SdkEventType } from '../../core/SdkEventEmitter.js';
import { Result } from '../../utils/type.js';
import { SessionStatus } from '../../wasm/bindings.js';
import { encodeAnnouncementPayload } from '../../utils/announcementPayload.js';
import { SessionsService } from '../session/session.js';

function toDM(row: DMRow): DM {
  return {
    ...row,
    //lastAnnouncementMessage: row.announcementMessage ?? undefined,
  } as unknown as DM;
}

function toSortedDMs(rows: DMRow[]): DM[] {
  return rows.map(toDM).sort((a, b) => {
    if (a.lastMessageTimestamp && b.lastMessageTimestamp) {
      return (
        b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
      );
    }
    if (a.lastMessageTimestamp) return -1;
    if (b.lastMessageTimestamp) return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export class DMService {
  private queries: Queries;
  private eventEmitter: SdkEventEmitter;
  private ownerUserId: string;
  private sessions: SessionsService;
  private announcementHandler: (
    contactUserId: string,
    contactName: string,
    message?: string
  ) => void;
  private messageQueuedHandler: (message: Message) => void;

  constructor(
    queries: Queries,
    eventEmitter: SdkEventEmitter,
    ownerUserId: string,
    sessions: SessionsService
  ) {
    this.queries = queries;
    this.eventEmitter = eventEmitter;
    this.ownerUserId = ownerUserId;
    this.sessions = sessions;
    this.announcementHandler = (contactUserId, contactName, message) => {
      void this.handleAnnouncementReceived(
        contactUserId,
        contactName,
        message
      ).catch(error => {
        this.eventEmitter.emit(
          SdkEventType.ERROR,
          error,
          'DM: handleAnnouncementReceived'
        );
      });
    };
    this.eventEmitter.on(
      SdkEventType.ANNOUNCEMENT_RECEIVED,
      this.announcementHandler
    );
    this.messageQueuedHandler = message => {
      void this.updateLastMessage(message).catch(error => {
        this.eventEmitter.emit(
          SdkEventType.ERROR,
          error,
          'DM: updateLastMessage, messageId=' + message.messageId
        );
      });
    };
    this.eventEmitter.on(
      SdkEventType.MSG_SEND_QUEUE,
      this.messageQueuedHandler
    );
  }

  async list(): Promise<DM[]> {
    const all = await this.queries.dms.getAll();
    return toSortedDMs(all);
  }

  async get(contactUserId: string): Promise<DM | undefined> {
    const row = await this.queries.dms.getByContact(contactUserId);
    return row ? toDM(row) : undefined;
  }

  async create(
    contactUserId: string,
    message?: string
  ): Promise<Result<DM, Error>> {
    const contact = await this.queries.contacts.getByOwnerAndUser(
      this.ownerUserId,
      contactUserId
    );
    if (!contact) {
      return { success: false, error: new Error('Contact not found') };
    }

    const existingDm = await this.queries.dms.getByContact(contactUserId);
    if (existingDm) {
      return { success: false, error: new Error('DM already exists') };
    }

    const payload =
      message !== undefined
        ? encodeAnnouncementPayload(undefined, message)
        : undefined;
    const ensureSession = await this.ensureSessionForCreate(
      contactUserId,
      payload ?? new Uint8Array(0)
    );
    if (!ensureSession.success) {
      return ensureSession;
    }

    const synResult = await this.sendDMSyn(contactUserId);
    if (!synResult.success) {
      return synResult;
    }

    const now = new Date();
    const dmId = await this.queries.dms.insert({
      contactUserId,
      accepted: false,
      direction: DiscussionDirection.INITIATED,
      announcementMessage: message ?? null,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const dmRow = await this.queries.dms.getById(dmId);
    if (!dmRow) {
      return { success: false, error: new Error('DM not found after insert') };
    }

    const dm = toDM(dmRow);
    this.eventEmitter.emit(SdkEventType.DM_REQUESTED, dm, contact);
    return { success: true, data: dm };
  }

  async accept(contactUserId: string): Promise<Result<DM, Error>> {
    const existingDm = await this.queries.dms.getByContact(contactUserId);
    if (!existingDm) {
      return { success: false, error: new Error('DM not found') };
    }

    if (existingDm.accepted) {
      return { success: false, error: new Error('DM already accepted') };
    }

    const sessionRow = await this.queries.sessions.getByContact(contactUserId);
    const currentStatus = this.sessions.getStatus(contactUserId);
    const sessionReady =
      sessionRow !== undefined && currentStatus === SessionStatus.Active;

    if (!sessionReady) {
      const renewed = await this.sessions.createOrRenew(
        contactUserId,
        new Uint8Array(0)
      );
      if (!renewed.success) {
        return { success: false, error: renewed.error };
      }
      if (this.sessions.getStatus(contactUserId) !== SessionStatus.Active) {
        return {
          success: false,
          error: new Error('Session is not active after renewal'),
        };
      }
    }

    const synResult = await this.sendDMSyn(contactUserId);
    if (!synResult.success) {
      return synResult;
    }

    await this.queries.dms.updateById(existingDm.id, {
      accepted: true,
      updatedAt: new Date(),
    });
    const updatedDm = await this.queries.dms.getById(existingDm.id);
    if (!updatedDm) {
      return { success: false, error: new Error('DM not found after update') };
    }

    const dm = toDM(updatedDm);
    this.eventEmitter.emit(SdkEventType.DM_ACCEPTED, dm);
    return { success: true, data: dm };
  }

  cleanup(): void {
    this.eventEmitter.off(
      SdkEventType.ANNOUNCEMENT_RECEIVED,
      this.announcementHandler
    );
    this.eventEmitter.off(
      SdkEventType.MSG_SEND_QUEUE,
      this.messageQueuedHandler
    );
  }

  private async handleAnnouncementReceived(
    contactUserId: string,
    _contactName: string,
    message?: string
  ): Promise<void> {
    const normalizedMessage = message ?? null;
    const contact = await this.queries.contacts.getByOwnerAndUser(
      this.ownerUserId,
      contactUserId
    );
    if (!contact) {
      throw new Error(
        `the contact doesnt exist (contactUserId=${contactUserId})`
      );
    }
    const existingDm = await this.queries.dms.getByContact(contactUserId);

    if (!existingDm) {
      const now = new Date();
      const dmId = await this.queries.dms.insert({
        contactUserId,
        accepted: false,
        direction: DiscussionDirection.RECEIVED,
        announcementMessage: normalizedMessage,
        unreadCount: 0,
        createdAt: now,
        updatedAt: now,
      });

      const dmRow = await this.queries.dms.getById(dmId);

      if (!dmRow) {
        throw new Error(
          `Could not retrieve the DM after insertion (dmId=${dmId})`
        );
      }

      this.eventEmitter.emit(SdkEventType.DM_REQUESTED, toDM(dmRow), contact);

      return;
    }

    if (existingDm.announcementMessage !== normalizedMessage) {
      await this.queries.dms.updateById(existingDm.id, {
        announcementMessage: normalizedMessage,
        updatedAt: new Date(),
      });
    }
  }

  private async updateLastMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.TEXT) {
      return;
    }

    const dm = await this.queries.dms.getByContact(message.contactUserId);
    if (!dm || dm.id == null) {
      // if no DM with this contact, return
      return;
    }

    const lastMessage = dm.lastMessageId
      ? await this.queries.messages.getById(dm.lastMessageId)
      : null;
    if (lastMessage && lastMessage.timestamp > message.timestamp) {
      // if the last message is newer than the incoming message, return
      return;
    }

    // update the DM with the new last message
    const newDM: DM = {
      ...dm,
      lastMessageId: message.id ?? null,
      lastMessageContent: message.content,
      lastMessageTimestamp: message.timestamp,
      updatedAt: new Date(),
    };
    await this.queries.dms.updateById(dm.id, newDM);
    this.eventEmitter.emit(SdkEventType.DM_UPDATED, newDM);
  }

  private async ensureSessionForCreate(
    contactUserId: string,
    userData: Uint8Array
  ): Promise<Result<void, Error>> {
    const sessionRow = await this.queries.sessions.getByContact(contactUserId);
    const currentStatus = this.sessions.getStatus(contactUserId);
    const sessionReady =
      sessionRow !== undefined &&
      (currentStatus === SessionStatus.Active ||
        currentStatus === SessionStatus.SelfRequested);

    if (sessionReady) {
      return { success: true, data: undefined };
    }

    const renewed = await this.sessions.createOrRenew(contactUserId, userData);
    if (!renewed.success) {
      return { success: false, error: renewed.error };
    }

    const statusAfter = this.sessions.getStatus(contactUserId);
    if (
      statusAfter !== SessionStatus.Active &&
      statusAfter !== SessionStatus.SelfRequested
    ) {
      return {
        success: false,
        error: new Error('Session is not active/self-requested after renewal'),
      };
    }

    return { success: true, data: undefined };
  }

  private async sendDMSyn(contactUserId: string): Promise<Result<void, Error>> {
    try {
      await this.sessions.sendMessage({
        ownerUserId: this.ownerUserId,
        contactUserId,
        content: '',
        type: MessageType.DM_SYN,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error
            : new Error('Failed to queue DM_SYN message'),
      };
    }
  }
}
